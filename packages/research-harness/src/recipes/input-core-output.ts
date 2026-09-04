/**
 * Input-Core-Output layout recipe.
 *
 * Pure geometry: consumes a FigurePlan fragment + canvas size, emits absolute
 * element placements and connector routes. No Electron, no LLM — fully unit
 * testable. The agent tool layer (slides-skill) executes the emitted ops.
 */

import { getComponentSpec, resolveSize } from '../components/registry.js'
import {
  endpointTable,
  resolveEdge,
  type EndpointTable,
  type RelationType,
} from '../semantic/schema.js'

export interface PlanNode {
  /** registry kind, e.g. 'data-source' | 'mechanism-module' | 'output-node' */
  component: string
  title: string
  subtitle?: string
}

/** A planner-declared relationship. The ONLY source of connector topology. */
export interface IceEdgeInput {
  from: string
  to: string
  role: 'main' | 'feedback'
  relation?: string
  label?: string
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
  /** Absolute slide-space y coordinate reserved for the feedback elbow. */
  laneY?: number
  relation?: RelationType
  label?: string
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
  /**
   * Explicit semantic edges. Connectors come EXCLUSIVELY from this list —
   * a missing/empty list yields zero connectors, never an implicit chain.
   * Endpoint refs name a node title or a zone role ('input'|'core'|'output');
   * zone refs expand to every member (explicit group semantics).
   */
  edges?: IceEdgeInput[]
  /** @deprecated no longer creates a connector; feedback must be an explicit edge */
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
  canvasW: number,
  canvasH: number,
  marginY: number,
): ElementPlacement[] {
  if (nodes.length === 0) return []
  const placements: ElementPlacement[] = []
  const totalH = nodes.reduce((acc, n) => acc + resolveSize(n.component, canvasW, canvasH).h, 0)
  const gap =
    nodes.length > 1 ? Math.max(12, (canvasH - 2 * marginY - totalH) / (nodes.length - 1)) : 0
  let y = canvasH / 2 - (totalH + gap * (nodes.length - 1)) / 2
  for (const n of nodes) {
    const { w, h } = resolveSize(n.component, canvasW, canvasH)
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

  const inputEls = placeZone(input.inputNodes, marginX, wIn, W, H, marginY)
  const coreEls = placeZone(input.coreNodes, marginX + wIn + gap, wCore, W, H, marginY)
  const outputEls = placeZone(
    input.outputNodes,
    marginX + wIn + gap + wCore + gap,
    wOut,
    W,
    H,
    marginY,
  )
  const elements = [...inputEls, ...coreEls, ...outputEls]

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

  // Connector topology: exclusively from the declared semantic edges. Region
  // refs ('input'/'core'/'output') resolve to every zone member — explicit
  // group semantics, never positional order.
  const table: EndpointTable = endpointTable([
    ...elements.map((element, index) => ({ ref: element.title, indices: [index] })),
    { ref: 'input', indices: inputEls.map((_, index) => index) },
    { ref: 'core', indices: coreEls.map((_, index) => inputEls.length + index) },
    {
      ref: 'output',
      indices: outputEls.map((_, index) => inputEls.length + coreEls.length + index),
    },
  ])
  const connectors: ConnectorRoute[] = []
  let laneY: number | undefined
  for (const edge of input.edges ?? []) {
    if (!table.byRef.has(edge.from) || !table.byRef.has(edge.to)) {
      throw new Error(
        `Edge reference "${edge.from} -> ${edge.to}" does not match any node title or zone (input/core/output) in this figure`,
      )
    }
    for (const pair of resolveEdge(edge, table, table)) {
      const isFeedback = pair.role === 'feedback'
      if (isFeedback && laneY === undefined) {
        laneY = Math.round(H - marginY * 0.4)
        regions.feedbackLaneY = laneY
      }
      connectors.push({
        fromIndex: pair.fromIndex,
        toIndex: pair.toIndex,
        kind: isFeedback ? 'elbow' : 'straight',
        role: pair.role,
        relation: pair.relation,
        ...(pair.label ? { label: pair.label } : {}),
        ...(isFeedback && laneY !== undefined ? { laneY } : {}),
      })
    }
  }

  return { elements, connectors, regions }
}
