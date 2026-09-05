/**
 * Connector Geometry v2 (Architecture gap P2).
 *
 * The Router used to throw all candidates into one bag, score by length, and
 * pick whatever won. That is exactly what produced the visible "long string
 * across the figure" artefacts. The fix is structural:
 *
 *  1. Direction FIRST: pick the dominant spatial relation between the two
 *     rects. That decides which side of each rect anchors.
 *  2. Anchor normal compliance: from a RIGHT anchor the first segment must
 *     be HORIZONTAL; from a BOTTOM anchor it must be VERTICAL; the last
 *     segment into an anchor must match its side.
 *  3. Strict straight rule: a straight connector is only legal when the
 *     two anchors are on the SAME axis (both Y for top/bottom, both X for
 *     left/right). Diagonal straight is FORBIDDEN.
 *  4. Edge priority: Primary (causal/process/...) gets a hard bend
 *     budget (max 2). Going to 3+ bends is a hard RECOMPOSE signal.
 *  5. Fan-in/fan-out: ports are spread by lane offset; a real junction is
 *     emitted for >=3 sources into the same target.
 */
import type { Pt, Rect } from './geometry.js'
import { anchorPoint, type AnchorSide } from './router.js'

export interface RouteCandidate {
  kind: 'straight' | 'elbow'
  start: AnchorSide
  end: AnchorSide
  routeY?: number
  segments: Array<{ a: Pt; b: Pt }>
  bends: number
  length: number
  cost: number
  axisAligned: boolean
  natural: boolean
  /** true when both end segments align with their anchor side normal */
  normalCompliant: boolean
}

export interface ObstacleContext {
  rects: Map<string, Rect>
  canvasW: number
  canvasH: number
  routedSegments?: Array<{ a: Pt; b: Pt; laneY?: number }>
  usedLanes?: Map<number, number>
  role: 'main' | 'feedback'
  direction: 'LR' | 'TB'
  padding?: number
  extraLanes?: number[]
  priority?: 'primary' | 'secondary' | 'feedback'
  /** for fan-in/out: index of this edge among same-target/same-source edges */
  fanIndex?: number
  fanCount?: number
  /** node importance (for anchor emphasis: side midpoint on dominant node) */
  sourceImportance?: number
  targetImportance?: number
  /** local feedback remains a loop but is not forced into page-level lanes */
  feedbackScope?: 'local' | 'peripheral'
  /** endpoint rects supply image-space context for legal local corridors */
  fromRect?: Rect
  toRect?: Rect
}

const COST = {
  nodeIntersection: Number.POSITIVE_INFINITY,
  semanticDirection: 10000,
  edgeCrossing: 120,
  sharedSegment: 90,
  bend: 6,
  length: 0.04,
  laneCrowding: 30,
  diagonalStraight: 50000, // hard forbidden: a straight route must be on one axis
  unnatural: 4000,
  bendBudgetExceeded: 6000, // strong preference, never a false infeasibility gate
  anchorNotSide: 1500, // picking a side that doesn't match the dominant direction
}

function poly(points: Pt[]): Array<{ a: Pt; b: Pt }> {
  const segs: Array<{ a: Pt; b: Pt }> = []
  for (let i = 0; i + 1 < points.length; i++) segs.push({ a: points[i]!, b: points[i + 1]! })
  return segs
}

function segIntersect(s1: { a: Pt; b: Pt }, s2: { a: Pt; b: Pt }): boolean {
  const d = (p1: Pt, p2: Pt, p3: Pt) =>
    (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  const d1 = d(s1.a, s1.b, s2.a)
  const d2 = d(s1.a, s1.b, s2.b)
  const d3 = d(s2.a, s2.b, s1.a)
  const d4 = d(s2.a, s2.b, s1.b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

function segHitsRect(a: Pt, b: Pt, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  if (maxX < rect.x || minX > rect.x + rect.w || maxY < rect.y || minY > rect.y + rect.h)
    return false
  // Endpoint anchored on the node edge: this is the legal connection site,
  // never a collision. Treat "fully on boundary" as not a hit.
  const onLeft =
    (a.x === rect.x && a.y >= rect.y && a.y <= rect.y + rect.h) ||
    (b.x === rect.x && b.y >= rect.y && b.y <= rect.y + rect.h)
  const onRight =
    (a.x === rect.x + rect.w && a.y >= rect.y && a.y <= rect.y + rect.h) ||
    (b.x === rect.x + rect.w && b.y >= rect.y && b.y <= rect.y + rect.h)
  const onTop =
    (a.y === rect.y && a.x >= rect.x && a.x <= rect.x + rect.w) ||
    (b.y === rect.y && b.x >= rect.x && b.x <= rect.x + rect.w)
  const onBottom =
    (a.y === rect.y + rect.h && a.x >= rect.x && a.x <= rect.x + rect.w) ||
    (b.y === rect.y + rect.h && b.x >= rect.x && b.x <= rect.x + rect.w)
  if (
    (a.x === b.x && (a.x === rect.x || a.x === rect.x + rect.w)) ||
    (a.y === b.y && (a.y === rect.y || a.y === rect.y + rect.h))
  ) {
    if (onLeft || onRight || onTop || onBottom) return false
  }
  if (minX >= rect.x && maxX <= rect.x + rect.w && minY >= rect.y && maxY <= rect.y + rect.h)
    return true
  const c = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ]
  for (let i = 0; i < 4; i++) {
    if (segIntersect({ a, b }, { a: c[i]!, b: c[(i + 1) % 4]! })) return true
  }
  return false
}

function pathCost(
  candidate: RouteCandidate,
  ctx: ObstacleContext,
  fromId: string,
  toId: string,
): number {
  const pad = ctx.padding ?? 8
  let cost = candidate.bends * COST.bend + candidate.length * COST.length
  if (!candidate.axisAligned) return Number.POSITIVE_INFINITY
  if (!candidate.normalCompliant) cost += COST.anchorNotSide
  if (!candidate.natural) cost += COST.unnatural
  if (ctx.priority === 'primary' && candidate.bends > 2) {
    cost += COST.bendBudgetExceeded
  }
  for (const seg of candidate.segments) {
    for (const [id, rect] of ctx.rects) {
      if (id === fromId || id === toId) continue
      const ex = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }
      if (segHitsRect(seg.a, seg.b, ex)) return Number.POSITIVE_INFINITY
    }
    for (const other of ctx.routedSegments ?? []) {
      if (segIntersect(seg, other)) cost += COST.edgeCrossing
    }
  }
  if (candidate.routeY !== undefined) {
    const claimed = ctx.usedLanes?.get(candidate.routeY) ?? 0
    cost += claimed * COST.laneCrowding
  }
  if (ctx.role === 'main' && ctx.direction === 'LR') {
    const netDx = candidate.segments.at(-1)!.b.x - candidate.segments[0]!.a.x
    if (netDx < -8) cost += COST.semanticDirection
  }
  return cost
}

function direction(from: Rect, to: Rect): 'lr' | 'rl' | 'tb' | 'bt' {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dy) > Math.abs(dx) * 1.3) return dy > 0 ? 'tb' : 'bt'
  return dx > 0 ? 'lr' : 'rl'
}

function naturalPair(dir: 'lr' | 'rl' | 'tb' | 'bt'): { start: AnchorSide; end: AnchorSide } {
  if (dir === 'lr') return { start: 'right', end: 'left' }
  if (dir === 'rl') return { start: 'left', end: 'right' }
  if (dir === 'tb') return { start: 'bottom', end: 'top' }
  return { start: 'top', end: 'bottom' }
}

function swapSide(p: { start: AnchorSide; end: AnchorSide }): {
  start: AnchorSide
  end: AnchorSide
} {
  if (p.start === 'right') return { start: 'bottom', end: 'top' }
  if (p.start === 'left') return { start: 'top', end: 'bottom' }
  if (p.start === 'bottom') return { start: 'right', end: 'left' }
  return { start: 'left', end: 'right' }
}

function fanPair(
  base: { start: AnchorSide; end: AnchorSide },
  fanIndex: number,
): { start: AnchorSide; end: AnchorSide } {
  return fanIndex % 2 === 0 ? base : swapSide(base)
}

function normalCompliant(
  start: AnchorSide,
  end: AnchorSide,
  first: { a: Pt; b: Pt },
  last: { a: Pt; b: Pt },
): boolean {
  if (start === 'right' || start === 'left') {
    if (first.a.y !== first.b.y) return false
  } else {
    if (first.a.x !== first.b.x) return false
  }
  if (end === 'right' || end === 'left') {
    if (last.a.y !== last.b.y) return false
  } else {
    if (last.a.x !== last.b.x) return false
  }
  return true
}

function buildCandidates(from: Rect, to: Rect, ctx: ObstacleContext): RouteCandidate[] {
  const cands: RouteCandidate[] = []
  // Feedback edges always go through the peripheral feedback lane; a
  // straight feedback looks like another primary edge and breaks the visual
  // grammar ("a feedback loop must be visibly different from a main flow").
  if (ctx.role === 'feedback' && ctx.feedbackScope !== 'local') {
    for (const lane of laneCandidates(ctx, 'feedback')) {
      const sL = anchorPoint(from, lane.side)
      const eL = anchorPoint(to, lane.side)
      cands.push({
        kind: 'elbow',
        start: lane.side,
        end: lane.side,
        routeY: lane.y,
        segments: poly([sL, { x: sL.x, y: lane.y }, { x: eL.x, y: lane.y }, eL]),
        bends: 2,
        length: Math.abs(lane.y - sL.y) + Math.abs(eL.x - sL.x) + Math.abs(eL.y - lane.y),
        cost: -50,
        axisAligned: true,
        natural: true,
        normalCompliant: true,
      })
    }
    return cands
  }
  const dir = direction(from, to)
  const base = naturalPair(dir)
  const pair =
    ctx.fanIndex !== undefined && ctx.fanCount !== undefined ? fanPair(base, ctx.fanIndex) : base
  const s = anchorPoint(from, pair.start)
  const e = anchorPoint(to, pair.end)
  const alignedX = Math.abs(s.y - e.y) <= 16
  const alignedY = Math.abs(s.x - e.x) <= 16
  if ((pair.start === 'right' || pair.start === 'left') && alignedX) {
    cands.push({
      kind: 'straight',
      start: pair.start,
      end: pair.end,
      segments: [{ a: s, b: e }],
      bends: 0,
      length: Math.abs(e.x - s.x),
      cost: 0,
      axisAligned: true,
      natural: true,
      normalCompliant: true,
    })
  } else if ((pair.start === 'top' || pair.start === 'bottom') && alignedY) {
    cands.push({
      kind: 'straight',
      start: pair.start,
      end: pair.end,
      segments: [{ a: s, b: e }],
      bends: 0,
      length: Math.abs(e.y - s.y),
      cost: 0,
      axisAligned: true,
      natural: true,
      normalCompliant: true,
    })
  }
  if (pair.start === 'right' || pair.start === 'left') {
    // Keep the source-normal-compliant corner preferred, but evaluate the
    // alternate corner as a safe fallback before inventing a fake route.
    for (const corner of [
      { x: e.x, y: s.y },
      { x: s.x, y: e.y },
    ]) {
      cands.push({
        kind: 'elbow',
        start: pair.start,
        end: pair.end,
        segments: poly([s, corner, e]),
        bends: 1,
        length: Math.abs(corner.x - s.x) + Math.abs(e.y - corner.y),
        cost: corner.x === e.x ? 0 : 12,
        axisAligned: true,
        natural: corner.x === e.x,
        normalCompliant: normalCompliant(
          pair.start,
          pair.end,
          { a: s, b: corner },
          { a: corner, b: e },
        ),
      })
    }
  } else {
    for (const corner of [
      { x: s.x, y: e.y },
      { x: e.x, y: s.y },
    ]) {
      cands.push({
        kind: 'elbow',
        start: pair.start,
        end: pair.end,
        segments: poly([s, corner, e]),
        bends: 1,
        length: Math.abs(corner.y - s.y) + Math.abs(e.x - corner.x),
        cost: corner.y === e.y ? 0 : 12,
        axisAligned: true,
        natural: corner.y === e.y,
        normalCompliant: normalCompliant(
          pair.start,
          pair.end,
          { a: s, b: corner },
          { a: corner, b: e },
        ),
      })
    }
  }
  if (pair.start === 'right' || pair.start === 'left') {
    const midX = (s.x + e.x) / 2
    cands.push({
      kind: 'elbow',
      start: pair.start,
      end: pair.end,
      segments: poly([s, { x: midX, y: s.y }, { x: midX, y: e.y }, e]),
      bends: 2,
      length: Math.abs(midX - s.x) + Math.abs(e.y - s.y) + Math.abs(e.x - midX),
      cost: 0,
      axisAligned: true,
      natural: true,
      normalCompliant: true,
    })
  } else {
    const midY = (s.y + e.y) / 2
    cands.push({
      kind: 'elbow',
      start: pair.start,
      end: pair.end,
      segments: poly([s, { x: s.x, y: midY }, { x: e.x, y: midY }, e]),
      bends: 2,
      length: Math.abs(s.x - e.x) + Math.abs(midY - s.y) + Math.abs(e.y - midY),
      cost: 0,
      axisAligned: true,
      natural: true,
      normalCompliant: true,
    })
  }
  for (const lane of laneCandidates(ctx, ctx.role)) {
    const sL = anchorPoint(from, lane.side)
    const eL = anchorPoint(to, lane.side)
    cands.push({
      kind: 'elbow',
      start: lane.side,
      end: lane.side,
      routeY: lane.y,
      segments: poly([sL, { x: sL.x, y: lane.y }, { x: eL.x, y: lane.y }, eL]),
      bends: 2,
      length: Math.abs(lane.y - sL.y) + Math.abs(eL.x - sL.x) + Math.abs(eL.y - lane.y),
      cost: lane.side === 'bottom' ? -10 : 0,
      axisAligned: true,
      natural: false,
      normalCompliant: true,
    })
  }
  return cands
}

interface LaneSpec {
  y: number
  side: AnchorSide
}

function laneCandidates(ctx: ObstacleContext, role: 'main' | 'feedback'): LaneSpec[] {
  const lanes: LaneSpec[] = []
  const bottom = ctx.canvasH - Math.round(ctx.canvasH * 0.06)
  const top = Math.round(ctx.canvasH * 0.06)
  if (role === 'feedback') {
    lanes.push({ y: bottom, side: 'bottom' })
    lanes.push({ y: top, side: 'top' })
  } else {
    lanes.push({ y: top, side: 'top' })
    lanes.push({ y: bottom, side: 'bottom' })
  }
  const from = ctx.fromRect
  const to = ctx.toRect
  if (from && to) {
    const margin = Math.max(28, (ctx.padding ?? 8) * 3)
    const candidates = [
      Math.min(from.y, to.y) - margin,
      Math.max(from.y + from.h, to.y + to.h) + margin,
      (Math.max(from.y, to.y) + Math.min(from.y + from.h, to.y + to.h)) / 2,
    ].map((y) => Math.round(Math.max(top + 8, Math.min(bottom - 8, y))))
    for (const y of new Set(candidates)) lanes.push({ y, side: 'bottom' })
  }
  for (const y of ctx.extraLanes ?? []) lanes.push({ y, side: 'bottom' })
  return lanes
}

export function routeOrthogonal(
  from: Rect,
  to: Rect,
  fromId: string,
  toId: string,
  ctx: ObstacleContext,
): RouteCandidate | null {
  const candidates = buildCandidates(from, to, ctx)
  // Page-level feedback is visually distinct on a peripheral lane; a
  // designer-declared local loop is allowed to use the normal candidate set.
  if (ctx.role === 'feedback' && ctx.feedbackScope !== 'local') {
    const laneCandidates = candidates.filter((c) => c.routeY !== undefined)
    if (laneCandidates.length > 0) {
      const ranked = laneCandidates
        .map((c) => ({ c, cost: pathCost(c, ctx, fromId, toId) }))
        .filter(({ cost }) => cost !== Number.POSITIVE_INFINITY)
        .sort((a, b) => a.cost - b.cost)
      if (ranked.length > 0) {
        const top = ranked[0]!
        return { ...top.c, cost: top.cost }
      }
    }
  }
  let best: RouteCandidate | null = null
  for (const candidate of candidates) {
    const cost = pathCost(candidate, ctx, fromId, toId)
    if (cost === Number.POSITIVE_INFINITY) continue
    if (!best || cost < best.cost) best = { ...candidate, cost }
  }
  if (best) return best
  return null
}
