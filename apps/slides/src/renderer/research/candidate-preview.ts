/**
 * Vision candidate review (P1-1, production closure 2) — renderer-side wiring.
 *
 * NEAR-FINAL preview (review fix): instead of generic colored rectangles, the
 * candidate is rendered through the REAL production pipeline —
 * buildFigureRenderPlan (same primitives, connectors, inhibition bars, micro
 * units, typography SSOT, domain profile as the final write) into a TEMPORARY
 * in-memory deck that is never saved — then rasterized through the same Konva
 * export path and reviewed. Vision judges what the user would actually get,
 * minus the commit.
 */
import type { CompositionCandidate, FigurePlanV2 } from '@genoffice/research-harness'
import type { RenderSlide } from '@genoffice/pptx-render'
import type { AgentImage } from '@genoffice/agent-core'
import type { ThemeRoles } from '@genoffice/theme-engine'

type RenderSlidesFn = (
  slides: RenderSlide[],
  images: Map<string, HTMLImageElement>,
  pixelRatio?: number,
) => Promise<string[]>

// Konva is imported LAZILY: a static import would pull node-canvas into every
// jsdom test.
let renderSlidesToPngBase64: RenderSlidesFn | null = null
async function rasterize(): Promise<RenderSlidesFn> {
  if (!renderSlidesToPngBase64) {
    const mod = await import('../export-render')
    renderSlidesToPngBase64 = mod.renderSlidesToPngBase64 as RenderSlidesFn
  }
  return renderSlidesToPngBase64
}

export interface NearFinalPreviewArgs {
  candidate: CompositionCandidate
  plan: FigurePlanV2
  planNodes: Array<{ id: string; visible: { title: string } }>
  visualPlan: { modules: unknown[] }
  domain?: string
  canvasW: number
  canvasH: number
  theme: ThemeRoles
}

/**
 * Render ONE candidate near-final: run buildFigureRenderPlan over the
 * candidate's own solve, materialize the elements into a temporary in-memory
 * deck, rasterize, return raw base64 PNG. Never touches user files.
 */
export async function renderCandidatePreview(args: NearFinalPreviewArgs): Promise<string> {
  const engine = await import('@genoffice/pptx-engine')
  const renderMod = await import('../export-render')
  const { routeEdges } = await import('@genoffice/research-harness')
  const { buildFigureRenderPlan } = await import('./native-figure-renderer')
  const opened = await engine.openPptx(await engine.createBlankPptx())
  // size the temp deck to the real canvas so placements map 1:1
  opened.deck.size = {
    cx: Math.round((args.canvasW * 9525) / 1),
    cy: Math.round((args.canvasH * 9525) / 1),
  }
  const slide = opened.deck.slides[0]!

  const renderPlan = buildFigureRenderPlan({
    plan: args.plan,
    solve: { placements: args.candidate.solve.placements },
    // routes are recomputed for THIS candidate's geometry (lightweight
    // anchor/route pass — no obstacle rerun needed for a preview)
    routes: routeEdges(
      args.plan.edges.map((edge, index) => ({
        key: edge.id ?? `${edge.from}->${edge.to}`,
        semanticEdgeId: edge.id ?? `${edge.from}->${edge.to}`,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role ?? 'main',
        relation: edge.relation,
      })),
      new Map(args.candidate.solve.placements.map((p) => [p.id, p])),
    ),
    visualPlan: args.visualPlan as import('@genoffice/research-harness').VisualPlan,
    domain: args.domain,
    canvasW: args.canvasW,
    canvasH: args.canvasH,
    theme: args.theme,
    thesis: args.plan.thesis ?? '',
  })

  const EMU = 9525
  for (const el of renderPlan.elements) {
    const isLine = el.kind === 'line' || el.kind === 'lineArrow' || el.kind === 'lineBent'
    engine.addElement(slide, {
      kind: el.kind as never,
      offset: {
        x: Math.round(el.x * EMU),
        y: Math.round(el.y * EMU),
        cx: Math.max(1, Math.round(el.w * EMU)),
        cy: Math.max(1, Math.round(el.h * EMU)),
      },
      ...(el.paragraphs.length > 0 ? { paragraphs: el.paragraphs as never } : {}),
      ...(isLine ? {} : el.fillColor !== 'none' ? { fillColor: el.fillColor } : {}),
      stroke: {
        color: el.stroke.color,
        widthEmu: Math.round(el.stroke.widthPt * 12700),
      },
      ...(el.adjust ? { adjust: el.adjust } : {}),
      ...(el.paragraphs.length > 0
        ? {
            bodyPr: {
              insetsEmu: {
                l: Math.round(el.insetsPx.l * EMU),
                t: Math.round(el.insetsPx.t * EMU),
                r: Math.round(el.insetsPx.r * EMU),
                b: Math.round(el.insetsPx.b * EMU),
              },
            },
          }
        : {}),
      semanticMetadata: el.semanticMetadata,
    })
  }

  const { buildRenderSlide } = await import('@genoffice/pptx-render')
  const rendered = buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx: args.canvasW,
  })
  const render = await rasterize()
  const [png] = await render([rendered], new Map(), 1)
  return png.replace(/^data:image\/png;base64,/, '')
}

/** Strip a data URL prefix from an image for the AgentImage channel. */
export function toAgentImage(pngBase64: string): AgentImage {
  return {
    base64: pngBase64.replace(/^data:image\/png;base64,/, ''),
    mime: 'image/png',
  }
}
