/**
 * Scientific Critic (17.3, deterministic core; P0).
 *
 * Runs AFTER routing against the FINAL canvas state and audits scientific
 * integrity, separate from the geometric/metric critic:
 *   - required evidence visible (hard → SEMANTIC_REPLAN)
 *   - declared connector relations actually realized (hard → ROUTE_FIX)
 *   - causal reading direction monotonicity (soft → COMPOSITION_REDESIGN)
 *   - importance dominance realized as visual dominance (soft → COMPOSITION_REDESIGN)
 *   - duplicate visible labels / over-summarisation signals (soft → CONTENT_REDUCE)
 *
 * Vision-based scientific review stays in the app-level QC loop; this module
 * is pure arithmetic so the pipeline can gate without a model.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { RoutedEdge } from '../routing/router.js'

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

const CONNECTOR_PRESENTATIONS = new Set([
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
  'junction',
])

const DIRECTIONAL_RELATIONS = new Set(['causal', 'process', 'transformation', 'data-flow'])

export function auditScientific(input: {
  plan: FigurePlanV2
  placements: Array<{ id: string; x: number; y: number; w: number; h: number }>
  routes?: RoutedEdge[]
  importance?: Map<string, number>
  direction?: 'LR' | 'TB'
}): ScientificIssue[] {
  const issues: ScientificIssue[] = []
  const placedIds = new Set(input.placements.map((p) => p.id))
  const narrative = input.plan.narrative

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

  // 2) declared connector relations must be realized as routed connectors
  const routeByEndpoints = new Map<string, RoutedEdge>()
  for (const route of input.routes ?? []) {
    routeByEndpoints.set(`${route.fromId}\u0000${route.toId}`, route)
  }
  const unrealized: string[] = []
  for (const edge of input.plan.edges) {
    const presentation = edge.presentation ?? 'arrow'
    if (!CONNECTOR_PRESENTATIONS.has(presentation)) continue
    const route = routeByEndpoints.get(`${edge.from}\u0000${edge.to}`)
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

  // 3) causal direction should advance along the declared reading flow (LR)
  if ((input.direction ?? 'LR') === 'LR') {
    const rectById = new Map(input.placements.map((p) => [p.id, p]))
    const backwards: string[] = []
    for (const edge of input.plan.edges) {
      if (!DIRECTIONAL_RELATIONS.has(edge.relation) || edge.role === 'feedback') continue
      const a = rectById.get(edge.from)
      const b = rectById.get(edge.to)
      if (!a || !b) continue
      if (b.x + b.w / 2 < a.x + a.w / 2 - 80) backwards.push(edge.id ?? `${edge.from}->${edge.to}`)
    }
    if (backwards.length > 0) {
      issues.push({
        severity: 'soft',
        repairClass: 'COMPOSITION_REDESIGN',
        message: `directional relations read backwards against the LR flow: ${backwards.join(', ')}`,
        affectedIds: backwards,
      })
    }
  }

  // 4) importance dominance must become visual dominance (anti card-wall)
  const importance = input.importance
  if (importance && importance.size >= 2 && input.placements.length >= 2) {
    const values = [...importance.values()]
    const spread = Math.max(...values) - Math.min(...values)
    if (spread >= 0.3) {
      const byArea = [...input.placements].sort((a, b) => b.w * b.h - a.w * a.h)
      const mostImportantId = [...importance.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      const areaRank = byArea.findIndex((p) => p.id === mostImportantId) + 1
      if (areaRank > Math.max(2, Math.ceil(input.placements.length / 3))) {
        issues.push({
          severity: 'soft',
          repairClass: 'COMPOSITION_REDESIGN',
          message: `most important node "${mostImportantId}" ranks #${areaRank} by area — information averaging detected`,
          affectedIds: [mostImportantId],
        })
      }
    }
  }

  // 5) duplicate visible titles = redundant information units
  const seenTitles = new Map<string, number>()
  for (const node of input.plan.nodes) {
    const title = node.visible.title.trim()
    seenTitles.set(title, (seenTitles.get(title) ?? 0) + 1)
  }
  const duplicates = [...seenTitles.entries()].filter(([, count]) => count > 1)
  if (duplicates.length > 0) {
    issues.push({
      severity: 'soft',
      repairClass: 'CONTENT_REDUCE',
      message: `duplicate visible labels should merge: ${duplicates.map(([title]) => title).join(', ')}`,
      affectedIds: duplicates.map(([title]) => title),
    })
  }

  return issues
}
