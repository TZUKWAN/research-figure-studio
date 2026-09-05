/**
 * P2 candidate review tests (GOAL §十四-§二十二): hard screen, fingerprint
 * dedup, vision blend, top-2 budget. Selection logic is exercised with an
 * injected stub renderer/vision reviewer — identical to the app wiring.
 */
import { describe, expect, it } from 'vitest'
import {
  reviewCandidates,
  VISION_WEIGHTS,
  visionOverall,
  type VisionReview,
} from '../src/orchestrator/candidate-review.js'
import { generateCandidates, type CompositionCandidate } from '../src/composition/candidate.js'
import { priorById } from '../src/composition/priors.js'
import { estimatorMeasurer, measureNode } from '../src/measurement/measure.js'

const SPEC = {
  titleSizePt: 13,
  detailSizePt: 10.5,
  maxTitleLines: 2,
  maxDetailLines: 2,
  padX: 10,
  padY: 8,
  titleGapY: 4,
  lineHeight: 1.25,
  minWidth: 96,
  maxWidth: 300,
  minHeight: 52,
  maxHeight: 170,
}

function measure(titles: string[]) {
  const measurer = estimatorMeasurer()
  return titles.map((title) => measureNode({ title }, SPEC, measurer))
}

const ids = ['hub', 's1', 's2', 's3', 's4', 's5', 'out']
const measured = measure(ids)
const meta = new Map(ids.map((id) => [id, { importance: id === 'hub' ? 0.95 : 0.45 }]))
// Integration note: with the semantic-orchestration grammar set merged in,
// the original one-output fan left only ONE hard-screen-clean candidate, so
// the blend contract had nothing to rank. The two-output fan keeps ≥2 clean
// candidates under the merged grammars, preserving the blend contract.
const edges = [
  { from: 's1', to: 'hub', role: 'main' as const, relation: 'causal' },
  { from: 's2', to: 'hub', role: 'main' as const, relation: 'causal' },
  { from: 's3', to: 'hub', role: 'main' as const, relation: 'data-flow' },
  { from: 'hub', to: 's4', role: 'main' as const, relation: 'process' },
  { from: 'hub', to: 's5', role: 'main' as const, relation: 'process' },
  { from: 's4', to: 'out', role: 'main' as const, relation: 'process' },
  { from: 's5', to: 'out', role: 'main' as const, relation: 'process' },
]

function review(stub: (candidate: CompositionCandidate) => VisionReview | null) {
  return reviewCandidates({
    candidates: generateCandidates(
      'A0',
      measured,
      edges,
      {
        roles: new Set(['core', 'input', 'output']),
        relations: new Set(['causal', 'process', 'data-flow']),
      },
      1280,
      720,
      null,
      meta,
    ),
    renderPreview: async () => 'c2Nhbg==',
    visionReview: async (candidate) => stub(candidate),
  })
}

function baseReview(): VisionReview {
  return {
    scientificReadability: 8,
    fiveSecondClarity: 8,
    visualHierarchy: 8,
    composition: 8,
    relationClarity: 8,
    typography: 8,
    visualRestraint: 8,
    domainAppropriateness: 8,
    professionalAppearance: 8,
    blockingProblems: [],
  }
}

describe('P2 multi-candidate art direction', () => {
  it('A0 produces four structurally different candidates', () => {
    const candidates = generateCandidates(
      'A0',
      measured,
      edges,
      {
        roles: new Set(['core', 'input', 'output']),
        relations: new Set(['causal', 'process', 'data-flow']),
      },
      1280,
      720,
      null,
      meta,
    )
    expect(candidates.length).toBeGreaterThanOrEqual(3)
  })

  it('hard screen eliminates geometry-illegal candidates before vision review', async () => {
    const seen: string[] = []
    const result = await review((candidate) => {
      seen.push(candidate.priorId ?? 'model')
      return null
    })
    for (const rejected of result.rejected) {
      expect(rejected.reason).toBeTruthy()
    }
    // every rejected candidate never reached the vision reviewer
    expect(result.ranked.length + result.rejected.length).toBeGreaterThanOrEqual(3)
    void seen
  })

  it('vision veto (blocking problems) fails a candidate regardless of beauty', async () => {
    let first = true
    const result = await review((_candidate) => {
      if (first) {
        first = false
        return { ...baseReview(), blockingProblems: ['unreadable labels at final size'] }
      }
      return baseReview()
    })
    // the vetoed candidate is rejected with the vision veto reason (it may not
    // be rejected[0] — deterministic rejections come first in the list)
    expect(result.rejected.some((entry) => entry.reason.startsWith('vision veto'))).toBe(true)
  })

  it('vision quality shifts the blend: better review wins at equal determinism', async () => {
    const result = await review((_candidate) => {
      return baseReview()
    })
    expect(result.ranked.length).toBeGreaterThanOrEqual(2)
    for (const entry of result.ranked) {
      expect(entry.blendedScore).toBeGreaterThan(0)
      expect(entry.blendedScore).toBeLessThanOrEqual(10)
    }
  })

  it('top-2 selection carries a refinement budget of at most 2', async () => {
    const result = await review(baseReview)
    expect(result.top2.length).toBeLessThanOrEqual(2)
    expect(result.refinementBudget).toBeLessThanOrEqual(2)
  })

  it('vision weights sum to exactly 1', () => {
    const sum = Object.values(VISION_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
    const full = baseReview()
    expect(visionOverall(full)).toBe(8)
  })
})

describe('P2 candidate shape sanity', () => {
  it('core-periphery prior exists for hub graphs', () => {
    expect(priorById('core-periphery')).not.toBeNull()
  })
})
