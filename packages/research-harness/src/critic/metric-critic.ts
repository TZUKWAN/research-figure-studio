/**
 * Visual/Metric Critic (Phase 7). Deterministic scientific-figure rubric over
 * the solved layout + routed edges: nine 0–10 scores, a weighted overall, and
 * a verdict of PASS / LOCAL_FIX / RECOMPOSE. Technical validity is a GATE —
 * serious violations force RECOMPOSE regardless of the weighted average.
 * Vision is optional: without a screenshot the geometry/metric path still
 * produces the full rubric.
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
  semanticFidelity: number
  readingPath: number
  visualHierarchy: number
  groupingClarity: number
  informationDensity: number
  whitespaceBalance: number
  connectorQuality: number
  textEconomy: number
  visualEconomy: number
  contentDensity: number
  primaryClarity: number
  connectorNaturalness: number
  overall: number
}

export type CriticVerdictLevel = 'PASS' | 'ROUTE_FIX' | 'LOCAL_LAYOUT_FIX' | 'RECOMPOSE'

export type CriticScope = 'semantic' | 'composition' | 'group' | 'node' | 'edge' | 'geometry'
export type CriticAction = 'accept' | 'geometry-fix' | 'composition-redesign' | 'semantic-replan'

export interface CriticDecision {
  scope: CriticScope
  severity: 'hard-feasibility' | 'quality'
  action: Exclude<CriticAction, 'accept'>
  affectedIds: string[]
  evidence: string
  message: string
}

export interface CriticVerdict {
  scores: CriticScores
  verdict: CriticVerdictLevel
  gateIssues: string[]
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
}

const WEIGHTS: Record<keyof Omit<CriticScores, 'overall'>, number> = {
  semanticFidelity: 0.25,
  readingPath: 0.15,
  visualHierarchy: 0.15,
  groupingClarity: 0.1,
  connectorQuality: 0.1,
  textEconomy: 0.1,
  informationDensity: 0.05,
  whitespaceBalance: 0.05,
  visualEconomy: 0.05,
  contentDensity: 0.05,
  primaryClarity: 0.05,
  connectorNaturalness: 0.05,
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
  const informationDensity = clamp10(
    fill < 0.03 ? 4 : fill > 0.6 ? 4 : 10 - Math.abs(fill - 0.15) * 10,
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
  const textEconomy = clamp10(10 - wideCount * 2)
  const visualEconomy = clamp10(10)
  const safe = (v: number) => (Number.isFinite(v) ? v : 5)
  const semanticFidelity = clamp10(10 - input.solve.issues.length * 3)
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
  const readingPath = clamp10(progressTotal ? (progressOk / progressTotal) * 10 : 7)
  const overallScore = clamp10(
    WEIGHTS.semanticFidelity * semanticFidelity +
      WEIGHTS.readingPath * readingPath +
      WEIGHTS.visualHierarchy * visualHierarchy +
      WEIGHTS.groupingClarity * groupingClarity +
      WEIGHTS.connectorQuality * connectorQuality +
      WEIGHTS.textEconomy * textEconomy +
      WEIGHTS.informationDensity * informationDensity +
      WEIGHTS.whitespaceBalance * whitespaceBalance +
      WEIGHTS.visualEconomy * visualEconomy +
      WEIGHTS.contentDensity * informationDensity +
      WEIGHTS.primaryClarity * informationDensity +
      WEIGHTS.connectorNaturalness * informationDensity,
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
    // A page-level density audit aligned with the wut-ppt discipline: not
    // "more cards", but "no scientific signal dropped". Minimal statement
    // figures remain valid on purpose.
    const isMinimalStatement =
      input.intent.plan.narrative?.expressionMode === 'statement' &&
      input.intent.plan.narrative?.complexity === 'minimal'
    if (infoDensity.density < 1.5 && !isMinimalStatement) {
      const decision: CriticDecision = {
        scope: 'semantic',
        severity: 'quality',
        action: 'semantic-replan',
        affectedIds: input.intent.plan.nodes.map((node) => node.id),
        evidence: `density ${infoDensity.density}/10 on ${input.intent.plan.nodes.length} nodes`,
        message:
          'The figure over-summarised the research content into too few visible signals; replan what must be visible rather than shrinking the layout.',
      }
      semanticDensityDecision = decision
      gateIssues.push(decision.message)
    }
  }
  const densityScore = infoDensity ? infoDensity.density : 8
  const primaryScore = infoDensity ? infoDensity.primaryClarity : 8
  const naturalnessScore = infoDensity ? infoDensity.connectorNaturalness : 8
  const intentFailures = input.intent?.spatial
    ? auditIntent(input.intent.spatial, placements, input.canvasW, input.canvasH)
    : []
  for (const failure of intentFailures) gateIssues.push(`intent: ${failure.detail}`)
  const routeEdgeIds = intersections.map((hit) => hit.key)
  const hasRouteIssue = intersections.length > 0
  const structuralIntent = intentFailures.some((failure) => failure.severity === 'structural')
  const geometryIssues = input.solve.issues
  const hasGeometryIssue = geometryIssues.length > 0

  const decisions: CriticDecision[] = [
    ...geometryIssues.map((issue) => ({
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
      action:
        failure.severity === 'structural'
          ? ('composition-redesign' as const)
          : ('composition-redesign' as const),
      affectedIds: [],
      evidence: failure.detail,
      message: failure.detail,
    })),
    ...(semanticDensityDecision ? [semanticDensityDecision] : []),
  ]

  let verdict: CriticVerdictLevel
  let reason: string | undefined
  if (structuralIntent) {
    verdict = 'RECOMPOSE'
    reason = intentFailures.find((failure) => failure.severity === 'structural')?.detail
  } else if (hasGeometryIssue) {
    verdict = 'LOCAL_LAYOUT_FIX'
    reason = geometryIssues[0]
  } else if (hasRouteIssue) {
    verdict = 'ROUTE_FIX'
    reason = `route intersects nodes for edges: ${routeEdgeIds.join(', ')}`
  } else if (overallScore >= 7.5) {
    verdict = 'PASS'
  } else if (overallScore >= 5.5) {
    verdict = 'LOCAL_LAYOUT_FIX'
    reason = `overall ${overallScore}/10 below PASS threshold`
  } else {
    verdict = 'RECOMPOSE'
    reason = `overall ${overallScore}/10 far below PASS threshold`
  }
  const scores: CriticScores = {
    semanticFidelity: safe(semanticFidelity),
    readingPath: safe(readingPath),
    visualHierarchy: safe(visualHierarchy),
    groupingClarity: safe(groupingClarity),
    informationDensity: safe(informationDensity),
    whitespaceBalance: safe(whitespaceBalance),
    connectorQuality: safe(connectorQuality),
    textEconomy: safe(textEconomy),
    visualEconomy: safe(visualEconomy),
    contentDensity: densityScore,
    primaryClarity: primaryScore,
    connectorNaturalness: naturalnessScore,
    overall: safe(overallScore),
  }
  return {
    scores,
    verdict,
    gateIssues,
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
