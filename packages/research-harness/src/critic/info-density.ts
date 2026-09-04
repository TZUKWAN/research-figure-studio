/**
 * Information-density critic (Phase 2 of the Info-Density round): judges
 * whether the Scientific Semantic Planner unfolded real content, whether the
 * Primary Spine is reachable on the canvas, and whether the rendered
 * Connectors use natural anchors / straight / elbow paths.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { SpatialPlan } from '../composition/spatial-plan.js'
import type { SolveResult } from '../constraints/solver.js'
import type { RoutedEdge } from '../routing/router.js'
import type { Rect } from '../routing/geometry.js'
import { anchorPoint } from '../routing/router.js'

export interface ContentDensityVerdict {
  /** 0..10 — higher = more scientific content surfaced */
  density: number
  /** 0..10 — spine is geometrically traceable on the canvas */
  primaryClarity: number
  /** 0..10 — connectors use natural anchors / paths */
  connectorNaturalness: number
  notes: string[]
}

/** Count meaningful CJK / word characters in the thesis + optional material. */
function textWeight(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk++
  }
  return Math.max(cjk, text.replace(/[\s,.;:!?()[\]{}'"`·—–\\-]/g, '').length)
}

// Density is the count of meaningful scientific tokens (titles, details,
// semantic labels, edge labels) per unit canvas area, normalized so a
// well-populated figure (e.g. 9 nodes with bilingual detail + 8 edges) hits ~5.
// We reward detail because long Chinese detail strings are a strong signal of
// real scientific content unfolding — single big cards do NOT score well.

export function criticInfoDensity(input: {
  plan: FigurePlanV2
  planIntent?: SpatialPlan
  solve: SolveResult
  canvasW: number
  canvasH: number
  routed?: RoutedEdge[]
}): ContentDensityVerdict {
  const notes: string[] = []
  // --- Content density ---
  // Per-node text budget rewards "real research work": titles, semantic
  // labels, and especially detail chips add up to a per-node score; flat
  // big cards (one title only) score low.
  const nodeWeight = input.plan.nodes.reduce(
    (sum, n) =>
      sum +
      textWeight(n.semanticLabel) +
      textWeight(n.visible.title) +
      textWeight(n.visible.detail ?? '') * 2, // details weighted higher
    0,
  )
  const edgeWeight = input.plan.edges.reduce((sum, e) => sum + textWeight(e.label ?? ''), 0)
  const groupWeight = (input.plan.groups ?? []).reduce(
    (sum, g) => sum + textWeight(g.label ?? ''),
    0,
  )
  const area = input.canvasW * input.canvasH
  // Each node contributes up to ~3.5 (CJK title ~1.5 + detail ~2*0.7);
  // 9 nodes with detail ≈ 25 weight ≈ 0.025/px² normalised → ~5.5
  const density = Math.min(10, ((nodeWeight + edgeWeight + groupWeight) / area) * 12_000)
  if (density < 4) {
    notes.push(
      `content density low: ${nodeWeight + edgeWeight + groupWeight} informative tokens over ${area}px² — the model may have over-summarised`,
    )
  }
  if (input.plan.nodes.length < 3) {
    notes.push(
      `node count ${input.plan.nodes.length} appears low for ${nodeWeight + edgeWeight + groupWeight} informative tokens — planner may have over-summarised`,
    )
  }

  // --- Primary logic clarity (spine reachability) ---
  const titleToPlacement = new Map(
    input.solve.placements.map((p) => [p.id, { x: p.x, y: p.y, w: p.w, h: p.h }]),
  )
  const spine = input.plan.primarySpine ?? []
  let primaryClarity = spine.length === 0 ? 8 : 5
  if (spine.length >= 2) {
    // chain the spine titles and check each consecutive pair is reachable on
    // a single straight axis-aligned line OR the routed path keeps the spine
    // monotonically advancing without crossing
    let monotone = 0
    let total = 0
    for (let i = 0; i + 1 < spine.length; i++) {
      const a = titleToPlacement.get(
        input.plan.nodes.find((n) => n.id === spine[i])?.visible.title ?? '',
      )
      const b = titleToPlacement.get(
        input.plan.nodes.find((n) => n.id === spine[i + 1])?.visible.title ?? '',
      )
      if (!a || !b) continue
      total++
      const dx = b.x - a.x
      const dy = b.y - a.y
      const axisAligned = Math.abs(dx) < 12 || Math.abs(dy) < 12
      if (axisAligned) monotone++
    }
    primaryClarity = total === 0 ? 8 : Math.round(((monotone / total) * 6 + 4) * 10) / 10
    if (monotone < total) {
      notes.push(
        `primary spine not axis-aligned between ${total - monotone}/${total} pairs — model may have placed spine diagonally`,
      )
    }
  } else if (spine.length === 1) {
    notes.push(
      'primarySpine has only one node — consider removing the field or expanding the chain',
    )
  }

  // --- Connector naturalness ---
  let connectorNaturalness = 10
  if (input.routed && input.routed.length > 0) {
    let unnatural = 0
    for (const route of input.routed) {
      if (route.status !== 'routed' || !route.start || !route.end) continue
      const a = input.solve.placements.find((p) => p.id === route.fromId)
      const b = input.solve.placements.find((p) => p.id === route.toId)
      if (!a || !b) continue
      const sp = anchorPoint(a, route.start.side)
      const ep = anchorPoint(b, route.end.side)
      const rects: Rect = { x: a.x, y: a.y, w: a.w, h: a.h }
      const rectt: Rect = { x: b.x, y: b.y, w: b.w, h: b.h }
      const v = a.y + a.h / 2 < b.y + b.h / 2 ? 'over' : 'under'
      const h = a.x + a.w / 2 < b.x + b.w / 2 ? 'right' : 'left'
      if (v === 'over' && route.end.side === 'bottom') unnatural++
      if (v === 'over' && route.start.side === 'right') unnatural++
      if (h === 'right' && route.end.side === 'left' && route.start.side === 'right') {
        // perfect: don't penalise
      } else if (h === 'right' && route.start.side === 'left' && route.end.side === 'right') {
        unnatural++
      }
      void sp
      void ep
      void rects
      void rectt
    }
    connectorNaturalness = Math.max(0, 10 - unnatural * 1.5)
    if (unnatural > 0)
      notes.push(
        `${unnatural} connector(s) chose sides inconsistent with the spatial relation between the two nodes`,
      )
  }

  if (notes.length === 0)
    notes.push('information density and connector naturalness within target bands')
  return {
    density: Math.round(density * 10) / 10,
    primaryClarity: Math.round(primaryClarity * 10) / 10,
    connectorNaturalness: Math.round(connectorNaturalness * 10) / 10,
    notes,
  }
}
