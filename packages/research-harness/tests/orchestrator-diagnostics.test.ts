import { describe, expect, it, vi } from 'vitest'
import { orchestrateFigure, parseFigurePlanV2, type OrchestrationDiagnostic } from '../src'
import type { OrchestrationDiagnosticCode } from '../src'

const VALID_PLAN = {
  thesis: 'Effect of X on Y',
  figureType: 'freeform',
  nodes: [
    {
      id: 'a',
      type: 'variable',
      semanticLabel: 'X',
      visible: { title: 'X' },
      importance: 0.8,
      role: 'input',
    },
    {
      id: 'b',
      type: 'outcome',
      semanticLabel: 'Y',
      visible: { title: 'Y' },
      importance: 0.8,
      role: 'output',
    },
  ],
  edges: [{ from: 'a', to: 'b', relation: 'causal' }],
  groups: [],
  globalIntent: { emphasis: ['a'], secondary: ['b'], optional: [] },
}

const _measured = (plan: ReturnType<typeof parseFigurePlanV2>) =>
  (plan?.nodes ?? []).map((n) => ({ id: n.id, w: 140, h: 60 }))

function makeLlm(overrides: {
  planRaw?: unknown
  composeRaw?: unknown
  composeThrow?: Error
  composeDelayMs?: number
  composeSignalAware?: boolean
}) {
  return {
    semanticPlan: async () => overrides.planRaw ?? VALID_PLAN,
    compose: async (ctx: { signal?: AbortSignal }) => {
      if (overrides.composeThrow) throw overrides.composeThrow
      if (overrides.composeDelayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, overrides.composeDelayMs!)
          ctx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      }
      return overrides.composeRaw
    },
  }
}

// strong calibration so selectAutonomy lands on A1/A2 and the composer runs
const STRONG = {
  capability: {
    calibration: { spatialPlanning: 'strong' as const, jsonReliability: 'high' as const },
  },
}

const codesOf = (
  diagnostics: OrchestrationDiagnostic[] | undefined,
): OrchestrationDiagnosticCode[] => (diagnostics ?? []).map((d) => d.code)

describe('orchestrator LLM-stage diagnostics (AI-P0-08/09/11)', () => {
  it('records MODEL_COMPOSITION_SCHEMA_FAILED and falls back when the model plan is unusable', async () => {
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, ...STRONG },
      makeLlm({ composeRaw: { nonsense: true } }),
    )
    expect(result.ok).toBe(true) // deterministic prior still delivers
    expect(result.fallbackUsed).toBe(true)
    expect(codesOf(result.diagnostics)).toContain('MODEL_COMPOSITION_SCHEMA_FAILED')
    expect(result.fallbackReason).toBeTruthy()
    // trace + repairs still flow
    expect(result.trace.length).toBeGreaterThan(0)
  })

  it('distinguishes parse failures from schema failures', async () => {
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, ...STRONG },
      makeLlm({ composeRaw: 'this is not json at all' }),
    )
    expect(codesOf(result.diagnostics)).toContain('MODEL_COMPOSITION_PARSE_FAILED')
    expect(codesOf(result.diagnostics)).not.toContain('MODEL_COMPOSITION_SCHEMA_FAILED')
  })

  it('records provider failures when the composer transport throws', async () => {
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, stageBudgets: { compositionMs: 50 }, ...STRONG },
      makeLlm({ composeThrow: new Error('HTTP 502: gateway exploded') }),
    )
    expect(codesOf(result.diagnostics)).toContain('MODEL_COMPOSITION_PROVIDER_FAILED')
    expect(result.fallbackUsed).toBe(true)
  })

  it('applies the composition stage budget and reports MODEL_COMPOSITION_TIMEOUT', async () => {
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, stageBudgets: { compositionMs: 30 }, ...STRONG },
      makeLlm({ composeRaw: null, composeDelayMs: 5_000 }),
    )
    expect(codesOf(result.diagnostics)).toContain('MODEL_COMPOSITION_TIMEOUT')
    expect(result.fallbackUsed).toBe(true)
    expect(result.fallbackReason).toContain('timed out')
  })

  it('reports semantic stage failures typed, not as generic strings', async () => {
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => ({ nodes: [] }), compose: async () => null },
    )
    expect(result.ok).toBe(false)
    expect(codesOf(result.diagnostics)).toContain('MODEL_SEMANTIC_SCHEMA_FAILED')
  })

  it('propagates cancellation between stages (AI-P1-05)', async () => {
    const controller = new AbortController()
    // cancel while the composer is awaiting its LLM
    setTimeout(() => controller.abort(), 20)
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, signal: controller.signal, ...STRONG },
      makeLlm({ composeRaw: null, composeDelayMs: 60_000, composeSignalAware: true }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('cancelled')
    expect(codesOf(result.diagnostics)).toContain('MODEL_COMPOSITION_CANCELLED')
  })

  it('downgrades a stale junction presentation with a typed diagnostic (AI-P0-05)', async () => {
    const plan = {
      ...VALID_PLAN,
      edges: [{ from: 'a', to: 'b', relation: 'causal', presentation: 'junction' }],
    }
    const result = await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => plan },
    )
    expect(codesOf(result.diagnostics)).toContain('MODEL_PRESENTATION_DOWNGRADED')
    const downgraded = (result.routes ?? []).find((r) => r.semanticEdgeId?.startsWith('edge:'))
    expect(downgraded?.presentation).toBe('arrow')
  })

  it('emits stage events for progress consumers (AI-P1-02)', async () => {
    const onEvent = vi.fn()
    await orchestrateFigure(
      { thesis: 'T', canvasW: 1280, canvasH: 720, ...STRONG },
      makeLlm({ composeRaw: null }),
      onEvent,
    )
    const stages = onEvent.mock.calls.map((c) => c[0].stage)
    expect(stages).toContain('semantic.plan')
    expect(stages).toContain('composition.started')
    expect(stages).toContain('figure.completed')
  })
})
