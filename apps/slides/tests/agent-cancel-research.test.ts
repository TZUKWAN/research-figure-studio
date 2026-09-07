import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide } from '@genoffice/pptx-render'

/**
 * AI-P1-05: cancel must actually reach the research pipeline's internal LLM
 * calls. The skill receives the loop's AbortSignal and hands it to
 * orchestrateFigure; an aborted run stops before further stage work and
 * reports a typed cancellation instead of grinding on.
 */

function makeAccess(overrides: {
  runLlm: DeckAccess['runLlm']
  runStructured?: DeckAccess['runStructured']
}): DeckAccess {
  const slide = {
    widthPx: 1280,
    heightPx: 720,
    nodes: [],
  } as unknown as RenderSlide
  return {
    getSlides: () => [slide],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: vi.fn(),
    applyDeck: vi.fn(),
    fitWidthPx: 1280,
    runLlm: overrides.runLlm,
    ...(overrides.runStructured ? { runStructured: overrides.runStructured } : {}),
  } as unknown as DeckAccess
}

// The production tool writes through ONE atomic applyTxn; the cancel tests
// abort before the transaction, so an unapplied stub is enough to pass the
// production-surface guard.
beforeAll(() => {
  ;(window as unknown as Record<string, unknown>).slidesApi = {
    applyTxn: vi.fn(async () => ({ applied: false, failures: [] })),
  }
})

describe('agent cancel reaches the research pipeline (AI-P1-05)', () => {
  it('an already-aborted signal never issues the planner LLM call', async () => {
    const controller = new AbortController()
    controller.abort()
    const runLlm = vi.fn(async () => ({ ok: true, text: '{}' }))
    const skill = createSlidesSkill(makeAccess({ runLlm }), 'research')
    const result = await skill.executeTool(
      {
        id: '1',
        name: 'create_research_figure',
        input: { slideIndex: 0, thesis: 'X causes Y' },
      },
      controller.signal,
    )
    expect(result.isError).toBe(true)
    expect(runLlm).not.toHaveBeenCalled()
  })

  it('aborting mid-planner resolves the tool promptly with a cancellation error', async () => {
    const controller = new AbortController()
    const runLlm = vi.fn(
      (_system: string, _user: string, signal?: AbortSignal) =>
        new Promise<{ ok: boolean; text?: string; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => resolve({ ok: true, text: '{"ok":true}' }), 60_000)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const skill = createSlidesSkill(makeAccess({ runLlm }), 'research')
    const started = Date.now()
    const execution = (async () =>
      skill.executeTool(
        { id: '1', name: 'create_research_figure', input: { slideIndex: 0, thesis: 'X causes Y' } },
        controller.signal,
      ))()
    // user hits stop while the planner LLM call is in flight
    setTimeout(() => controller.abort(), 30)
    const result = await execution
    expect(Date.now() - started).toBeLessThan(5_000) // prompt stop, not a 60s hang
    expect(result.isError).toBe(true)
    expect(String(result.output).toLowerCase()).toMatch(/cancel|stop|abort/i)
  })

  it('runStructured receives the signal and schema (native enforcement path)', async () => {
    const controller = new AbortController()
    const runStructured = vi.fn(
      async (options: { signal?: AbortSignal; jsonSchema?: { name: string } }) => {
        expect(options.signal).toBe(controller.signal)
        expect(options.jsonSchema?.name).toBe('research_figure_plan')
        return { ok: true, text: '{"thesis":"X"}' }
      },
    )
    const runLlm = vi.fn()
    const _skill = createSlidesSkill(
      makeAccess({ runLlm, runStructured: runStructured as DeckAccess['runStructured'] }),
      'research',
    )
    // A capability profile with structuredJson=true unlocks the native carrier
    const accessWithProfile = makeAccess({
      runLlm,
      runStructured: runStructured as DeckAccess['runStructured'],
    })
    ;(accessWithProfile as { getCapabilityProfile: () => Promise<unknown> }).getCapabilityProfile =
      async () => ({
        streaming: true,
        toolCalling: true,
        multiTurnTools: true,
        structuredJson: true,
        vision: false,
        confidence: 'probed',
        probedAt: '2026-01-01',
        failures: {},
      })
    const skill2 = createSlidesSkill(accessWithProfile, 'research')
    // plan may fail validation against the stub; the assertion is on the transport args
    await Promise.resolve(
      skill2.executeTool(
        { id: '1', name: 'create_research_figure', input: { slideIndex: 0, thesis: 'X causes Y' } },
        controller.signal,
      ),
    ).catch(() => undefined)
    expect(runStructured).toHaveBeenCalled()
    expect(runStructured.mock.calls[0]?.[0]?.jsonSchema?.name).toBe('research_figure_plan')
    expect(runLlm).not.toHaveBeenCalled()
  })
})
