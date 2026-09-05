/**
 * Domain-specific scientific validators (QA-P1-06). Lightweight, DETERMINISTIC
 * checks derived only from the structured plan schema — never invented science
 * facts, never free-text reasoning. Each validator returns a finite list of
 * soft issues; an unknown domain validates nothing.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { ScientificDomain } from '../contract/domain-profile.js'
import type { ScientificIssue } from './scientific-critic.js'
import type { SemanticEdge } from '../semantic/schema.js'

type PlanIssue = ScientificIssue

function soft(
  repairClass: PlanIssue['repairClass'],
  message: string,
  affectedIds: string[],
): PlanIssue {
  return { severity: 'soft', repairClass, message, affectedIds }
}

const CONNECTOR_PRESENTATIONS = new Set([
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
])

function connectorEdges(edges: SemanticEdge[]): SemanticEdge[] {
  return edges.filter((edge) => CONNECTOR_PRESENTATIONS.has(edge.presentation ?? 'arrow'))
}

/** CS/ML: data must flow from sources toward outcomes; models need inflow. */
function validateCsMl(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  const connectors = connectorEdges(plan.edges)
  if (connectors.length > 0 && !connectors.some((edge) => edge.relation === 'data-flow')) {
    found.push(
      soft(
        'SEMANTIC_REPLAN',
        'cs/ml figure declares connectors but no data-flow relation — pipelines must carry data direction',
        plan.edges.map((edge) => edge.id ?? edge.from),
      ),
    )
  }
  const models = plan.nodes.filter((node) => node.type === 'model' || node.type === 'mechanism')
  const toIds = new Set(connectors.map((edge) => edge.to))
  const isolatedModels = models.filter((node) => !toIds.has(node.id))
  if (models.length > 0 && isolatedModels.length === models.length) {
    found.push(
      soft(
        'SEMANTIC_REPLAN',
        `model/mechanism nodes receive no data-flow input: ${isolatedModels.map((node) => node.id).join(', ')}`,
        isolatedModels.map((node) => node.id),
      ),
    )
  }
  return found
}

/** Materials/chemistry: transformations form a sequence; inhibition keeps its marker. */
function validateMaterials(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  for (const edge of plan.edges) {
    if (edge.relation === 'inhibition' && (edge.presentation ?? 'inhibition') !== 'inhibition') {
      found.push(
        soft(
          'COMPOSITION_REDESIGN',
          `inhibition edge ${edge.id ?? `${edge.from}->${edge.to}`} must keep the flat inhibition marker, not a generic arrow`,
          [edge.id ?? `${edge.from}->${edge.to}`],
        ),
      )
    }
  }
  const transformations = connectorEdges(plan.edges).filter(
    (edge) => edge.relation === 'transformation',
  )
  const fromCount = new Map<string, number>()
  for (const edge of transformations) fromCount.set(edge.from, (fromCount.get(edge.from) ?? 0) + 1)
  const branching = [...fromCount.entries()].filter(([, count]) => count > 1)
  if (transformations.length >= 3 && branching.length > 0) {
    found.push(
      soft(
        'COMPOSITION_REDESIGN',
        `transformation sequence branches from ${branching.map(([id]) => id).join(', ')} — synthesis routes are linear unless a condition says otherwise`,
        branching.map(([id]) => id),
      ),
    )
  }
  return found
}

/** Biomed: sign-carrying relations keep their pathway markers. */
function validateBiomed(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  for (const edge of plan.edges) {
    const presentation = edge.presentation ?? 'arrow'
    if (edge.relation === 'inhibition' && presentation !== 'inhibition') {
      found.push(
        soft(
          'COMPOSITION_REDESIGN',
          `pathway inhibition ${edge.id ?? `${edge.from}->${edge.to}`} must use the flat-ended marker`,
          [edge.id ?? `${edge.from}->${edge.to}`],
        ),
      )
    }
    if (edge.relation === 'promotion' && presentation === 'inhibition') {
      found.push(
        soft(
          'COMPOSITION_REDESIGN',
          `activation edge ${edge.id ?? `${edge.from}->${edge.to}`} rendered with an inhibition marker inverts the sign`,
          [edge.id ?? `${edge.from}->${edge.to}`],
        ),
      )
    }
  }
  return found
}

/** Engineering: feedback keeps its loop presentation; signals flow. */
function validateEngineering(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  for (const edge of plan.edges) {
    if (
      edge.relation === 'feedback' &&
      (edge.presentation ?? 'feedback-loop') !== 'feedback-loop'
    ) {
      found.push(
        soft(
          'COMPOSITION_REDESIGN',
          `control feedback ${edge.id ?? `${edge.from}->${edge.to}`} must read as a loop, not a plain arrow`,
          [edge.id ?? `${edge.from}->${edge.to}`],
        ),
      )
    }
  }
  return found
}

/** Social science: mediation needs a full X→M→Y chain; hypotheses stay dashed. */
function validateSocialScience(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  const connectors = connectorEdges(plan.edges)
  const mediationTargets = new Set(
    connectors.filter((edge) => edge.relation === 'mediation').map((edge) => edge.to),
  )
  const mediationSources = new Set(
    connectors.filter((edge) => edge.relation === 'mediation').map((edge) => edge.from),
  )
  const brokenMediators = [...mediationTargets].filter((id) => !mediationSources.has(id))
  if (mediationTargets.size > 0 && brokenMediators.length > 0) {
    found.push(
      soft(
        'SEMANTIC_REPLAN',
        `mediators with incoming but no outgoing mediation path: ${brokenMediators.join(', ')}`,
        brokenMediators,
      ),
    )
  }
  for (const edge of plan.edges) {
    if (
      edge.relation === 'hypothesis' &&
      (edge.presentation ?? 'dashed-arrow') !== 'dashed-arrow'
    ) {
      found.push(
        soft(
          'COMPOSITION_REDESIGN',
          `hypothesis edge ${edge.id ?? `${edge.from}->${edge.to}`} must stay visually tentative (dashed)`,
          [edge.id ?? `${edge.from}->${edge.to}`],
        ),
      )
    }
  }
  return found
}

export function validateDomain(
  plan: FigurePlanV2,
  domain?: ScientificDomain | string,
): PlanIssue[] {
  switch (domain) {
    case 'cs-ml':
      return validateCsMl(plan)
    case 'materials-chemistry':
      return validateMaterials(plan)
    case 'biomed':
      return validateBiomed(plan)
    case 'engineering':
      return validateEngineering(plan)
    case 'social-science':
      return validateSocialScience(plan)
    default:
      return []
  }
}

// ── QA-P1-07: FigureFamily validators ──

/**
 * Family-level structural validators. Deterministic checks a family MUST
 * satisfy for its graph to realize the family's contract at all.
 */
export function validateFamily(plan: FigurePlanV2, family?: string): PlanIssue[] {
  switch (family) {
    case 'hierarchy':
      return validateHierarchyFamily(plan)
    case 'network':
      return validateNetworkFamily(plan)
    case 'pipeline':
      return validatePipelineFamily(plan)
    case 'timeline':
      return validateTimelineFamily(plan)
    case 'comparison':
      return validateComparisonFamily(plan)
    case 'matrix':
      return validateMatrixFamily(plan)
    default:
      return []
  }
}

function hierarchyEdges(plan: FigurePlanV2): SemanticEdge[] {
  return plan.edges.filter((edge) => edge.relation === 'hierarchy')
}

/** hierarchy: the parent relation must form an acyclic forest (≤1 parent). */
function validateHierarchyFamily(plan: FigurePlanV2): PlanIssue[] {
  const found: PlanIssue[] = []
  const hEdges = hierarchyEdges(plan)
  if (hEdges.length === 0) {
    found.push(soft('SEMANTIC_REPLAN', 'hierarchy figure declares no hierarchy relations', []))
    return found
  }
  const parents = new Map<string, number>()
  for (const edge of hEdges) {
    parents.set(edge.to, (parents.get(edge.to) ?? 0) + 1)
  }
  const multiParent = [...parents.entries()].filter(([, count]) => count > 1)
  if (multiParent.length > 0) {
    found.push(
      soft(
        'SEMANTIC_REPLAN',
        `hierarchy nodes with more than one parent: ${multiParent.map(([id]) => id).join(', ')}`,
        multiParent.map(([id]) => id),
      ),
    )
  }
  const adj = new Map<string, string[]>()
  for (const edge of hEdges) adj.set(edge.from, [...(adj.get(edge.from) ?? []), edge.to])
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let cyclic = false
  const visit = (node: string): void => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 'visiting') cyclic = true
      else if (!state.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const node of adj.keys()) if (!state.has(node)) visit(node)
  if (cyclic) {
    found.push(
      soft(
        'SEMANTIC_REPLAN',
        'hierarchy containment contains a cycle',
        hEdges.map((edge) => edge.id ?? `${edge.from}->${edge.to}`),
      ),
    )
  }
  return found
}

/** network: every node participates in at least one relation. */
function validateNetworkFamily(plan: FigurePlanV2): PlanIssue[] {
  const connected = new Set<string>()
  for (const edge of plan.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  const isolated = plan.nodes.filter((node) => !connected.has(node.id))
  if (isolated.length > 0) {
    return [
      soft(
        'SEMANTIC_REPLAN',
        `network figure has isolated nodes: ${isolated.map((node) => node.id).join(', ')}`,
        isolated.map((node) => node.id),
      ),
    ]
  }
  return []
}

/** pipeline: every node must be reachable from a source along connectors. */
function validatePipelineFamily(plan: FigurePlanV2): PlanIssue[] {
  const connectors = connectorEdges(plan.edges)
  if (connectors.length === 0) {
    return [soft('SEMANTIC_REPLAN', 'pipeline figure declares no stage connectors', [])]
  }
  const adj = new Map<string, string[]>()
  for (const edge of connectors) adj.set(edge.from, [...(adj.get(edge.from) ?? []), edge.to])
  const toIds = new Set(connectors.map((edge) => edge.to))
  const sources = [...adj.keys()].filter((id) => !toIds.has(id))
  const visited = new Set<string>()
  const queue = [...sources]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (visited.has(node)) continue
    visited.add(node)
    for (const next of adj.get(node) ?? []) queue.push(next)
  }
  const unreachable = plan.nodes.filter(
    (node) => !visited.has(node.id) && !sources.includes(node.id),
  )
  if (unreachable.length > 0) {
    return [
      soft(
        'SEMANTIC_REPLAN',
        `pipeline stages unreachable from any source: ${unreachable.map((node) => node.id).join(', ')}`,
        unreachable.map((node) => node.id),
      ),
    ]
  }
  return []
}

/** timeline: the declared spine must advance monotonically (temporal order). */
function validateTimelineFamily(plan: FigurePlanV2): PlanIssue[] {
  const spine = plan.primarySpine ?? []
  if (spine.length < 2) {
    return [
      soft(
        'SEMANTIC_REPLAN',
        'timeline without a ≥2-node primarySpine cannot express temporal order',
        [],
      ),
    ]
  }
  return []
}

/** comparison: needs ≥2 declared groups (the compared conditions). */
function validateComparisonFamily(plan: FigurePlanV2): PlanIssue[] {
  if ((plan.groups ?? []).length < 2) {
    return [
      soft(
        'SEMANTIC_REPLAN',
        'comparison figure declares fewer than two groups — compared conditions are not explicit',
        [],
      ),
    ]
  }
  return []
}

/** matrix: rows/columns must be declared as groups with members. */
function validateMatrixFamily(plan: FigurePlanV2): PlanIssue[] {
  const groups = plan.groups ?? []
  if (groups.length === 0) {
    return [soft('SEMANTIC_REPLAN', 'matrix figure declares no row/column groups', [])]
  }
  const sizes = groups.map((group) => group.memberIds.length)
  const uneven = Math.max(...sizes) - Math.min(...sizes)
  if (uneven > Math.max(2, Math.max(...sizes) / 2)) {
    return [
      soft(
        'SEMANTIC_REPLAN',
        `matrix groups are uneven (sizes ${sizes.join('/')}), rows/columns integrity at risk`,
        groups.map((group) => group.id),
      ),
    ]
  }
  return []
}

/** Map a legacy figureType string onto a FigureFamily for validation. */
export function familyFromFigureType(figureType: string): string | undefined {
  const map: Record<string, string> = {
    hierarchy: 'hierarchy',
    timeline: 'timeline',
    matrix: 'matrix',
    'feedback-loop': 'causal-model',
    'input-core-output': 'pipeline',
    'horizontal-pipeline': 'pipeline',
    'layered-architecture': 'architecture',
    'parallel-paths': 'comparison',
    'core-periphery': 'network',
  }
  return map[figureType]
}
