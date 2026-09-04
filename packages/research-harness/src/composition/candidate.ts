/**
 * Candidate generation + ranking (Phase 3, GOAL §25-26). Never bet the figure
 * on one composition: A0 emits 2–3 program candidates from the top-fitting
 * priors; A1/A2 pair the model's SpatialPlan with one prior-based alternative.
 * Ranking is deterministic (solver feasibility + routing cost).
 */
import type { MeasuredNode } from '../measurement/measure.js'
import { solveGeometry, type SolveResult } from '../constraints/solver.js'
import { routeEdges, edgeCrossingCount, connectorNodeIntersections } from '../routing/router.js'
import type { Rect } from '../routing/geometry.js'
import { COMPOSITION_PRIORS, priorFitScore, type CompositionPrior } from './priors.js'
import type { SpatialPlan } from './spatial-plan.js'
import type { RelationPresentation } from '../semantic/schema.js'

export interface FigureEdgesInput {
  id?: string
  from: string
  to: string
  role: 'main' | 'feedback'
  relation: string
  presentation?: RelationPresentation
}

export interface CompositionCandidate {
  source: 'prior' | 'model'
  priorId: string | null
  plan: SpatialPlan
  solve: SolveResult
  crossings: number
  nodeIntersections: number
  score: number
}

interface ScoreInputs {
  measured: MeasuredNode[]
  edges: FigureEdgesInput[]
  canvasW: number
  canvasH: number
}

function evaluateCandidate(
  plan: SpatialPlan,
  source: 'prior' | 'model',
  priorId: string | null,
  inputs: ScoreInputs,
): CompositionCandidate {
  const solve = solveGeometry({
    plan,
    measured: inputs.measured,
    canvasW: inputs.canvasW,
    canvasH: inputs.canvasH,
  })
  const rects = new Map<string, Rect>(
    solve.placements.map((placement) => [placement.id, placement]),
  )
  const routed = routeEdges(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  )
  const crossings = edgeCrossingCount(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  )
  const nodeIntersections = connectorNodeIntersections(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  ).length
  // deterministic rank: gate failures dominate, then crossings, then intent
  // preservation (lower drift wins), then whitespace balance
  const score =
    solve.issues.length * 1000 +
    nodeIntersections * 100 +
    crossings * 20 +
    Math.min(99, solve.intentDriftPx / 8)
  return { source, priorId, plan, solve, crossings, nodeIntersections, score }
}

/**
 * Build a program candidate from a prior: deterministic longest-path layering
 * (columns = flow layers, nodes centered per column) biased by the prior's
 * reading flow. This is the A0 fallback designer — never the default for a
 * capable model, and always re-rankable against the model's own plan.
 */
export interface NodeMeta {
  importance: number
  groupId?: string
}

export function candidateFromPrior(
  prior: CompositionPrior,
  measured: MeasuredNode[],
  edges: FigureEdgesInput[],
  canvasW: number,
  canvasH: number,
  meta?: Map<string, NodeMeta>,
): CompositionCandidate {
  const ids = measured.map((node) => node.title)
  const idSet = new Set(ids)
  const internalEdges = edges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to))
  const inDeg = new Map(ids.map((id) => [id, 0]))
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const edge of internalEdges) {
    if (edge.role === 'feedback') continue
    inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1)
    adj.get(edge.from)!.push(edge.to)
  }
  // longest-path layering (Kahn); cycles → remaining nodes join the last layer
  const layer = new Map<string, number>(ids.map((id) => [id, 0]))
  const degree = new Map(inDeg)
  const queue = ids.filter((id) => (degree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(id) ?? 0) + 1))
      const remaining = (degree.get(next) ?? 0) - 1
      degree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }
  for (const id of ids) if (!order.includes(id)) layer.set(id, ids.length)
  const maxLayer = Math.max(0, ...[...layer.values()])
  const byLayer = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id) ?? 0
    byLayer.set(l, [...(byLayer.get(l) ?? []), id])
  }
  // Within-layer ordering (A0 must NOT read as a bare DAG dump): barycenter of
  // the neighbouring layers' final slots, then importance, then group identity.
  const slot = new Map<string, number>()
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b)
  for (const l of layerKeys) {
    const members = byLayer.get(l)!
    const importanceOf = (id: string) => meta?.get(id)?.importance ?? 0.5
    const groupOf = (id: string) => meta?.get(id)?.groupId ?? ''
    const bary = (id: string): number => {
      let sum = 0
      let count = 0
      for (const edge of internalEdges) {
        if (edge.role === 'feedback') continue
        if (edge.to === id && slot.has(edge.from)) {
          sum += slot.get(edge.from)!
          count++
        }
        if (edge.from === id && slot.has(edge.to)) {
          sum += slot.get(edge.to)!
          count++
        }
      }
      return count ? sum / count : Number.POSITIVE_INFINITY
    }
    members.sort((a, b) => {
      const ba = bary(a)
      const bb = bary(b)
      if (ba !== bb) return ba - bb
      if (importanceOf(a) !== importanceOf(b)) return importanceOf(b) - importanceOf(a)
      if (groupOf(a) !== groupOf(b)) return groupOf(a).localeCompare(groupOf(b))
      return a.localeCompare(b)
    })
    members.forEach((id, index) => slot.set(id, index))
    byLayer.set(l, members)
  }
  const vertical = prior.readingFlow === 'TB'
  const layerCount = maxLayer + 1
  const placements = measured.map((node) => {
    const l = layer.get(node.title) ?? 0
    const members = byLayer.get(l) ?? [node.title]
    const slot = members.indexOf(node.title)
    const bandFrac = 1 / layerCount
    const alongFrac = 1 / members.length
    const alongCenter = alongFrac * (slot + 0.5)
    const bandCenter = bandFrac * (l + 0.5)
    // importance-aware sizing: salience scales the composition hint, not the
    // measured text fit
    const imp = meta?.get(node.title)?.importance ?? 0.5
    const scale = 0.85 + 0.4 * imp
    const w = Math.max(0.09, Math.min(0.42, (node.bounds.preferredWidth / canvasW) * 1.25 * scale))
    const h = Math.max(0.1, Math.min(0.4, (node.bounds.preferredHeight / canvasH) * 1.3 * scale))
    const boxHint = vertical
      ? {
          x: Math.min(0.98 - w, Math.max(0.02, alongCenter - w / 2)),
          y: Math.min(0.98 - h, Math.max(0.02, bandCenter - h / 2)),
          w,
          h,
        }
      : {
          x: Math.min(0.98 - w, Math.max(0.02, bandCenter - w / 2)),
          y: Math.min(0.98 - h, Math.max(0.02, alongCenter - h / 2)),
          w,
          h,
        }
    return { id: node.title, boxHint, visualRole: 'primary' as const }
  })
  const plan: SpatialPlan = {
    composition: {
      readingFlow: prior.readingFlow,
      balance: 'loosely-balanced',
      density: ids.length > 10 ? 'high' : 'medium',
      whitespaceStrategy: 'balanced',
    },
    placements,
  }
  return evaluateCandidate(plan, 'prior', prior.id, { measured, edges, canvasW, canvasH })
}

/**
 * Generate the candidate set for an autonomy level.
 * - A0: 2–3 prior candidates ranked by semantic fit (model not consulted).
 * - A1/A2: the model SpatialPlan plus the best prior alternative.
 */
export function generateCandidates(
  autonomy: 'A0' | 'A1' | 'A2',
  measured: MeasuredNode[],
  edges: FigureEdgesInput[],
  signals: { roles: Set<string>; relations: Set<string> },
  canvasW: number,
  canvasH: number,
  modelPlan?: SpatialPlan | null,
  meta?: Map<string, NodeMeta>,
): CompositionCandidate[] {
  const rankedPriors = [...COMPOSITION_PRIORS]
    .map((prior) => ({ prior, fit: priorFitScore(prior, signals) }))
    .sort((a, b) => b.fit - a.fit || a.prior.id.localeCompare(b.prior.id))
    .slice(0, autonomy === 'A0' ? 3 : 1)
  const candidates = rankedPriors.map(({ prior }) =>
    candidateFromPrior(prior, measured, edges, canvasW, canvasH, meta),
  )
  if (autonomy !== 'A0' && modelPlan) {
    candidates.unshift(
      evaluateCandidate(modelPlan, 'model', null, { measured, edges, canvasW, canvasH }),
    )
  }
  return candidates.sort(
    (a, b) => a.score - b.score || a.priorId?.localeCompare(b.priorId ?? '') || 0,
  )
}
