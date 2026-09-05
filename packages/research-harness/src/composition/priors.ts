/**
 * Composition Priors (Phase 3, GOAL §17-18; P0 rewrite).
 *
 * A prior is a TENDENCY with an explicit SPATIAL GRAMMAR family. Two priors
 * sharing a grammar produce the same layout family; `generateCandidates`
 * selects priors so the candidate set spans DIFFERENT grammars (never four
 * recolors of the same topology).
 *
 * `priorFitScore` matches a computed CompositionSignature (real graph
 * statistics) against each prior — the prior's own `semanticFit` vocabulary
 * and the signature agree through semantic keys, not string vibes.
 */
import type { ReadingFlow } from './spatial-plan.js'

export interface CompositionPrior {
  id: string
  /** spatial grammar family — the layout builder this prior executes */
  grammar:
    | 'linear'
    | 'converging'
    | 'diverging'
    | 'input-core-output'
    | 'parallel'
    | 'layered'
    | 'radial'
    | 'network'
    | 'timeline'
    | 'matrix'
    | 'comparison'
    | 'feedback'
    | 'causal'
    | 'mediation'
    | 'moderation'
    | 'tree'
  semanticFit: string[]
  principles: string[]
  defaultBias: Record<string, number>
  allowedRange: Record<string, [number, number]>
  readingFlow: ReadingFlow
}

export const COMPOSITION_PRIORS: CompositionPrior[] = [
  {
    id: 'linear-process',
    grammar: 'linear',
    semanticFit: ['chain', 'stage sequence', 'pipeline'],
    principles: ['main flow LR', 'columns by layer', 'equal prominence unless staged'],
    defaultBias: { first: 0.06, last: 0.94 },
    allowedRange: { first: [0.04, 0.1], last: [0.9, 0.96] },
    readingFlow: 'LR',
  },
  {
    id: 'converging-flow',
    grammar: 'converging',
    semanticFit: ['multi-input', 'fan-in', 'aggregation'],
    principles: ['inputs spread on the left', 'convergence point gets visual weight'],
    defaultBias: { inputs: 0.08, sink: 0.82 },
    allowedRange: { inputs: [0.04, 0.14], sink: [0.7, 0.92] },
    readingFlow: 'LR',
  },
  {
    id: 'diverging-flow',
    grammar: 'diverging',
    semanticFit: ['multi-output', 'fan-out', 'diffusion'],
    principles: ['source anchored left', 'outputs spread on the right'],
    defaultBias: { source: 0.1, outputs: 0.86 },
    allowedRange: { source: [0.05, 0.16], outputs: [0.78, 0.94] },
    readingFlow: 'LR',
  },
  {
    id: 'input-core-output',
    grammar: 'input-core-output',
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
    grammar: 'parallel',
    semanticFit: ['parallel paths', 'competing mechanisms', 'independent tracks'],
    principles: ['tracks run side-by-side', 'shared inputs/outputs anchor the ends'],
    defaultBias: { start: 0.08, end: 0.88 },
    allowedRange: { start: [0.04, 0.12], end: [0.82, 0.94] },
    readingFlow: 'LR',
  },
  {
    id: 'layered-architecture',
    grammar: 'layered',
    semanticFit: ['stack', 'tiered system', 'abstraction layers'],
    principles: ['layers stack TB', 'flow usually LR inside a layer'],
    defaultBias: { top: 0.08, bottom: 0.9 },
    allowedRange: { top: [0.04, 0.12], bottom: [0.86, 0.95] },
    readingFlow: 'TB',
  },
  {
    id: 'core-periphery',
    grammar: 'radial',
    semanticFit: ['hub model', 'central construct with satellites'],
    principles: ['core at visual center', 'satellites ring outward'],
    defaultBias: { core: 0.5 },
    allowedRange: { core: [0.42, 0.58] },
    readingFlow: 'radial',
  },
  {
    id: 'feedback-system',
    grammar: 'feedback',
    semanticFit: ['loop', 'homeostatic model', 'reinforcing/balancing loop'],
    principles: ['main flow LR', 'feedback rides the peripheral lane'],
    defaultBias: { start: 0.08, end: 0.88, feedbackLane: 0.92 },
    allowedRange: { start: [0.04, 0.14], end: [0.8, 0.94], feedbackLane: [0.86, 0.97] },
    readingFlow: 'LR',
  },
  {
    id: 'causal-framework',
    grammar: 'causal',
    semanticFit: ['X→Y model', 'effect decomposition'],
    principles: ['cause left, effect right', 'moderators above the main path'],
    defaultBias: { cause: 0.12, effect: 0.84 },
    allowedRange: { cause: [0.05, 0.2], effect: [0.76, 0.92] },
    readingFlow: 'LR',
  },
  {
    id: 'mediation',
    grammar: 'mediation',
    semanticFit: ['X→M→Y mediation'],
    principles: ['mediator centered between cause and effect'],
    defaultBias: { x: 0.1, m: 0.5, y: 0.9 },
    allowedRange: { x: [0.05, 0.16], m: [0.42, 0.58], y: [0.84, 0.95] },
    readingFlow: 'LR',
  },
  {
    id: 'moderation',
    grammar: 'moderation',
    semanticFit: ['moderated effect'],
    principles: ['moderator above the arrow it qualifies'],
    defaultBias: { x: 0.12, y: 0.84, moderator: 0.48 },
    allowedRange: { x: [0.05, 0.2], y: [0.76, 0.92], moderator: [0.35, 0.62] },
    readingFlow: 'LR',
  },
  {
    id: 'multi-stage-pipeline',
    grammar: 'linear',
    semanticFit: ['experiment flow', 'algorithm pipeline'],
    principles: ['stages LR with clear stage bands'],
    defaultBias: { first: 0.06, last: 0.92 },
    allowedRange: { first: [0.03, 0.1], last: [0.88, 0.96] },
    readingFlow: 'LR',
  },
  {
    id: 'hierarchical-system',
    grammar: 'tree',
    semanticFit: ['taxonomy', 'org chart', 'decomposition'],
    principles: ['root top, leaves bottom'],
    defaultBias: { root: 0.5, leaves: 0.9 },
    allowedRange: { root: [0.42, 0.58], leaves: [0.82, 0.95] },
    readingFlow: 'TB',
  },
  {
    id: 'temporal-timeline',
    grammar: 'timeline',
    semanticFit: ['timeline', 'phase sequence', 'milestones'],
    principles: [
      'time advances along the declared timeOrder, never alphabetically',
      'phases keep their own band',
      'milestones get emphasis',
    ],
    defaultBias: { first: 0.08, last: 0.92, bandCenter: 0.42 },
    allowedRange: { first: [0.04, 0.14], last: [0.86, 0.96], bandCenter: [0.3, 0.55] },
    readingFlow: 'LR',
  },
  {
    id: 'matrix-grid',
    grammar: 'matrix',
    semanticFit: ['matrix', 'row-column grid', 'cross-tabulation'],
    principles: [
      'rows and columns come from declared group axes',
      'cells align to both axes',
      'headers keep their row/column',
    ],
    defaultBias: { top: 0.1, left: 0.12 },
    allowedRange: { top: [0.05, 0.2], left: [0.05, 0.2] },
    readingFlow: 'TB',
  },
  {
    id: 'comparison-mirror',
    grammar: 'comparison',
    semanticFit: ['A vs B', 'contrast', 'same-scale comparison'],
    principles: [
      'two mirrored regions with aligned anchors',
      'shared dimensions occupy the same rows',
      'difference emphasis sits on the seam',
    ],
    defaultBias: { leftCenter: 0.28, rightCenter: 0.72 },
    allowedRange: { leftCenter: [0.2, 0.38], rightCenter: [0.62, 0.8] },
    readingFlow: 'LR',
  },
  {
    id: 'network-graph',
    grammar: 'network',
    semanticFit: ['network', 'hub-spoke', 'association graph'],
    principles: [
      'degree-ordered deterministic ring (no force simulation)',
      'hubs gravitate to the center',
      'bipartite graphs use two stable columns',
    ],
    defaultBias: { center: 0.5 },
    allowedRange: { center: [0.4, 0.6] },
    readingFlow: 'radial',
  },
]

export function priorById(id: string): CompositionPrior | null {
  return COMPOSITION_PRIORS.find((prior) => prior.id === id) ?? null
}

/**
 * CompositionSignature — real graph statistics computed from a plan.
 * This is what prior selection matches against; no free-text vibes.
 */
export interface CompositionSignature {
  nodeCount: number
  edgeCount: number
  relations: Set<string>
  roles: Set<string>
  /** max in/out degree over all nodes (fan-in / fan-out strength) */
  maxFanIn: number
  maxFanOut: number
  /** longest-path layer count (chain depth) */
  layerCount: number
  /** weakly-connected component count excluding feedback edges (parallel tracks) */
  componentCount: number
  /** hierarchy relation present (tree-ish decomposition) */
  hasHierarchy: boolean
  hasFeedback: boolean
  hasMediation: boolean
  hasModeration: boolean
  /** importance max-min spread (0 when unknown) */
  importanceSpread: number
  // ── extended signals (audit COMP-P1-01) ──
  /** non-feedback cycles present (count of back edges found by DFS) */
  hasCycle: boolean
  /** nodes with no non-feedback edges at all */
  isolatedCount: number
  sourceCount: number
  sinkCount: number
  /** nodes with out-degree ≥ 2 (branch points) */
  branchCount: number
  /** nodes with in-degree ≥ 2 (join points) */
  joinCount: number
  /** endpoint pairs carrying more than one relation (multi-edge safe identity) */
  multiEdgePairCount: number
  /** max total degree ÷ mean total degree (hub dominance, ≥1) */
  centralitySkew: number
  /** layerCount ÷ nodeCount: how much of the figure one chain spans */
  chainCoverage: number
  /** explicit temporal order declared (timeline family signal) */
  hasTimeOrder: boolean
  /** explicit matrix row/column axes declared (matrix family signal) */
  hasMatrixAxes: boolean
}

export interface CompositionSignatureInput {
  nodeCount: number
  edgeCount: number
  relations: Set<string>
  roles: Set<string>
  edges?: Array<{ from: string; to: string; role: string }>
  importances?: number[]
  hasTimeOrder?: boolean
  hasMatrixAxes?: boolean
}

export function compositionSignature(input: CompositionSignatureInput): CompositionSignature {
  const nodeCount = Math.max(1, input.nodeCount)
  const edges = input.edges ?? []
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  const totalDeg = new Map<string, number>()
  const ids = new Set<string>()
  const pairCounts = new Map<string, number>()
  for (const edge of edges) {
    ids.add(edge.from)
    ids.add(edge.to)
    outDeg.set(edge.from, (outDeg.get(edge.from) ?? 0) + 1)
    inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1)
    const pair = `${edge.from}\u0000${edge.to}`
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
  }
  for (const id of ids) {
    totalDeg.set(id, (inDeg.get(id) ?? 0) + (outDeg.get(id) ?? 0))
  }
  const maxFanIn = Math.max(0, ...inDeg.values())
  const maxFanOut = Math.max(0, ...outDeg.values())
  // longest-path layering over non-feedback edges
  const layerOf = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const inCount = new Map<string, number>()
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    adj.set(edge.from, [...(adj.get(edge.from) ?? []), edge.to])
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1)
    layerOf.set(edge.from, layerOf.get(edge.from) ?? 0)
    layerOf.set(edge.to, layerOf.get(edge.to) ?? 0)
  }
  const queue = [...layerOf.keys()].filter((id) => (inCount.get(id) ?? 0) === 0)
  let maxLayer = 0
  let processed = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    processed++
    for (const next of adj.get(id) ?? []) {
      layerOf.set(next, Math.max(layerOf.get(next) ?? 0, (layerOf.get(id) ?? 0) + 1))
      maxLayer = Math.max(maxLayer, layerOf.get(next) ?? 0)
      inCount.set(next, (inCount.get(next) ?? 0) - 1)
      if ((inCount.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  // weak components (non-feedback)
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const root = parent.get(id) ?? id
    if (root === id) return id
    const top = find(root)
    parent.set(id, top)
    return top
  }
  for (const id of ids) parent.set(id, id)
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    const a = find(edge.from)
    const b = find(edge.to)
    if (a !== b) parent.set(a, b)
  }
  const componentCount = new Set([...ids].map(find)).size
  const importances = input.importances ?? []
  const importanceSpread =
    importances.length >= 2 ? Math.max(...importances) - Math.min(...importances) : 0
  const degrees = [...totalDeg.values()]
  const meanDegree = degrees.length > 0 ? degrees.reduce((s, v) => s + v, 0) / degrees.length : 0
  const maxDegree = Math.max(0, ...degrees)
  const multiEdgePairCount = [...pairCounts.values()].filter((count) => count > 1).length
  return {
    nodeCount,
    edgeCount: input.edgeCount,
    relations: input.relations,
    roles: input.roles,
    maxFanIn,
    maxFanOut,
    layerCount: maxLayer + 1,
    componentCount: Math.max(1, componentCount),
    hasHierarchy: input.relations.has('hierarchy'),
    hasFeedback: input.relations.has('feedback'),
    hasMediation: input.relations.has('mediation'),
    hasModeration: input.relations.has('moderation'),
    importanceSpread,
    hasCycle: processed < layerOf.size,
    isolatedCount: Math.max(0, nodeCount - ids.size),
    sourceCount: [...ids].filter((id) => (inDeg.get(id) ?? 0) === 0).length,
    sinkCount: [...ids].filter((id) => (outDeg.get(id) ?? 0) === 0).length,
    branchCount: [...outDeg.values()].filter((degree) => degree >= 2).length,
    joinCount: [...inDeg.values()].filter((degree) => degree >= 2).length,
    multiEdgePairCount,
    centralitySkew: meanDegree > 0 ? maxDegree / meanDegree : 1,
    chainCoverage: (maxLayer + 1) / nodeCount,
    hasTimeOrder: input.hasTimeOrder === true,
    hasMatrixAxes: input.hasMatrixAxes === true,
  }
}

/**
 * Deterministic semantic fit of a prior against a CompositionSignature.
 * Falls back to role/relation-set heuristics when no signature is supplied
 * (legacy callers). Pure arithmetic — no model in the loop.
 */
export function priorFitScore(
  prior: CompositionPrior,
  signals: {
    roles: Set<string>
    relations: Set<string>
    signature?: CompositionSignature
  },
): number {
  const signature = signals.signature
  if (!signature) return legacyFit(prior, signals)
  let score = 0
  const rel = signature.relations
  const role = signature.roles
  switch (prior.grammar) {
    case 'radial':
      // one hub with many satellites: strong fan asymmetry on a single node
      if (Math.max(signature.maxFanIn, signature.maxFanOut) >= 3) score += 3
      if (signature.centralitySkew >= 1.8) score += 1
      if (signature.nodeCount >= 5 && signature.maxFanIn >= 2 && signature.maxFanOut >= 2)
        score += 1
      break
    case 'converging':
      if (signature.maxFanIn >= 2) score += 3
      if (role.has('input')) score += 1
      break
    case 'diverging':
      if (signature.maxFanOut >= 2) score += 3
      if (role.has('output')) score += 1
      break
    case 'input-core-output':
      if (role.has('input') && role.has('core') && role.has('output')) score += 3
      if (signature.layerCount >= 3) score += 1
      break
    case 'parallel':
      if (signature.componentCount >= 2) score += 3
      if (signature.branchCount >= 1 && signature.joinCount >= 1) score += 2
      if (rel.has('association') || rel.has('bidirectional')) score += 1
      break
    case 'layered':
      if (signature.nodeCount >= 6 && signature.layerCount >= 2) score += 2
      if (rel.has('hierarchy')) score += 1
      break
    case 'network':
      // hubs + association structure, not a chain: high centrality skew with
      // meaningful degree on both sides reads as a network, not a pipeline
      if (signature.centralitySkew >= 1.6) score += 3
      if (rel.has('association') || rel.has('bidirectional') || rel.has('mapping')) score += 2
      if (signature.componentCount >= 2) score += 1
      break
    case 'timeline':
      // time semantics MUST be declared; layer count alone is not time
      if (signature.hasTimeOrder) score += 4
      if (rel.has('process') || rel.has('causal')) score += 1
      break
    case 'matrix':
      if (signature.hasMatrixAxes) score += 4
      break
    case 'comparison':
      if (role.has('context') || signature.nodeCount >= 4) score += 1
      if (signature.componentCount >= 2) score += 2
      break
    case 'feedback':
      if (signature.hasFeedback) score += 4
      break
    case 'causal':
      if (rel.has('causal') || rel.has('process')) score += 1
      if (signature.hasModeration) score += 2
      break
    case 'mediation':
      if (signature.hasMediation) score += 4
      break
    case 'moderation':
      if (signature.hasModeration) score += 4
      break
    case 'tree':
      if (signature.hasHierarchy) score += 4
      else if (signature.layerCount >= 3 && signature.maxFanOut >= 2) score += 2
      break
    case 'linear':
      if (rel.has('process')) score += 1
      if (signature.layerCount >= Math.max(2, signature.nodeCount - 2)) score += 2
      break
  }
  return score
}

function legacyFit(
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
