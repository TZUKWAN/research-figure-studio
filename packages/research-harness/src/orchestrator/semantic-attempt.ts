/**
 * Semantic Attempt State (audit ORCH-P0-01/02/03).
 *
 * Every plan-derived collection in the orchestrator is compiled by exactly
 * ONE function — `compileSemanticAttempt`. A semantic replan replaces the
 * whole state object, so no stale `measured`/`edges`/`importance`/`signals`
 * from a previous FigurePlan can ever leak into a new composition round.
 * Consistency assertions run on every compile: they are invariants, not
 * debug helpers.
 */
import { parseFigurePlanV2WithDiagnostics, type FigurePlanV2 } from '../semantic/figure-plan.js'
import {
  measureNode,
  estimatorMeasurer,
  type MeasuredNode,
  type NodeTextSpec,
} from '../measurement/measure.js'
import { SEMANTIC_NODE_STYLES, type CollisionClass } from '../components/semantic-styles.js'
import type { CandidateContext, FigureEdgesInput, NodeMeta } from '../composition/candidate.js'
import { compositionSignature, type CompositionSignature } from '../composition/priors.js'
import { classifyEdges, type EdgePriority } from '../constraints/edge-aware-solver.js'
import { domainPresentationDefault } from '../contract/domain-profile.js'
import type { ScientificDomain } from '../contract/domain-profile.js'
import type { CriticVerdict } from '../critic/metric-critic.js'
import type { ScientificIssue } from '../critic/scientific-critic.js'

export interface CompositionSignals {
  roles: Set<string>
  relations: Set<string>
  signature: CompositionSignature
}

/**
 * ALL state derived from one FigurePlan. Compiled fresh for every semantic
 * attempt; never mutated across attempts.
 */
export interface SemanticAttemptState {
  /** which semantic attempt (0 = initial plan, 1..n = semantic replans) */
  attempt: number
  plan: FigurePlanV2
  measured: MeasuredNode[]
  edges: FigureEdgesInput[]
  signals: CompositionSignals
  meta: Map<string, NodeMeta>
  importance: Map<string, number>
  groupIds: Map<string, string>
  /** routing priority keyed by STABLE EDGE ID (multi-edge safe) */
  edgePriorityById: Map<string, EdgePriority>
  /** fallback index keyed by endpoint pair → ALL priorities (COMP-P1-11) */
  edgePriorityByPair: Map<string, EdgePriority[]>
  collisionClasses: Map<string, CollisionClass>
  direction: 'LR' | 'TB'
  /** forbidden-claim/visible-text violations of THIS plan */
  forbiddenHits: string[]
  /** context threaded to grammar builders (family/spine/timeOrder/groups) */
  candidateContext: CandidateContext
}

export interface CompileSemanticAttemptInput {
  plan: FigurePlanV2
  attempt: number
  /** per-type text spec factory (typography contract) */
  specFor: (type: keyof typeof SEMANTIC_NODE_STYLES) => NodeTextSpec
  measure?: typeof measureNode
  domain: ScientificDomain
  family?: import('../contract/figure-contract.js').FigureFamily
  /** contract-forbidden claim strings; hits are THIS plan's violations */
  forbiddenClaims?: string[]
}

/**
 * The ONLY place a FigurePlan becomes orchestrator state (ORCH-P0-03).
 * `plan` may be mutated in one bounded way: empty visible titles receive a
 * restrained fallback (first clause, ≤14 chars) — a soft repair, never a
 * semantic change.
 */
export function compileSemanticAttempt(input: CompileSemanticAttemptInput): SemanticAttemptState {
  const { plan } = input
  // TEXT_OPTIMIZE: restrained fallback for missing visible titles (soft rule)
  for (const node of plan.nodes) {
    if (!node.visible.title) {
      node.visible.title = node.semanticLabel.slice(0, 14)
    }
  }
  const measure = input.measure ?? measureNode
  const measured: MeasuredNode[] = plan.nodes.map((node) => ({
    ...measure(
      {
        id: node.id,
        title: node.visible.title,
        ...(node.visible.detail ? { detail: node.visible.detail } : {}),
      },
      input.specFor(node.type),
      estimatorMeasurer(),
    ),
  }))
  const edges: FigureEdgesInput[] = plan.edges.map((edge, index) => {
    const presentation =
      edge.presentation ?? domainPresentationDefault(input.domain, edge.relation) ?? undefined
    return {
      id: edge.id ?? `edge:${edge.from}->${edge.to}:${edge.relation}:${index}`,
      from: edge.from,
      to: edge.to,
      role: edge.role,
      relation: edge.relation,
      ...(presentation ? { presentation } : {}),
      ...(edge.targetEdge ? { targetEdge: edge.targetEdge } : {}),
      ...(edge.qualifiedBy ? { qualifiedBy: edge.qualifiedBy } : {}),
    }
  })
  const groups = new Map<string, string[]>()
  for (const group of plan.groups) {
    groups.set(
      group.id,
      group.memberIds.filter((id) => plan.nodes.some((node) => node.id === id)),
    )
  }
  const meta = new Map<string, NodeMeta>(
    plan.nodes.map((node) => [
      node.id,
      {
        importance: node.importance,
        role: node.role,
        ...(node.groupId ? { groupId: node.groupId } : {}),
      },
    ]),
  )
  const signature = compositionSignature({
    nodeCount: plan.nodes.length,
    edgeCount: plan.edges.length,
    relations: new Set(plan.edges.map((edge) => edge.relation)),
    roles: new Set(plan.nodes.map((node) => node.role)),
    edges: plan.edges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
    importances: plan.nodes.map((node) => node.importance),
    hasTimeOrder: (plan.timeOrder ?? []).length > 0,
    hasMatrixAxes:
      (plan.matrix?.rowGroupIds.length ?? 0) > 0 && (plan.matrix?.columnGroupIds.length ?? 0) > 0,
  })
  const edgeTargets = classifyEdges(plan)
  const edgePriorityById = new Map<string, EdgePriority>()
  const edgePriorityByPair = new Map<string, EdgePriority[]>()
  // classifyEdges is 1:1 with plan.edges — index-aligned, so stable ids map 1:1
  edgeTargets.forEach((target, index) => {
    const id = edges[index]?.id
    if (id) edgePriorityById.set(id, target.priority)
    const pair = `${target.fromId}\u0000${target.toId}`
    edgePriorityByPair.set(pair, [...(edgePriorityByPair.get(pair) ?? []), target.priority])
  })
  const collisionClasses = new Map(
    plan.nodes.map((node) => [node.id, SEMANTIC_NODE_STYLES[node.type].collisionClass]),
  )
  const state: SemanticAttemptState = {
    attempt: input.attempt,
    plan,
    measured,
    edges,
    signals: {
      roles: new Set(plan.nodes.map((node) => node.role)),
      relations: new Set(plan.edges.map((edge) => edge.relation)),
      signature,
    },
    meta,
    importance: new Map(plan.nodes.map((node) => [node.id, node.importance])),
    groupIds: new Map(
      plan.nodes.flatMap((node) => (node.groupId ? [[node.id, node.groupId] as const] : [])),
    ),
    edgePriorityById,
    edgePriorityByPair,
    collisionClasses,
    direction: plan.readingIntent?.preferredDirection === 'TB' ? 'TB' : 'LR',
    forbiddenHits: [],
    candidateContext: {
      ...(input.family ? { family: input.family } : {}),
      ...(plan.primarySpine ? { spine: plan.primarySpine } : {}),
      ...(plan.narrative?.visualCenter ? { visualCenter: plan.narrative.visualCenter } : {}),
      ...(plan.timeOrder ? { timeOrder: plan.timeOrder } : {}),
      ...(plan.groups.length > 0 ? { groups } : {}),
      ...(plan.matrix
        ? {
            matrix: {
              rowGroupIds: plan.matrix.rowGroupIds,
              columnGroupIds: plan.matrix.columnGroupIds,
            },
          }
        : {}),
    },
  }
  // forbidden claims / visible-text violations are semantic hard failures of
  // THIS plan (recomputed on every replan)
  const forbiddenClaims = input.forbiddenClaims ?? []
  state.forbiddenHits = forbiddenClaims.filter((claim) => {
    const needle = claim.toLowerCase()
    return plan.nodes.some(
      (node) =>
        node.visible.title.toLowerCase().includes(needle) ||
        node.visible.detail?.toLowerCase().includes(needle) ||
        node.semanticLabel.toLowerCase().includes(needle),
    )
  })
  assertSemanticAttemptConsistency(state)
  return state
}

/**
 * Consistency assertions over ALL plan-derived collections (ORCH-P0-03).
 * Any violation is a programming error and must fail loudly, never silently
 * compose a half-compiled graph.
 */
export function assertSemanticAttemptConsistency(state: SemanticAttemptState): void {
  const nodeIds = new Set(state.plan.nodes.map((node) => node.id))
  const measuredIds = new Set(state.measured.map((node) => node.id))
  const importanceIds = new Set(state.importance.keys())
  const metaIds = new Set(state.meta.keys())
  const sameSet = (a: Set<string>, b: Set<string>, label: string): void => {
    if (a.size !== b.size) throw new Error(`semantic attempt inconsistent: ${label} size mismatch`)
    for (const id of a) {
      if (!b.has(id)) throw new Error(`semantic attempt inconsistent: ${label} missing "${id}"`)
    }
  }
  sameSet(measuredIds, nodeIds, 'measured ids vs plan nodes')
  sameSet(importanceIds, nodeIds, 'importance ids vs plan nodes')
  sameSet(metaIds, nodeIds, 'meta ids vs plan nodes')
  for (const [id, group] of state.groupIds) {
    if (!nodeIds.has(id)) {
      throw new Error(`semantic attempt inconsistent: groupIds contains unknown node "${id}"`)
    }
    void group
  }
  for (const edge of state.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(
        `semantic attempt inconsistent: edge "${edge.id}" from missing node "${edge.from}"`,
      )
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(
        `semantic attempt inconsistent: edge "${edge.id}" to missing node "${edge.to}"`,
      )
    }
  }
  for (const members of state.candidateContext.groups?.values() ?? []) {
    for (const id of members) {
      if (!nodeIds.has(id)) {
        throw new Error(`semantic attempt inconsistent: group member "${id}" is not a plan node`)
      }
    }
  }
}

/**
 * Semantic failure classes (ORCH-P0-02): model-output parse errors and
 * FigurePlan schema errors are recorded SEPARATELY.
 */
export type SemanticFailureKind =
  'MODEL_OUTPUT_PARSE_ERROR' | 'FIGURE_PLAN_SCHEMA_ERROR' | 'PLANNER_TRANSPORT_ERROR'

export interface SemanticPlanAttemptResult {
  plan: FigurePlanV2 | null
  /** SPECIFIC validation errors from the LAST failed attempt */
  errors: string[]
  failureKind?: SemanticFailureKind
  attemptsUsed: number
  schemaRepairsUsed: number
  /** full per-attempt diagnostics (ids and messages only — no raw material) */
  diagnostics: Array<{ attempt: number; kind: SemanticFailureKind; errors: string[] }>
}

export interface PlanSemanticFigureInput {
  thesis: string
  semanticPlan: (thesis: string, feedback?: string) => Promise<unknown>
  /** schema repair budget on TOP of the initial attempt (default 2) */
  maxSchemaRepairs?: number
  /** scientist critique feedback (semantic replan path, ORCH-P0-01) */
  critiqueFeedback?: string
  onAttempt?: (info: {
    attempt: number
    kind: 'initial' | 'schema-repair'
    failureKind?: SemanticFailureKind
    errors: string[]
  }) => void
}

const JSONISH = /json|parse|unexpected token|unexpected end/i

/**
 * The semantic parse/repair loop: initial attempt + bounded schema repairs.
 * Each retry feeds the planner the EXACT validation errors — never a bare
 * "schema validation failed".
 */
export async function planSemanticFigure(
  input: PlanSemanticFigureInput,
): Promise<SemanticPlanAttemptResult> {
  const maxRepairs = input.maxSchemaRepairs ?? 2
  const diagnostics: SemanticPlanAttemptResult['diagnostics'] = []
  let lastErrors: string[] = []
  let lastKind: SemanticFailureKind | undefined
  const totalAttempts = 1 + maxRepairs
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let raw: unknown
    try {
      raw = await input.semanticPlan(
        input.thesis,
        attempt === 1
          ? input.critiqueFeedback
          : buildRepairFeedback(input.critiqueFeedback, lastKind, lastErrors),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastKind = JSONISH.test(message) ? 'MODEL_OUTPUT_PARSE_ERROR' : 'PLANNER_TRANSPORT_ERROR'
      lastErrors = [`planner output unusable (${lastKind}): ${message}`]
      diagnostics.push({ attempt, kind: lastKind, errors: lastErrors })
      input.onAttempt?.({
        attempt,
        kind: attempt === 1 ? 'initial' : 'schema-repair',
        failureKind: lastKind,
        errors: lastErrors,
      })
      continue
    }
    const { plan, errors } = parseFigurePlanV2WithDiagnostics(raw)
    if (plan) {
      return {
        plan,
        errors: [],
        attemptsUsed: attempt,
        schemaRepairsUsed: attempt - 1,
        diagnostics,
      }
    }
    lastKind = 'FIGURE_PLAN_SCHEMA_ERROR'
    lastErrors = errors
    diagnostics.push({ attempt, kind: lastKind, errors })
    input.onAttempt?.({
      attempt,
      kind: attempt === 1 ? 'initial' : 'schema-repair',
      failureKind: lastKind,
      errors,
    })
  }
  return {
    plan: null,
    errors: lastErrors,
    failureKind: lastKind,
    attemptsUsed: totalAttempts,
    schemaRepairsUsed: totalAttempts - 1,
    diagnostics,
  }
}

function buildRepairFeedback(
  critique: string | undefined,
  kind: SemanticFailureKind | undefined,
  errors: string[],
): string {
  const parts: string[] = []
  if (critique) parts.push(critique)
  if (kind === 'MODEL_OUTPUT_PARSE_ERROR' || kind === 'PLANNER_TRANSPORT_ERROR') {
    parts.push('Your previous reply was not parseable as JSON. Output the raw JSON object only.')
  } else if (errors.length > 0) {
    parts.push(
      `Your previous FigurePlan was rejected. Fix EXACTLY these errors: ${errors.join('; ')}`,
    )
  }
  return parts.join('\n')
}

/**
 * Compile the scientist-facing feedback for a SEMANTIC replan (ORCH-P0-01):
 * only semantic findings — missing evidence, wrong relations, forbidden
 * claims, structural intent failures — never pure geometry complaints.
 */
export function compileSemanticReplanFeedback(input: {
  critic?: CriticVerdict
  scientificIssues?: ScientificIssue[]
  forbiddenHits?: string[]
}): string {
  const lines: string[] = []
  for (const claim of input.forbiddenHits ?? []) {
    lines.push(`FORBIDDEN: the plan contains forbidden claim/text "${claim}"`)
  }
  const critic = input.critic
  if (critic) {
    for (const gate of critic.hardGates) {
      if (gate.scope === 'semantic' && !gate.pass) {
        lines.push(`HARD: ${gate.gate} failed — ${gate.detail ?? 'semantic requirement unmet'}`)
      }
    }
    for (const decision of critic.decisions ?? []) {
      if (decision.scope === 'semantic') {
        lines.push(`${decision.severity}: ${decision.message}`)
      }
    }
    if (lines.length === 0 && critic.reason) {
      lines.push(`critic: ${critic.reason}`)
    }
  }
  for (const issue of input.scientificIssues ?? []) {
    if (issue.repairClass === 'SEMANTIC_REPLAN' || issue.severity === 'hard') {
      lines.push(`${issue.repairClass}: ${issue.message}`)
    }
  }
  if (lines.length === 0) {
    lines.push(
      'The figure failed scientific review; regenerate the plan with complete relations and evidence.',
    )
  }
  return [
    'The previous FigurePlan was rejected by scientific review:',
    ...lines.map((line) => `- ${line}`),
    'Regenerate the COMPLETE FigurePlan v2 JSON fixing these findings: every required node present, correct relations, no invented content.',
  ].join('\n')
}

/** True when the critic's verdict has a SEMANTIC cause (L6, not L5). */
export function isSemanticFailure(critic: CriticVerdict): boolean {
  return (
    critic.hardGates.some((gate) => gate.scope === 'semantic' && !gate.pass) ||
    (critic.decisions?.some((decision) => decision.scope === 'semantic') ?? false)
  )
}
