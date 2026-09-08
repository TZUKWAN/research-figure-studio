/**
 * Multi-Candidate Art Director selection logic (P2, GOAL §十四-§二十二).
 *
 * Pure selection logic with INJECTED render/vision capabilities:
 *   1. hard-gate screen (never sends failing candidates to a vision model)
 *   2. deterministic quality score (already on the candidate)
 *   3. optional screenshot vision review (rubric JSON, image REQUIRED)
 *   4. blended ranking — scientific integrity is never outvoted by beauty
 *   5. top-2 selection with a refinement budget of exactly 1 per candidate
 *
 * The app wires `renderPreview` (offscreen Konva via renderSlidesToPngBase64)
 * and `visionReview` (runLlm + QC-style rubric prompt). Harness tests inject
 * stubs; the selection logic is identical everywhere.
 */
import type { CompositionCandidate } from '../composition/candidate.js'

export interface VisionReview {
  scientificReadability: number
  fiveSecondClarity: number
  visualHierarchy: number
  composition: number
  relationClarity: number
  typography: number
  visualRestraint: number
  domainAppropriateness: number
  professionalAppearance: number
  blockingProblems: string[]
  repairSuggestions?: Array<{
    repairClass: string
    targetIds: string[]
    instruction: string
  }>
}

export type VisionReviewer = (
  candidate: CompositionCandidate,
  screenshotPngBase64: string,
) => Promise<VisionReview | null>

export type PreviewRenderer = (
  candidate: CompositionCandidate,
  /** plan node titles for the preview (the orchestrator's current plan) */
  planNodes: Array<{ id: string; visible: { title: string } }>,
) => Promise<string>

export interface ReviewedCandidate {
  candidate: CompositionCandidate
  vision: VisionReview | null
  /** deterministic + vision blend; vision absent → deterministic only */
  blendedScore: number
}

/** Vision rubric weights (sum = 1). GOAL §二十. */
export const VISION_WEIGHTS: Record<keyof Omit<VisionReview, 'blockingProblems' | 'repairSuggestions'>, number> = {
  scientificReadability: 0.15,
  fiveSecondClarity: 0.15,
  visualHierarchy: 0.1,
  composition: 0.15,
  relationClarity: 0.1,
  typography: 0.1,
  visualRestraint: 0.05,
  domainAppropriateness: 0.05,
  professionalAppearance: 0.15,
}

/** Blended weights: deterministic screen quality vs vision quality. */
export const BLEND = { deterministic: 0.5, vision: 0.5 } as const

export function visionOverall(review: VisionReview): number {
  const keys = Object.keys(VISION_WEIGHTS) as Array<keyof typeof VISION_WEIGHTS>
  const sum = keys.reduce((acc, key) => acc + VISION_WEIGHTS[key] * review[key], 0)
  return Math.round(sum * 100) / 100
}

export interface CandidateReviewResult {
  /** survivors of the hard screen, ranked best-first */
  ranked: ReviewedCandidate[]
  rejected: Array<{ candidate: CompositionCandidate; reason: string }>
  /** top candidates entering the refinement budget (max 2, GOAL §二十一) */
  top2: ReviewedCandidate[]
  refinementBudget: number
}

/**
 * Screen → render → vision-review → blend → rank → top-2.
 * renderPreview/visionReview are injected: harness tests use stubs, the app
 * wires offscreen Konva rendering and the screenshot vision rubric.
 */
export async function reviewCandidates(input: {
  candidates: CompositionCandidate[]
  maxDeliverableNodes?: number
  renderPreview: PreviewRenderer
  visionReview: VisionReviewer
  /** titles for preview rendering (the orchestrator's current plan) */
  planNodes?: Array<{ id: string; visible: { title: string } }>
}): Promise<CandidateReviewResult> {
  const rejected: CandidateReviewResult['rejected'] = []
  const survivors: CompositionCandidate[] = []

  // 1) deterministic hard screen: geometry-illegal or node-intersecting
  // candidates are eliminated before any vision token is spent (GOAL §十六)
  for (const candidate of input.candidates) {
    if (candidate.solve.issues.length > 0) {
      rejected.push({
        candidate,
        reason: `geometry: ${candidate.solve.issues.join('; ')}`,
      })
      continue
    }
    if (candidate.nodeIntersections > 0) {
      rejected.push({
        candidate,
        reason: `connector crosses ${candidate.nodeIntersections} node(s)`,
      })
      continue
    }
    survivors.push(candidate)
  }

  // 2) render + vision review on survivors
  const ranked: ReviewedCandidate[] = []
  for (const candidate of survivors) {
    let vision: VisionReview | null = null
    try {
      const screenshot = await input.renderPreview(candidate, input.planNodes ?? [])
      if (screenshot) vision = await input.visionReview(candidate, screenshot)
    } catch {
      // vision review is OPTIONAL quality signal; deterministic score still applies
      vision = null
    }
    // vision veto: blocking problems fail the candidate outright (GOAL §二十:
    // 科学错误绝不能被漂亮抵消 — and hard visual blockers are not averaged away)
    if (vision && vision.blockingProblems.length > 0) {
      rejected.push({
        candidate,
        reason: `vision veto: ${vision.blockingProblems.join('; ')}`,
      })
      continue
    }
    const deterministic = Math.max(0, 10 - candidate.score / 100)
    const visionScore = vision ? visionOverall(vision) : null
    const blendedScore = Math.round(
      (BLEND.deterministic * deterministic +
        BLEND.vision * (visionScore ?? deterministic)) *
        100,
    ) / 100
    ranked.push({ candidate, vision, blendedScore })
  }

  ranked.sort((a, b) => b.blendedScore - a.blendedScore)
  const top2 = ranked.slice(0, 2)
  return {
    ranked,
    rejected,
    top2,
    // GOAL §二十二: initial 4, top-2 refinement, max 1 refinement per candidate
    refinementBudget: Math.min(2, top2.length),
  }
}
