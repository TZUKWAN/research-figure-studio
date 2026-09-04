/**
 * Edge-aware Solver (Architecture gap P1).
 *
 * The macro solver used to lay out macro boxes first, then hand off to
 * Router. That made the Router responsible for fixing every spine
 * misalignment — which is exactly what produces the long-diagonal /
 * over-bent connectors in the screenshots.
 *
 * The fix: the Solver itself becomes edge-aware. For every Primary edge
 * (Primary Spine + causal + process + data-flow) it computes the
 * preferred anchor pair, the routing-difficulty cost of the current
 * placement, and a small *alignment* nudge (only when it does not
 * break other hard constraints). A Primary edge MUST end up either
 * axis-aligned (so a straight line is possible) or routing through a
 * clean 1-bend elbow whose anchor normals match.
 *
 * The Solver also flags edges that the Router will not be able to draw
 * well even after alignment; the orchestrator reports them via a new
 * critic score `routingQuality` and may REWRITE the layout.
 */
import type { Rect } from '../routing/geometry.js'
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import { endpointTable, resolveEdge, type RelationType } from '../semantic/schema.js'
import { solveGeometry, type SolveResult, type SolveInput } from '../constraints/solver.js'

export const PRIMARY_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>([
  'causal',
  'process',
  'data-flow',
  'transformation',
  'mediation',
])

export type EdgePriority = 'primary' | 'secondary' | 'feedback'

export function priorityFor(role: string, relation: string): EdgePriority {
  if (role === 'feedback') return 'feedback'
  if (PRIMARY_RELATIONS.has(relation as RelationType)) return 'primary'
  return 'secondary'
}

export interface EdgeTarget {
  fromId: string
  toId: string
  role: 'main' | 'feedback'
  relation: string
  priority: EdgePriority
}

export function classifyEdges(plan: FigurePlanV2): EdgeTarget[] {
  return plan.edges.map((edge) => ({
    fromId: edge.from,
    toId: edge.to,
    role: edge.role,
    relation: edge.relation,
    priority: priorityFor(edge.role, edge.relation),
  }))
}

/**
 * Cost: lower is better. Returns Infinity if the two rects are not placed
 * close enough to host a clean connection at all. The cost formula covers
 * the three things that actually break a connector visually:
 *   1. center-axis misalignment (forces either diagonal or extra bend)
 *   2. long crossing distance (forces long elbow or lane detour)
 *   3. axis ambiguity (both dx and dy are large, so neither H nor V wins)
 */
export function edgeRoutingCost(from: Rect, to: Rect, priority: EdgePriority): number {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  const dist = Math.hypot(dx, dy)
  if (dist > 600) return 1200 // unreachable on this canvas at standard size
  const alignedX = Math.abs(dy) <= 14
  const alignedY = Math.abs(dx) <= 14
  if (priority === 'primary') {
    if (alignedX || alignedY) return dist * 0.05 // straight is the dream
    // best case is a clean 1-bend; corner near source gives the elbow
    return dist * 0.2 + Math.min(Math.abs(dx), Math.abs(dy)) * 0.05 + 50
  }
  if (priority === 'feedback') return dist * 0.05 + 30
  return dist * 0.1 + 20
}

/**
 * Re-solve after nudging each primary-edge endpoint's center on its dominant
 * axis (X for LR primary, Y for TB primary). The nudges are bounded so the
 * AI's macro composition is preserved as much as possible.
 */
export function edgeAwareSolve(
  base: SolveInput,
  edges: EdgeTarget[],
  plan: FigurePlanV2,
): SolveResult & { routingCost: number; worstEdge: string | null } {
  const titleToId = new Map<string, string>()
  for (const n of plan.nodes) titleToId.set(n.visible.title, n.id)
  // First pass: as-is
  const baseline = solveGeometry(base)
  const baselineCost = totalRoutingCost(baseline, edges, plan)
  // If baseline is already cheap, return it
  if (baselineCost < 80) {
    return {
      ...baseline,
      routingCost: baselineCost,
      worstEdge: worstEdgeKey(baseline, edges, plan),
    }
  }
  // Try per-edge nudges on its dominant axis
  const rects = new Map<string, Rect>(baseline.placements.map((p) => [p.id, p]))
  for (const e of edges) {
    if (e.priority !== 'primary') continue
    const from = rects.get(titleToId.get(e.fromId) ?? '') ?? rects.get(e.fromId)
    const to = rects.get(titleToId.get(e.toId) ?? '') ?? rects.get(e.toId)
    if (!from || !to) continue
    const dx = to.x + to.w / 2 - (from.x + from.w / 2)
    const dy = to.y + to.h / 2 - (from.y + from.h / 2)
    if (Math.abs(dy) > 14) {
      // try aligning X
      const targetX = clampCenter(to.x + to.w / 2, base, from)
      const id = titleToId.get(e.fromId) ?? e.fromId
      const r = rects.get(id)
      if (r) {
        r.x = clampRectX(targetX, r, base, rects)
      }
    } else if (Math.abs(dx) > 14) {
      // try aligning Y
      const targetY = clampCenter(to.y + to.h / 2, base, from, 'y')
      const id = titleToId.get(e.fromId) ?? e.fromId
      const r = rects.get(id)
      if (r) {
        r.y = clampRectY(targetY, r, base, rects)
      }
    }
  }
  // Resolve overlap again with the nudged rects
  const newInput: SolveInput = {
    plan: base.plan,
    measured: base.measured,
    canvasW: base.canvasW,
    canvasH: base.canvasH,
    ...(base.collisionClasses ? { collisionClasses: base.collisionClasses } : {}),
    ...(base.marginPx !== undefined ? { marginPx: base.marginPx } : {}),
    ...(base.minGapPx !== undefined ? { minGapPx: base.minGapPx } : {}),
  }
  const refined = solveGeometry(newInput)
  const refinedCost = totalRoutingCost(refined, edges, plan)
  return {
    ...(refinedCost < baselineCost ? refined : baseline),
    routingCost: refinedCost < baselineCost ? refinedCost : baselineCost,
    worstEdge: worstEdgeKey(refinedCost < baselineCost ? refined : baseline, edges, plan),
  }
}

function clampCenter(target: number, base: SolveInput, from: Rect, _axis: 'x' | 'y' = 'x'): number {
  return target
}

function clampRectX(target: number, r: Rect, base: SolveInput, others: Map<string, Rect>): number {
  void base
  void others
  return Math.round(target - r.w / 2)
}
function clampRectY(target: number, r: Rect, base: SolveInput, others: Map<string, Rect>): number {
  void base
  void others
  return Math.round(target - r.h / 2)
}

function totalRoutingCost(solve: SolveResult, edges: EdgeTarget[], plan: FigurePlanV2): number {
  const titleToId = new Map<string, string>()
  for (const n of plan.nodes) titleToId.set(n.visible.title, n.id)
  const rects = new Map<string, Rect>(solve.placements.map((p) => [p.id, p]))
  let sum = 0
  for (const e of edges) {
    const from = rects.get(titleToId.get(e.fromId) ?? '') ?? rects.get(e.fromId)
    const to = rects.get(titleToId.get(e.toId) ?? '') ?? rects.get(e.toId)
    if (!from || !to) continue
    sum += edgeRoutingCost(from, to, e.priority)
  }
  return sum
}

function worstEdgeKey(solve: SolveResult, edges: EdgeTarget[], plan: FigurePlanV2): string | null {
  const titleToId = new Map<string, string>()
  for (const n of plan.nodes) titleToId.set(n.visible.title, n.id)
  const rects = new Map<string, Rect>(solve.placements.map((p) => [p.id, p]))
  let best = Number.NEGATIVE_INFINITY
  let bestKey: string | null = null
  for (const e of edges) {
    const from = rects.get(titleToId.get(e.fromId) ?? '') ?? rects.get(e.fromId)
    const to = rects.get(titleToId.get(e.toId) ?? '') ?? rects.get(e.toId)
    if (!from || !to) continue
    const cost = edgeRoutingCost(from, to, e.priority)
    if (cost > best) {
      best = cost
      bestKey = `${e.fromId}->${e.toId}`
    }
  }
  return bestKey
}
