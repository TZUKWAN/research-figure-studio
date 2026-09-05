/**
 * Unified repair taxonomy (P0.5, GOAL §十一/§十二).
 *
 * One enum, one ladder table. UI layers may render friendlier labels, but the
 * runtime only ever emits/compares these classes. Ladder entries declare the
 * retry budget and the escalation class when the budget is exhausted — there
 * is deliberately no "budget exhausted → accept" transition anywhere.
 */

export const REPAIR_CLASSES = [
  'SEMANTIC_REPLAN',
  'CONTENT_REDUCE',
  'COMPOSITION_REDESIGN',
  'TYPOGRAPHY_FIX',
  'GEOMETRY_FIX',
  'ROUTE_FIX',
  'STYLE_FIX',
  'DOMAIN_STYLE_FIX',
  'PANEL_ALIGNMENT_FIX',
] as const

export type RepairClass = (typeof REPAIR_CLASSES)[number]

export interface RepairLadderStep {
  /** what triggers this class */
  trigger: string
  /** which pipeline stage owns the retry */
  handler: 'planner' | 'composer' | 'router' | 'renderer'
  /** retries allowed inside the owning stage */
  retryBudget: number
  /** next class when the retry budget is exhausted */
  escalation: RepairClass | 'FAIL_DELIVERY'
}

export const REPAIR_LADDER: Record<RepairClass, RepairLadderStep> = {
  ROUTE_FIX: {
    trigger: 'connector intersects node / unroutable declared connector',
    handler: 'router',
    retryBudget: 1,
    escalation: 'COMPOSITION_REDESIGN',
  },
  GEOMETRY_FIX: {
    trigger: 'overlap / out-of-bounds / exceeds canvas',
    handler: 'composer',
    retryBudget: 2,
    escalation: 'COMPOSITION_REDESIGN',
  },
  COMPOSITION_REDESIGN: {
    trigger: 'structural intent failure / information averaging / backwards reading',
    handler: 'composer',
    retryBudget: 2,
    escalation: 'SEMANTIC_REPLAN',
  },
  SEMANTIC_REPLAN: {
    trigger: 'required evidence missing / forbidden claim / over-summarised content',
    handler: 'planner',
    retryBudget: 2,
    escalation: 'FAIL_DELIVERY',
  },
  CONTENT_REDUCE: {
    trigger: 'canvas overloaded (fill band exceeded) / duplicate labels',
    handler: 'planner',
    retryBudget: 1,
    escalation: 'FAIL_DELIVERY',
  },
  TYPOGRAPHY_FIX: {
    trigger: 'final-size text floor failure',
    handler: 'composer',
    retryBudget: 1,
    // never "shrink below the floor": reduce content or recompose instead
    escalation: 'COMPOSITION_REDESIGN',
  },
  STYLE_FIX: {
    trigger: 'theme/contrast violation',
    handler: 'renderer',
    retryBudget: 1,
    escalation: 'FAIL_DELIVERY',
  },
  DOMAIN_STYLE_FIX: {
    trigger: 'domain primitive / connector semantics mismatch',
    handler: 'renderer',
    retryBudget: 1,
    escalation: 'COMPOSITION_REDESIGN',
  },
  PANEL_ALIGNMENT_FIX: {
    trigger: 'multi-panel alignment beyond tolerance',
    handler: 'composer',
    retryBudget: 1,
    escalation: 'COMPOSITION_REDESIGN',
  },
}
