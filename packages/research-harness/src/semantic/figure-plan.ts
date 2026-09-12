/**
 * FigurePlan v2 (Phase 1/2 semantic schema). Separates semantic meaning from
 * visible text (GOAL section 9) and makes relation-typed edges the sole topology.
 */
import { parseSemanticEdgesDetailed, type SemanticEdge } from './schema.js'
import type { VisibleText } from '../measurement/measure.js'

export const SEMANTIC_NODE_TYPES = [
  'data-source',
  'variable',
  'mechanism',
  'process',
  'model',
  'method',
  'actor',
  'evidence',
  'outcome',
  'hypothesis',
  'annotation',
  'context',
] as const

export type SemanticNodeType = (typeof SEMANTIC_NODE_TYPES)[number]

export type SemanticRole =
  'input' | 'core' | 'intermediate' | 'output' | 'context' | 'moderator' | 'support'

export interface SemanticNode {
  id: string
  type: SemanticNodeType
  /** full scientific meaning, kept for the model and future re-composition */
  semanticLabel: string
  /** compressed on-figure text (soft rules: title 4–12 CJK chars etc.) */
  visible: VisibleText
  importance: number
  role: SemanticRole
  groupId?: string
  /** contract evidence ids this node carries (P0.5 contract bridge) */
  evidenceRefs?: string[]
  /** contract provenance ids backing quantitative claims on this node */
  provenanceRefs?: string[]
  /** what kind of claim the node makes; drives provenance gating */
  claimType?: 'qualitative' | 'quantitative' | 'derived' | 'sample'
  /** phase label for timeline stages (COMP-P1-03): e.g. "2020-03" or "Phase 1" */
  phase?: string
  /** raw time point for timeline ordering; ordering itself comes from timeOrder */
  timePoint?: string
}

export interface SemanticGroup {
  id: string
  label?: string
  memberIds: string[]
}

export const EXPRESSION_MODES = [
  'statement',
  'mechanism',
  'comparison',
  'hierarchy',
  'network',
  'matrix',
  'timeline',
  'spatial-metaphor',
  'freeform',
] as const

export type ExpressionMode = (typeof EXPRESSION_MODES)[number]

export type NarrativeComplexity = 'minimal' | 'compact' | 'rich'

/**
 * Communication intent selected before composition. It is intentionally
 * qualitative: this is where the planner decides what to merge or omit rather
 * than turning thesis length into a node-count target.
 */
export interface NarrativePlan {
  expressionMode: ExpressionMode
  complexity: NarrativeComplexity
  centralMessage: string
  visualCenter?: string
  readingPath?: string[]
  mustShow: string[]
  mayMerge: string[][]
  omitFromCanvas: string[]
  /** what the figure must carry explicitly instead of pushing it off-canvas */
  evidenceMustShow?: string[]
  /** deliberate statement-of-what-left-out, for reviewer-facing accountability */
  offCanvasReasoning?: string[]
}

export interface FigurePlanV2 {
  thesis: string
  figureType: string
  narrative?: NarrativePlan
  /** optional dominant logical chain (model-decided, NOT required) */
  primarySpine?: string[]
  nodes: SemanticNode[]
  edges: SemanticEdge[]
  groups: SemanticGroup[]
  globalIntent: {
    emphasis: string[]
    secondary: string[]
    optional: string[]
  }
  readingIntent?: {
    preferredDirection?: 'LR' | 'RL' | 'TB' | 'BT' | 'radial' | 'mixed'
  }
  /** explicit temporal order over node ids (COMP-P1-03; subset of node ids) */
  timeOrder?: string[]
  /** explicit matrix axes (COMP-P1-04): groups used as rows / columns */
  matrix?: MatrixSpec
}

/** Row/column semantics for the matrix family. Group ids must exist in groups. */
export interface MatrixSpec {
  rowGroupIds: string[]
  columnGroupIds: string[]
  /** what one cell expresses, e.g. "effect size", "presence" */
  cellRelation?: string
}

const NODE_TYPE_SET = new Set<string>(SEMANTIC_NODE_TYPES)
const ROLE_SET = new Set<string>([
  'input',
  'core',
  'intermediate',
  'output',
  'context',
  'moderator',
  'support',
])
const EXPRESSION_MODE_SET = new Set<string>(EXPRESSION_MODES)
const NARRATIVE_COMPLEXITY_SET = new Set<string>(['minimal', 'compact', 'rich'])

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

/**
 * P0 (production closure): reference-typed fields must never be silently
 * dropped. A dangling id is a SCHEMA ERROR with the exact field and id, fed
 * to the bounded repair loop — format normalization is repair, but dropping
 * a mustShow/readingPath/timeOrder reference silently destroys research
 * semantics.
 */
function requireNodeRefs(
  field: string,
  ids: string[],
  known: Set<string>,
  errors: string[],
): string[] {
  const kept: string[] = []
  for (const id of ids) {
    if (known.has(id)) kept.push(id)
    else errors.push(`${field} references missing node "${id}"`)
  }
  return kept
}

function requireGroupRefs(
  field: string,
  ids: string[],
  known: Set<string>,
  errors: string[],
): string[] {
  const kept: string[] = []
  for (const id of ids) {
    if (known.has(id)) kept.push(id)
    else errors.push(`${field} references missing group "${id}"`)
  }
  return kept
}

function parseNarrative(
  raw: unknown,
  ids: Set<string>,
  thesis: string,
  errors: string[],
): NarrativePlan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const narrative = raw as Record<string, unknown>
  const expressionMode = text(narrative.expressionMode)
  if (!EXPRESSION_MODE_SET.has(expressionMode)) return undefined
  const complexity = text(narrative.complexity)
  const validComplexity = NARRATIVE_COMPLEXITY_SET.has(complexity) ? complexity : 'compact'
  const centralMessage = text(narrative.centralMessage) || thesis
  const visualCenter = text(narrative.visualCenter)
  if (visualCenter && !ids.has(visualCenter)) {
    errors.push(`narrative.visualCenter references missing node "${visualCenter}"`)
  }
  const readingPath = requireNodeRefs(
    'narrative.readingPath',
    strings(narrative.readingPath),
    ids,
    errors,
  )
  const mustShow = requireNodeRefs('narrative.mustShow', strings(narrative.mustShow), ids, errors)
  const mayMerge: string[][] = []
  if (Array.isArray(narrative.mayMerge)) {
    for (const [index, group] of (narrative.mayMerge as unknown[]).entries()) {
      const members = requireNodeRefs(`narrative.mayMerge[${index}]`, strings(group), ids, errors)
      if (members.length > 1) mayMerge.push(members)
    }
  }
  const evidenceMustShow = requireNodeRefs(
    'narrative.evidenceMustShow',
    strings(narrative.evidenceMustShow),
    ids,
    errors,
  )
  return {
    expressionMode: expressionMode as ExpressionMode,
    complexity: validComplexity as NarrativeComplexity,
    centralMessage,
    ...(visualCenter && ids.has(visualCenter) ? { visualCenter } : {}),
    ...(readingPath.length > 0 ? { readingPath } : {}),
    mustShow,
    mayMerge,
    omitFromCanvas: strings(narrative.omitFromCanvas),
    ...(evidenceMustShow.length > 0 ? { evidenceMustShow } : {}),
    offCanvasReasoning: strings(narrative.offCanvasReasoning),
  }
}

/**
 * R0/R1 parse + repair of a raw model FigurePlan v2. Deterministic: casing
 * repairs, importance clamped to 0–1 (default 0.5), visible.title falls back
 * to a trimmed semanticLabel, edges validated via parseSemanticEdges. Returns
 * null when the plan cannot be repaired (caller triggers R2 model repair).
 */
export function parseFigurePlanV2(raw: unknown): FigurePlanV2 | null {
  return parseFigurePlanV2WithDiagnostics(raw).plan
}

export interface FigurePlanDiagnostics {
  plan: FigurePlanV2 | null
  /** SPECIFIC validation errors (ORCH-P0-02): one actionable message each */
  errors: string[]
}

/**
 * Diagnostics-aware parse: collects EVERY independent schema error instead of
 * bailing at the first. The semantic repair loop feeds these exact strings
 * back to the planner, so "schema validation failed" alone is never sent.
 */
export function parseFigurePlanV2WithDiagnostics(raw: unknown): FigurePlanDiagnostics {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { plan: null, errors: ['FigurePlan must be a JSON object'] }
  }
  const plan = raw as Record<string, unknown>
  const thesis = text(plan.thesis)
  if (!thesis) errors.push('missing "thesis"')
  const figureType = text(plan.figureType) || 'input-core-output'
  if (!Array.isArray(plan.nodes)) {
    return { plan: null, errors: [...errors, '"nodes" must be an array'] }
  }
  const rawNodes = plan.nodes

  const nodes: SemanticNode[] = []
  const ids = new Set<string>()
  for (const [index, rawNode] of rawNodes.entries()) {
    const node = (rawNode ?? {}) as Record<string, unknown>
    const id = text(node.id)
    if (!id) {
      errors.push(`node at index ${index} is missing "id"`)
      continue
    }
    if (ids.has(id)) {
      errors.push(`duplicate node id "${id}"`)
      continue
    }
    const type = text(node.type)
    const semanticLabel = text(node.semanticLabel) || text(node.title)
    const visible = (node.visible ?? {}) as Record<string, unknown>
    const visibleTitle = text(visible.title) || semanticLabel
    if (!semanticLabel) {
      errors.push(`node "${id}" is missing "semanticLabel"`)
      continue
    }
    const role = text(node.role) || 'core'
    if (!NODE_TYPE_SET.has(type || 'process') && type !== '') {
      errors.push(
        `node "${id}": type "${type}" unsupported (allowed: ${SEMANTIC_NODE_TYPES.join(', ')})`,
      )
    }
    if (!ROLE_SET.has(role)) {
      errors.push(`node "${id}": role "${role}" unsupported (allowed: ${[...ROLE_SET].join(', ')})`)
    }
    if (typeof node.importance === 'number' && !Number.isFinite(node.importance)) {
      errors.push(`node "${id}": importance must be a finite number`)
      continue
    }
    const importanceRaw = typeof node.importance === 'number' ? node.importance : 0.5
    ids.add(id)
    nodes.push({
      id,
      type: (NODE_TYPE_SET.has(type) ? type : 'process') as SemanticNodeType,
      semanticLabel,
      visible: {
        title: visibleTitle,
        ...(text(visible.detail) ? { detail: text(visible.detail) } : {}),
      },
      importance: Math.min(1, Math.max(0, importanceRaw)),
      role: (ROLE_SET.has(role) ? role : 'core') as SemanticRole,
      ...(text(node.groupId) ? { groupId: text(node.groupId) } : {}),
      ...(strings(node.evidenceRefs).length > 0
        ? { evidenceRefs: strings(node.evidenceRefs) }
        : {}),
      ...(strings(node.provenanceRefs).length > 0
        ? { provenanceRefs: strings(node.provenanceRefs) }
        : {}),
      ...(['qualitative', 'quantitative', 'derived', 'sample'].includes(text(node.claimType))
        ? {
            claimType: text(node.claimType) as
              'qualitative' | 'quantitative' | 'derived' | 'sample',
          }
        : {}),
      ...(text(node.phase) ? { phase: text(node.phase) } : {}),
      ...(text(node.timePoint) ? { timePoint: text(node.timePoint) } : {}),
    })
  }
  if (nodes.length === 0) {
    errors.push('"nodes" must contain at least one valid node')
    return { plan: null, errors }
  }

  const edgeIds = new Set<string>(
    (Array.isArray(plan.edges) ? plan.edges : []).flatMap((edge) => {
      const id = text((edge as Record<string, unknown> | null)?.id)
      return id ? [id] : []
    }),
  )
  const detailed = parseSemanticEdgesDetailed(plan.edges, {
    nodeIds: ids,
    edgeIds,
  })
  if (!detailed.edges) {
    return { plan: null, errors: [...errors, ...detailed.errors] }
  }
  const edges = detailed.edges

  const groups: SemanticGroup[] = []
  const groupIds = new Set<string>()
  const rawGroups = Array.isArray(plan.groups) ? plan.groups : []
  for (const rawGroup of rawGroups) {
    const group = (rawGroup ?? {}) as Record<string, unknown>
    const gid = text(group.id)
    const declaredMembers = strings(group.memberIds)
    const memberIds = requireNodeRefs(`group "${gid}" memberIds`, declaredMembers, ids, errors)
    if (!gid || memberIds.length === 0) continue
    if (groupIds.has(gid)) {
      errors.push(`duplicate group id "${gid}"`)
      continue
    }
    groupIds.add(gid)
    groups.push({ id: gid, ...(text(group.label) ? { label: text(group.label) } : {}), memberIds })
  }

  const narrative = parseNarrative(plan.narrative, ids, thesis, errors)

  const timeOrder = requireNodeRefs('timeOrder', strings(plan.timeOrder), ids, errors)

  const rawMatrix = (plan.matrix ?? {}) as Record<string, unknown>
  const rowGroupIds = requireGroupRefs(
    'matrix.rowGroupIds',
    strings(rawMatrix.rowGroupIds),
    groupIds,
    errors,
  )
  const columnGroupIds = requireGroupRefs(
    'matrix.columnGroupIds',
    strings(rawMatrix.columnGroupIds),
    groupIds,
    errors,
  )
  const hasMatrixSpec =
    (Array.isArray(rawMatrix.rowGroupIds) && strings(rawMatrix.rowGroupIds).length > 0) ||
    (Array.isArray(rawMatrix.columnGroupIds) && strings(rawMatrix.columnGroupIds).length > 0)
  const matrix: MatrixSpec | undefined =
    rowGroupIds.length > 0 && columnGroupIds.length > 0
      ? {
          rowGroupIds,
          columnGroupIds,
          ...(text(rawMatrix.cellRelation) ? { cellRelation: text(rawMatrix.cellRelation) } : {}),
        }
      : hasMatrixSpec
        ? (() => {
            // A declared matrix whose axes did not resolve is a structural
            // failure, never a silent downgrade to a non-matrix plan.
            errors.push(
              'matrix declared but one axis resolved empty (check matrix.rowGroupIds/columnGroupIds against groups)',
            )
            return undefined
          })()
        : undefined

  if (errors.length > 0) return { plan: null, errors }

  const intent = (plan.globalIntent ?? {}) as Record<string, unknown>
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
      : []

  const emphasis = requireNodeRefs(
    'globalIntent.emphasis',
    stringList(intent.emphasis),
    ids,
    errors,
  )
  const secondary = requireNodeRefs(
    'globalIntent.secondary',
    stringList(intent.secondary),
    ids,
    errors,
  )
  const optional = requireNodeRefs(
    'globalIntent.optional',
    stringList(intent.optional),
    ids,
    errors,
  )
  const primarySpine = requireNodeRefs('primarySpine', strings(plan.primarySpine), ids, errors)
  // node.groupId is a group reference collected AFTER groups parse
  for (const node of nodes) {
    if (node.groupId && !groupIds.has(node.groupId)) {
      errors.push(`node "${node.id}": groupId references missing group "${node.groupId}"`)
    }
  }
  if (errors.length > 0) return { plan: null, errors }

  return {
    plan: {
      thesis,
      figureType,
      ...(narrative ? { narrative } : {}),
      nodes,
      edges,
      groups,
      globalIntent: {
        emphasis,
        secondary,
        optional,
      },
      ...(primarySpine.length > 0 ? { primarySpine } : {}),
      ...(typeof plan.readingIntent === 'object' && plan.readingIntent !== null
        ? {
            readingIntent: {
              preferredDirection: text(
                (plan.readingIntent as Record<string, unknown>).preferredDirection,
              ) as FigurePlanV2['readingIntent'] extends { preferredDirection?: infer D }
                ? D
                : never,
            },
          }
        : {}),
      ...(timeOrder.length > 0 ? { timeOrder } : {}),
      ...(matrix ? { matrix } : {}),
    },
    errors: [],
  }
}
