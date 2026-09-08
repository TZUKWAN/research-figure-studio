/**
 * Delivery Gate (P0.5, GOAL §三/§十二).
 *
 * Single, non-bypassable authority for "may this figure be delivered?".
 * Repair-budget exhaustion is NEVER acceptance: if the pipeline ran out of
 * budget while the critic still demands changes, delivery fails with
 * diagnostics preserved — no silent shipping.
 */
import type { CriticVerdict } from '../critic/metric-critic.js'

export type DeliveryGateReason =
  | 'GEOMETRY_HARD_FAIL'
  | 'ROUTE_HARD_FAIL'
  | 'SEMANTIC_HARD_FAIL'
  | 'PUBLICATION_HARD_FAIL'
  | 'CONTENT_CONTRACT_FAIL'
  | 'POST_WRITE_LAYOUT_FAIL'
  | 'QUALITY_THRESHOLD_FAIL'
  | 'REPAIR_BUDGET_EXHAUSTED'
  | 'VISION_REVIEW_UNAVAILABLE'

export interface DeliveryGateInput {
  critic: Pick<CriticVerdict, 'verdict' | 'hardPass' | 'hardGates'>
  /** count of hard scientific-critic issues (evidence/connector/fidelity) */
  scientificHardIssues: number
  /** count of hard publication-audit issues (final-size text/stroke floors) */
  publicationHardIssues: number
  /** forbidden claims or visible-text contract violations found on canvas */
  contentContractViolations: number
  /** required evidence ids that never reached the canvas */
  requiredEvidenceMissing: number
  /** renderer-side post-write layout audit issues (slides layer) */
  postWriteIssues?: number
  /**
   * P1-2 venue policy: the contract REQUIRES screenshot vision review
   * (publication-grade venue/context) but no vision reviewer reached the
   * pipeline — a submission-grade PASS is impossible without it.
   */
  visionReviewRequiredMissing?: boolean
  /** true when the repair ladder ran out of budget while not yet PASS */
  repairBudgetExhausted: boolean
}

export interface DeliveryGateResult {
  pass: boolean
  reasons: DeliveryGateReason[]
  detail: string
}

/**
 * The ONLY source of `orchestration.ok`. Every condition is additive so the
 * caller receives the complete failure picture, not just the first miss.
 */
export function evaluateDeliveryGate(input: DeliveryGateInput): DeliveryGateResult {
  const reasons: DeliveryGateReason[] = []
  for (const gate of input.critic.hardGates ?? []) {
    if (gate.pass) continue
    if (gate.scope === 'geometry') reasons.push('GEOMETRY_HARD_FAIL')
    else if (gate.scope === 'route') reasons.push('ROUTE_HARD_FAIL')
    else if (gate.scope === 'semantic') reasons.push('SEMANTIC_HARD_FAIL')
  }
  if (input.scientificHardIssues > 0) reasons.push('SEMANTIC_HARD_FAIL')
  if (input.publicationHardIssues > 0) reasons.push('PUBLICATION_HARD_FAIL')
  if (input.contentContractViolations > 0) reasons.push('CONTENT_CONTRACT_FAIL')
  if (input.requiredEvidenceMissing > 0) reasons.push('SEMANTIC_HARD_FAIL')
  if (input.postWriteIssues !== undefined && input.postWriteIssues > 0)
    reasons.push('POST_WRITE_LAYOUT_FAIL')
  if (input.critic.verdict !== 'PASS') reasons.push('QUALITY_THRESHOLD_FAIL')
  if (input.repairBudgetExhausted && input.critic.verdict !== 'PASS')
    reasons.push('REPAIR_BUDGET_EXHAUSTED')
  if (input.visionReviewRequiredMissing) reasons.push('VISION_REVIEW_UNAVAILABLE')

  const unique = [...new Set(reasons)]
  return {
    pass: unique.length === 0,
    reasons: unique,
    detail: unique.join(', '),
  }
}
