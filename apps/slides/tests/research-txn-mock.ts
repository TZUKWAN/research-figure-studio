/**
 * Shared test harness for research-figure renderer tests: a REAL pptx-engine
 * deck driven through the SAME transaction surface the tool uses
 * (window.slidesApi.applyTxn / undo), with the atomic executor and render
 * rebuild fully in the loop.
 */
import { vi } from 'vitest'
import { createBlankPptx, openPptx } from '@genoffice/pptx-engine'
import { runTxn } from '../src/main/ops/executor'
import '../src/main/ops/core-ops'
import '../src/main/ops/element-ops'
import '../src/main/ops/insert-ops'
import '../src/main/ops/slide-ops'
import { buildRenderSlide, type RenderSlide } from '@genoffice/pptx-render'
import type { DeckAccessLike } from '../src/renderer/research/create-research-figure-tool'

export { createBlankPptx, openPptx }

export async function makeTxnAccess(runLlm: DeckAccessLike['runLlm'], fitWidthPx = 1280) {
  const opened = await openPptx(await createBlankPptx())
  const rebuild = () =>
    opened.deck.slides.map((slide) => buildRenderSlide(slide, opened.deck.size, { fitWidthPx }))
  let renderedSlides = rebuild()
  let snapshot: unknown = null
  const applyTxn = vi.fn(
    async (req: { ops: Array<Record<string, unknown>>; isolation?: 'atomic' | 'per_op' }) => {
      snapshot = structuredClone(opened.deck.slides)
      const r = runTxn(opened, { ops: req.ops as never, isolation: req.isolation ?? 'atomic' })
      if (!r.applied) {
        return {
          applied: false,
          ...(r.failures
            ? { failures: r.failures.map((f) => ({ index: f.index, error: f.error })) }
            : {}),
        }
      }
      renderedSlides = rebuild()
      return {
        applied: true,
        records: (r.records ?? []).map((rec) => ({
          op: rec.op.op,
          ...(rec.created ? { created: rec.created } : {}),
        })),
        slides: renderedSlides,
      }
    },
  )
  const undo = vi.fn(async () => {
    if (snapshot == null) return null
    opened.deck.slides = structuredClone(snapshot) as typeof opened.deck.slides
    renderedSlides = rebuild()
    return renderedSlides
  })
  ;(window as unknown as Record<string, unknown>).slidesApi = { applyTxn, undo }
  const applySlide = vi.fn((_index: number, slide: RenderSlide) => {
    renderedSlides[0] = slide
  })
  const applyDeck = vi.fn((slides: RenderSlide[]) => {
    renderedSlides = slides
  })
  const access = {
    getSlides: () => renderedSlides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide,
    applyDeck,
    fitWidthPx,
    runLlm,
  } as unknown as DeckAccessLike
  return { access, applyTxn, undo, opened, rendered: () => renderedSlides[0]! }
}
