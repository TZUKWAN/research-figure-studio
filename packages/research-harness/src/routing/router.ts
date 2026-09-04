/**
 * Native Connector Router (Phase 5). Two phases kept separate:
 *  A) Anchor assignment — semantic direction + reading flow decide sides.
 *  B) Path routing — straight when aligned, native elbow otherwise; feedback
 *     takes the peripheral lane. Port occupancy spreads parallel connectors.
 *
 * Anchor idx values match the existing PowerPoint binding channel
 * (editConnectorEndpoints): 0=top, 1=left, 2=bottom, 3=right.
 */
import type { Rect } from './geometry.js'
import type { RelationPresentation } from '../semantic/schema.js'
import { routeOrthogonal } from './orthogonal.js'

export type AnchorSide = 'top' | 'left' | 'bottom' | 'right'

export const ANCHOR_IDX: Record<AnchorSide, number> = { top: 0, left: 1, bottom: 2, right: 3 }

export interface RoutedEdgeInput {
  key: string
  semanticEdgeId?: string
  fromId: string
  toId: string
  role: 'main' | 'feedback'
  relation: string
  presentation?: RelationPresentation
  priority?: 'primary' | 'secondary' | 'feedback'
  /** a local loop is deliberately different from a figure-wide feedback lane */
  feedbackScope?: 'local' | 'peripheral'
}

export type RouteStatus = 'routed' | 'suppressed' | 'unroutable'

export interface RoutedEdge {
  key: string
  semanticEdgeId?: string
  fromId: string
  toId: string
  role: 'main' | 'feedback'
  relation: string
  presentation?: RelationPresentation
  status: RouteStatus
  kind?: 'straight' | 'elbow'
  start?: { side: AnchorSide; idx: number }
  end?: { side: AnchorSide; idx: number }
  /** px offset applied to shared lanes so parallel connectors don't overlap */
  laneOffsetPx: number
  /** absolute lane y for 2-bend routes (rendered via bentConnector3 routeYPx) */
  routeY?: number
  diagnostic?: string
}

/**
 * Greedy joint routing with obstacle avoidance (P0): main edges first, each
 * edge scored over candidates (direct / 1-bend / lane 2-bend) against node
 * exclusion zones, already-routed segments and lane crowding.
 */
export function routeEdgesWithObstacles(
  edges: RoutedEdgeInput[],
  rects: Map<string, Rect>,
  canvas: { w: number; h: number },
  direction: 'LR' | 'TB' = 'LR',
  extraLanes?: number[],
): RoutedEdge[] {
  const routedSegments: Array<{
    a: { x: number; y: number }
    b: { x: number; y: number }
    laneY?: number
  }> = []
  const usedLanes = new Map<number, number>()
  const out: RoutedEdge[] = []
  for (const edge of edges) {
    const from = rects.get(edge.fromId)
    const to = rects.get(edge.toId)
    if (!from || !to) {
      out.push({
        key: edge.key,
        ...(edge.semanticEdgeId ? { semanticEdgeId: edge.semanticEdgeId } : {}),
        fromId: edge.fromId,
        toId: edge.toId,
        role: edge.role,
        relation: edge.relation,
        ...(edge.presentation ? { presentation: edge.presentation } : {}),
        status: 'unroutable',
        laneOffsetPx: 0,
        diagnostic: `unresolved endpoint: ${edge.fromId} -> ${edge.toId}`,
      })
      continue
    }
    // Detect fan-in/out for this target so the Router can spread ports
    // (avoiding the "all lines stacked at the same anchor" problem).
    let fanIndex: number | undefined
    let fanCount: number | undefined
    if (edge.role === 'main') {
      const group = edges.filter((e) => e.toId === edge.toId && e.role === 'main')
      if (group.length > 1) {
        fanIndex = group.findIndex((e) => e.key === edge.key)
        fanCount = group.length
      }
    }
    const cand = routeOrthogonal(from, to, edge.fromId, edge.toId, {
      rects,
      canvasW: canvas.w,
      canvasH: canvas.h,
      routedSegments,
      usedLanes,
      role: edge.role,
      direction,
      extraLanes,
      priority: edge.priority ?? 'secondary',
      fromRect: from,
      toRect: to,
      ...(edge.feedbackScope ? { feedbackScope: edge.feedbackScope } : {}),
      ...(fanIndex !== undefined ? { fanIndex } : {}),
      ...(fanCount !== undefined ? { fanCount } : {}),
    })
    if (!cand) {
      out.push({
        key: edge.key,
        ...(edge.semanticEdgeId ? { semanticEdgeId: edge.semanticEdgeId } : {}),
        fromId: edge.fromId,
        toId: edge.toId,
        role: edge.role,
        relation: edge.relation,
        ...(edge.presentation ? { presentation: edge.presentation } : {}),
        status: 'unroutable',
        laneOffsetPx: 0,
        diagnostic: 'no legal orthogonal route',
      })
      continue
    }
    for (const seg of cand.segments) {
      routedSegments.push({ a: seg.a, b: seg.b, laneY: cand.routeY })
    }
    if (cand.routeY !== undefined) {
      usedLanes.set(cand.routeY, (usedLanes.get(cand.routeY) ?? 0) + 1)
    }
    out.push({
      key: edge.key,
      ...(edge.semanticEdgeId ? { semanticEdgeId: edge.semanticEdgeId } : {}),
      fromId: edge.fromId,
      toId: edge.toId,
      role: edge.role,
      relation: edge.relation,
      ...(edge.presentation ? { presentation: edge.presentation } : {}),
      kind: cand.kind,
      start: { side: cand.start, idx: ANCHOR_IDX[cand.start] },
      end: { side: cand.end, idx: ANCHOR_IDX[cand.end] },
      status: 'routed',
      laneOffsetPx: 0,
      ...(cand.routeY !== undefined ? { routeY: cand.routeY } : {}),
    })
  }
  return out
}

export function anchorPoint(rect: Rect, side: AnchorSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w / 2, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h }
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2 }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }
}

/**
 * Anchor assignment: semantic direction first (LR flow prefers source.right →
 * target.left even when bottom→top is geometrically shorter), vertical flow
 * when the pair is vertically stacked.
 */
export function assignAnchors(
  from: Rect,
  to: Rect,
  role: 'main' | 'feedback',
): { start: AnchorSide; end: AnchorSide } {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (role === 'feedback') {
    // peripheral lane: exit bottom, enter bottom of the target region
    return { start: 'bottom', end: 'bottom' }
  }
  if (Math.abs(dy) > Math.abs(dx) * 1.4) {
    return dy > 0 ? { start: 'bottom', end: 'top' } : { start: 'top', end: 'bottom' }
  }
  return dx >= 0 ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' }
}

/**
 * Route a list of semantic edges: anchors + path kind + lane offsets. Feedback
 * edges become elbows; main edges stay straight when their anchor sides face
 * each other cleanly (alignment within 60% of the smaller node dimension).
 */
export function routeEdges(edges: RoutedEdgeInput[], rects: Map<string, Rect>): RoutedEdge[] {
  const usage = new Map<string, number>()
  return edges.map((edge) => {
    const from = rects.get(edge.fromId)
    const to = rects.get(edge.toId)
    if (!from || !to) {
      return {
        key: edge.key,
        ...(edge.semanticEdgeId ? { semanticEdgeId: edge.semanticEdgeId } : {}),
        fromId: edge.fromId,
        toId: edge.toId,
        role: edge.role,
        relation: edge.relation,
        ...(edge.presentation ? { presentation: edge.presentation } : {}),
        status: 'unroutable' as const,
        kind: 'straight' as const,
        start: { side: 'right' as AnchorSide, idx: ANCHOR_IDX.right },
        end: { side: 'left' as AnchorSide, idx: ANCHOR_IDX.left },
        laneOffsetPx: 0,
        diagnostic: `unresolved endpoint: ${edge.fromId} -> ${edge.toId}`,
      }
    }
    const sides = assignAnchors(from, to, edge.role)
    const laneKey = `${edge.fromId}|${edge.toId}|${sides.start}`
    const offset = (usage.get(laneKey) ?? 0) * 12
    usage.set(laneKey, (usage.get(laneKey) ?? 0) + 1)
    const startPt = anchorPoint(from, sides.start)
    const endPt = anchorPoint(to, sides.end)
    const aligned =
      sides.start === 'right' || sides.start === 'left'
        ? Math.abs(startPt.y - endPt.y) <= Math.min(from.h, to.h) * 0.6
        : Math.abs(startPt.x - endPt.x) <= Math.min(from.w, to.w) * 0.6
    const kind: 'straight' | 'elbow' =
      edge.role === 'feedback' ? 'elbow' : aligned ? 'straight' : 'elbow'
    return {
      key: edge.key,
      ...(edge.semanticEdgeId ? { semanticEdgeId: edge.semanticEdgeId } : {}),
      fromId: edge.fromId,
      toId: edge.toId,
      role: edge.role,
      relation: edge.relation,
      ...(edge.presentation ? { presentation: edge.presentation } : {}),
      status: 'routed',
      kind,
      start: { side: sides.start, idx: ANCHOR_IDX[sides.start] },
      end: { side: sides.end, idx: ANCHOR_IDX[sides.end] },
      laneOffsetPx: offset,
    }
  })
}

/** Deterministic edge-crossing count over routed main connectors. */
export function edgeCrossingCount(edges: RoutedEdgeInput[], rects: Map<string, Rect>): number {
  const segments = edges
    .filter((edge) => edge.role === 'main')
    .map((edge) => {
      const from = rects.get(edge.fromId)
      const to = rects.get(edge.toId)
      if (!from || !to) return null
      const sides = assignAnchors(from, to, edge.role)
      const a = anchorPoint(from, sides.start)
      const b = anchorPoint(to, sides.end)
      return { a, b, key: edge.key }
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null)
  let crossings = 0
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segmentsIntersect(segments[i]!, segments[j]!)) crossings++
    }
  }
  return crossings
}

function segmentsIntersect(
  s1: { a: { x: number; y: number }; b: { x: number; y: number } },
  s2: { a: { x: number; y: number }; b: { x: number; y: number } },
): boolean {
  const shared = new Set([s1.a, s1.b, s2.a, s2.b])
  if (shared.size < 4) {
    // share an endpoint → not counted as a crossing
    const keys1 = new Set([JSON.stringify(s1.a), JSON.stringify(s1.b)])
    const keys2 = new Set([JSON.stringify(s2.a), JSON.stringify(s2.b)])
    for (const key of keys1) if (keys2.has(key)) return false
  }
  const d = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
  ) => (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  const d1 = d(s1.a, s1.b, s2.a)
  const d2 = d(s1.a, s1.b, s2.b)
  const d3 = d(s2.a, s2.b, s1.a)
  const d4 = d(s2.a, s2.b, s1.b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Count routed segments passing through a foreign node's exclusion bounds. */
export function connectorNodeIntersections(
  edges: RoutedEdgeInput[],
  rects: Map<string, Rect>,
  padding = 8,
): Array<{ key: string; nodeId: string }> {
  const hits: Array<{ key: string; nodeId: string }> = []
  for (const edge of edges) {
    const from = rects.get(edge.fromId)
    const to = rects.get(edge.toId)
    if (!from || !to) continue
    const sides = assignAnchors(from, to, edge.role)
    const a = anchorPoint(from, sides.start)
    const b = anchorPoint(to, sides.end)
    for (const [id, rect] of rects) {
      if (id === edge.fromId || id === edge.toId) continue
      const ex = {
        x: rect.x - padding,
        y: rect.y - padding,
        w: rect.w + padding * 2,
        h: rect.h + padding * 2,
      }
      if (segmentHitsRect(a, b, ex)) hits.push({ key: edge.key, nodeId: id })
    }
  }
  return hits
}

function segmentHitsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: Rect,
): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  if (maxX < rect.x || minX > rect.x + rect.w || maxY < rect.y || minY > rect.y + rect.h) {
    return false
  }
  if (minX >= rect.x && maxX <= rect.x + rect.w && minY >= rect.y && maxY <= rect.y + rect.h) {
    return true
  }
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ]
  for (let i = 0; i < 4; i++) {
    const edge = { a: corners[i]!, b: corners[(i + 1) % 4]! }
    if (segmentsIntersect({ a, b }, edge)) {
      return true
    }
  }
  return false
}
