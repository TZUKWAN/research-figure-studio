/**
 * Visual/Metric Critic (Phase 7, P0 rewrite). Two separated layers:
 *
 *  1. HARD GATES — boolean feasibility. Any failure blocks delivery and maps
 *     to a repair class. Gates are never averaged into the score.
 *  2. SOFT SCORES — a weighted 0–10 rubric whose weights sum to exactly 1.0.
 *     Every weighted metric is real (computed from placements/edges/routes);
 *     no constant placeholders. Additional diagnostics (density, spine
 *     clarity, connector naturalness) are reported but not weighted.
 *
 * Verdict semantics (stable contract):
 *   semantic hard failure or structural intent failure → RECOMPOSE
 *   geometry gate failure                              → LOCAL_LAYOUT_FIX
 *   route gate failure                                 → ROUTE_FIX (edgeIds)
 *   otherwise thresholded on the weighted overall
 */
import type { SolveResult } from '../constraints/solver.js'
import { edgeCrossingCount, connectorNodeIntersections, routeEdges } from '../routing/router.js'

import type { FigureEdgesInput } from '../composition/candidate.js'
import type { RoutedEdge } from '../routing/router.js'
import { anchorPoint } from '../routing/router.js'
import type { Rect } from '../routing/geometry.js'
import { auditIntent } from './intent.js'
import { criticInfoDensity } from './info-density.js'

type Pt = { x: number; y: number }

function routedSegments(route: RoutedEdge, rects: Map<string, Rect>): Array<{ a: Pt; b: Pt }> {
  if (route.status !== 'routed' || !route.start || !route.end) return []
  const from = rects.get(route.fromId)
  const to = rects.get(route.toId)
  if (!from || !to) return []
  const sp = anchorPoint(from, route.start.side)
  const ep = anchorPoint(to, route.end.side)
  if (route.kind === 'straight') return [{ a: sp, b: ep }]
  if (route.routeY !== undefined) {
    return [
      { a: sp, b: { x: sp.x, y: route.routeY } },
      { a: { x: sp.x, y: route.routeY }, b: { x: ep.x, y: route.routeY } },
      { a: { x: ep.x, y: route.routeY }, b: ep },
    ]
  }
  const horizontalStart = route.start.side === 'right' || route.start.side === 'left'
  const horizontalEnd = route.end.side === 'right' || route.end.side === 'left'
  if (horizontalStart && horizontalEnd) {
    const midX = (sp.x + ep.x) / 2
    return [
      { a: sp, b: { x: midX, y: sp.y } },
      { a: { x: midX, y: sp.y }, b: { x: midX, y: ep.y } },
      { a: { x: midX, y: ep.y }, b: ep },
    ]
  }
  if (!horizontalStart && !horizontalEnd) {
    const midY = (sp.y + ep.y) / 2
    return [
      { a: sp, b: { x: sp.x, y: midY } },
      { a: { x: sp.x, y: midY }, b: { x: ep.x, y: midY } },
      { a: { x: ep.x, y: midY }, b: ep },
    ]
  }
  if (horizontalStart) {
    const corner = { x: ep.x, y: sp.y }
    return [
      { a: sp, b: corner },
      { a: corner, b: ep },
    ]
  }
  const corner = { x: sp.x, y: ep.y }
  return [
    { a: sp, b: corner },
    { a: corner, b: ep },
  ]
}

function segIntersect2(s1: { a: Pt; b: Pt }, s2: { a: Pt; b: Pt }): boolean {
  const d = (p1: Pt, p2: Pt, p3: Pt) =>
    (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  const d1 = d(s1.a, s1.b, s2.a)
  const d2 = d(s1.a, s1.b, s2.b)
  const d3 = d(s2.a, s2.b, s1.a)
  const d4 = d(s2.a, s2.b, s1.b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

export interface CriticScores {
  // ── weighted rubric (CRITIC_WEIGHTS sums to exactly 1.0) ──
  /** relation coverage + graph honesty: declared connectors realized, no geometry lies */
  scientificFidelity: number
  /** required evidence visible on canvas (mustShow / node coverage) */
  evidenceCompleteness: number
  /** visual center dominance + monotone reading progress: the 5-second test */
  fiveSecondClarity: number
  /** importance ↔ area rank correlation */
  visualHierarchy: number
  /** canvas fill band: neither empty nor overloaded */
  compositionQuality: number
  /** crossings / node intersections / anchor-side naturalness */
  relationClarity: number
  /** measurable readability proxy: no oversized wide nodes at shared rank */
  typography: number
  /** quadrant balance of occupied canvas */
  whitespaceBalance: number
  /** anti card-wall: equal-size averaging penalized when importance varies */
  visualRestraint: number
  /** every semantic node placed and reachable as a distinct editable element */
  editability: number
  // ── real diagnostics (reported, NOT weighted) ──
  informationDensity: number
  contentDensity: number
  primaryClarity: number
  connectorNaturalness: number
  groupingClarity: number
  overall: number
}

export type CriticVerdictLevel = 'PASS' | 'ROUTE_FIX' | 'LOCAL_LAYOUT_FIX' | 'RECOMPOSE'

export type CriticScope =
  'semantic' | 'composition' | 'group' | 'node' | 'edge' | 'geometry' | 'route'
export type CriticAction = 'accept' | 'geometry-fix' | 'composition-redesign' | 'semantic-replan'

export interface CriticDecision {
  scope: CriticScope
  severity: 'hard-feasibility' | 'quality'
  action: Exclude<CriticAction, 'accept'>
  affectedIds: string[]
  evidence: string
  message: string
}

export interface HardGateResult {
  gate: string
  scope: CriticScope
  pass: boolean
  detail?: string
}

export interface CriticVerdict {
  scores: CriticScores
  verdict: CriticVerdictLevel
  gateIssues: string[]
  /** boolean feasibility gates; any fail blocks delivery regardless of score */
  hardGates: HardGateResult[]
  hardPass: boolean
  decisions?: CriticDecision[]
  /** edges to re-route when verdict === 'ROUTE_FIX' */
  edgeIds?: string[]
  /** human-readable dominant reason for the verdict */
  reason?: string
}

export interface CriticInput {
  solve: SolveResult
  edges: FigureEdgesInput[]
  canvasW: number
  canvasH: number
  /** node importance (0–1) keyed by node id, for hierarchy correlation */
  importance: Map<string, number>
  groupIds?: Map<string, string>
  /** declared AI composition intent for faithfulness checks */
  intent?: {
    plan: import('../semantic/figure-plan.js').FigurePlanV2
    spatial?: import('../composition/spatial-plan.js').SpatialPlan
  }
  /** final obstacle-routed edges: audits THESE instead of re-deriving */
  routed?: RoutedEdge[]
  /** venue/contract-driven PASS threshold (default 7.5) */
  passThreshold?: number
}

const CONNECTOR_PRESENTATIONS = new Set([
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
])

/**
 * Soft rubric weights. MUST sum to exactly 1.0 — enforced by a unit test.
 * Every entry is a real computed metric; no constant placeholders.
 */
export const CRITIC_WEIGHTS: Record<
  keyof Omit<
    CriticScores,
    | 'overall'
    | 'informationDensity'
    | 'contentDensity'
    | 'primaryClarity'
    | 'connectorNaturalness'
    | 'groupingClarity'
  >,
  number
> = {
  scientificFidelity: 0.2,
  evidenceCompleteness: 0.15,
  fiveSecondClarity: 0.15,
  visualHierarchy: 0.1,
  compositionQuality: 0.1,
  relationClarity: 0.1,
  typography: 0.08,
  whitespaceBalance: 0.05,
  visualRestraint: 0.04,
  editability: 0.03,
}

export function criticVerdict(input: CriticInput): CriticVerdict {
  const placements = input.solve.placements
  const rects = new Map<string, Rect>(placements.map((p) => [p.id, p]))
  const routed = routeEdges(
    input.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  )
  let crossings = 0
  const withArea = placements.map((p) => ({
    area: p.w * p.h,
    importance: input.importance.get(p.id) ?? 0.5,
  }))
  const intersections: Array<{ key: string; nodeId: string }> = []
  if (input.routed) {
    const segs = input.routed.flatMap((route) => routedSegments(route, rects))
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segIntersect2(segs[i]!, segs[j]!)) crossings++
      }
    }
    const pad = 8
    for (const route of input.routed) {
      for (const seg of routedSegments(route, rects)) {
        for (const [id, rect] of rects) {
          if (id === route.fromId || id === route.toId) continue
          const ex = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }
          const minX = Math.min(seg.a.x, seg.b.x)
          const maxX = Math.max(seg.a.x, seg.b.x)
          const minY = Math.min(seg.a.y, seg.b.y)
          const maxY = Math.max(seg.a.y, seg.b.y)
          const fullyInside =
            minX >= ex.x && maxX <= ex.x + ex.w && minY >= ex.y && maxY <= ex.y + ex.h
          const crosses =
            segIntersect2(seg, {
              a: { x: ex.x, y: ex.y },
              b: { x: ex.x + ex.w, y: ex.y + ex.h },
            }) ||
            segIntersect2(seg, { a: { x: ex.x + ex.w, y: ex.y }, b: { x: ex.x, y: ex.y + ex.h } })
          if (fullyInside || crosses) intersections.push({ key: route.key, nodeId: id })
        }
      }
    }
  } else {
    crossings = edgeCrossingCount(
      input.edges.map((edge, index) => ({
        key: `e${index}`,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
      })),
      rects,
    )
    for (const hit of connectorNodeIntersections(
      input.edges.map((edge, index) => ({
        key: `e${index}`,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
      })),
      rects,
    )) {
      intersections.push(hit)
    }
  }
  const visualHierarchy = clamp10(
    10 *
      Math.abs(
        spearman(
          withArea.map((v) => v.importance),
          withArea.map((v) => v.area),
        ),
      ),
  )
  let groupingClarity = 8
  if (input.groupIds && input.groupIds.size > 0) {
    const byGroup = new Map<string, string[]>()
    for (const [id, group] of input.groupIds) {
      byGroup.set(group, [...(byGroup.get(group) ?? []), id])
    }
    let tight = 0
    let total = 0
    for (const members of byGroup.values()) {
      if (members.length < 2) continue
      total++
      const spread = groupSpread(members, rects)
      const outside = groupSpread(
        placements.map((p) => p.id).filter((id) => !members.includes(id)),
        rects,
      )
      if (spread <= outside) tight++
    }
    groupingClarity = clamp10(total ? (tight / total) * 10 : 8)
  }
  const area = placements.reduce((sum, p) => sum + p.w * p.h, 0)
  const fill = area / (input.canvasW * input.canvasH)
  const compositionQuality = clamp10(
    fill < 0.03 ? 4 : fill > 0.6 ? 3 : 10 - Math.abs(fill - 0.15) * 10,
  )
  const quadrants = [0, 0, 0, 0]
  for (const p of placements) {
    const cx = p.x + p.w / 2
    const cy = p.y + p.h / 2
    quadrants[(cx < input.canvasW / 2 ? 0 : 1) + (cy < input.canvasH / 2 ? 0 : 2)]!++
  }
  const qMax = Math.max(...quadrants)
  const qMin = Math.min(...quadrants)
  const whitespaceBalance = clamp10(
    placements.length ? 10 - (qMax - qMin) * (4 / Math.max(4, placements.length)) * 1.2 : 5,
  )
  const connectorQuality = clamp10(10 - crossings * 1.5 - intersections.length * 4)
  const utilization = placements.map((p) => p.w / Math.max(1, input.canvasW))
  const wideCount = utilization.filter((u) => u > 0.34).length
  const typography = clamp10(10 - wideCount * 2)
  const safe = (v: number) => (Number.isFinite(v) ? v : 5)

  // ── route bookkeeping (real, from the final routed set when provided) ──
  const routeByKey = new Map<string, RoutedEdge>()
  const routeByEndpoints = new Map<string, RoutedEdge>()
  if (input.routed) {
    for (const route of input.routed) {
      routeByKey.set(route.key, route)
      routeByEndpoints.set(`${route.fromId}\u0000${route.toId}`, route)
    }
  }
  const declaredConnectors = input.edges.filter(
    (edge) => !edge.presentation || CONNECTOR_PRESENTATIONS.has(edge.presentation),
  )
  const unroutableDeclared = input.routed
    ? input.routed.filter((route) => route.status === 'unroutable').length
    : 0
  const realizedConnectors = input.routed
    ? declaredConnectors.filter((edge) => {
        // production routes are keyed by semantic edge id; the inline fallback
        // router uses e${index}. Match by endpoints, which both share.
        const route =
          routeByEndpoints.get(`${edge.from}\u0000${edge.to}`) ??
          routeByKey.get(`e${input.edges.indexOf(edge)}`)
        return route ? route.status === 'routed' : false
      })
    : declaredConnectors
  const relationCoverage =
    declaredConnectors.length === 0 ? 1 : realizedConnectors.length / declaredConnectors.length
  const scientificFidelity = clamp10(10 * relationCoverage - input.solve.issues.length * 2)

  // anchor-side naturalness (real, same rule as info-density critic)
  let unnatural = 0
  const naturalRoutes = input.routed ?? routed
  for (const route of naturalRoutes) {
    if (route.status !== 'routed' || !route.start || !route.end) continue
    const a = placements.find((p) => p.id === route.fromId)
    const b = placements.find((p) => p.id === route.toId)
    if (!a || !b) continue
    const v = a.y + a.h / 2 < b.y + b.h / 2 ? 'over' : 'under'
    const h = a.x + a.w / 2 < b.x + b.w / 2 ? 'right' : 'left'
    if (v === 'over' && route.end.side === 'bottom') unnatural++
    if (v === 'over' && route.start.side === 'right') unnatural++
    if (h === 'right' && route.start.side === 'left' && route.end.side === 'right') unnatural++
  }
  const connectorNaturalness = clamp10(
    naturalRoutes.length === 0 ? 10 : Math.max(0, 10 - unnatural * 1.5),
  )
  const relationClarity = clamp10(connectorQuality * 0.6 + connectorNaturalness * 0.4)

  // ── five-second clarity: visual center dominance + monotone progress ──
  let centerScore = 7
  const visualCenterId = input.intent?.spatial?.composition.visualCenter
  if (visualCenterId) {
    const centerRect = rects.get(visualCenterId)
    if (centerRect) {
      const rank =
        [...placements]
          .sort((a, b) => b.w * b.h - a.w * a.h)
          .findIndex((p) => p.id === visualCenterId) + 1
      centerScore = rank <= 2 ? 10 : clamp10(10 - (rank - 2) * 2)
    } else {
      centerScore = 3 // declared center missing from canvas
    }
  } else if (withArea.length > 0) {
    const maxImportance = Math.max(...withArea.map((v) => v.importance))
    const dominantShare =
      maxImportance > 0
        ? (placements.find((p) => (input.importance.get(p.id) ?? 0.5) === maxImportance)?.w ?? 0) *
          (placements.find((p) => (input.importance.get(p.id) ?? 0.5) === maxImportance)?.h ?? 0)
        : 0
    centerScore = clamp10(6 + (dominantShare / Math.max(1, area)) * 8)
  }
  let progressOk = 0
  let progressTotal = 0
  for (const edge of input.edges) {
    if (edge.role === 'feedback') continue
    const a = rects.get(edge.from)
    const b = rects.get(edge.to)
    if (!a || !b) continue
    progressTotal++
    if (b.x + b.w / 2 >= a.x + a.w / 2 - 8) progressOk++
  }
  const progressScore = clamp10(progressTotal ? (progressOk / progressTotal) * 10 : 7)
  const fiveSecondClarity = clamp10(centerScore * 0.5 + progressScore * 0.5)

  // ── evidence completeness: mustShow + node coverage (real, from plan) ──
  const planNodes = input.intent?.plan.nodes
  let evidenceCompleteness: number
  let missingRequired: string[] = []
  if (planNodes && planNodes.length > 0) {
    const placedIds = new Set(placements.map((p) => p.id))
    const nodeCoverage = planNodes.filter((n) => placedIds.has(n.id)).length / planNodes.length
    const mustShow = input.intent?.plan.narrative?.mustShow ?? []
    if (mustShow.length > 0) {
      missingRequired = mustShow.filter((id) => !placedIds.has(id))
      evidenceCompleteness = clamp10(
        ((mustShow.length - missingRequired.length) / mustShow.length) * 8 + nodeCoverage * 2,
      )
    } else {
      evidenceCompleteness = clamp10(nodeCoverage * 10 - unroutableDeclared)
    }
  } else {
    evidenceCompleteness = clamp10(10 - unroutableDeclared * 2)
  }

  // ── editability: distinct placed elements + resolvable graph ──
  const uniquePlaced = new Set(placements.map((p) => p.id)).size
  const editability =
    planNodes && planNodes.length > 0
      ? clamp10((uniquePlaced / planNodes.length) * 10 - unroutableDeclared)
      : clamp10(10 - unroutableDeclared * 2)

  // ── visual restraint: equal-size averaging penalized when importance varies ──
  const sizeCluster = new Map<string, number>()
  for (const p of placements) {
    const key = `${p.w}x${p.h}`
    sizeCluster.set(key, (sizeCluster.get(key) ?? 0) + 1)
  }
  const modalCluster = Math.max(0, ...sizeCluster.values())
  const modalRatio = placements.length ? modalCluster / placements.length : 0
  const importanceValues = [...input.importance.values()]
  const importanceSpread =
    importanceValues.length >= 2 ? Math.max(...importanceValues) - Math.min(...importanceValues) : 0
  // neutral 8 = insufficient contrast data to judge; NOT a padded perfect score
  const visualRestraint =
    importanceSpread >= 0.25 ? clamp10(10 - Math.max(0, modalRatio - 0.5) * 12) : 8

  const overallScore = clamp10(
    CRITIC_WEIGHTS.scientificFidelity * scientificFidelity +
      CRITIC_WEIGHTS.evidenceCompleteness * evidenceCompleteness +
      CRITIC_WEIGHTS.fiveSecondClarity * fiveSecondClarity +
      CRITIC_WEIGHTS.visualHierarchy * visualHierarchy +
      CRITIC_WEIGHTS.compositionQuality * compositionQuality +
      CRITIC_WEIGHTS.relationClarity * relationClarity +
      CRITIC_WEIGHTS.typography * typography +
      CRITIC_WEIGHTS.whitespaceBalance * whitespaceBalance +
      CRITIC_WEIGHTS.visualRestraint * visualRestraint +
      CRITIC_WEIGHTS.editability * editability,
  )

  const gateIssues: string[] = [...input.solve.issues]
  for (const hit of intersections)
    gateIssues.push(`connector passes through node ${hit.nodeId} (${hit.key})`)
  let infoDensity: ReturnType<typeof criticInfoDensity> | null = null
  let semanticDensityDecision: CriticDecision | null = null
  if (input.intent) {
    infoDensity = criticInfoDensity({
      plan: input.intent.plan,
      ...(input.intent.spatial ? { planIntent: input.intent.spatial } : {}),
      solve: { placements, issues: input.solve.issues, intentDriftPx: input.solve.intentDriftPx },
      canvasW: input.canvasW,
      canvasH: input.canvasH,
      ...(input.routed ? { routed: input.routed } : {}),
    })
    // Density is a SEMANTIC decision, not a geometry gate: a minimal statement
    // is valid by design. Only genuine over-summarisation of rich content
    // escalates, and it escalates to semantic replan — never to the router.
    const isMinimalStatement =
      input.intent.plan.narrative?.expressionMode === 'statement' &&
      input.intent.plan.narrative?.complexity === 'minimal'
    if (infoDensity.density < 1.5 && !isMinimalStatement) {
      semanticDensityDecision = {
        scope: 'semantic',
        severity: 'quality',
        action: 'semantic-replan',
        affectedIds: input.intent.plan.nodes.map((node) => node.id),
        evidence: `density ${infoDensity.density}/10 on ${input.intent.plan.nodes.length} nodes`,
        message:
          'The figure over-summarised the research content into too few visible signals; replan what must be visible rather than shrinking the layout.',
      }
      gateIssues.push(semanticDensityDecision.message)
    }
  }
  const densityScore = infoDensity ? infoDensity.density : clamp10(compositionQuality)
  const primaryScore = infoDensity ? infoDensity.primaryClarity : 8
  const naturalnessScore = infoDensity ? infoDensity.connectorNaturalness : connectorNaturalness
  const intentFailures = input.intent?.spatial
    ? auditIntent(input.intent.spatial, placements, input.canvasW, input.canvasH)
    : []
  for (const failure of intentFailures) gateIssues.push(`intent: ${failure.detail}`)

  // ── hard gates: boolean feasibility, never averaged ──
  const hardGates: HardGateResult[] = [
    {
      gate: 'geometry_legal',
      scope: 'geometry',
      pass: input.solve.issues.length === 0,
      ...(input.solve.issues.length > 0 ? { detail: input.solve.issues.join('; ') } : {}),
    },
    {
      gate: 'connector_not_through_node',
      scope: 'route',
      pass: intersections.length === 0,
      ...(intersections.length > 0
        ? { detail: intersections.map((hit) => `${hit.key}→${hit.nodeId}`).join(', ') }
        : {}),
    },
    {
      gate: 'routes_feasible',
      scope: 'route',
      pass: unroutableDeclared === 0,
      ...(unroutableDeclared > 0
        ? { detail: `${unroutableDeclared} unroutable connector(s)` }
        : {}),
    },
    ...(input.intent?.plan.narrative?.mustShow?.length
      ? [
          {
            gate: 'required_evidence',
            scope: 'semantic' as const,
            pass: missingRequired.length === 0,
            ...(missingRequired.length > 0
              ? { detail: `missing on canvas: ${missingRequired.join(', ')}` }
              : {}),
          },
        ]
      : []),
  ]
  const hardPass = hardGates.every((gate) => gate.pass)
  const semanticHardFail = hardGates.some((gate) => gate.scope === 'semantic' && !gate.pass)

  const structuralIntent = intentFailures.some((failure) => failure.severity === 'structural')
  const routeEdgeIds = intersections.map((hit) => hit.key)
  const hasRouteIssue = intersections.length > 0 || unroutableDeclared > 0

  const decisions: CriticDecision[] = [
    ...input.solve.issues.map((issue) => ({
      scope: 'geometry' as const,
      severity: 'hard-feasibility' as const,
      action: 'geometry-fix' as const,
      affectedIds: [],
      evidence: issue,
      message: issue,
    })),
    ...intersections.map((hit) => ({
      scope: 'edge' as const,
      severity: 'hard-feasibility' as const,
      action: 'geometry-fix' as const,
      affectedIds: [hit.key, hit.nodeId],
      evidence: `connector ${hit.key} intersects ${hit.nodeId}`,
      message: `connector ${hit.key} must not pass through ${hit.nodeId}`,
    })),
    ...intentFailures.map((failure) => ({
      scope: 'composition' as const,
      severity:
        failure.severity === 'structural' ? ('hard-feasibility' as const) : ('quality' as const),
      action: 'composition-redesign' as const,
      affectedIds: [],
      evidence: failure.detail,
      message: failure.detail,
    })),
    ...(semanticDensityDecision ? [semanticDensityDecision] : []),
  ]

  let verdict: CriticVerdictLevel
  let reason: string | undefined
  if (semanticHardFail) {
    verdict = 'RECOMPOSE'
    reason = hardGates.find((gate) => gate.scope === 'semantic' && !gate.pass)?.detail
  } else if (structuralIntent) {
    verdict = 'RECOMPOSE'
    reason = intentFailures.find((failure) => failure.severity === 'structural')?.detail
  } else if (!hardGates.find((gate) => gate.gate === 'geometry_legal')!.pass) {
    verdict = 'LOCAL_LAYOUT_FIX'
    reason = input.solve.issues[0]
  } else if (hasRouteIssue) {
    verdict = 'ROUTE_FIX'
    reason = intersections.length
      ? `route intersects nodes for edges: ${routeEdgeIds.join(', ')}`
      : `${unroutableDeclared} declared connector(s) have no legal route`
  } else if (overallScore >= (input.passThreshold ?? 7.5)) {
    verdict = 'PASS'
  } else if (overallScore >= 5.5) {
    verdict = 'LOCAL_LAYOUT_FIX'
    reason = `overall ${overallScore}/10 below PASS threshold`
  } else {
    verdict = 'RECOMPOSE'
    reason = `overall ${overallScore}/10 far below PASS threshold`
  }
  const scores: CriticScores = {
    scientificFidelity: safe(scientificFidelity),
    evidenceCompleteness: safe(evidenceCompleteness),
    fiveSecondClarity: safe(fiveSecondClarity),
    visualHierarchy: safe(visualHierarchy),
    compositionQuality: safe(compositionQuality),
    relationClarity: safe(relationClarity),
    typography: safe(typography),
    whitespaceBalance: safe(whitespaceBalance),
    visualRestraint: safe(visualRestraint),
    editability: safe(editability),
    informationDensity: safe(clamp10(compositionQuality)),
    contentDensity: safe(densityScore),
    primaryClarity: safe(primaryScore),
    connectorNaturalness: safe(naturalnessScore),
    groupingClarity: safe(groupingClarity),
    overall: safe(overallScore),
  }
  return {
    scores,
    verdict,
    gateIssues,
    hardGates,
    hardPass,
    decisions,
    ...(verdict === 'ROUTE_FIX' ? { edgeIds: routeEdgeIds } : {}),
    ...(reason ? { reason } : {}),
  }
}

function clamp10(v: number): number {
  return Math.max(0, Math.min(10, Math.round(v * 10) / 10))
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (values: number[]): number[] => {
    const sorted = [...values].sort((a, b) => a - b)
    return values.map((v) => sorted.indexOf(v))
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const n = xs.length
  if (n < 2) return 0
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / n
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my)
    dx += (rx[i]! - mx) ** 2
    dy += (ry[i]! - my) ** 2
  }
  // degenerate (all-equal) inputs are NEUTRAL, not anti-correlated
  return dx === 0 || dy === 0 ? 0.5 : num / Math.sqrt(dx * dy)
}

function groupSpread(ids: string[], rects: Map<string, Rect>): number {
  const centers = ids.map((id) => rects.get(id)).filter((r): r is Rect => r !== undefined)
  if (centers.length < 2) return 0
  let maxDist = 0
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const a = centers[i]!
      const b = centers[j]!
      maxDist = Math.max(
        maxDist,
        Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2)),
      )
    }
  }
  return maxDist
}
