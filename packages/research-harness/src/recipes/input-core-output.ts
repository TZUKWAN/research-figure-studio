/**
 * Input-Core-Output layout recipe.
 *
 * Pure geometry: consumes a FigurePlan fragment + canvas size, emits absolute
 * element placements and connector routes. No Electron, no LLM — fully unit
 * testable. The agent tool layer (slides-skill) executes the emitted ops.
 */

import { getComponentSpec, resolveSize } from '../components/registry.js'

export interface PlanNode {
  /** registry kind, e.g. 'data-source' | 'mechanism-module' | 'output-node' */
  component: string
  title: string
  subtitle?: string
}

export interface ElementPlacement {
  component: string
  title: string
  subtitle?: string
  x: number
  y: number
  w: number
  h: number
  preset: string
  titleFontPt: number
  bodyFontPt: number
}

export interface ConnectorRoute {
  fromIndex: number
  toIndex: number
  kind: 'straight' | 'elbow' | 'curved'
  role: 'main' | 'feedback'
}

export interface IceLayout {
  elements: ElementPlacement[]
  connectors: ConnectorRoute[]
  /** semantic regions for audit + selection tooling */
  regions: {
    input: { x: number; y: number; w: number; h: number }
    core: { x: number; y: number; w: number; h: number }
    output: { x: number; y: number; w: number; h: number }
    feedbackLaneY?: number
  }
}

export interface IceInput {
  inputNodes: PlanNode[]
  coreNodes: PlanNode[]
  outputNodes: PlanNode[]
  /** draw a bottom feedback loop from last output back to first core/input */
  feedback?: boolean
  canvasW: number
  canvasH: number
}

const MARGIN_X_FRAC = 0.06
const MARGIN_Y_FRAC = 0.1
const ZONE_GAP_FRAC = 0.03

function placeZone(
  nodes: PlanNode[],
  zoneX: number,
  zoneW: number,
  canvasH: number,
  marginY: number,
): ElementPlacement[] {
  if (nodes.length === 0) return []
  const placements: ElementPlacement[] = []
  const totalH = nodes.reduce((acc, n) => acc + resolveSize(n.component, zoneW, canvasH).h, 0)
  const gap =
    nodes.length > 1
      ? Math.max(12, (canvasH - 2 * marginY - totalH) / (nodes.length - 1))
      : 0
  let y = canvasH / 2 - (totalH + gap * (nodes.length - 1)) / 2
  for (const n of nodes) {
    const { w, h } = resolveSize(n.component, zoneW, canvasH)
    const spec = getComponentSpec(n.component)
    placements.push({
      component: n.component,
      title: n.title,
      ...(n.subtitle ? { subtitle: n.subtitle } : {}),
      x: Math.round(zoneX + (zoneW - w) / 2),
      y: Math.round(y),
      w,
      h,
      preset: spec.preset,
      titleFontPt: spec.titleFontPt,
      bodyFontPt: spec.bodyFontPt,
    })
    y += h + gap
  }
  return placements
}

/**
 * Horizontal three-zone layout: input | core | output, vertically centered per
 * zone, equal gaps inside a zone, main-flow connectors between consecutive
 * placements, optional feedback lane along the bottom.
 */
export function layoutInputCoreOutput(input: IceInput): IceLayout {
  const W = input.canvasW
  const H = input.canvasH
  const marginX = Math.round(W * MARGIN_X_FRAC)
  const marginY = Math.round(H * MARGIN_Y_FRAC)
  const gap = Math.round(W * ZONE_GAP_FRAC)
  const usable = W - 2 * marginX - 2 * gap
  const wIn = Math.round(usable * 0.24)
  const wCore = Math.round(usable * 0.46)
  const wOut = usable - wIn - wCore

  const inputEls = placeZone(input.inputNodes, marginX, wIn, H, marginY)
  const coreEls = placeZone(input.coreNodes, marginX + wIn + gap, wCore, H, marginY)
  const outputEls = placeZone(
    input.outputNodes,
    marginX + wIn + gap + wCore + gap,
    wOut,
    H,
    marginY,
  )
  const elements = [...inputEls, ...coreEls, ...outputEls]

  const connectors: ConnectorRoute[] = []
  const seq = [...inputEls, ...coreEls, ...outputEls]
  for (let i = 0; i < seq.length - 1; i++) {
    connectors.push({ fromIndex: i, toIndex: i + 1, kind: 'straight', role: 'main' })
  }

  const regions: IceLayout['regions'] = {
    input: { x: marginX, y: marginY, w: wIn, h: H - 2 * marginY },
    core: { x: marginX + wIn + gap, y: marginY, w: wCore, h: H - 2 * marginY },
    output: {
      x: marginX + wIn + gap + wCore + gap,
      y: marginY,
      w: wOut,
      h: H - 2 * marginY,
    },
  }

  if (input.feedback && outputEls.length > 0 && coreEls.length > 0) {
    const laneY = Math.round(H - marginY * 0.4)
    regions.feedbackLaneY = laneY
    const lastOut = elements.length - 1
    const firstCore = inputEls.length
    connectors.push({
      fromIndex: lastOut,
      toIndex: firstCore,
      kind: 'elbow',
      role: 'feedback',
    })
    void laneY // consumed by executor when routing the elbow below the zones
  }

  return { elements, connectors, regions }
}
