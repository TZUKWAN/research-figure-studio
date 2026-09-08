/**
 * Vision candidate review (P1-1, production closure 2) — renderer-side wiring.
 *
 * Converts an orchestrator CompositionCandidate into an off-screen preview
 * slide (macro boxes + titles at the candidate's solved geometry), rasterizes
 * it through the existing Konva export path, and runs the vision rubric over
 * the screenshot through the multimodal runLlm channel. Both functions are
 * injected into orchestrateFigure so candidate SELECTION — not post-hoc
 * review — is what vision participates in.
 */
import type { CompositionCandidate } from '@genoffice/research-harness'
import type { RenderSlide, ShapeRenderNode } from '@genoffice/pptx-render'
// Konva is imported LAZILY: static import would pull node-canvas into every jsdom test
type RenderSlidesFn = (slides: RenderSlide[], images: Map<string, HTMLImageElement>, pixelRatio?: number) => Promise<string[]>
let renderSlidesToPngBase64: RenderSlidesFn | null = null
async function rasterize(): Promise<RenderSlidesFn> {
  if (!renderSlidesToPngBase64) {
    const mod = await import('../export-render')
    renderSlidesToPngBase64 = mod.renderSlidesToPngBase64 as RenderSlidesFn
  }
  return renderSlidesToPngBase64
}
import type { AgentImage } from '@genoffice/agent-core'

/** Build a preview RenderSlide from a candidate's solved macro geometry. */
export function buildCandidatePreviewSlide(
  candidate: CompositionCandidate,
  planNodes: Array<{ id: string; visible: { title: string } }>,
  canvasW: number,
  canvasH: number,
): RenderSlide {
  const titleById = new Map(planNodes.map((node) => [node.id, node.visible.title]))
  const nodes: ShapeRenderNode[] = candidate.solve.placements.map((placement, index) => {
    const dominant = placement.w * placement.h >= 0.06 * canvasW * canvasH
    return {
      id: `pv_${index}`,
      sourceId: `preview:${placement.id}`,
      type: 'shape',
      box: { x: placement.x, y: placement.y, w: placement.w, h: placement.h, rot: 0 },
      shapePath: undefined,
      background: false,
      fill: { kind: 'solid', color: dominant ? '#B23A48' : '#E8EEF4' },
      stroke: { color: '#263746', width: 1 },
      semanticMetadata: { semanticNodeId: placement.id },
      text: placement.id
        ? {
            insets: { l: 6, t: 4, r: 6, b: 4 },
            contentHeight: 18,
            lines: [
              {
                runs: [
                  {
                    text: titleById.get(placement.id) ?? placement.id,
                    x: placement.x + 6,
                    widthPx: Math.max(10, placement.w - 12),
                    fontSizePx: dominant ? 18 : 13,
                    bold: dominant,
                    color: dominant ? '#FFFFFF' : '#18212B',
                  },
                ],
              },
            ],
          }
        : undefined,
    } as unknown as ShapeRenderNode
  })
  return {
    widthPx: canvasW,
    heightPx: canvasH,
    scale: 1,
    background: { kind: 'solid', color: '#FFFFFF' },
    nodes,
  }
}

/** Rasterize one candidate's preview slide to raw base64 PNG. */
export async function renderCandidatePreview(
  candidate: CompositionCandidate,
  planNodes: Array<{ id: string; visible: { title: string } }>,
  canvasW: number,
  canvasH: number,
): Promise<string> {
  const slide = buildCandidatePreviewSlide(candidate, planNodes, canvasW, canvasH)
  const render = await rasterize()
  const [png] = await render([slide], new Map(), 1)
  // AgentImage wants raw base64 without the data: URL prefix
  return png.replace(/^data:image\/png;base64,/, '')
}

/** Strip a data URL prefix from an image for the AgentImage channel. */
export function toAgentImage(pngBase64: string): AgentImage {
  return {
    base64: pngBase64.replace(/^data:image\/png;base64,/, ''),
    mime: 'image/png',
  }
}
