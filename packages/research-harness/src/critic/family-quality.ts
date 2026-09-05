/**
 * FamilyQualityProfile (QA-P0-02). A single global fill target (~15%) cannot
 * govern every figure family: a graphical abstract legitimately fills far
 * more canvas than a minimal statement. Each family declares the composition
 * band it is judged against, plus the expectations the composition critic
 * scores softly. This table is judgement band, not layout instruction.
 */
import type { FigureFamily } from '../contract/figure-contract.js'

export interface FamilyQualityProfile {
  /** acceptable occupied-area fraction of the canvas */
  targetFillRange: [number, number]
  /** fill fraction the profile considers ideal */
  idealFill: number
  /** expected share of total node area held by the most important node */
  focalExpectation: number
  /** how much whitespace unevenness the family tolerates (0 = strict) */
  whitespaceTolerance: number
  /** whether deliberate asymmetry is part of the family's language */
  asymmetricOk: boolean
  /** expected relation edges per node (soft band) */
  relationDensity: [number, number]
}

const P = (
  targetFillRange: [number, number],
  idealFill: number,
  focalExpectation: number,
  whitespaceTolerance: number,
  asymmetricOk: boolean,
  relationDensity: [number, number],
): FamilyQualityProfile => ({
  targetFillRange,
  idealFill,
  focalExpectation,
  whitespaceTolerance,
  asymmetricOk,
  relationDensity,
})

export const FAMILY_QUALITY_PROFILES: Record<FigureFamily, FamilyQualityProfile> = {
  'graphical-abstract': P([0.22, 0.55], 0.35, 0.22, 0.6, true, [0.4, 1.4]),
  matrix: P([0.2, 0.6], 0.4, 0.08, 0.3, false, [0.2, 0.8]),
  network: P([0.15, 0.5], 0.3, 0.15, 0.6, true, [0.8, 2.0]),
  timeline: P([0.1, 0.4], 0.22, 0.12, 0.5, true, [0.3, 1.0]),
  comparison: P([0.15, 0.5], 0.3, 0.1, 0.5, false, [0.2, 1.0]),
  'multi-panel-data': P([0.25, 0.65], 0.45, 0.1, 0.4, false, [0.1, 0.6]),
  framework: P([0.12, 0.45], 0.25, 0.18, 0.6, true, [0.4, 1.5]),
  architecture: P([0.15, 0.5], 0.3, 0.15, 0.6, true, [0.4, 1.5]),
  pipeline: P([0.12, 0.42], 0.25, 0.14, 0.5, false, [0.5, 1.4]),
  mechanism: P([0.12, 0.45], 0.26, 0.18, 0.6, true, [0.5, 1.6]),
  'causal-model': P([0.1, 0.4], 0.22, 0.16, 0.6, true, [0.5, 1.6]),
  hierarchy: P([0.1, 0.45], 0.25, 0.2, 0.5, false, [0.3, 1.0]),
  'experimental-setup': P([0.15, 0.5], 0.3, 0.14, 0.6, true, [0.2, 1.2]),
  outreach: P([0.18, 0.55], 0.32, 0.16, 0.6, true, [0.2, 1.2]),
  freeform: P([0.08, 0.5], 0.25, 0.14, 0.8, true, [0.1, 1.8]),
}

export function familyProfileFor(family?: string): FamilyQualityProfile {
  if (family && Object.prototype.hasOwnProperty.call(FAMILY_QUALITY_PROFILES, family)) {
    return FAMILY_QUALITY_PROFILES[family as FigureFamily]
  }
  return FAMILY_QUALITY_PROFILES.freeform
}

/**
 * Soft fill fit: 10 inside the target band, falling off smoothly outside.
 * Halving at ~50% deviation keeps the penalty legible without dominating.
 */
export function fillScore(fill: number, profile: FamilyQualityProfile): number {
  const [lo, hi] = profile.targetFillRange
  if (fill >= lo && fill <= hi) return 10
  const distance = fill < lo ? (lo - fill) / Math.max(lo, 1e-6) : (fill - hi) / Math.max(hi, 1e-6)
  return Math.max(0, 10 * Math.exp(-distance * 1.6))
}
