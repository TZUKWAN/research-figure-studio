/**
 * Unified AI error taxonomy (AI-P1-12).
 *
 * Internal code must not depend on English message matching alone (the legacy
 * `"(empty stream)"` string stays supported for backward compatibility, but
 * new code classifies typed error classes first). UI layers localize from the
 * code; diagnostics log the code.
 */

export type AiErrorCode =
  | 'PROVIDER_AUTH'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_CONTEXT_LIMIT'
  | 'PROVIDER_CREDITS'
  | 'PROVIDER_EMPTY_STREAM'
  | 'PROVIDER_RESPONSE'
  | 'PROVIDER_BAD_REQUEST'
  | 'STRUCTURED_PARSE'
  | 'STRUCTURED_SCHEMA'
  | 'TOOL_INPUT'
  | 'TOOL_EXECUTION'
  | 'CANCELLED'
  | 'MODEL_CAPABILITY'
  | 'UNKNOWN'

const AUTH_PATTERN = /\b(401|403)\b|invalid[_ ]api[_ ]key|unauthorized|forbidden|authentication/i
const RATE_LIMIT_PATTERN = /\b429\b|rate[_ ]limit|too many requests|quota exceeded/i
const CONTEXT_LIMIT_PATTERN =
  /\b(400)\b[^\n]*(context length|maximum context|too long|token limit)|context[_ ]length[_ ]exceeded|reduce the length/i
const BAD_REQUEST_PATTERN = /\b400\b|bad request|invalid (request|parameter)|response_format/i
const EMPTY_STREAM_PATTERN = /\(empty stream\)|returned no content|empty (response|stream)/i

/**
 * Classify an error (message, class, cause chain) into the taxonomy. Text
 * matching is the fallback — typed error classes win when present.
 */
export function classifyAiError(err: unknown): AiErrorCode {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown; cause?: unknown }
    if (e.name === 'AiTimeoutError') return 'PROVIDER_TIMEOUT'
    if (e.name === 'AiCreditsError') return 'PROVIDER_CREDITS'
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'Canceled') {
      return 'CANCELLED'
    }
    if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND') {
      return 'PROVIDER_NETWORK'
    }
    if (e.cause) {
      const causeCode = classifyAiError(e.cause)
      if (causeCode !== 'UNKNOWN') return causeCode
    }
  }
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  if (!text) return 'UNKNOWN'
  if (AUTH_PATTERN.test(text)) return 'PROVIDER_AUTH'
  if (RATE_LIMIT_PATTERN.test(text)) return 'PROVIDER_RATE_LIMIT'
  if (CONTEXT_LIMIT_PATTERN.test(text)) return 'PROVIDER_CONTEXT_LIMIT'
  if (EMPTY_STREAM_PATTERN.test(text)) {
    return 'PROVIDER_EMPTY_STREAM'
  }
  if (BAD_REQUEST_PATTERN.test(text)) return 'PROVIDER_BAD_REQUEST'
  return 'UNKNOWN'
}

/**
 * A structured error with a taxonomy code. Provider/app layers may throw or
 * return this so downstream diagnostics never re-derive the code from prose.
 */
export class AiError extends Error {
  readonly code: AiErrorCode
  constructor(code: AiErrorCode, message: string) {
    super(message)
    this.name = 'AiError'
    this.code = code
  }
}
