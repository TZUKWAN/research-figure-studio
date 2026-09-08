/**
 * P0-1 (production closure 2): post-write verification is FAIL-CLOSED.
 *
 * Rule A: applied=true without a rebuilt slide → FAIL (rollback), never a
 *         verification-skipping success.
 * Rule B: rollback capability is a mutation precondition — no undo, no write.
 * Critical: a FAILED rollback reports isError + mutated=true (canvas
 *           uncertain), never a fake "canvas unchanged".
 */
import { describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { makeTxnAccess } from './research-txn-mock'
import type { DeckAccessLike } from '../src/renderer/research/create-research-figure-tool'

const figurePlan = {
  thesis: '共同注意通过同步化提升协作效率。',
  figureType: 'mechanism',
  narrative: {
    expressionMode: 'mechanism',
    complexity: 'compact',
    centralMessage: 'x',
    visualCenter: 'shared-attention',
    readingPath: ['shared-attention', 'sync', 'collab'],
    mustShow: ['shared-attention', 'sync', 'collab'],
    mayMerge: [],
    omitFromCanvas: [],
  },
  nodes: [
    {
      id: 'shared-attention',
      type: 'mechanism',
      semanticLabel: 'A',
      visible: { title: '共同注意' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'sync',
      type: 'process',
      semanticLabel: 'S',
      visible: { title: '同步化' },
      importance: 0.7,
      role: 'intermediate',
    },
    {
      id: 'collab',
      type: 'outcome',
      semanticLabel: 'C',
      visible: { title: '协作效率' },
      importance: 0.8,
      role: 'output',
    },
  ],
  edges: [
    {
      id: 'e1',
      from: 'shared-attention',
      to: 'sync',
      role: 'main',
      relation: 'causal',
      presentation: 'arrow',
    },
    {
      id: 'e2',
      from: 'sync',
      to: 'collab',
      role: 'main',
      relation: 'causal',
      presentation: 'arrow',
    },
  ],
  groups: [],
  globalIntent: { emphasis: ['shared-attention'], secondary: [], optional: [] },
}

const spatialPlan = {
  composition: {
    readingFlow: 'LR',
    balance: 'loosely-balanced',
    density: 'medium',
    visualCenter: 'shared-attention',
    whitespaceStrategy: 'balanced',
  },
  placements: [
    {
      id: 'shared-attention',
      boxHint: { x: 0.08, y: 0.3, w: 0.28, h: 0.42 },
      visualRole: 'dominant',
    },
    { id: 'sync', boxHint: { x: 0.46, y: 0.32, w: 0.2, h: 0.22 }, visualRole: 'primary' },
    { id: 'collab', boxHint: { x: 0.72, y: 0.3, w: 0.22, h: 0.24 }, visualRole: 'secondary' },
  ],
}

function researchRunLlm() {
  return vi.fn(async (system: string) => {
    if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
    if (system.includes('Composition Designer'))
      return { ok: true, text: JSON.stringify(spatialPlan) }
    return { ok: false, error: 'unexpected prompt' }
  })
}

const run = (access: DeckAccessLike) =>
  createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool({
    id: 'p0-1',
    name: 'create_research_figure',
    input: { slideIndex: 0, thesis: figurePlan.thesis },
  })

/** Patch the session's applyTxn to tamper with the REBUILT slides it returns. */
function tamperRebuiltSlides(tamper: (slides: RenderSlide[]) => RenderSlide[]): void {
  const api = (
    window as unknown as {
      slidesApi: {
        applyTxn: (
          req: unknown,
        ) => Promise<{ applied: boolean; slides?: RenderSlide[]; records?: unknown }>
      }
    }
  ).slidesApi
  const real = api.applyTxn
  api.applyTxn = async (req: unknown) => {
    const r = await real(req)
    return { ...r, ...(r.slides ? { slides: tamper(r.slides) } : {}) }
  }
}

const dropModule =
  (semanticId: string) =>
  (slides: RenderSlide[]): RenderSlide[] =>
    slides.map((slide, index) =>
      index === 0
        ? {
            ...slide,
            nodes: slide.nodes.filter(
              (node) =>
                (node as { semanticMetadata?: Record<string, unknown> }).semanticMetadata
                  ?.semanticNodeId !== semanticId,
            ),
          }
        : slide,
    )

describe('post-write verification is fail-closed (P0-1)', () => {
  it('Case 3: no undo capability → refuse BEFORE mutating (applyTxn never called)', async () => {
    const { access } = await makeTxnAccess(researchRunLlm())
    ;(window as unknown as Record<string, unknown>).slidesApi = {
      applyTxn: vi.fn(async () => ({ applied: true })),
      // undo deliberately absent
    }
    const applyTxn = (window as unknown as { slidesApi: { applyTxn: ReturnType<typeof vi.fn> } })
      .slidesApi.applyTxn
    const result = await run(access)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('no undo/rollback capability')
    expect(applyTxn).not.toHaveBeenCalled()
  })

  it('Case 1: applied=true without a rebuilt slide → rollback + FAIL (no success)', async () => {
    const { access, undo } = await makeTxnAccess(researchRunLlm())
    const api = (
      window as unknown as {
        slidesApi: { applyTxn: (req: unknown) => Promise<{ applied: boolean; records?: unknown }> }
      }
    ).slidesApi
    const real = api.applyTxn
    api.applyTxn = async (req: unknown) => {
      const r = await real(req)
      // simulate the handler dropping the rebuilt slides array
      return { applied: r.applied, records: r.records }
    }
    const result = await run(access)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('no rebuilt slide was returned')
    expect(undo).toHaveBeenCalled() // the rollback RAN
    expect(String(result.output)).not.toContain('Created an orchestrated')
  })

  it('Case 2: verification fail with working undo → FAIL and canvas restored', async () => {
    const { access, undo, rendered } = await makeTxnAccess(researchRunLlm())
    // tamper: drop an entire module from the rebuilt slide → verification fails
    tamperRebuiltSlides(dropModule('sync'))
    const result = await run(access)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('figure reverted after post-write verification')
    expect(undo).toHaveBeenCalled()
    // canvas restored: no research module remains on the live slide
    const live = rendered()
    expect(
      live.nodes.some(
        (node) =>
          (node as { semanticMetadata?: Record<string, unknown> }).semanticMetadata
            ?.componentType === 'research-module',
      ),
    ).toBe(false)
  })

  it('Case 4: verification fail with failing undo → CRITICAL mutated failure', async () => {
    const { access, undo } = await makeTxnAccess(researchRunLlm())
    tamperRebuiltSlides(dropModule('sync'))
    undo.mockRejectedValue(new Error('undo stack corrupted'))
    const result = await run(access)
    expect(result.isError).toBe(true)
    const failure = result as { output: string; mutated?: boolean; critical?: boolean }
    expect(failure.output).toContain('CRITICAL_TRANSACTION_ROLLBACK_FAILED')
    // never pretend the canvas is unchanged
    expect(failure.mutated).toBe(true)
    expect(failure.critical).toBe(true)
  })

  it('Case 5: verification pass → success (invariant holds)', async () => {
    const { access } = await makeTxnAccess(researchRunLlm())
    const result = await run(access)
    expect(result.isError, result.output).toBeUndefined()
    expect(String(result.output)).toContain('Created an orchestrated')
  })

  it('Case 6: applyTxn null → fail, no mutation', async () => {
    const { access } = await makeTxnAccess(researchRunLlm())
    ;(window as unknown as Record<string, unknown>).slidesApi = {
      applyTxn: undefined,
      undo: vi.fn(),
    }
    const result = await run(access)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('transaction API unavailable')
  })

  it('Case 7: applied=false → fail (canvas unchanged)', async () => {
    const { access, applyTxn, undo } = await makeTxnAccess(researchRunLlm())
    applyTxn.mockResolvedValue({
      applied: false,
      failures: [{ index: 2, error: 'boom' }],
    })
    const result = await run(access)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('figure transaction rolled back')
    expect(undo).not.toHaveBeenCalled() // nothing to roll back
  })
})
