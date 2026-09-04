/**
 * Junction / bus generator (Architecture gap P2).
 *
 * When >=3 sources converge on one target (or one source fans out to >=3
 * targets) we draw a small dot at the target's connection point and run
 * each source → dot through its own short straight/elbow. This kills the
 * "stacked connectors at the same port" problem the previous round kept
 * seeing in screenshots, and gives the figure a clean tree-shaped fan.
 */
import type { Rect } from './geometry.js'
import type { AnchorSide } from './router.js'
import { anchorPoint } from './router.js'

export interface JunctionAnchor {
  /** which target/source the junction sits on */
  hostRect: Rect
  side: AnchorSide
  /** how many edges meet at this junction */
  fan: number
  /** the small dot radius in px (default 4) */
  radius?: number
}

export function junctionCenter(j: JunctionAnchor): { x: number; y: number } {
  const c = anchorPoint(j.hostRect, j.side)
  return c
}

export interface JunctionDot {
  /** id of the macro node the junction is on */
  hostId: string
  side: AnchorSide
  x: number
  y: number
  r: number
  /** number of edges this junction services */
  fan: number
}

/** A junction box is just a small dot the Router treats as a node. */
export function buildJunctionDots(
  hostId: string,
  hostRect: Rect,
  side: AnchorSide,
  fan: number,
  radius = 4,
): JunctionDot {
  const c = anchorPoint(hostRect, side)
  return { hostId, side, x: c.x, y: c.y, r: radius, fan }
}
