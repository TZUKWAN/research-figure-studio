/**
 * Horizontal Pipeline recipe: one ordered row of research components with
 * deterministic spacing and main-flow connectors.
 */

import { getComponentSpec, resolveSize } from '../components/registry.js'
import { endpointTable, resolveEdge } from '../semantic/schema.js'
import type {
  ConnectorRoute,
  ElementPlacement,
  IceEdgeInput,
  PlanNode,
} from './input-core-output.js'

export interface HorizontalPipelineInput {
  nodes: PlanNode[]
  /**
   * Explicit semantic edges; the ONLY source of connector topology. An empty
   * list yields zero connectors — never an implicit adjacent-pair chain.
   */
  edges?: IceEdgeInput[]
  canvasW: number
  canvasH: number
  gapPx?: number
  marginPx?: number
}

export interface HorizontalPipelineLayout {
  elements: ElementPlacement[]
  connectors: ConnectorRoute[]
  regions: {
    pipeline: { x: number; y: number; w: number; h: number }
  }
}

const MARGIN_FRAC = 0.06
const GAP_FRAC = 0.025
const MIN_GAP_PX = 24

export function layoutHorizontalPipeline(input: HorizontalPipelineInput): HorizontalPipelineLayout {
  const margin = input.marginPx ?? Math.round(input.canvasW * MARGIN_FRAC)
  const gap = input.gapPx ?? Math.max(MIN_GAP_PX, Math.round(input.canvasW * GAP_FRAC))
  const sizes = input.nodes.map((node) => resolveSize(node.component, input.canvasW, input.canvasH))
  const totalW = sizes.reduce((sum, size) => sum + size.w, 0) + gap * Math.max(0, sizes.length - 1)
  if (totalW > input.canvasW - margin * 2) {
    throw new Error(
      `Horizontal Pipeline needs ${totalW}px but only ${Math.max(0, input.canvasW - margin * 2)}px is available; reduce nodes or use a wider canvas.`,
    )
  }

  const maxH = sizes.reduce((max, size) => Math.max(max, size.h), 0)
  const elements: ElementPlacement[] = []
  let x = margin
  for (let i = 0; i < input.nodes.length; i++) {
    const node = input.nodes[i]!
    const size = sizes[i]!
    const spec = getComponentSpec(node.component)
    const y = Math.round((input.canvasH - maxH) / 2 + (maxH - size.h) / 2)
    elements.push({
      component: node.component,
      title: node.title,
      ...(node.subtitle ? { subtitle: node.subtitle } : {}),
      x,
      y,
      w: size.w,
      h: size.h,
      preset: spec.preset,
      titleFontPt: spec.titleFontPt,
      bodyFontPt: spec.bodyFontPt,
    })
    x += size.w + gap
  }

  const table = endpointTable(
    elements.map((element, index) => ({ ref: element.title, indices: [index] })),
  )
  const connectors: ConnectorRoute[] = []
  for (const edge of input.edges ?? []) {
    if (!table.byRef.has(edge.from) || !table.byRef.has(edge.to)) {
      throw new Error(
        `Edge reference "${edge.from} -> ${edge.to}" does not match any node title in this pipeline`,
      )
    }
    for (const pair of resolveEdge(edge, table, table)) {
      connectors.push({
        fromIndex: pair.fromIndex,
        toIndex: pair.toIndex,
        kind: pair.role === 'feedback' ? 'elbow' : 'straight',
        role: pair.role,
        relation: pair.relation,
        ...(pair.label ? { label: pair.label } : {}),
      })
    }
  }

  return {
    elements,
    connectors,
    regions: {
      pipeline: {
        x: margin,
        y: Math.round((input.canvasH - maxH) / 2),
        w: input.canvasW - margin * 2,
        h: maxH,
      },
    },
  }
}
