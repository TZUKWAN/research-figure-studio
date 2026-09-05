/**
 * FigureFamily Strategy (audit COMP-P1-02). The contract declares one of 15
 * figure families; this module is the SINGLE source of truth for which
 * composition grammars a family may use, which it prefers, which it forbids,
 * and which additional semantic signals it REQUIRES.
 *
 * A family whose signals are missing fails with an explicit typed error —
 * it never silently degrades to freeform while claiming support.
 */
import type { FigureFamily } from '../contract/figure-contract.js'
import type { CompositionSignature } from './priors.js'

export interface FigureFamilyStrategy {
  family: FigureFamily
  /** grammars this family may compose with */
  eligibleGrammars: string[]
  /** grammars tried first (semantic best fit) */
  preferredGrammars: string[]
  /** grammars that would misrepresent this family */
  forbiddenGrammars: string[]
  /** predicates over the CompositionSignature that MUST hold to compose */
  requiredSignals: Array<{
    signal: string
    test: (signature: CompositionSignature) => boolean
    /** what the planner must declare to satisfy this signal */
    remedy: string
  }>
  /**
   * strict: when no eligible grammar produces a candidate the run FAILS.
   * relaxed: when no eligible grammar produces a candidate the run may use
   * the general priors (still recorded in diagnostics).
   */
  fallbackPolicy: 'strict' | 'relaxed'
}

/** families with no honest composition semantics YET (reported, never faked) */
export const UNSUPPORTED_FAMILIES: readonly FigureFamily[] = ['outreach']

export class UnsupportedFigureFamilyError extends Error {
  readonly family: string
  constructor(family: string, reason?: string) {
    super(
      reason ??
        `UNSUPPORTED_FIGURE_FAMILY: "${family}" has no composition semantics; declare a supported family or omit it`,
    )
    this.name = 'UnsupportedFigureFamilyError'
    this.family = family
  }
}

const noForbidden: string[] = []

export const FAMILY_STRATEGIES: Record<FigureFamily, FigureFamilyStrategy> = {
  framework: {
    family: 'framework',
    eligibleGrammars: ['input-core-output', 'layered', 'parallel', 'diverging'],
    preferredGrammars: ['input-core-output', 'layered'],
    forbiddenGrammars: ['moderation'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  architecture: {
    family: 'architecture',
    eligibleGrammars: ['layered', 'parallel', 'input-core-output'],
    preferredGrammars: ['layered'],
    forbiddenGrammars: ['mediation'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  pipeline: {
    family: 'pipeline',
    eligibleGrammars: ['linear', 'parallel', 'layered'],
    preferredGrammars: ['linear'],
    forbiddenGrammars: ['radial'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  mechanism: {
    family: 'mechanism',
    eligibleGrammars: ['input-core-output', 'causal', 'mediation', 'layered'],
    preferredGrammars: ['input-core-output'],
    forbiddenGrammars: ['timeline'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  'causal-model': {
    family: 'causal-model',
    eligibleGrammars: ['causal', 'mediation', 'moderation', 'input-core-output'],
    preferredGrammars: ['causal'],
    forbiddenGrammars: ['matrix'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  hierarchy: {
    family: 'hierarchy',
    eligibleGrammars: ['tree', 'layered'],
    preferredGrammars: ['tree'],
    forbiddenGrammars: ['moderation'],
    requiredSignals: [
      {
        signal: 'acyclic hierarchy subgraph',
        test: (signature) => !signature.hasCycle,
        remedy: 'remove the non-feedback cycle so the hierarchy can be layered',
      },
    ],
    fallbackPolicy: 'strict',
  },
  network: {
    family: 'network',
    eligibleGrammars: ['network', 'radial', 'parallel'],
    preferredGrammars: ['network'],
    forbiddenGrammars: ['linear'],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  timeline: {
    family: 'timeline',
    eligibleGrammars: ['timeline', 'linear'],
    preferredGrammars: ['timeline'],
    forbiddenGrammars: ['radial', 'matrix'],
    requiredSignals: [
      {
        signal: 'declared timeOrder',
        test: (signature) => signature.hasTimeOrder,
        remedy:
          'declare plan.timeOrder: [nodeId, ...] — lexicographic node ids are NOT temporal order',
      },
    ],
    fallbackPolicy: 'strict',
  },
  matrix: {
    family: 'matrix',
    eligibleGrammars: ['matrix'],
    preferredGrammars: ['matrix'],
    forbiddenGrammars: ['radial'],
    requiredSignals: [
      {
        signal: 'declared matrix axes',
        test: (signature) => signature.hasMatrixAxes,
        remedy:
          'declare plan.matrix { rowGroupIds, columnGroupIds } referencing existing groups — a uniform grid of unrelated nodes is not a matrix',
      },
    ],
    fallbackPolicy: 'strict',
  },
  'multi-panel-data': {
    family: 'multi-panel-data',
    eligibleGrammars: ['parallel', 'layered'],
    preferredGrammars: ['parallel'],
    forbiddenGrammars: [],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  'graphical-abstract': {
    family: 'graphical-abstract',
    eligibleGrammars: ['input-core-output', 'radial', 'network', 'causal'],
    preferredGrammars: ['input-core-output'],
    forbiddenGrammars: [],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  'experimental-setup': {
    family: 'experimental-setup',
    eligibleGrammars: ['linear', 'input-core-output', 'comparison', 'layered'],
    preferredGrammars: ['linear'],
    forbiddenGrammars: [],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  comparison: {
    family: 'comparison',
    eligibleGrammars: ['comparison', 'parallel', 'linear'],
    preferredGrammars: ['comparison'],
    forbiddenGrammars: [],
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
  outreach: {
    family: 'outreach',
    eligibleGrammars: [],
    preferredGrammars: [],
    forbiddenGrammars: noForbidden,
    requiredSignals: [],
    fallbackPolicy: 'strict',
  },
  freeform: {
    family: 'freeform',
    eligibleGrammars: [],
    preferredGrammars: [],
    forbiddenGrammars: noForbidden,
    requiredSignals: [],
    fallbackPolicy: 'relaxed',
  },
}

/**
 * Resolve the strategy for a family. `null` means "no declared family —
 * general priors apply". Unsupported families throw the typed error instead
 * of silently falling back (audit §31).
 */
export function familyStrategyFor(family?: string): FigureFamilyStrategy | null {
  if (!family) return null
  const normalized = family.trim().toLowerCase()
  if (!normalized || normalized === 'freeform' || normalized === 'auto') return null
  const strategy = FAMILY_STRATEGIES[normalized as FigureFamily]
  if (!strategy) {
    throw new UnsupportedFigureFamilyError(normalized)
  }
  if (UNSUPPORTED_FAMILIES.includes(normalized as FigureFamily)) {
    throw new UnsupportedFigureFamilyError(
      normalized,
      `UNSUPPORTED_FIGURE_FAMILY: "${normalized}" composition is not implemented; the figure would be faked`,
    )
  }
  return strategy
}

/** Signals the signature fails, with the planner remedy for each. */
export function unmetFamilySignals(
  strategy: FigureFamilyStrategy,
  signature: CompositionSignature,
): Array<{ signal: string; remedy: string }> {
  return strategy.requiredSignals
    .filter((requirement) => !requirement.test(signature))
    .map((requirement) => ({ signal: requirement.signal, remedy: requirement.remedy }))
}
