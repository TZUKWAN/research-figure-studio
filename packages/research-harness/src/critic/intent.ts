/**
 * Intent-faithfulness audit (P1): compares the AI Art Director's SpatialPlan
 * INTENT against the SOLVED geometry. The critic's question is not "is this
 * pretty" but "did the final canvas faithfully realise the declared design".
 */
import type { SpatialPlan } from '../composition/spatial-plan.js'
import type { SolvedPlacement } from '../constraints/solver.js'
import type { Rect } from '../routing/geometry.js'

export interface IntentFailure {
  id: string
  severity: 'local' | 'structural'
  detail: string
}

export function auditIntent(
  plan: SpatialPlan,
  placements: SolvedPlacement[],
  canvasW: number,
  canvasH: number,
): IntentFailure[] {
  const failures: IntentFailure[] = []
  if (placements.length < 2) return failures
  const rects = new Map<string, Rect>(placements.map((p) => [p.id, p]))
  const areaOf = (r: Rect) => r.w * r.h
  const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
  const maxArea = Math.max(...placements.map((p) => areaOf(p)))

  // visualCenter must be REALIZED as the visually dominant element. It does
  // NOT have to sit at the geometric canvas center: asymmetric compositions
  // are legitimate design statements, and punishing them would force every
  // figure back into grid symmetry. Dominance = area prominence.
  const vcId = plan.composition.visualCenter
  if (vcId && rects.has(vcId)) {
    if (areaOf(rects.get(vcId)!) < maxArea * 0.85) {
      failures.push({
        id: 'visualCenter-not-emphasised',
        severity: 'structural',
        detail: `hierarchy realization failure: visualCenter "${vcId}" is not among the most prominent nodes`,
      })
    }
  }

  // dominant placements must be the largest
  for (const placement of plan.placements) {
    if (placement.visualRole !== 'dominant') continue
    const rect = rects.get(placement.id)
    if (rect && areaOf(rect) < maxArea * 0.85) {
      failures.push({
        id: `dominant-${placement.id}`,
        severity: 'structural',
        detail: `dominant node "${placement.id}" is visually smaller than the largest node`,
      })
    }
  }

  // proximity intents must be measurably closer than the global median pair
  const pairDistances: number[] = []
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = center(placements[i]!)
      const b = center(placements[j]!)
      pairDistances.push(Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  const median = [...pairDistances].sort((a, b) => a - b)[Math.floor(pairDistances.length / 2)] ?? 0
  for (const placement of plan.placements) {
    for (const other of placement.placementIntent?.proximityTo ?? []) {
      const a = rects.get(placement.id)
      const b = rects.get(other)
      if (!a || !b) continue
      const ca = center(a)
      const cb = center(b)
      const d = Math.hypot(ca.x - cb.x, ca.y - cb.y)
      if (d > median * 0.8) {
        failures.push({
          id: `proximity-${placement.id}-${other}`,
          severity: 'local',
          detail: `"${placement.id}" should sit near "${other}" but is at median spread`,
        })
      }
    }
    for (const other of placement.placementIntent?.separationFrom ?? []) {
      const a = rects.get(placement.id)
      const b = rects.get(other)
      if (!a || !b) continue
      const ca = center(a)
      const cb = center(b)
      const d = Math.hypot(ca.x - cb.x, ca.y - cb.y)
      if (d < median * 0.5) {
        failures.push({
          id: `separation-${placement.id}-${other}`,
          severity: 'local',
          detail: `"${placement.id}" should be separated from "${other}" but is clustered with it`,
        })
      }
    }
  }

  // symmetric balance: left/right extent spread within 25%
  if (plan.composition.balance === 'symmetric') {
    const minX = Math.min(...placements.map((p) => p.x))
    const maxX = Math.max(...placements.map((p) => p.x + p.w))
    const left = minX
    const right = canvasW - maxX
    if (Math.abs(left - right) > canvasW * 0.25) {
      failures.push({
        id: 'balance-symmetry',
        severity: 'local',
        detail: `symmetric balance requested but margins differ (left ${Math.round(left)}px vs right ${Math.round(right)}px)`,
      })
    }
  }

  return failures
}
