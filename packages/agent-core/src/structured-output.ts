/**
 * Provider-neutral structured output (AI-P0-01).
 *
 * The research pipeline used to recover JSON from model prose with
 * "first `{` … last `}`" slicing, which breaks on trailing commentary,
 * multiple objects, reasoning braces and truncated output. This module is the
 * replacement protocol:
 *
 * 1. the caller asks the provider for native/forced JSON when supported
 *    (ai-provider structured call; capability-probed),
 * 2. whatever comes back is recovered with a balanced-brace scan that respects
 *    strings/escapes and completes a truncated tail (bounded repair — NOT a
 *    growing regex pile),
 * 3. the caller's validator runs; on failure a bounded number of repair turns
 *    re-asks the model with the specific schema feedback.
 *
 * Every outcome carries typed parse diagnostics; nothing is silently null.
 */

/** One typed reason the raw model output could not be turned into `value`. */
export interface StructuredDiagnostic {
  code:
    | 'EMPTY_RESPONSE'
    | 'NO_JSON_OBJECT'
    | 'TRUNCATED_JSON'
    | 'JSON_PARSE_FAILED'
    | 'SCHEMA_VALIDATION_FAILED'
  message: string
}

export interface StructuredRequest<T> {
  /** stable id used in logs/metrics (e.g. 'research.semantic-planner') */
  schemaId: string
  /** JSON Schema describing the expected object (single carrier: also sent to providers that support native enforcement) */
  jsonSchema?: JsonSchemaCarrier | Record<string, unknown>
  system: string
  user: string
  /** deterministic validation + repair; throws (or returns null) when unusable */
  validate: (value: unknown) => T | null
}

export type StructuredProviderMode = 'native-json' | 'tool-schema' | 'plain'

export interface StructuredResult<T> {
  ok: boolean
  value?: T
  /** raw model text of the successful (or last) attempt */
  rawText?: string
  diagnostics: StructuredDiagnostic[]
  /** how the winning attempt constrained the model */
  providerMode: StructuredProviderMode
  /** number of model calls consumed (1 + repair turns) */
  attempts: number
}

/** Schema carrier passed to the transport (name needed by providers that force a tool). */
export interface JsonSchemaCarrier {
  name: string
  schema: Record<string, unknown>
}

/** Low-level single completion the client drives. Implementations forward the
 *  schema hint when the transport supports native enforcement. */
export interface StructuredTransport {
  (options: {
    system: string
    user: string
    signal?: AbortSignal
    jsonSchema?: JsonSchemaCarrier
  }): Promise<{ ok: boolean; text?: string; mode?: StructuredProviderMode; error?: string }>
}

export interface StructuredOutputOptions {
  /** repair turns after the first attempt (default 1) */
  maxRepairs?: number
  signal?: AbortSignal
}

const MAX_REPAIRS_DEFAULT = 1

/** Accept a bare schema or a named carrier; bare schemas get a derived name. */
function normalizeCarrier(
  jsonSchema: JsonSchemaCarrier | Record<string, unknown> | undefined,
): JsonSchemaCarrier | undefined {
  if (!jsonSchema) return undefined
  if ('name' in jsonSchema && typeof (jsonSchema as JsonSchemaCarrier).name === 'string') {
    return jsonSchema as JsonSchemaCarrier
  }
  return { name: 'structured_response', schema: jsonSchema as Record<string, unknown> }
}

/**
 * Extract the first balanced JSON object from model text. Unlike
 * `indexOf('{')`/`lastIndexOf('}')` slicing this survives trailing prose with
 * braces ("Note: {explanation}"), fences, leading labels and embedded objects,
 * and it detects (rather than mis-parses) truncated output.
 */
export function extractJsonObject(text: string): {
  value: unknown | undefined
  diagnostic?: StructuredDiagnostic
} {
  const start = text.indexOf('{')
  if (start < 0)
    return {
      value: undefined,
      diagnostic: { code: 'NO_JSON_OBJECT', message: 'no JSON object found in the response' },
    }
  let inString = false
  let escaped = false
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        try {
          return { value: JSON.parse(candidate) }
        } catch (e) {
          return {
            value: undefined,
            diagnostic: {
              code: 'JSON_PARSE_FAILED',
              message: `balanced object failed to parse: ${e instanceof Error ? e.message : String(e)}`,
            },
          }
        }
      }
    }
  }
  // Unterminated: a truncated tail. Complete the bracket/string state and try
  // the repaired candidate — bounded repair, one pass, no guess-and-retry loop.
  let repaired = text.slice(start)
  if (inString) repaired += '"'
  repaired += '}'.repeat(depth)
  try {
    return {
      value: JSON.parse(repaired),
      diagnostic: {
        code: 'TRUNCATED_JSON',
        message: 'output was cut off; the JSON tail was completed by repair',
      },
    }
  } catch {
    return {
      value: undefined,
      diagnostic: {
        code: 'TRUNCATED_JSON',
        message: 'output was cut off mid-object and could not be repaired',
      },
    }
  }
}

/** True when the text ends mid-string / mid-object (used by retry policy). */
export function looksTruncated(text: string): boolean {
  const res = extractJsonObject(text)
  return res.diagnostic?.code === 'TRUNCATED_JSON'
}

/**
 * Drive one structured request to completion: native/forced JSON attempt,
 * bounded repair turns with validator feedback, typed diagnostics throughout.
 */
export async function requestStructured<T>(
  transport: StructuredTransport,
  request: StructuredRequest<T>,
  options: StructuredOutputOptions = {},
): Promise<StructuredResult<T>> {
  const maxRepairs = options.maxRepairs ?? MAX_REPAIRS_DEFAULT
  const diagnostics: StructuredDiagnostic[] = []
  let feedback: string | undefined
  let lastText: string | undefined
  let lastMode: StructuredProviderMode = 'plain'
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    if (options.signal?.aborted) {
      return {
        ok: false,
        diagnostics,
        providerMode: lastMode,
        attempts: attempt,
        ...(lastText ? { rawText: lastText } : {}),
      }
    }
    const user = feedback ? `${request.user}\n\n${feedback}` : request.user
    let response: { ok: boolean; text?: string; mode?: StructuredProviderMode; error?: string }
    try {
      response = await transport({
        system: request.system,
        user,
        signal: options.signal,
        jsonSchema: normalizeCarrier(request.jsonSchema),
      })
    } catch (e) {
      diagnostics.push({
        code: 'EMPTY_RESPONSE',
        message: `transport failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      return { ok: false, diagnostics, providerMode: lastMode, attempts: attempt + 1 }
    }
    lastMode = response.mode ?? 'plain'
    if (!response.ok) {
      diagnostics.push({
        code: 'EMPTY_RESPONSE',
        message: response.error ?? 'provider call failed',
      })
      return { ok: false, diagnostics, providerMode: lastMode, attempts: attempt + 1 }
    }
    const text = response.text ?? ''
    lastText = text
    if (!text.trim()) {
      diagnostics.push({ code: 'EMPTY_RESPONSE', message: 'model returned an empty response' })
      if (attempt >= maxRepairs) break
      feedback = 'Your previous reply was empty. Output ONLY the JSON object.'
      continue
    }
    const { value, diagnostic } = extractJsonObject(text)
    if (value === undefined) {
      diagnostics.push(diagnostic ?? { code: 'NO_JSON_OBJECT', message: 'no JSON object found' })
      if (attempt >= maxRepairs) break
      feedback =
        'Your previous reply was not parseable JSON. Output ONLY one JSON object conforming to the schema — no prose, no code fence, no trailing notes.'
      continue
    }
    if (diagnostic) diagnostics.push(diagnostic)
    let validated: T | null = null
    try {
      validated = request.validate(value)
    } catch (e) {
      diagnostics.push({
        code: 'SCHEMA_VALIDATION_FAILED',
        message: e instanceof Error ? e.message : String(e),
      })
    }
    if (validated !== null) {
      return {
        ok: true,
        value: validated,
        rawText: text,
        diagnostics,
        providerMode: lastMode,
        attempts: attempt + 1,
      }
    }
    if (!diagnostics.some((d) => d.code === 'SCHEMA_VALIDATION_FAILED')) {
      diagnostics.push({ code: 'SCHEMA_VALIDATION_FAILED', message: 'value rejected by validator' })
    }
    if (attempt >= maxRepairs) break
    const lastIssue = diagnostics.at(-1)?.message ?? 'value rejected'
    feedback = `Previous attempt rejected: ${lastIssue}\nFix the issues and output the JSON object again. Output ONLY the JSON object.`
  }
  return {
    ok: false,
    diagnostics,
    providerMode: lastMode,
    attempts: maxRepairs + 1,
    ...(lastText ? { rawText: lastText } : {}),
  }
}
