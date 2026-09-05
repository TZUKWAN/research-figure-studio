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
  // Shims over the canonical ops exactly like slides-main does: the wired
  // create_research_figure path calls addElement/editConnectorEndpoints, and
  // these adapters run the SAME ops through runTxn on the same real deck.
  const EMU_PER_PX_96 = 9525
  const EMU_PER_PT = 12700
  const deckWidthPx = opened.deck.size.cx / EMU_PER_PX_96
  const scale = fitWidthPx / deckWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  const addElement = vi.fn(async (op: {
    slideIndex: number
    kind: string
    xPx: number
    yPx: number
    wPx: number
    hPx: number
    paragraphs?: unknown
    fillColor?: string
    stroke?: { color: string; widthPt: number; dash?: string }
    semanticMetadata?: Record<string, unknown>
  }) => {
    snapshot = structuredClone(opened.deck.slides)
    const r = runTxn(opened, {
      ops: [
        {
          op: 'addElement',
          target: { slide: op.slideIndex },
          kind: op.kind,
          offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
          ...(op.paragraphs ? { paragraphs: op.paragraphs } : {}),
          ...(op.fillColor ? { fill: op.fillColor } : {}),
          ...(op.stroke
            ? { stroke: { color: op.stroke.color, widthEmu: Math.round(op.stroke.widthPt * EMU_PER_PT) } }
            : {}),
          ...(op.semanticMetadata ? { semanticMetadata: op.semanticMetadata } : {}),
        },
      ],
    } as never)
    if (!r.applied) return null
    renderedSlides = rebuild()
    const created = (r.records ?? []).flatMap((rec) => rec.created ?? [])[0]
    if (created === undefined) return null
    return { slide: renderedSlides[0]!, sourceId: created }
  })
  const editConnectorEndpoints = vi.fn(
    async (op: {
      slideIndex: number
      sourceId: string
      x1Px: number
      y1Px: number
      x2Px: number
      y2Px: number
      routeYPx?: number
      start: unknown
      end: unknown
    }) => {
      const r = runTxn(opened, {
        ops: [
          {
            op: 'setConnectorEndpoints',
            target: { slide: op.slideIndex, el: op.sourceId },
            p1: { x: toEmu(op.x1Px), y: toEmu(op.y1Px) },
            p2: { x: toEmu(op.x2Px), y: toEmu(op.y2Px) },
            ...(op.routeYPx != null ? { routeY: toEmu(op.routeYPx) } : {}),
            start: op.start,
            end: op.end,
          },
        ],
      } as never)
      if (!r.applied) return null
      renderedSlides = rebuild()
      return renderedSlides[0]!
    },
  )
  ;(window as unknown as Record<string, unknown>).slidesApi = { applyTxn, undo, addElement, editConnectorEndpoints }
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
