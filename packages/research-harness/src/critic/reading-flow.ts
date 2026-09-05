/**
 * Reading-flow semantics (QA-P0-04 / QA-P0-05). One implementation of
 * "directional progress" shared by the metric critic's fiveSecondClarity and
 * the scientific critic's direction audit, so LR / RL / TB / BT / radial /
 * mixed can never disagree between the two critics again.
 */
import type { ReadingFlow } from '../composition/spatial-plan.js'
import type { Rect, Pt } from '../routing/geometry.js'

export type { ReadingFlow }

export const ALL_READING_FLOWS: ReadingFlow[] = ['LR', 'RL', 'TB', 'BT', 'radial', 'mixed']

export function isReadingFlow(value: unknown): value is ReadingFlow {
  return typeof value === 'string' && (ALL_READING_FLOWS as string[]).includes(value)
}

/** Resolve the effective flow: spatial plan wins, then plan readingIntent, then LR. */
export function resolveReadingFlow(
  spatial?: {
    composition: { readingFlow: ReadingFlow }
  },
  plan?: { readingIntent?: { preferredDirection?: string } },
): ReadingFlow {
  if (spatial?.composition?.readingFlow) return spatial.composition.readingFlow
  const declared = plan?.readingIntent?.preferredDirection
  if (isReadingFlow(declared)) return declared
  return 'LR'
}

/** 1-based position of a node in the declared readingPath (undefined if absent). */
export function readingPathPositions(readingPath?: string[]): Map<string, number> | null {
  if (!readingPath || readingPath.length < 2) return null
  return new Map(readingPath.map((id, index) => [id, index + 1]))
}

/**
 * Signed progress of to relative to from along the declared flow.
 *   > 0 — forward progress
 *   ≈ 0 — lateral (within `tolerance`)
 *   < 0 — backwards reading
 * Returns null when the flow cannot decide (e.g. radial with no center).
 */
export function directionalProgress(
  flow: ReadingFlow,
  from: Rect,
  to: Rect,
  canvas: { w: number; h: number },
  options?: {
    visualCenterId?: string
    rectById?: Map<string, Rect>
    pathPositions?: Map<string, number> | null
  },
): number | null {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
  if (flow === 'LR') return tc.x - fc.x
  if (flow === 'RL') return fc.x - tc.x
  if (flow === 'TB') return tc.y - fc.y
  if (flow === 'BT') return fc.y - tc.y
  if (flow === 'mixed') {
    // geometric fallback when no readingPath is declared: LR projection
    return tc.x - fc.x
  }
  // radial: progress = outward movement from the DECLARED visual center.
  // Without a declared center there is no basis to judge — the caller skips
  // the edge instead of the critic guessing a center.
  const center =
    options?.visualCenterId && options.rectById
      ? rectCenter(options.rectById.get(options.visualCenterId)!)
      : undefined
  if (!center || Number.isNaN(center.x)) return null
  const dFrom = Math.hypot(fc.x - center.x, fc.y - center.y)
  const dTo = Math.hypot(tc.x - center.x, tc.y - center.y)
  return dTo - dFrom
}

function rectCenter(rect: Rect): Pt {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/**
 * Id-keyed variant — the one critics use. `pathPositions` resolves mixed-flow
 * progress from the declared readingPath order (1 step ≙ 100px so the shared
 * tolerance scale applies); radial uses the declared visual center. Returns
 * null where the flow cannot decide (caller skips the edge rather than
 * guessing).
 */
export function directionalProgressById(
  flow: ReadingFlow,
  fromId: string,
  toId: string,
  rectById: Map<string, Rect>,
  canvas: { w: number; h: number },
  options?: {
    visualCenterId?: string
    pathPositions?: Map<string, number> | null
  },
): number | null {
  const from = rectById.get(fromId)
  const to = rectById.get(toId)
  if (!from || !to) return null
  if (flow === 'mixed' && options?.pathPositions) {
    const a = options.pathPositions.get(fromId)
    const b = options.pathPositions.get(toId)
    if (a !== undefined && b !== undefined) return (b - a) * 100
  }
  if (flow === 'radial' && !options?.visualCenterId) return null
  return directionalProgress(flow, from, to, canvas, {
    ...(options?.visualCenterId ? { visualCenterId: options.visualCenterId } : {}),
    ...(options?.pathPositions ? { pathPositions: options.pathPositions } : {}),
    rectById,
  })
}
