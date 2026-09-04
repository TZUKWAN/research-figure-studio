/**
 * FigurePlan v2 (Phase 1/2 semantic schema). Separates semantic meaning from
 * visible text (GOAL §9) and makes relation-typed edges the sole topology.
 */
import { parseSemanticEdges, type SemanticEdge } from './schema.js'
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

function parseNarrative(raw: unknown, ids: Set<string>, thesis: string): NarrativePlan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const narrative = raw as Record<string, unknown>
  const expressionMode = text(narrative.expressionMode)
  if (!EXPRESSION_MODE_SET.has(expressionMode)) return undefined
  const complexity = text(narrative.complexity)
  const validComplexity = NARRATIVE_COMPLEXITY_SET.has(complexity) ? complexity : 'compact'
  const centralMessage = text(narrative.centralMessage) || thesis
  const visualCenter = text(narrative.visualCenter)
  return {
    expressionMode: expressionMode as ExpressionMode,
    complexity: validComplexity as NarrativeComplexity,
    centralMessage,
    ...(visualCenter && ids.has(visualCenter) ? { visualCenter } : {}),
    ...(strings(narrative.readingPath).length > 0
      ? { readingPath: strings(narrative.readingPath).filter((id) => ids.has(id)) }
      : {}),
    mustShow: strings(narrative.mustShow).filter((id) => ids.has(id)),
    mayMerge: Array.isArray(narrative.mayMerge)
      ? (narrative.mayMerge as unknown[])
          .map((group) => strings(group).filter((id) => ids.has(id)))
          .filter((group) => group.length > 1)
      : [],
    omitFromCanvas: strings(narrative.omitFromCanvas),
    evidenceMustShow: strings(narrative.evidenceMustShow).filter((id) => ids.has(id)),
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
  if (typeof raw !== 'object' || raw === null) return null
  const plan = raw as Record<string, unknown>
  const thesis = text(plan.thesis)
  const figureType = text(plan.figureType) || 'input-core-output'
  const rawNodes = Array.isArray(plan.nodes) ? plan.nodes : []
  if (!thesis || rawNodes.length === 0) return null

  const nodes: SemanticNode[] = []
  const ids = new Set<string>()
  for (const rawNode of rawNodes) {
    const node = (rawNode ?? {}) as Record<string, unknown>
    const id = text(node.id)
    if (!id || ids.has(id)) return null
    const type = text(node.type)
    const semanticLabel = text(node.semanticLabel) || text(node.title)
    const visible = (node.visible ?? {}) as Record<string, unknown>
    const visibleTitle = text(visible.title) || semanticLabel
    if (!semanticLabel) return null
    const importanceRaw = typeof node.importance === 'number' ? node.importance : 0.5
    const role = text(node.role) || 'core'
    if (!NODE_TYPE_SET.has(type || 'process') && type !== '') return null
    if (!ROLE_SET.has(role)) return null
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
      role: role as SemanticRole,
      ...(text(node.groupId) ? { groupId: text(node.groupId) } : {}),
    })
  }

  const titleTable = {
    byRef: new Map<string, number[]>(nodes.map((node, index) => [node.id, [index]])),
  }
  const edges = parseSemanticEdges(plan.edges, [titleTable, titleTable])
  if (edges === null) return null

  const groups: SemanticGroup[] = []
  const rawGroups = Array.isArray(plan.groups) ? plan.groups : []
  for (const rawGroup of rawGroups) {
    const group = (rawGroup ?? {}) as Record<string, unknown>
    const gid = text(group.id)
    const memberIds = Array.isArray(group.memberIds)
      ? (group.memberIds as unknown[]).filter(
          (member): member is string => typeof member === 'string' && ids.has(member),
        )
      : []
    if (!gid || memberIds.length === 0) continue
    groups.push({ id: gid, ...(text(group.label) ? { label: text(group.label) } : {}), memberIds })
  }

  const intent = (plan.globalIntent ?? {}) as Record<string, unknown>
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
      : []

  const narrative = parseNarrative(plan.narrative, ids, thesis)

  return {
    thesis,
    figureType,
    ...(narrative ? { narrative } : {}),
    nodes,
    edges,
    groups,
    globalIntent: {
      emphasis: stringList(intent.emphasis).filter((item) => ids.has(item)),
      secondary: stringList(intent.secondary).filter((item) => ids.has(item)),
      optional: stringList(intent.optional).filter((item) => ids.has(item)),
    },
    ...(Array.isArray(plan.primarySpine)
      ? {
          primarySpine: (plan.primarySpine as unknown[]).filter(
            (id): id is string => typeof id === 'string' && ids.has(id),
          ),
        }
      : {}),
    ...(typeof plan.readingIntent === 'object' && plan.readingIntent !== null
      ? {
          readingIntent: {
            preferredDirection: text(
              (plan.readingIntent as Record<string, unknown>).preferredDirection,
            ) as FigurePlanV2['readingIntent'] extends { preferredDirection?: infer D } ? D : never,
          },
        }
      : {}),
  }
}
