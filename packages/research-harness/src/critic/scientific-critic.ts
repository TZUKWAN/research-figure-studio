/**
 * Scientific Critic (17.3, deterministic core; QA deep-fix rewrite).
 *
 * Runs AFTER routing against the FINAL canvas state and audits scientific
 * integrity, separate from the geometric/metric critic:
 *   - required evidence visible (hard → SEMANTIC_REPLAN)
 *   - declared connector relations actually realized BY EDGE ID
 *     (hard → ROUTE_FIX) — multi-edges between one pair never collapse
 *   - reading direction monotonicity for LR / RL / TB / BT / radial /
 *     mixed+readingPath (soft → COMPOSITION_REDESIGN)
 *   - relation contradiction + causal-cycle policy (soft, structured only)
 *   - orphan evidence / output / annotation (soft, role aware)
 *   - duplicate labels scoped to groups/panels (soft → CONTENT_REDUCE)
 *   - multi-signal dominance (area + centrality + size) (soft)
 *
 * Vision-based scientific review stays in the app-level QC loop; this module
 * is pure arithmetic so the pipeline can gate without a model.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { SemanticEdge } from '../semantic/schema.js'
import type { RoutedEdge } from '../routing/router.js'
import type { Rect } from '../routing/geometry.js'
import type { ScientificDomain } from '../contract/domain-profile.js'
import type { FigureFamily } from '../contract/figure-contract.js'
import { RELATION_SEMANTICS } from '../semantic/relation-semantics.js'
import {
  directionalProgressById,
  isReadingFlow,
  resolveReadingFlow,
  readingPathPositions,
  type ReadingFlow,
} from './reading-flow.js'

export type ScientificRepairClass =
  | 'SEMANTIC_REPLAN'
  | 'CONTENT_REDUCE'
  | 'COMPOSITION_REDESIGN'
  | 'TYPOGRAPHY_FIX'
  | 'GEOMETRY_FIX'
  | 'ROUTE_FIX'

export interface ScientificIssue {
  severity: 'hard' | 'soft'
  repairClass: ScientificRepairClass
  message: string
  affectedIds: string[]
}

export function auditScientific(input: {
  plan: FigurePlanV2
  placements: Array<{ id: string; x: number; y: number; w: number; h: number }>
  routes?: RoutedEdge[]
  importance?: Map<string, number>
  /** full reading flow; LR remains the default for legacy callers */
  direction?: ReadingFlow | 'LR' | 'TB'
  spatial?: import('../composition/spatial-plan.js').SpatialPlan
  family?: FigureFamily
  domain?: ScientificDomain
}): ScientificIssue[] {
  const issues: ScientificIssue[] = []
  const placedIds = new Set(input.placements.map((p) => p.id))
  const narrative = input.plan.narrative
  const rectById = new Map<string, Rect>(input.placements.map((p) => [p.id, p]))
  const edges: SemanticEdge[] = input.plan.edges

  // 1) required evidence must be on canvas — hard gate
  const mustShow = narrative?.mustShow ?? []
  const missingEvidence = mustShow.filter((id) => !placedIds.has(id))
  if (missingEvidence.length > 0) {
    issues.push({
      severity: 'hard',
      repairClass: 'SEMANTIC_REPLAN',
      message: `required evidence missing from canvas: ${missingEvidence.join(', ')}`,
      affectedIds: missingEvidence,
    })
  }

  // 2) declared connector relations must be realized — QA-P0-07: index by
  // edge id (falling back to the endpoint MULTI-map, not an overwrite map),
  // so several relations between one pair stay distinct.
  const routeById = new Map<string, RoutedEdge>()
  const routesByEndpoint = new Map<string, RoutedEdge[]>()
  for (const route of input.routes ?? []) {
    if (route.semanticEdgeId) routeById.set(route.semanticEdgeId, route)
    if (route.key) routeById.set(route.key, route)
    const pair = `${route.fromId}\u0000${route.toId}`
    routesByEndpoint.set(pair, [...(routesByEndpoint.get(pair) ?? []), route])
  }
  const connectorPresentations = new Set([
    'arrow',
    'line',
    'dashed-arrow',
    'inhibition',
    'feedback-loop',
    'junction',
  ])
  const unrealized: string[] = []
  for (const edge of edges) {
    const presentation = edge.presentation ?? 'arrow'
    if (!connectorPresentations.has(presentation)) continue
    const route = routeForEdge(edge, routeById, routesByEndpoint)
    if (!route || route.status !== 'routed') {
      unrealized.push(edge.id ?? `${edge.from}->${edge.to}`)
    }
  }
  if (unrealized.length > 0) {
    issues.push({
      severity: 'hard',
      repairClass: 'ROUTE_FIX',
      message: `declared scientific connectors not realized on canvas: ${unrealized.join(', ')}`,
      affectedIds: unrealized,
    })
  }

  // 3) QA-P0-05: causal direction advances along the DECLARED reading flow —
  // LR / RL / TB / BT geometrically, radial by distance rings around the
  // visual center, mixed via the declared readingPath. Priority: the solved
  // spatial plan wins, then the explicit direction argument, then the plan's
  // readingIntent, then LR. A flow that cannot decide (radial without a
  // center) is skipped, never misjudged.
  const flow: ReadingFlow = input.spatial
    ? resolveReadingFlow(input.spatial, input.plan)
    : isReadingFlow(input.direction ?? input.plan.readingIntent?.preferredDirection)
      ? (input.direction ?? input.plan.readingIntent!.preferredDirection!)
      : 'LR'
  const pathPositions = readingPathPositions(narrative?.readingPath)
  const backwards: string[] = []
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    const semantic = RELATION_SEMANTICS[edge.relation]
    if (!semantic || !semantic.monotonicAlongFlow) continue
    const progress = directionalProgressById(
      flow,
      edge.from,
      edge.to,
      rectById,
      canvasOf(input.placements),
      {
        ...(input.spatial?.composition.visualCenter
          ? { visualCenterId: input.spatial.composition.visualCenter }
          : {}),
        ...(pathPositions ? { pathPositions } : {}),
      },
    )
    if (progress === null) continue
    if (progress < -80) backwards.push(edge.id ?? `${edge.from}->${edge.to}`)
  }
  if (backwards.length > 0) {
    issues.push({
      severity: 'soft',
      repairClass: 'COMPOSITION_REDESIGN',
      message: `directional relations read backwards against the ${flow} flow: ${backwards.join(', ')}`,
      affectedIds: backwards,
    })
  }

  // 4) QA-P1-01: relation contradiction audits — structured semantics ONLY.
  issues.push(...contradictionIssues(edges))

  // 5) QA-P1-02: causal cycle policy. Feedback cycles are legitimate systems;
  // a causal cycle without any feedback declaration is a modelling error.
  issues.push(...cycleIssues(edges, input.family))

  // 6) QA-P1-03: orphan evidence / outputs / annotations — role aware, and
  // skipped entirely for deliberate minimal statements.
  issues.push(...orphanIssues(input.plan, narrative?.visualCenter))

  // 7) QA-P1-04: duplicate visible titles scoped to their group/panel.
  issues.push(...duplicateTitleIssues(input.plan))

  // 8) QA-P1-05: dominance from multiple deterministic signals — area,
  // centrality, and placement size rank. The final visual verdict belongs to
  // the Vision Critic; this only catches gross area-only averaging.
  const importance = input.importance
  if (importance && importance.size >= 2 && input.placements.length >= 2) {
    const values = [...importance.values()]
    const spread = Math.max(...values) - Math.min(...values)
    if (spread >= 0.3) {
      const mostImportantId = [...importance.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      const dominanceRank = combinedDominanceRank(mostImportantId, input.placements)
      if (dominanceRank > Math.max(2, Math.ceil(input.placements.length / 3))) {
        issues.push({
          severity: 'soft',
          repairClass: 'COMPOSITION_REDESIGN',
          message: `most important node "${mostImportantId}" ranks #${dominanceRank} by combined visual dominance — information averaging detected`,
          affectedIds: [mostImportantId],
        })
      }
    }
  }

  return issues
}

function canvasOf(placements: Array<{ x: number; y: number; w: number; h: number }>): {
  w: number
  h: number
} {
  const maxX = Math.max(0, ...placements.map((p) => p.x + p.w))
  const maxY = Math.max(0, ...placements.map((p) => p.y + p.h))
  return { w: maxX, h: maxY }
}

/**
 * QA-P0-07: resolve the route for a declared edge. Semantic edge ids are the
 * primary key; the endpoint fallback exists ONLY for legacy callers whose
 * routes carry no semanticEdgeId at all — otherwise a sibling route on the
 * same pair would mask an unrealized edge.
 */
function routeForEdge(
  edge: SemanticEdge,
  routeById: Map<string, RoutedEdge>,
  routesByEndpoint: Map<string, RoutedEdge[]>,
): RoutedEdge | undefined {
  const byId = edge.id ? routeById.get(edge.id) : undefined
  if (byId) return byId
  const pairRoutes = routesByEndpoint.get(`${edge.from}\u0000${edge.to}`) ?? []
  const idsInUse = pairRoutes.some((route) => route.semanticEdgeId)
  if (edge.id && idsInUse) return undefined
  return pairRoutes[0]
}

const POSITIVE_RELATIONS = new Set(['causal', 'promotion', 'mediation'])

/**
 * QA-P1-01: finite, deterministic contradiction checks over structured
 * semantics — never free-text reasoning. Promotion/causal and inhibition on
 * the same ordered pair is only contradictory when no label distinguishes
 * the conditions; opposite edges on one pair are checked against
 * `allowsInverse` from RELATION_SEMANTICS.
 */
export function contradictionIssues(edges: SemanticEdge[]): ScientificIssue[] {
  const found: ScientificIssue[] = []
  const byPair = new Map<string, SemanticEdge[]>()
  for (const edge of edges) {
    const key = `${edge.from}\u0000${edge.to}`
    byPair.set(key, [...(byPair.get(key) ?? []), edge])
  }
  for (const pairEdges of byPair.values()) {
    const hasPositive = pairEdges.some((e) => POSITIVE_RELATIONS.has(e.relation))
    const hasNegative = pairEdges.some((e) => e.relation === 'inhibition')
    if (hasPositive && hasNegative) {
      const labeled = pairEdges.filter((e) => (e.label ?? '').trim().length > 0)
      if (labeled.length < 2) {
        found.push({
          severity: 'soft',
          repairClass: 'SEMANTIC_REPLAN',
          message: `contradictory relations (${pairEdges.map((e) => e.relation).join(' + ')}) between "${pairEdges[0]!.from}" and "${pairEdges[0]!.to}" without condition labels`,
          affectedIds: pairEdges.map((e) => e.id ?? `${e.from}->${e.to}`),
        })
      }
    }
    const inverse = `${pairEdges[0]!.to}\u0000${pairEdges[0]!.from}`
    if (byPair.has(inverse)) {
      for (const edge of pairEdges) {
        const semantic = RELATION_SEMANTICS[edge.relation]
        const mirror = byPair
          .get(inverse)!
          .find((candidate) => candidate.relation === edge.relation)
        if (semantic && !semantic.allowsInverse && mirror) {
          found.push({
            severity: 'soft',
            repairClass: 'SEMANTIC_REPLAN',
            message: `mutual "${edge.relation}" relations between "${edge.from}" and "${edge.to}" — declare feedback/bidirectional instead`,
            affectedIds: [
              edge.id ?? `${edge.from}->${edge.to}`,
              mirror.id ?? `${mirror.from}->${mirror.to}`,
            ],
          })
        }
      }
    }
  }
  return found
}

const CYCLE_RELATIONS = new Set([
  'causal',
  'process',
  'transformation',
  'data-flow',
  'promotion',
  'mediation',
])
const CYCLE_TOLERANT_FAMILIES = new Set<string>([
  'network',
  'freeform',
  'experimental-setup',
  'outreach',
])

/** QA-P1-02: cycles among strictly directed relations need feedback intent. */
export function cycleIssues(edges: SemanticEdge[], family?: FigureFamily): ScientificIssue[] {
  const found: ScientificIssue[] = []
  const directed = edges.filter(
    (edge) =>
      edge.role !== 'feedback' &&
      edge.relation !== 'feedback' &&
      CYCLE_RELATIONS.has(edge.relation),
  )
  // DFS cycle detection over the directed subgraph
  const adj = new Map<string, string[]>()
  for (const edge of directed) {
    adj.set(edge.from, [...(adj.get(edge.from) ?? []), edge.to])
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const report = new Set<string>()
  const visit = (node: string): void => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of adj.get(node) ?? []) {
      const nodeState = state.get(next)
      if (nodeState === 'visiting') {
        const cycleStart = stack.indexOf(next)
        report.add(stack.slice(cycleStart).join(' -> '))
      } else if (!nodeState) {
        visit(next)
      }
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const node of adj.keys()) {
    if (!state.has(node)) visit(node)
  }
  if (report.size > 0 && !CYCLE_TOLERANT_FAMILIES.has(family ?? '')) {
    found.push({
      severity: 'soft',
      repairClass: 'SEMANTIC_REPLAN',
      message: `directed cycle without a declared feedback relation: ${[...report].join('; ')}`,
      affectedIds: [...report],
    })
  }
  return found
}

/**
 * QA-P1-03: orphans. Evidence must connect to something; outputs without any
 * incoming connector are unfinished; annotations must hang off a target or
 * be the declared visual center. Context nodes may legitimately stand alone.
 * Deliberate minimal statements are exempt from every orphan check.
 */
export function orphanIssues(plan: FigurePlanV2, visualCenter?: string): ScientificIssue[] {
  const narrative = plan.narrative
  if (narrative?.expressionMode === 'statement' && narrative?.complexity === 'minimal') {
    return []
  }
  const found: ScientificIssue[] = []
  const connected = new Set<string>()
  for (const edge of plan.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  const orphanEvidence = plan.nodes.filter(
    (node) => node.type === 'evidence' && !connected.has(node.id),
  )
  if (orphanEvidence.length > 0) {
    found.push({
      severity: 'soft',
      repairClass: 'SEMANTIC_REPLAN',
      message: `evidence nodes with no relation to any claim: ${orphanEvidence.map((n) => n.id).join(', ')}`,
      affectedIds: orphanEvidence.map((n) => n.id),
    })
  }
  const outputNodes = plan.nodes.filter((node) => node.role === 'output')
  const hasIncoming = new Set(plan.edges.map((edge) => edge.to))
  const fedLess = outputNodes.filter((node) => !hasIncoming.has(node.id))
  if (outputNodes.length > 1 && fedLess.length === outputNodes.length) {
    found.push({
      severity: 'soft',
      repairClass: 'SEMANTIC_REPLAN',
      message: `no output node receives any relation: ${fedLess.map((n) => n.id).join(', ')}`,
      affectedIds: fedLess.map((n) => n.id),
    })
  }
  const floatingAnnotations = plan.nodes.filter(
    (node) => node.type === 'annotation' && !connected.has(node.id) && node.id !== visualCenter,
  )
  if (floatingAnnotations.length > 0) {
    found.push({
      severity: 'soft',
      repairClass: 'COMPOSITION_REDESIGN',
      message: `annotations without a target: ${floatingAnnotations.map((n) => n.id).join(', ')}`,
      affectedIds: floatingAnnotations.map((n) => n.id),
    })
  }
  return found
}

/**
 * QA-P1-04: duplicates inside one group/panel merge; identical titles in
 * DIFFERENT declared groups are legitimate comparison labels.
 */
export function duplicateTitleIssues(plan: FigurePlanV2): ScientificIssue[] {
  const found: ScientificIssue[] = []
  const seen = new Map<string, Set<string>>()
  for (const node of plan.nodes) {
    const title = node.visible.title.trim()
    if (!title) continue
    const scope = node.groupId ?? '__global__'
    seen.set(title, (seen.get(title) ?? new Set()).add(scope))
  }
  const ambiguous: string[] = []
  for (const [title, scopes] of seen) {
    if (scopes.size > 1 && scopes.has('__global__')) {
      // same title both inside a named group and outside it
      ambiguous.push(title)
    } else if (scopes.size === 1 && scopes.has('__global__')) {
      const count = plan.nodes.filter((node) => node.visible.title.trim() === title).length
      if (count > 1) ambiguous.push(title)
    }
  }
  if (ambiguous.length > 0) {
    found.push({
      severity: 'soft',
      repairClass: 'CONTENT_REDUCE',
      message: `duplicate visible labels should merge: ${ambiguous.join(', ')}`,
      affectedIds: ambiguous,
    })
  }
  return found
}

/**
 * QA-P1-05: combined deterministic dominance. PERCENTILE RANKS of area and
 * centrality combine centrality-first (0.55/0.45): in a canvas, sitting at
 * the compositional center is the strongest static dominance signal, area
 * the second. The final visual verdict belongs to the Vision Critic; this
 * only catches gross information averaging.
 */
export function combinedDominanceRank(
  nodeId: string,
  placements: Array<{ id: string; x: number; y: number; w: number; h: number }>,
): number {
  if (placements.length === 0) return 0
  // hull center from true bounding extremes (left/right edges, not centers)
  const cx =
    (Math.min(...placements.map((p) => p.x)) + Math.max(...placements.map((p) => p.x + p.w))) / 2
  const cy =
    (Math.min(...placements.map((p) => p.y)) + Math.max(...placements.map((p) => p.y + p.h))) / 2
  const distances = placements.map((p) => Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy))
  const areas = placements.map((p) => p.w * p.h)
  const rankOf = (values: number[], value: number, ascending: boolean): number => {
    const sorted = [...values].sort((a, b) => (ascending ? a - b : b - a))
    const idx = sorted.indexOf(value)
    return values.length <= 1 ? 1 : 1 - idx / (values.length - 1)
  }
  const scored = placements.map((p, i) => {
    const areaRank = rankOf(areas, areas[i]!, false)
    // centrality rank: NEARER the hull center is better → ascending distance
    const centralityRank = rankOf(distances, distances[i]!, true)
    return { id: p.id, dominance: 0.45 * areaRank + 0.55 * centralityRank }
  })
  scored.sort((a, b) => b.dominance - a.dominance)
  return scored.findIndex((entry) => entry.id === nodeId) + 1
}
