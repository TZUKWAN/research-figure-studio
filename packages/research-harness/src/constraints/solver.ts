/**
 * Semantic Geometry Solver (Phase 4). Turns SpatialPlan boxHints + measured
 * node sizes into legal canvas geometry. Hard constraints (no illegal overlap
 * between solid nodes, canvas bounds, min sizes, min gaps) are always
 * satisfied or reported; soft constraints (boxHint intent, centrality,
 * alignment) are preserved as far as the hard constraints allow.
 */
import type { MeasuredNode } from '../measurement/measure.js'
import type { NormalizedBox, SpatialPlan } from '../composition/spatial-plan.js'

export interface SolvedPlacement {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface SolveInput {
  plan: SpatialPlan
  measured: MeasuredNode[]
  canvasW: number
  canvasH: number
  marginPx?: number
  minGapPx?: number
  /** per-node collision class; overlay/background pairs are not pushed apart */
  collisionClasses?: Map<string, import('../components/semantic-styles.js').CollisionClass>
}

export interface SolveResult {
  placements: SolvedPlacement[]
  /** hard-constraint residuals the caller must treat as gate failures */
  issues: string[]
  /** mean px drift of the placement center from its boxHint center */
  intentDriftPx: number
}

// No grid snap: the composer's boxHints are taken at face value; only
// bounds / overlap legalisation is enforced below.
export function solveGeometry(input: SolveInput): SolveResult {
  const margin = input.marginPx ?? Math.round(input.canvasW * 0.06)
  const minGap = input.minGapPx ?? 12
  const measuredById = new Map(input.measured.map((node) => [node.title, node]))
  const issues: string[] = []

  // 1) Honor the composer's boxHint at face value (no grid snap, no
  // recenter). The composer's intent is binding: we only LEGALIZE bounds and
  // overlaps. A hint that is a touch outside the canvas is clamped; a hint
  // larger than the canvas is capped by the node's max sizes; otherwise the
  // px position comes from the hint's center.
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const placement of input.plan.placements) {
    const node = measuredById.get(placement.id)
    if (!node) {
      issues.push(`unmeasured node: ${placement.id}`)
      continue
    }
    const hint: NormalizedBox = placement.boxHint
    const hintW = hint.w * input.canvasW
    const hintH = hint.h * input.canvasH
    const w = Math.min(
      Math.max(node.bounds.minWidth, Math.min(hintW, node.bounds.preferredWidth)),
      node.bounds.maxWidth,
    )
    const h = Math.min(
      Math.max(node.bounds.minHeight, Math.min(hintH, node.bounds.preferredHeight)),
      node.bounds.maxHeight,
    )
    const cx = hint.x * input.canvasW + hintW / 2
    const cy = hint.y * input.canvasH + hintH / 2
    rects.set(placement.id, {
      x: Math.round(cx - w / 2),
      y: Math.round(cy - h / 2),
      w,
      h,
    })
  }

  // 2) hard: canvas bounds with margins (clamp only; no recenter)
  for (const [id, rect] of rects) {
    rect.x = Math.min(Math.max(margin, rect.x), input.canvasW - margin - rect.w)
    rect.y = Math.min(Math.max(margin, rect.y), input.canvasH - margin - rect.h)
    if (rect.w > input.canvasW - margin * 2 || rect.h > input.canvasH - margin * 2) {
      issues.push(`node ${id} exceeds usable canvas`)
    }
  }

  // 3) hard: solid de-overlap — push apart along the minimal axis.
  // overlay/background nodes (annotations, context regions) are exempt.
  const classes = input.collisionClasses
  const pushable = (a: string, b: string): boolean => {
    if (!classes) return true
    const ca = classes.get(a) ?? 'solid'
    const cb = classes.get(b) ?? 'solid'
    return ca !== 'overlay' && cb !== 'overlay' && ca !== 'background' && cb !== 'background'
  }
  const ids = [...rects.keys()]
  for (let iter = 0; iter < 240; iter++) {
    let moved = false
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = rects.get(ids[i]!)!
        const b = rects.get(ids[j]!)!
        const overlapX =
          Math.min(a.x + a.w + minGap, b.x + b.w + minGap) - Math.max(a.x - minGap, b.x - minGap)
        const overlapY =
          Math.min(a.y + a.h + minGap, b.y + b.h + minGap) - Math.max(a.y - minGap, b.y - minGap)
        if (overlapX > 0 && overlapY > 0 && pushable(ids[i]!, ids[j]!)) {
          if (overlapX <= overlapY) {
            const push = (overlapX + 1) / 2
            if (a.x + a.w / 2 <= b.x + b.w / 2) {
              a.x -= push
              b.x += push
            } else {
              a.x += push
              b.x -= push
            }
          } else {
            const push = (overlapY + 1) / 2
            if (a.y + a.h / 2 <= b.y + b.h / 2) {
              a.y -= push
              b.y += push
            } else {
              a.y += push
              b.y -= push
            }
          }
          moved = true
        }
      }
    }
    for (const [id, rect] of rects) {
      rect.x = Math.round(Math.min(Math.max(margin, rect.x), input.canvasW - margin - rect.w))
      rect.y = Math.round(Math.min(Math.max(margin, rect.y), input.canvasH - margin - rect.h))
    }
    if (!moved) break
  }

  // 4) report residual illegal overlaps (gate failures)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (!pushable(ids[i]!, ids[j]!)) continue
      const a = rects.get(ids[i]!)!
      const b = rects.get(ids[j]!)!
      if (
        Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
        Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
      ) {
        issues.push(`illegal overlap: ${ids[i]} intersects ${ids[j]}`)
      }
    }
  }

  // 5) soft metric: intent drift
  let drift = 0
  for (const placement of input.plan.placements) {
    const rect = rects.get(placement.id)
    if (!rect) continue
    const hint = placement.boxHint
    const hintCx = hint.x * input.canvasW + (hint.w * input.canvasW) / 2
    const hintCy = hint.y * input.canvasH + (hint.h * input.canvasH) / 2
    drift += Math.hypot(rect.x + rect.w / 2 - hintCx, rect.y + rect.h / 2 - hintCy)
  }
  const intentDriftPx =
    input.plan.placements.length && Number.isFinite(drift)
      ? drift / input.plan.placements.length
      : 0

  return {
    placements: [...rects.entries()].map(([id, rect]) => ({ id, ...rect })),
    issues,
    intentDriftPx,
  }
}
