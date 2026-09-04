/**
 * Semantic schema for research figures (Phase 1 of the adaptive diagram
 * architecture): explicit relation-typed edges are the ONLY topology source.
 * Nothing here may derive a relationship from array order, column order or
 * creation order — that was the v1 defect this module replaces.
 */

/** Scientific relation vocabulary for a SemanticEdge. */
export const RELATION_TYPES = [
  'causal',
  'process',
  'data-flow',
  'transformation',
  'association',
  'mediation',
  'moderation',
  'feedback',
  'inhibition',
  'mapping',
  'hierarchy',
  'bidirectional',
] as const

export type RelationType = (typeof RELATION_TYPES)[number]

const RELATION_TYPE_SET = new Set<string>(RELATION_TYPES)

/** Routing role remains a backward-compatible hint, not the relation's meaning. */
export type EdgeRouteRole = 'main' | 'feedback'

const EDGE_ROUTE_ROLES = new Set<string>(['main', 'feedback'])

/** How a scientific relationship is intentionally realised on the canvas. */
export const RELATION_PRESENTATIONS = [
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
  'containment',
  'proximity',
  'alignment',
  'annotation',
] as const

export type RelationPresentation = (typeof RELATION_PRESENTATIONS)[number]

const RELATION_PRESENTATION_SET = new Set<string>(RELATION_PRESENTATIONS)

/** Raw planner-supplied edge before validation/repair. */
export interface SemanticEdgeInput {
  id?: string
  from: string
  to: string
  /** moderation edges may target an edge instead of a node */
  targetEdge?: string
  /** optional compatibility hint for connector routing */
  role?: string
  relation?: string
  presentation?: string
  label?: string
}

/** A validated edge with stable identity and explicit visual presentation. */
export interface SemanticEdge {
  /** parser-supplied when absent; optional for backward-compatible direct fixtures */
  id?: string
  from: string
  to: string
  targetEdge?: string
  role: EdgeRouteRole
  relation: RelationType
  /** parser supplies a semantic default; optional for backward-compatible direct fixtures */
  presentation?: RelationPresentation
  label?: string
}

/**
 * Endpoint lookup: maps a plan reference (node title, or region/group id) to
 * the placement indices it names. Region refs expand to ALL member indices —
 * the explicit group-to-group semantics of the plan, never positional order.
 */
export interface EndpointTable {
  byRef: Map<string, number[]>
}

export function endpointTable(entries: Array<{ ref: string; indices: number[] }>): EndpointTable {
  const byRef = new Map<string, number[]>()
  for (const { ref, indices } of entries) {
    if (!ref) continue
    const existing = byRef.get(ref)
    byRef.set(ref, existing ? [...existing, ...indices] : indices)
  }
  return { byRef }
}

export interface ResolvedEdge {
  id: string
  fromIndex: number
  toIndex: number
  role: EdgeRouteRole
  relation: RelationType
  presentation: RelationPresentation
  targetEdge?: string
  label?: string
}

function normEnum(value: unknown, allowed: Set<string>): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (allowed.has(trimmed)) return trimmed
  const lower = trimmed.toLowerCase()
  if (allowed.has(lower)) return lower
  return null
}

function normText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function defaultPresentation(relation: RelationType, role: EdgeRouteRole): RelationPresentation {
  if (relation === 'feedback' || role === 'feedback') return 'feedback-loop'
  if (relation === 'inhibition') return 'inhibition'
  if (relation === 'association') return 'line'
  if (relation === 'hierarchy') return 'containment'
  if (relation === 'moderation') return 'dashed-arrow'
  return 'arrow'
}

function parseEdge(edge: Record<string, unknown>, index: number): SemanticEdge | null {
  const from = normText(edge.from)
  const to = normText(edge.to)
  const role = normEnum(edge.role ?? 'main', EDGE_ROUTE_ROLES)
  const relation = normEnum(
    edge.relation === undefined ? 'process' : edge.relation,
    RELATION_TYPE_SET,
  )
  if (!from || !to || from === to || !role || !relation) return null
  const normalizedRelation = relation as RelationType
  const normalizedRole = role as EdgeRouteRole
  const presentation = normEnum(edge.presentation, RELATION_PRESENTATION_SET)
  const parsed: SemanticEdge = {
    id: normText(edge.id) || `edge:${from}->${to}:${normalizedRelation}:${index}`,
    from,
    to,
    role: normalizedRole,
    relation: normalizedRelation,
    presentation: (presentation ??
      defaultPresentation(normalizedRelation, normalizedRole)) as RelationPresentation,
  }
  const targetEdge = normText(edge.targetEdge)
  if (targetEdge) parsed.targetEdge = targetEdge
  const label = normText(edge.label)
  if (label) parsed.label = label
  return parsed
}

/**
 * Parse + repair (R0/R1) a raw edge list. Deterministic: casing repairs, id
 * passthrough, relation defaults to `process`. Returns null when any edge is
 * malformed — callers surface a retry message instead of guessing topology.
 *
 * When `tables` is supplied every edge is also resolved against them; an
 * edge naming an unknown node/region rejects the whole list.
 */
export function parseSemanticEdges(
  rawEdges: unknown,
  tables?: [EndpointTable, EndpointTable],
): SemanticEdge[] | null {
  if (!Array.isArray(rawEdges)) return null
  const edges: SemanticEdge[] = []
  const seenIds = new Set<string>()
  const seenRelations = new Set<string>()
  for (const [index, raw] of rawEdges.entries()) {
    const parsed = parseEdge((raw ?? {}) as Record<string, unknown>, index)
    if (!parsed) return null
    const id = parsed.id ?? `edge:${parsed.from}->${parsed.to}:${parsed.relation}:${index}`
    if (seenIds.has(id)) return null
    const semanticIdentity = [
      parsed.from,
      parsed.to,
      parsed.relation,
      parsed.presentation,
      parsed.targetEdge ?? '',
      parsed.label ?? '',
    ].join('\u0000')
    if (seenRelations.has(semanticIdentity)) return null
    parsed.id = id
    seenIds.add(id)
    seenRelations.add(semanticIdentity)
    edges.push(parsed)
  }
  if (tables) {
    for (const edge of edges) {
      if (resolveEdge(edge, tables[0], tables[1]).length === 0) return null
    }
  }
  return edges
}

/**
 * Resolve one validated edge into concrete placement pairs. Node refs give a
 * single pair; region refs expand to every member (cartesian on both sides).
 * Unresolvable refs → empty list; self pairs are dropped.
 */
export function resolveEdge(
  edge: SemanticEdgeInput,
  fromTable: EndpointTable,
  toTable: EndpointTable,
): ResolvedEdge[] {
  const role = normEnum(edge.role ?? 'main', EDGE_ROUTE_ROLES) as EdgeRouteRole | null
  if (!role) return []
  const relation = normEnum(edge.relation ?? 'process', RELATION_TYPE_SET) as RelationType | null
  if (!relation) return []
  const presentation = normEnum(
    edge.presentation,
    RELATION_PRESENTATION_SET,
  ) as RelationPresentation | null
  if (edge.presentation !== undefined && !presentation) return []
  const from = normText(edge.from)
  const to = normText(edge.to)
  const id = normText(edge.id) || `edge:${from}->${to}:${relation}:0`
  const fromIndices = fromTable.byRef.get(from) ?? []
  const toIndices = toTable.byRef.get(to) ?? []
  const label = normText(edge.label)
  const targetEdge = normText(edge.targetEdge)
  const pairs: ResolvedEdge[] = []
  for (const fromIndex of fromIndices) {
    for (const toIndex of toIndices) {
      if (fromIndex === toIndex) continue
      pairs.push({
        id,
        fromIndex,
        toIndex,
        role,
        relation,
        presentation: presentation ?? defaultPresentation(relation, role),
        ...(targetEdge ? { targetEdge } : {}),
        ...(label ? { label } : {}),
      })
    }
  }
  return pairs
}
