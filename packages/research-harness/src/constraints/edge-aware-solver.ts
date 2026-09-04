/**
 * Edge classification (P0 rewrite). Maps semantic edges to routing priorities
 * used by the Router and the critic.
 *
 * The former edge-aware SOLVE (nudging primary endpoints toward an axis) was
 * removed intentionally: composition authority belongs to the Designer, and
 * the solver only legalizes bounds/overlap/text-fit. Dead nudge code has been
 * deleted rather than kept unused.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { RelationType } from '../semantic/schema.js'

export const PRIMARY_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>([
  'causal',
  'process',
  'data-flow',
  'transformation',
  'mediation',
])

export type EdgePriority = 'primary' | 'secondary' | 'feedback'

export function priorityFor(role: string, relation: string): EdgePriority {
  if (role === 'feedback') return 'feedback'
  if (PRIMARY_RELATIONS.has(relation as RelationType)) return 'primary'
  return 'secondary'
}

export interface EdgeTarget {
  fromId: string
  toId: string
  role: 'main' | 'feedback'
  relation: string
  priority: EdgePriority
}

export function classifyEdges(plan: FigurePlanV2): EdgeTarget[] {
  return plan.edges.map((edge) => ({
    fromId: edge.from,
    toId: edge.to,
    role: edge.role,
    relation: edge.relation,
    priority: priorityFor(edge.role, edge.relation),
  }))
}
