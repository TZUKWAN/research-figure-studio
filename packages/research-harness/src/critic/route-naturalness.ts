/**
 * Direction-independent connector naturalness (QA-P0-10). Replaces the
 * LR-specific over/under + right/left side heuristics: the expected exit and
 * entry sides follow from the from→to vector, and path quality is judged by
 * bend count, detour ratio and backtracking — all orientation-free.
 */
import type { Rect, Segment, Pt } from '../routing/geometry.js'
import { polylineLength } from '../routing/geometry.js'
import type { AnchorSide, RoutedEdge } from '../routing/router.js'

export interface NaturalnessVerdict {
  /** 0–10 */
  score: number
  /** machine-readable reasons, for diagnostics rather than string-matching */
  issues: Array<'exit-side' | 'entry-side' | 'detour' | 'backtrack' | 'bends'>
}

const OPPOSITE: Record<AnchorSide, AnchorSide> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
}

/** Side of `rect` facing the point `t`. */
export function sideFacing(rect: Rect, t: Pt): AnchorSide {
  const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  const dx = t.x - c.x
  const dy = t.y - c.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

function segmentDirection(seg: Segment): AnchorSide {
  const dx = seg.b.x - seg.a.x
  const dy = seg.b.y - seg.a.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

export function routeNaturalness(
  route: RoutedEdge,
  segments: Segment[],
  from: Rect,
  to: Rect,
): NaturalnessVerdict {
  const issues: NaturalnessVerdict['issues'] = []
  if (segments.length === 0) return { score: 10, issues }
  // expected exit = side of `from` facing `to`; expected entry = opposite side of `to`
  const exit = sideFacing(from, { x: to.x + to.w / 2, y: to.y + to.h / 2 })
  const entry = OPPOSITE[exit]
  const firstDir = segmentDirection(segments[0]!)
  if (firstDir !== route.start?.side && firstDir !== exit) issues.push('exit-side')
  // for a single straight segment the exit direction IS the entry direction
  if (segments.length > 1) {
    const lastDir = segmentDirection(segments[segments.length - 1]!)
    if (lastDir !== entry) issues.push('entry-side')
  }

  // detour ratio: polyline length vs straight centre-to-centre distance
  const straight = Math.max(
    1,
    Math.hypot(to.x + to.w / 2 - (from.x + from.w / 2), to.y + to.h / 2 - (from.y + from.h / 2)),
  )
  const detour = polylineLength(segments.flatMap((s) => [s.a, s.b])) / straight
  if (detour > 3) issues.push('detour')

  // backtracking: a segment that moves against the net axis of the route
  const netX = to.x + to.w / 2 - (from.x + from.w / 2)
  const netY = to.y + to.h / 2 - (from.y + from.h / 2)
  for (const seg of segments) {
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    if (Math.abs(dx) > 1 && dx * netX < -1 && Math.abs(dx) > Math.abs(netX) * 0.4)
      issues.push('backtrack')
    if (Math.abs(dy) > 1 && dy * netY < -1 && Math.abs(dy) > Math.abs(netY) * 0.4)
      issues.push('backtrack')
  }
  if (segments.length - 1 >= 3) issues.push('bends')

  const penalty =
    issues.filter((i) => i === 'exit-side' || i === 'entry-side').length * 1.5 +
    issues.filter((i) => i === 'backtrack').length * 1.0 +
    (issues.includes('detour') ? 1.5 : 0) +
    (issues.includes('bends') ? 1.0 : 0)
  return { score: Math.max(0, 10 - penalty), issues }
}
