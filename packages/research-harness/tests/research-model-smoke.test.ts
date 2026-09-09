/**
 * P1-4 (production closure 2): REAL model smoke that reuses the PRODUCTION
 * protocol chain — the compiled runtime protocol (machine schema), the
 * production structured-output engine (requestStructured: truncation
 * detection + protocol repair) and the PRODUCTION parser
 * (parseFigurePlanV2WithDiagnostics). No hand-written mini protocol.
 *
 * - No METIS_SMOKE_* credentials → clean skip (never a red CI gate).
 * - Credentials present → a REAL model must satisfy the production contract.
 *
 * semantic smoke: planner contract only.
 * full smoke: planner → designer → orchestrator → delivery gate.
 */
import { describe, expect, it } from 'vitest'
import {
  compileResearchRuntimeProtocol,
  renderJsonContract,
} from '../src/protocol/figure-plan-protocol.js'
import { parseFigurePlanV2WithDiagnostics } from '../src/semantic/figure-plan.js'
import { parseSpatialPlanWithDiagnostics } from '../src/composition/spatial-plan.js'
import { orchestrateFigure } from '../src/orchestrator/create-figure.js'
import { requestStructured } from '../../agent-core/src/structured-output.js'

const BASE_URL = process.env.METIS_SMOKE_BASE_URL
const API_KEY = process.env.METIS_SMOKE_API_KEY
const MODEL = process.env.METIS_SMOKE_MODEL
const HAS_CREDENTIALS = Boolean(BASE_URL && API_KEY && MODEL)

const THESIS =
  'Southern Ocean warming drives Antarctic krill swarm fragmentation, reducing penguin chick survival.'

const protocol = compileResearchRuntimeProtocol()

/** Production transport: OpenAI-compatible chat completions with the provider schema carrier. */
async function productionTransport(request: {
  system: string
  user: string
  signal?: AbortSignal
  jsonSchema?: { name: string; schema: Record<string, unknown> }
}): Promise<{ ok: boolean; text?: string; error?: string; mode: 'native-json' | 'plain' }> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: request.system },
    { role: 'user', content: request.user },
  ]
  const body: Record<string, unknown> = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 4096,
    messages,
  }
  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.jsonSchema.name,
        schema: request.jsonSchema.schema,
        strict: false,
      },
    }
  }
  const response = await fetch(`${BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    ...(request.signal ? { signal: request.signal } : {}),
  })
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}: ${await response.text()}`, mode: 'plain' }
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = json.choices?.[0]?.message?.content ?? ''
  return { ok: text.trim().length > 0, text, mode: request.jsonSchema ? 'native-json' : 'plain' }
}

describe.skipIf(!HAS_CREDENTIALS)('research model smoke (P1-4, real model)', () => {
  it(
    'semantic smoke: real planner protocol + real production parser accept a live model answer',
    { timeout: 180_000 },
    async () => {
      const plannerSystem = [
        'You are the Semantic Planner of a research-figure pipeline.',
        'Output ONLY one JSON object satisfying this schema; no prose.',
        renderJsonContract(protocol.figurePlanSchema),
      ].join('\n')
      const result = await requestStructured(productionTransport, {
        schemaId: 'research.semantic-planner.smoke',
        jsonSchema: { name: 'research_figure_plan', schema: protocol.figurePlanSchema },
        system: plannerSystem,
        user: `Thesis: ${THESIS}\nCanvas: 1280x720px`,
        validate: (value) => {
          const parsed = parseFigurePlanV2WithDiagnostics(value)
          if (!parsed.plan) {
            throw new Error(parsed.errors.join('; ') || 'FigurePlan failed schema validation')
          }
          return parsed.plan
        },
      })
      expect(
        result.ok,
        `planner failed: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
      ).toBe(true)
      expect((result.value as unknown as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0)
    },
  )

  it(
    'full smoke: planner → designer → orchestrator → delivery gate on a live model',
    { timeout: 300_000 },
    async () => {
      const plannerSystem = [
        'You are the Semantic Planner of a research-figure pipeline.',
        'Output ONLY one JSON object satisfying this schema; no prose.',
        renderJsonContract(protocol.figurePlanSchema),
      ].join('\n')
      const designerSystem = [
        'You are the Composition Designer of a research-figure pipeline.',
        'Output ONLY one JSON object satisfying this schema; no prose.',
        renderJsonContract(protocol.spatialPlanSchema),
      ].join('\n')
      // the designer validator MUST validate against the ids the planner
      // actually produced (P1-4 review fix) — never a hardcoded a..h list
      let plannedNodeIds: string[] = []
      const llm = {
        semanticPlan: async (thesis: string, feedback?: string) => {
          const result = await requestStructured(productionTransport, {
            schemaId: 'research.semantic-planner.smoke.full',
            jsonSchema: { name: 'research_figure_plan', schema: protocol.figurePlanSchema },
            system: plannerSystem,
            user: feedback
              ? `Thesis: ${thesis}\nCanvas: 1280x720px\n\nPrevious attempt rejected: ${feedback}\nFix and output the JSON object again.`
              : `Thesis: ${thesis}\nCanvas: 1280x720px`,
            validate: (value) => {
              const parsed = parseFigurePlanV2WithDiagnostics(value)
              if (!parsed.plan) throw new Error(parsed.errors.join('; '))
              return parsed.plan
            },
          })
          if (!result.ok) {
            throw new Error(result.diagnostics.map((d) => d.message).join('; '))
          }
          plannedNodeIds = (result.value as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id)
          return result.value
        },
        compose: async (ctx: unknown) => {
          const result = await requestStructured(productionTransport, {
            schemaId: 'research.composition-designer.smoke',
            jsonSchema: { name: 'research_spatial_plan', schema: protocol.spatialPlanSchema },
            system: designerSystem,
            user: JSON.stringify(ctx),
            validate: (value) => {
              const parsed = parseSpatialPlanWithDiagnostics(value, plannedNodeIds)
              if (!parsed.plan) throw new Error(parsed.errors.join('; '))
              return parsed.plan
            },
          })
          if (!result.ok) {
            throw new Error(result.diagnostics.map((d) => d.message).join('; '))
          }
          return result.value
        },
      }
      const result = await orchestrateFigure({ thesis: THESIS, canvasW: 1280, canvasH: 720 }, llm)
      // FULL smoke means the delivery gate must PASS for this fixture — a
      // merely-not-crashed pipeline is not a passing smoke (P1-4 review fix)
      expect(result.ok, `delivery failed: ${result.delivery?.detail ?? result.error}`).toBe(true)
      expect(result.delivery?.pass).toBe(true)
      expect(result.critic?.verdict).toBe('PASS')
    },
  )
})
