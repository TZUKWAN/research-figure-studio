/**
 * Composition Priors (Phase 3, GOAL §17-18). Priors are TENDENCIES, not
 * templates: each carries topological/spatial/routing bias with an allowed
 * range the model (or candidate generator) may move inside.
 */
import type { ReadingFlow } from './spatial-plan.js'

export interface CompositionPrior {
  id: string
  semanticFit: string[]
  principles: string[]
  defaultBias: Record<string, number>
  allowedRange: Record<string, [number, number]>
  readingFlow: ReadingFlow
}

export const COMPOSITION_PRIORS: CompositionPrior[] = [
  {
    id: 'linear-process',
    semanticFit: ['simple flow', 'stage sequence', 'pipeline'],
    principles: ['main flow LR', 'equal node prominence unless staged'],
    defaultBias: { first: 0.06, last: 0.94 },
    allowedRange: { first: [0.04, 0.1], last: [0.9, 0.96] },
    readingFlow: 'LR',
  },
  {
    id: 'converging-flow',
    semanticFit: ['multi-input', 'fan-in', 'aggregation'],
    principles: ['inputs spread on the left', 'convergence point gets visual weight'],
    defaultBias: { inputs: 0.08, sink: 0.82 },
    allowedRange: { inputs: [0.04, 0.14], sink: [0.7, 0.92] },
    readingFlow: 'LR',
  },
  {
    id: 'diverging-flow',
    semanticFit: ['multi-output', 'fan-out', 'diffusion'],
    principles: ['source anchored left', 'outputs spread on the right'],
    defaultBias: { source: 0.1, outputs: 0.86 },
    allowedRange: { source: [0.05, 0.16], outputs: [0.78, 0.94] },
    readingFlow: 'LR',
  },
  {
    id: 'input-core-output',
    semanticFit: ['causal-framework', 'mechanism-model', 'processing-system'],
    principles: [
      'main flow usually LR',
      'core usually gets strongest visual weight',
      'inputs may converge',
      'outputs may diverge',
      'moderators may stay outside primary flow',
      'feedback normally uses peripheral lane',
    ],
    defaultBias: { input: 0.24, core: 0.46, output: 0.3 },
    allowedRange: {
      input: [0.15, 0.32],
      core: [0.34, 0.62],
      output: [0.15, 0.32],
    },
    readingFlow: 'LR',
  },
  {
    id: 'parallel-mechanisms',
    semanticFit: ['parallel paths', 'competing mechanisms', 'independent tracks'],
    principles: ['tracks run side-by-side', 'shared inputs/outputs anchor the ends'],
    defaultBias: { start: 0.08, end: 0.88 },
    allowedRange: { start: [0.04, 0.12], end: [0.82, 0.94] },
    readingFlow: 'LR',
  },
  {
    id: 'layered-architecture',
    semanticFit: ['stack', 'tiered system', 'abstraction layers'],
    principles: ['layers stack TB', 'flow usually LR inside a layer'],
    defaultBias: { top: 0.08, bottom: 0.9 },
    allowedRange: { top: [0.04, 0.12], bottom: [0.86, 0.95] },
    readingFlow: 'TB',
  },
  {
    id: 'core-periphery',
    semanticFit: ['hub model', 'central construct with satellites'],
    principles: ['core at visual center', 'satellites ring outward'],
    defaultBias: { core: 0.5 },
    allowedRange: { core: [0.42, 0.58] },
    readingFlow: 'radial',
  },
  {
    id: 'feedback-system',
    semanticFit: ['loop', 'homeostatic model', 'reinforcing/balancing loop'],
    principles: ['main flow LR', 'feedback rides the peripheral lane'],
    defaultBias: { start: 0.08, end: 0.88, feedbackLane: 0.92 },
    allowedRange: { start: [0.04, 0.14], end: [0.8, 0.94], feedbackLane: [0.86, 0.97] },
    readingFlow: 'LR',
  },
  {
    id: 'causal-framework',
    semanticFit: ['X→Y model', 'effect decomposition'],
    principles: ['cause left, effect right', 'moderators above the main path'],
    defaultBias: { cause: 0.12, effect: 0.84 },
    allowedRange: { cause: [0.05, 0.2], effect: [0.76, 0.92] },
    readingFlow: 'LR',
  },
  {
    id: 'mediation',
    semanticFit: ['X→M→Y mediation'],
    principles: ['mediator centered between cause and effect'],
    defaultBias: { x: 0.1, m: 0.5, y: 0.9 },
    allowedRange: { x: [0.05, 0.16], m: [0.42, 0.58], y: [0.84, 0.95] },
    readingFlow: 'LR',
  },
  {
    id: 'moderation',
    semanticFit: ['moderated effect'],
    principles: ['moderator above the arrow it qualifies'],
    defaultBias: { x: 0.12, y: 0.84, moderator: 0.48 },
    allowedRange: { x: [0.05, 0.2], y: [0.76, 0.92], moderator: [0.35, 0.62] },
    readingFlow: 'LR',
  },
  {
    id: 'multi-stage-pipeline',
    semanticFit: ['experiment flow', 'algorithm pipeline'],
    principles: ['stages LR with clear stage bands'],
    defaultBias: { first: 0.06, last: 0.92 },
    allowedRange: { first: [0.03, 0.1], last: [0.88, 0.96] },
    readingFlow: 'LR',
  },
  {
    id: 'hierarchical-system',
    semanticFit: ['taxonomy', 'org chart', 'decomposition'],
    principles: ['root top, leaves bottom'],
    defaultBias: { root: 0.5, leaves: 0.9 },
    allowedRange: { root: [0.42, 0.58], leaves: [0.82, 0.95] },
    readingFlow: 'TB',
  },
]

export function priorById(id: string): CompositionPrior | null {
  return COMPOSITION_PRIORS.find((prior) => prior.id === id) ?? null
}

/**
 * Deterministic semantic fit score of a prior against a plan's signals
 * (node roles/relation types present). Pure arithmetic, no model in the loop.
 */
export function priorFitScore(
  prior: CompositionPrior,
  signals: { roles: Set<string>; relations: Set<string> },
): number {
  let score = 0
  const has = (list: string[], keys: Set<string>) => list.some((item) => keys.has(item))
  const roleFit: Record<string, string[]> = {
    'converging-flow': ['fan-in'],
    'diverging-flow': ['fan-out'],
    'feedback-system': ['feedback'],
    moderation: ['moderation'],
    mediation: ['mediation'],
    'parallel-mechanisms': ['parallel'],
  }
  for (const [id, keys] of Object.entries(roleFit)) {
    if (prior.id === id && has(keys, signals.relations)) score += 3
  }
  if (prior.id === 'input-core-output') {
    if (signals.roles.has('input') && signals.roles.has('core') && signals.roles.has('output')) {
      score += 3
    }
  }
  if (prior.id === 'linear-process' && signals.relations.has('process')) score += 1
  if (prior.id === 'hierarchical-system' && signals.relations.has('hierarchy')) score += 3
  return score
}
