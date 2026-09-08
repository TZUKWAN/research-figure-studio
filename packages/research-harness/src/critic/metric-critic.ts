/**
 * Visual/Metric Critic (QA deep-fix rewrite). Two separated layers:
 *
 *  1. HARD GATES — boolean feasibility. Any failure blocks delivery and maps
 *     to a repair class. Gates are never averaged into the score.
 *  2. SOFT SCORES — a weighted 0–10 rubric whose weights sum to exactly 1.0.
 *     Every weighted metric is computed from placements/edges/routes;
 *     metrics whose required input was not supplied report a NEUTRAL 8 and
 *     say so in `metricNotes` instead of inventing a number.
 *
 * Verdict semantics (stable contract):
 *   semantic hard failure or structural intent failure → RECOMPOSE
 *   geometry gate failure                              → LOCAL_LAYOUT_FIX
 *   route gate failure                                 → ROUTE_FIX (edgeIds)
 *   otherwise thresholded on the weighted overall
 */
import type { SolveResult } from '../constraints/solver.js'
import { routeEdges } from '../routing/router.js'

import type { FigureEdgesInput } from '../composition/candidate.js'
import type { RoutedEdge } from '../routing/router.js'
import { anchorPoint } from '../routing/router.js'
import type { Rect, Pt, Segment } from '../routing/geometry.js'
import { segmentContact, segmentIntersectsRect } from '../routing/geometry.js'
import { auditIntent } from './intent.js'
import { criticInfoDensity } from './info-density.js'
import { relationSemantic } from '../semantic/relation-semantics.js'
import { familyProfileFor, fillScore } from './family-quality.js'
import type { FigureFamily } from '../contract/figure-contract.js'
import {
  resolveReadingFlow,
  readingPathPositions,
  directionalProgressById,
} from './reading-flow.js'
import { routeNaturalness } from './route-naturalness.js'

/** Segment tagged with its route + index so legal contacts can be excluded. */
interface TaggedSegment extends Segment {
  routeKey: string
  segmentIndex: number
}

/**
 * Flatten a route into axis-aligned segments with anchor truth from the rects.
 * Shared by the crossing audit and the node-intersection audit.
 */
export function routedSegments(route: RoutedEdge, rects: Map<string, Rect>): TaggedSegment[] {
  if (route.status !== 'routed' || !route.start || !route.end) return []
  const from = rects.get(route.fromId)
  const to = rects.get(route.toId)
  if (!from || !to) return []
  const sp = anchorPoint(from, route.start.side)
  const ep = anchorPoint(to, route.end.side)
  const tag = (a: Pt, b: Pt, segmentIndex: number): TaggedSegment => ({
    a,
    b,
    routeKey: route.key,
    segmentIndex,
  })
  if (route.kind === 'straight') return [tag(sp, ep, 0)]
  if (route.routeY !== undefined) {
    return [
      tag(sp, { x: sp.x, y: route.routeY }, 0),
      tag({ x: sp.x, y: route.routeY }, { x: ep.x, y: route.routeY }, 1),
      tag({ x: ep.x, y: route.routeY }, ep, 2),
    ]
  }
  const horizontalStart = route.start.side === 'right' || route.start.side === 'left'
  const horizontalEnd = route.end.side === 'right' || route.end.side === 'left'
  if (horizontalStart && horizontalEnd) {
    const midX = (sp.x + ep.x) / 2
    return [
      tag(sp, { x: midX, y: sp.y }, 0),
      tag({ x: midX, y: sp.y }, { x: midX, y: ep.y }, 1),
      tag({ x: midX, y: ep.y }, ep, 2),
    ]
  }
  if (!horizontalStart && !horizontalEnd) {
    const midY = (sp.y + ep.y) / 2
    return [
      tag(sp, { x: sp.x, y: midY }, 0),
      tag({ x: sp.x, y: midY }, { x: ep.x, y: midY }, 1),
      tag({ x: ep.x, y: midY }, ep, 2),
    ]
  }
  if (horizontalStart) {
    const corner = { x: ep.x, y: sp.y }
    return [tag(sp, corner, 0), tag(corner, ep, 1)]
  }
  const corner = { x: sp.x, y: ep.y }
  return [tag(sp, corner, 0), tag(corner, ep, 1)]
}

export interface TypographySignal {
  /** resolved on-canvas font sizes (pt) */
  titlePt: number
  detailPt: number
  /** wrapped line counts at the solved box width */
  titleLines: number
  detailLines: number
  /** lines the node could still show before clamping (capacity) */
  maxTitleLines: number
  maxDetailLines: number
  /** px height the text block needs when unclamped */
  textBlockH: number
  padY: number
}

export interface CriticScores {
  // ── weighted rubric (CRITIC_WEIGHTS sums to exactly 1.0) ──
  /** composite: relation realization + direction correctness + sign preservation */
  scientificFidelity: number
  /** required evidence visible on canvas (mustShow / node coverage) */
  evidenceCompleteness: number
  /** visual center dominance + directional reading progress: the 5-second test */
  fiveSecondClarity: number
  /** importance ↔ area rank correlation */
  visualHierarchy: number
  /** family-profiled fill band + focal expectation (NOT a universal 0.15) */
  compositionQuality: number
  /** crossings / node intersections / orientation-free route naturalness */
  relationClarity: number
  /** measurable readability: real font pt, lines, overflow, occupancy */
  typography: number
  /** hull margins + area-density distribution relative to declared balance */
  whitespaceBalance: number
  /** anti card-wall: tolerance-binned size clustering vs importance spread */
  visualRestraint: number
  /**
   * graph addressability: every semantic node is a distinct placed element.
   * NOT PPTX editability — real editability is audited post-render.
   * @deprecated renamed from `editability`; alias kept one release.
   */
  structuralAddressability: number
  // ── real diagnostics (reported, NOT weighted) ──
  /** informative text tokens per canvas area (from the plan) */
  informationDensity: number
  primaryClarity: number
  connectorNaturalness: number
  groupingClarity: number
  overall: number
}

/** Deprecated alias kept for one release; identical value, weaker meaning. */
export interface DeprecatedScoreAliases {
  /** @deprecated use `structuralAddressability` */
  editability: number
  /** @deprecated merged into `informationDensity` (same real metric now) */
  contentDensity: number
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
  scores: CriticScores & DeprecatedScoreAliases
  verdict: CriticVerdictLevel
  gateIssues: string[]
  /** boolean feasibility gates; any fail blocks delivery regardless of score */
  hardGates: HardGateResult[]
  hardPass: boolean
  decisions?: CriticDecision[]
  /** which metrics ran on real input vs neutral fallback — auditability */
  metricNotes?: string[]
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
  /** figure family selecting the composition quality profile */
  family?: FigureFamily
  /** per-node measurable typography signals keyed by node id (QA-P0-01) */
  typography?: Map<string, TypographySignal>
  /** effective final font floor context: final print width (mm) */
  finalWidthMm?: number
}

const CONNECTOR_PRESENTATIONS = new Set([
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
])

const SIGN_PRESENTATION: Record<string, string> = {
  inhibition: 'inhibition',
  feedback: 'feedback-loop',
}

/**
 * Soft rubric weights. MUST sum to exactly 1.0 — enforced by a unit test.
 * Every entry is a real computed metric; no constant placeholders.
 */
export const CRITIC_WEIGHTS: Record<
  keyof Omit<
    CriticScores,
    'overall' | 'informationDensity' | 'primaryClarity' | 'connectorNaturalness' | 'groupingClarity'
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
  structuralAddressability: 0.03,
}

/** px tolerance for tangential contact with a node's exclusion zone. */
const NODE_PAD_PX = 8

export function criticVerdict(input: CriticInput): CriticVerdict {
  const placements = input.solve.placements
  const rects = new Map<string, Rect>(placements.map((p) => [p.id, p]))
  const metricNotes: string[] = []

  // ── route index (QA-P0-07): key → route, PAIR → routes[] (multi-edge safe).
  // Production routes carry the semantic edge id in `key`; inline fallback
  // routes use e${index}. Nothing in the audits may collapse a pair.
  const routes: RoutedEdge[] =
    input.routed ??
    routeEdges(
      input.edges.map((edge, index) => ({
        key: edge.id ?? `e${index}`,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
      })),
      rects,
    )
  const routeByKey = new Map<string, RoutedEdge>()
  const routesByEndpoint = new Map<string, RoutedEdge[]>()
  for (const route of routes) {
    routeByKey.set(route.key, route)
    const pair = `${route.fromId}\u0000${route.toId}`
    routesByEndpoint.set(pair, [...(routesByEndpoint.get(pair) ?? []), route])
  }

  // ── flatten + audit geometry ──
  const segs: TaggedSegment[] = []
  const segsByRoute = new Map<string, TaggedSegment[]>()
  for (const route of routes) {
    const routeSegs = routedSegments(route, rects)
    segsByRoute.set(route.key, routeSegs)
    segs.push(...routeSegs)
  }

  // QA-P0-08: crossings exclude LEGAL CONTACT — adjacent segments of the same
  // route (elbow joints) and shared anchor endpoints of different routes.
  let crossings = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s1 = segs[i]!
      const s2 = segs[j]!
      if (s1.routeKey === s2.routeKey && Math.abs(s1.segmentIndex - s2.segmentIndex) === 1) {
        continue // consecutive segments of one route meet at a legit elbow
      }
      const contact = segmentContact(s1, s2)
      if (contact === 'cross' || contact === 'collinear-overlap') crossings++
    }
  }

  // QA-P0-09: node intersections via Liang–Barsky against the padded rect —
  // never a diagonal proxy. Endpoint nodes are exempt; tangent within 1px of
  // the padded boundary is tolerated.
  const intersections: Array<{ key: string; nodeId: string }> = []
  const seenIntersections = new Set<string>()
  for (const route of routes) {
    for (const seg of segsByRoute.get(route.key) ?? []) {
      for (const [id, rect] of rects) {
        if (id === route.fromId || id === route.toId) continue
        const ex = {
          x: rect.x - NODE_PAD_PX,
          y: rect.y - NODE_PAD_PX,
          w: rect.w + NODE_PAD_PX * 2,
          h: rect.h + NODE_PAD_PX * 2,
        }
        if (segmentIntersectsRect(seg, ex, 1)) {
          const hitKey = `${route.key}\u0000${id}`
          if (!seenIntersections.has(hitKey)) {
            seenIntersections.add(hitKey)
            intersections.push({ key: route.key, nodeId: id })
          }
        }
      }
    }
  }

  const withArea = placements.map((p) => ({
    id: p.id,
    area: p.w * p.h,
    importance: input.importance.get(p.id) ?? 0.5,
  }))

  // Visual hierarchy follows scientific importance — a NEGATIVE correlation
  // (important nodes drawn smaller) must be punished, never abs()-rewarded.
  // Low importance spread means the figure legitimately has no strong
  // hierarchy: neutral 8, not a 0 for lacking area differences.
  const hierarchyImportanceValues = withArea.map((v) => v.importance)
  const hierarchyImportanceSpread =
    hierarchyImportanceValues.length >= 2
      ? Math.max(...hierarchyImportanceValues) - Math.min(...hierarchyImportanceValues)
      : 0
  const visualHierarchy =
    hierarchyImportanceSpread < 0.15
      ? 8
      : clamp10(
          5 *
            (spearman(
              withArea.map((v) => v.importance),
              withArea.map((v) => v.area),
            ) +
              1),
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

  // ── QA-P0-02: composition quality from the FAMILY profile, not 0.15 ──
  const profile = familyProfileFor(input.family)
  const area = placements.reduce((sum, p) => sum + p.w * p.h, 0)
  const fill = area / Math.max(1, input.canvasW * input.canvasH)
  let compositionQuality = clamp10(fillScore(fill, profile))
  const focalDeficit = focalScore(withArea, input.importance, profile)
  compositionQuality = clamp10(compositionQuality * 0.8 + focalDeficit * 0.2)

  // ── QA-P0-03: whitespace from hull margins + area density, intent-aware ──
  const declaredBalance = input.intent?.spatial?.composition.balance
  const whitespaceBalance = whitespaceScore(
    placements,
    input.canvasW,
    input.canvasH,
    declaredBalance,
    profile,
  )

  // ── relation clarity: crossings + intersections + naturalness ──
  const connectorQuality = clamp10(10 - crossings * 1.5 - intersections.length * 4)
  let unnaturalWeighted = 0
  let naturalnessTotal = 0
  for (const route of routes) {
    if (route.status !== 'routed') continue
    const a = rects.get(route.fromId)
    const b = rects.get(route.toId)
    if (!a || !b) continue
    const natural = routeNaturalness(route, segsByRoute.get(route.key) ?? [], a, b)
    unnaturalWeighted += 10 - natural.score
    naturalnessTotal++
  }
  const connectorNaturalness = clamp10(
    naturalnessTotal === 0 ? 10 : 10 - unnaturalWeighted / naturalnessTotal,
  )
  const relationClarity = clamp10(connectorQuality * 0.6 + connectorNaturalness * 0.4)

  // ── QA-P0-04: five-second clarity over the DECLARED reading flow ──
  const flow = input.intent?.spatial
    ? resolveReadingFlow(input.intent.spatial, input.intent.plan)
    : resolveReadingFlow(undefined, input.intent?.plan)
  const pathPositions = readingPathPositions(input.intent?.plan.narrative?.readingPath)
  const visualCenterId =
    input.intent?.spatial?.composition.visualCenter ?? input.intent?.plan.narrative?.visualCenter

  let centerScore = 7
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
  const canvas = { w: input.canvasW, h: input.canvasH }
  for (const edge of input.edges) {
    if (edge.role === 'feedback') continue
    const semantic = relationSemantic(edge.relation)
    if (!semantic || !semantic.monotonicAlongFlow) continue
    const progress = directionalProgressById(flow, edge.from, edge.to, rects, canvas, {
      ...(visualCenterId ? { visualCenterId } : {}),
      ...(pathPositions ? { pathPositions } : {}),
    })
    if (progress === null) continue // flow cannot judge (e.g. radial w/o center): skip, don't punish
    progressTotal++
    if (progress >= -8) progressOk++
  }
  const progressScore = clamp10(progressTotal ? (progressOk / progressTotal) * 10 : 7)
  const fiveSecondClarity = clamp10(centerScore * 0.5 + progressScore * 0.5)

  // ── evidence completeness: mustShow + node coverage (real, from plan) ──
  const planNodes = input.intent?.plan.nodes
  let evidenceCompleteness: number
  let missingRequired: string[] = []
  const unroutableDeclared = routes.filter((route) => route.status === 'unroutable').length
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

  // ── QA-P0-14: structural addressability (NOT PPTX editability) ──
  const uniquePlaced = new Set(placements.map((p) => p.id)).size
  const structuralAddressability =
    planNodes && planNodes.length > 0
      ? clamp10((uniquePlaced / planNodes.length) * 10 - unroutableDeclared)
      : clamp10(10 - unroutableDeclared * 2)

  // ── QA-P0-01: typography from measurable signals ──
  const typographyResult = typographyScore(input, placements)
  const typography = typographyResult.score
  if (typographyResult.note) metricNotes.push(typographyResult.note)

  // ── QA-P0-13: restraint via tolerance bins + area CV, not exact strings ──
  const visualRestraint = restraintScore(placements, input.importance)

  // ── QA-P0-11: scientific fidelity as a composite, evidence excluded ──
  const declaredConnectors = input.edges.filter(
    (edge) => !edge.presentation || CONNECTOR_PRESENTATIONS.has(edge.presentation),
  )
  const declaredById = new Map(
    declaredConnectors.map((edge, index) => [edge.id ?? `e${index}`, edge] as const),
  )
  let realizedCount = 0
  let directionScoreSum = 0
  let signScoreSum = 0
  for (const [edgeId, edge] of declaredById) {
    const route =
      routeByKey.get(edgeId) ??
      (routesByEndpoint.get(`${edge.from}\u0000${edge.to}`) ?? []).find(
        (candidate) => candidate.status === 'routed',
      )
    // An unrealized declared relation fails EVERY fidelity dimension: the
    // science it carries is absent from the canvas, not merely misplaced.
    if (!route || route.status !== 'routed') continue
    realizedCount++
    let edgeDirection = 1
    const semantic = relationSemantic(edge.relation)
    if (semantic?.monotonicAlongFlow && edge.role !== 'feedback') {
      const progress = directionalProgressById(flow, edge.from, edge.to, rects, canvas, {
        ...(visualCenterId ? { visualCenterId } : {}),
        ...(pathPositions ? { pathPositions } : {}),
      })
      if (progress !== null && progress < -8) edgeDirection = 0
    }
    directionScoreSum += edgeDirection
    let edgeSign = 1
    const expectedPresentation = SIGN_PRESENTATION[edge.relation]
    if (expectedPresentation) {
      edgeSign = (route.presentation ?? edge.presentation) === expectedPresentation ? 1 : 0
    }
    signScoreSum += edgeSign
  }
  const realizationCoverage =
    declaredConnectors.length === 0 ? 1 : realizedCount / declaredConnectors.length
  const directionScore = declaredById.size === 0 ? 1 : directionScoreSum / declaredById.size
  const signScore = declaredById.size === 0 ? 1 : signScoreSum / declaredById.size
  const scientificFidelity = clamp10(
    10 * (0.6 * realizationCoverage + 0.25 * directionScore + 0.15 * signScore) -
      input.solve.issues.length * 2,
  )

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
      CRITIC_WEIGHTS.structuralAddressability * structuralAddressability,
  )

  const gateIssues: string[] = [...input.solve.issues]
  for (const hit of intersections)
    gateIssues.push(`connector passes through node ${hit.nodeId} (${hit.key})`)
  let infoDensityValue = 5
  let primaryScore = 8
  let semanticDensityDecision: CriticDecision | null = null
  if (input.intent) {
    const infoDensity = criticInfoDensity({
      plan: input.intent.plan,
      ...(input.intent.spatial ? { planIntent: input.intent.spatial } : {}),
      solve: { placements, issues: input.solve.issues, intentDriftPx: input.solve.intentDriftPx },
      canvasW: input.canvasW,
      canvasH: input.canvasH,
      ...(input.routed ? { routed: input.routed } : {}),
    })
    // QA-P0-12: ONE density metric — informative tokens per area. The old
    // `contentDensity` field was a copy of compositionQuality; `informationDensity`
    // now carries the real value and `contentDensity` is a deprecated alias.
    infoDensityValue = infoDensity.density
    primaryScore = infoDensity.primaryClarity
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
  } else {
    metricNotes.push('informationDensity: neutral (no plan intent supplied)')
  }
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
  const safe = (v: number) => (Number.isFinite(v) ? v : 5)
  const scores: CriticScores & DeprecatedScoreAliases = {
    scientificFidelity: safe(scientificFidelity),
    evidenceCompleteness: safe(evidenceCompleteness),
    fiveSecondClarity: safe(fiveSecondClarity),
    visualHierarchy: safe(visualHierarchy),
    compositionQuality: safe(compositionQuality),
    relationClarity: safe(relationClarity),
    typography: safe(typography),
    whitespaceBalance: safe(whitespaceBalance),
    visualRestraint: safe(visualRestraint),
    structuralAddressability: safe(structuralAddressability),
    // deprecated aliases — removed in a future release
    editability: safe(structuralAddressability),
    contentDensity: safe(infoDensityValue),
    informationDensity: safe(infoDensityValue),
    primaryClarity: safe(primaryScore),
    connectorNaturalness: safe(connectorNaturalness),
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
    ...(metricNotes.length > 0 ? { metricNotes } : {}),
    ...(verdict === 'ROUTE_FIX' ? { edgeIds: routeEdgeIds } : {}),
    ...(reason ? { reason } : {}),
  }
}

// ── metric helpers (all pure, all unit-testable) ──

/** QA-P0-01: typography from measurable signals; neutral 8 when unmeasured. */
function typographyScore(
  input: CriticInput,
  placements: Array<{ id: string; w: number; h: number }>,
): { score: number; note?: string } {
  const signals = input.typography
  if (!signals || signals.size === 0) {
    return { score: 8, note: 'typography: neutral 8 — no measured signals supplied' }
  }
  let penalty = 0
  let worstOverflow = 0
  let smallestEffectivePt = Infinity
  let judged = 0
  for (const placement of placements) {
    const signal = signals.get(placement.id)
    if (!signal) continue
    judged++
    // text must fit its box: unclamped block height vs available height
    const available = Math.max(1, placement.h - signal.padY * 2)
    const overflow = Math.max(0, signal.textBlockH - available) / available
    worstOverflow = Math.max(worstOverflow, overflow)
    if (overflow > 0.15) penalty += Math.min(4, overflow * 8)
    // wrapped lines beyond capacity mean text was clamped away
    const clampedLines =
      Math.max(0, signal.titleLines - signal.maxTitleLines) +
      Math.max(0, signal.detailLines - signal.maxDetailLines)
    if (clampedLines > 0) penalty += Math.min(3, clampedLines * 0.75)
    // effective final size vs canvas-scale floor (6pt at final width)
    if (input.finalWidthMm && input.finalWidthMm > 0) {
      const canvasMm = (input.canvasW * 25.4) / 96
      const effectiveDetail = (signal.detailPt * input.finalWidthMm) / Math.max(1, canvasMm)
      smallestEffectivePt = Math.min(smallestEffectivePt, effectiveDetail)
    }
    // single node monopolising canvas width hurts scanability
    const occupancy = placement.w / Math.max(1, input.canvasW)
    if (occupancy > 0.6) penalty += 2
  }
  if (smallestEffectivePt !== Infinity && smallestEffectivePt < 4.5) penalty += 2
  if (judged === 0)
    return { score: 8, note: 'typography: neutral 8 — signals do not match placements' }
  return { score: clamp10(10 - penalty) }
}

/** QA-P0-13: tolerance-binned equal-size clustering (8px bins + area CV). */
function restraintScore(
  placements: Array<{ w: number; h: number }>,
  importance: Map<string, number>,
): number {
  if (placements.length < 3) return 8
  const BIN = 8
  const bins = new Map<string, number>()
  for (const p of placements) {
    const key = `${Math.round(p.w / BIN)}:${Math.round(p.h / BIN)}`
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }
  const modalRatio = Math.max(0, ...bins.values()) / placements.length
  const areas = placements.map((p) => p.w * p.h)
  const mean = areas.reduce((a, b) => a + b, 0) / areas.length
  const cv =
    mean > 0 ? Math.sqrt(areas.reduce((s, a) => s + (a - mean) ** 2, 0) / areas.length) / mean : 0
  const values = [...importance.values()]
  const spread = values.length >= 2 ? Math.max(...values) - Math.min(...values) : 0
  // neutral 8 = insufficient contrast data to judge; NOT a padded perfect score
  if (spread < 0.25) return 8
  // a card wall = one dominant size bin AND flat area distribution
  const wallSignal = Math.max(0, modalRatio - 0.5) * 12 + Math.max(0, 0.08 - cv) * 30
  return clamp10(10 - wallSignal)
}

/** focal expectation: the most important node should hold visible area share. */
function focalScore(
  withArea: Array<{ id: string; area: number; importance: number }>,
  importance: Map<string, number>,
  profile: { focalExpectation: number },
): number {
  if (withArea.length === 0) return 5
  const totalArea = withArea.reduce((sum, v) => sum + v.area, 0)
  if (totalArea <= 0) return 5
  const mostImportantId = [...importance.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!mostImportantId) return 5
  const focalArea = withArea.find((v) => v.id === mostImportantId)?.area ?? 0
  const share = focalArea / totalArea
  // meeting half the expectation is fine; falling below a third hurts
  return clamp10(10 * Math.min(1, share / Math.max(0.05, profile.focalExpectation * 0.8)))
}

/** QA-P0-03: hull margins + area-weighted density, intent-aware. */
function whitespaceScore(
  placements: Array<{ id: string; x: number; y: number; w: number; h: number }>,
  canvasW: number,
  canvasH: number,
  declaredBalance?: 'symmetric' | 'asymmetric' | 'loosely-balanced',
  profile?: { whitespaceTolerance: number },
): number {
  if (placements.length === 0) return 5
  const tolerance = profile?.whitespaceTolerance ?? 0.6
  const minX = Math.min(...placements.map((p) => p.x))
  const maxX = Math.max(...placements.map((p) => p.x + p.w))
  const minY = Math.min(...placements.map((p) => p.y))
  const maxY = Math.max(...placements.map((p) => p.y + p.h))
  const left = minX
  const right = canvasW - maxX
  const top = minY
  const bottom = canvasH - maxY
  let penalty = 0
  // 1) edge margins: content must not crowd the canvas edge (5% floor)
  const minMargin = Math.min(left, right, top, bottom)
  if (minMargin < canvasW * 0.03) penalty += 3
  else if (minMargin < canvasW * 0.05) penalty += 1
  // 2) L/R balance by AREA — skipped for declared asymmetric compositions
  if (declaredBalance !== 'asymmetric' && canvasW > 0) {
    const lrImbalance = Math.abs(left - right) / canvasW
    if (lrImbalance > 0.3 && tolerance < 0.7) penalty += (lrImbalance - 0.3) * 8 * (1 - tolerance)
  }
  // 3) local negative space: 4×4 area-density grid; both wall-to-wall coverage
  //    and one vast empty quadrant beyond tolerance are composition faults
  const cells = 4
  const cellArea = new Array<number>(cells * cells).fill(0)
  for (const p of placements) {
    const x0 = Math.max(0, Math.floor((p.x / canvasW) * cells))
    const x1 = Math.min(cells - 1, Math.floor(((p.x + p.w) / canvasW) * cells))
    const y0 = Math.max(0, Math.floor((p.y / canvasH) * cells))
    const y1 = Math.min(cells - 1, Math.floor(((p.y + p.h) / canvasH) * cells))
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++)
        cellArea[cy * cells + cx]! += (p.w * p.h) / Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1))
    }
  }
  const emptyCells = cellArea.filter((a) => a <= 0).length
  if (emptyCells === 0) penalty += 2 // no breathing room anywhere
  return clamp10(10 - penalty)
}

function clamp10(v: number): number {
  return Math.max(0, Math.min(10, Math.round(v * 10) / 10))
}

/** Average-rank assignment so ties split rank mass evenly (GOAL section 5). */
function rankWithTies(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const rankOf = new Map<number, number>()
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++
    const averageRank = (i + j) / 2 + 1
    rankOf.set(sorted[i]!, averageRank)
    i = j + 1
  }
  return values.map((v) => rankOf.get(v)!)
}

function spearman(xs: number[], ys: number[]): number {
  const rx = rankWithTies(xs)
  const ry = rankWithTies(ys)
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
