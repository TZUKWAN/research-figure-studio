/** Shared pixel-space geometry primitives (top-left origin, px at 96dpi). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
}

export interface Segment {
  a: Pt
  b: Pt
}

/** Coordinate equality tolerance (px) for anchor/contact bookkeeping. */
export const GEOM_TOL = 1e-7

export function rectCenter(rect: Rect): Pt {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}

function samePt(p: Pt, q: Pt): boolean {
  return Math.abs(p.x - q.x) <= GEOM_TOL && Math.abs(p.y - q.y) <= GEOM_TOL
}

export type SegmentContact = 'none' | 'endpoint-touch' | 'cross' | 'collinear-overlap'

function cross(o: Pt, p: Pt, q: Pt): number {
  return (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
}

/**
 * Classify how two closed segments meet. `endpoint-touch` = they share a
 * coordinate (legal: elbow joints of one route, shared anchors of parallel
 * connectors); `cross` = a proper interior crossing; `collinear-overlap` =
 * both segments lie on one line and overlap over a non-degenerate span.
 */
export function segmentContact(s1: Segment, s2: Segment): SegmentContact {
  const shareEndpoint =
    samePt(s1.a, s2.a) || samePt(s1.a, s2.b) || samePt(s1.b, s2.a) || samePt(s1.b, s2.b)
  const d1 = cross(s1.a, s1.b, s2.a)
  const d2 = cross(s1.a, s1.b, s2.b)
  const d3 = cross(s2.a, s2.b, s1.a)
  const d4 = cross(s2.a, s2.b, s1.b)
  const collinear =
    Math.abs(d1) <= GEOM_TOL &&
    Math.abs(d2) <= GEOM_TOL &&
    Math.abs(d3) <= GEOM_TOL &&
    Math.abs(d4) <= GEOM_TOL
  if (collinear) {
    // overlap if projecting both onto the dominant axis yields intersecting spans
    const horizontal = Math.abs(s1.b.x - s1.a.x) >= Math.abs(s1.b.y - s1.a.y)
    const span = (s: Segment): [number, number] =>
      horizontal
        ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)]
        : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)]
    const [lo1, hi1] = span(s1)
    const [lo2, hi2] = span(s2)
    const overlap = Math.min(hi1, hi2) - Math.max(lo1, lo2)
    return overlap > GEOM_TOL ? 'collinear-overlap' : shareEndpoint ? 'endpoint-touch' : 'none'
  }
  const straddle =
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  if (straddle) return 'cross'
  // touching at an endpoint without straddling is still a contact
  if (shareEndpoint) return 'endpoint-touch'
  const onSegment = (s: Segment, p: Pt) =>
    Math.abs(cross(s.a, s.b, p)) <= GEOM_TOL &&
    p.x >= Math.min(s.a.x, s.b.x) - GEOM_TOL &&
    p.x <= Math.max(s.a.x, s.b.x) + GEOM_TOL &&
    p.y >= Math.min(s.a.y, s.b.y) - GEOM_TOL &&
    p.y <= Math.max(s.a.y, s.b.y) + GEOM_TOL
  if (onSegment(s1, s2.a) || onSegment(s1, s2.b) || onSegment(s2, s1.a) || onSegment(s2, s1.b))
    return shareEndpoint ? 'endpoint-touch' : 'cross'
  return 'none'
}

/** Boolean convenience: do two segments properly cross or overlap? */
export function segmentsProperlyIntersect(s1: Segment, s2: Segment): boolean {
  const contact = segmentContact(s1, s2)
  return contact === 'cross' || contact === 'collinear-overlap'
}

/**
 * QA-P0-09: robust axis-aligned segment-vs-rectangle intersection using the
 * Liang–Barsky clip test against the rect's four half-planes — NOT a diagonal
 * proxy. `tol` shrinks the rect so tangential contact within `tol` px does
 * not count as an intersection.
 */
export function segmentIntersectsRect(seg: Segment, rect: Rect, tol = 0): boolean {
  const x0 = rect.x + tol
  const y0 = rect.y + tol
  const x1 = rect.x + rect.w - tol
  const y1 = rect.y + rect.h - tol
  if (x1 < x0 || y1 < y0) return false
  const dx = seg.b.x - seg.a.x
  const dy = seg.b.y - seg.a.y
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) <= GEOM_TOL) return q >= 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return (
    clip(-dx, seg.a.x - x0) &&
    clip(dx, x1 - seg.a.x) &&
    clip(-dy, seg.a.y - y0) &&
    clip(dy, y1 - seg.a.y)
  )
}

/** Polyline length in px. */
export function polylineLength(points: Pt[]): number {
  let len = 0
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y)
  }
  return len
}
