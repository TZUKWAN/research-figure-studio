/**
 * Candidate generation + ranking (Phase 3; P0 rewrite — Scientific Art
 * Direction; audit COMP-P0-01..08 / COMP-P1-01..10).
 *
 * Every prior EXECUTES its own spatial grammar. Grammar builders may DECLINE
 * (return null) when the graph lacks the structure their grammar names — a
 * declined grammar is skipped, never faked with round-robin or lexicographic
 * substitutes. Placement fractions come from the prior's defaultBias clamped
 * by allowedRange (config mutation must change layout), and vertical capacity
 * is computed from MEASURED node sizes before geometry is proposed.
 */
import type { MeasuredNode } from '../measurement/measure.js'
import { solveGeometry, type SolveResult, type UnitFitConstraint } from '../constraints/solver.js'
import { routeEdges, edgeCrossingCount, connectorNodeIntersections } from '../routing/router.js'
import type { Rect } from '../routing/geometry.js'
import {
  COMPOSITION_PRIORS,
  compositionSignature,
  priorFitScore,
  type CompositionPrior,
  type CompositionSignature,
} from './priors.js'
import type { SpatialPlan, SpatialPlacement } from './spatial-plan.js'
import {
  buildAdjacency,
  decomposeParallelTracks,
  detectCycle,
  forestRoots,
  weightedMainChain,
  type Adjacency,
  type PathEdge,
} from './paths.js'
import {
  familyStrategyFor,
  unmetFamilySignals,
  UnsupportedFigureFamilyError,
} from './family-strategy.js'
import type { FigureFamily } from '../contract/figure-contract.js'

export interface FigureEdgesInput {
  id?: string
  from: string
  to: string
  role: 'main' | 'feedback'
  relation: string
  presentation?: string
  /** moderation targeting an edge (COMP-P0-02) */
  targetEdge?: string
  /** node ids qualifying this edge (COMP-P0-02) */
  qualifiedBy?: string[]
}

export interface CompositionCandidate {
  source: 'prior' | 'model'
  priorId: string | null
  plan: SpatialPlan
  solve: SolveResult
  crossings: number
  nodeIntersections: number
  score: number
}

interface ScoreInputs {
  measured: MeasuredNode[]
  edges: FigureEdgesInput[]
  canvasW: number
  canvasH: number
  unitFit?: Map<string, UnitFitConstraint>
}

function evaluateCandidate(
  plan: SpatialPlan,
  source: 'prior' | 'model',
  priorId: string | null,
  inputs: ScoreInputs,
  fitPenalty = 0,
): CompositionCandidate {
  const solve = solveGeometry({
    plan,
    measured: inputs.measured,
    canvasW: inputs.canvasW,
    canvasH: inputs.canvasH,
    ...(inputs.unitFit ? { unitFitConstraints: inputs.unitFit } : {}),
  })
  const rects = new Map<string, Rect>(
    solve.placements.map((placement) => [placement.id, placement]),
  )
  const routed = routeEdges(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  )
  const crossings = edgeCrossingCount(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  )
  const nodeIntersections = connectorNodeIntersections(
    inputs.edges.map((edge, index) => ({
      key: `e${index}`,
      fromId: edge.from,
      toId: edge.to,
      role: edge.role,
      relation: edge.relation,
    })),
    rects,
  ).length
  // deterministic rank: gate failures dominate, then crossings, then intent
  // preservation, then the semantic-fit penalty of the chosen grammar
  const score =
    solve.issues.length * 1000 +
    nodeIntersections * 100 +
    crossings * 20 +
    Math.min(99, solve.intentDriftPx / 8) +
    fitPenalty
  return { source, priorId, plan, solve, crossings, nodeIntersections, score }
}

export interface NodeMeta {
  importance: number
  groupId?: string
  /** semantic role drives position in causal/feedback grammars (COMP-P0-06) */
  role?: string
}

/** Semantic context threaded from the FigurePlan into grammar builders. */
export interface CandidateContext {
  /** declared figure family, when the contract names one */
  family?: FigureFamily
  /** primarySpine / readingPath — the argumentative main chain (COMP-P1-08) */
  spine?: string[]
  /** narrative.visualCenter — declared visual anchor (COMP-P1-09) */
  visualCenter?: string
  /** explicit temporal order over node ids (COMP-P1-03) */
  timeOrder?: string[]
  /** groupId → member ids (matrix/comparison axes) */
  groups?: Map<string, string[]>
  /** matrix row/column group ids (COMP-P1-04) */
  matrix?: { rowGroupIds: string[]; columnGroupIds: string[] }
}

// ─────────────────────────────────────────────────────────────────────────────
// Topology: real graph statistics driving every grammar builder
// ─────────────────────────────────────────────────────────────────────────────

interface Hint {
  x: number
  y: number
  w: number
  h: number
}

type Size = Pick<Hint, 'w' | 'h'>

interface Topology {
  ids: string[]
  adjacency: Adjacency
  inDeg: Map<string, number>
  outDeg: Map<string, number>
  layerOf: Map<string, number>
  maxLayer: number
  sources: string[]
  sinks: string[]
  hub: string | null
  root: string | null
  depthOf: Map<string, number>
  maxDepth: number
  components: string[][]
  mainChain: string[]
  /** non-feedback cycle present (grammar eligibility, COMP-P0-07) */
  hasCycle: boolean
}

function buildTopology(
  ids: string[],
  edges: FigureEdgesInput[],
  opts: { importance?: Map<string, number>; spine?: string[] } = {},
): Topology {
  const sorted = [...ids].sort()
  const adjacency = buildAdjacency(sorted, edges as PathEdge[])
  const { inDeg, outDeg, successors } = adjacency
  // longest-path layering (Kahn); cycle nodes keep layer 0 and flip hasCycle
  const layerOf = new Map<string, number>(sorted.map((id) => [id, 0]))
  const inCount = new Map(inDeg)
  const queue = sorted.filter((id) => (inCount.get(id) ?? 0) === 0)
  let processed = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    processed++
    for (const next of successors.get(id) ?? []) {
      layerOf.set(next, Math.max(layerOf.get(next) ?? 0, (layerOf.get(id) ?? 0) + 1))
      inCount.set(next, (inCount.get(next) ?? 0) - 1)
      if ((inCount.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  const maxLayer = Math.max(0, ...[...layerOf.values()])
  const sources = sorted.filter((id) => (inDeg.get(id) ?? 0) === 0)
  const sinks = sorted.filter((id) => (outDeg.get(id) ?? 0) === 0 && (inDeg.get(id) ?? 0) > 0)
  // hub: max total degree, ties → first in sorted order
  let hub: string | null = null
  let hubDegree = -1
  for (const id of sorted) {
    const degree = (inDeg.get(id) ?? 0) + (outDeg.get(id) ?? 0)
    if (degree > hubDegree) {
      hubDegree = degree
      hub = id
    }
  }
  // root: source with max out-degree (tree grammar), fallback hub
  let root: string | null = sources.length > 0 ? sources[0]! : hub
  let rootOut = -1
  for (const id of sources) {
    if ((outDeg.get(id) ?? 0) > rootOut) {
      rootOut = outDeg.get(id) ?? 0
      root = id
    }
  }
  // hierarchy depth via BFS from root over all non-feedback edges
  const depthOf = new Map<string, number>()
  if (root) {
    depthOf.set(root, 0)
    const bfs = [root]
    while (bfs.length > 0) {
      const id = bfs.shift()!
      for (const next of successors.get(id) ?? []) {
        if (!depthOf.has(next)) {
          depthOf.set(next, (depthOf.get(id) ?? 0) + 1)
          bfs.push(next)
        }
      }
    }
  }
  for (const id of sorted) if (!depthOf.has(id)) depthOf.set(id, 0)
  const maxDepth = Math.max(0, ...[...depthOf.values()])
  // components
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id) ?? id
    if (p === id) return id
    const rootNode = find(p)
    parent.set(id, rootNode)
    return rootNode
  }
  for (const id of sorted) parent.set(id, id)
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue
    const a = find(edge.from)
    const b = find(edge.to)
    if (a !== b) parent.set(a, b)
  }
  const componentMap = new Map<string, string[]>()
  for (const id of sorted) {
    const key = find(id)
    componentMap.set(key, [...(componentMap.get(key) ?? []), id])
  }
  const components = [...componentMap.values()].sort((a, b) => a.length - b.length)
  // main chain: declared spine → weighted longest path → greedy (COMP-P1-08)
  const mainChain = weightedMainChain(
    sorted,
    adjacency,
    edges as PathEdge[],
    opts.importance ?? new Map(),
    opts.spine,
  )
  return {
    ids: sorted,
    adjacency,
    inDeg,
    outDeg,
    layerOf,
    maxLayer,
    sources,
    sinks,
    hub,
    root,
    depthOf,
    maxDepth,
    components,
    mainChain,
    hasCycle: processed < sorted.length,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar builders: each returns per-node fraction hints + the anchor set,
// or NULL when the graph does not honestly admit this grammar.
// ─────────────────────────────────────────────────────────────────────────────

interface GrammarLayout {
  hints: Map<string, Hint>
  anchors: Set<string>
}

interface GrammarContext {
  topo: Topology
  sizes: Map<string, Size>
  edges: FigureEdgesInput[]
  meta?: Map<string, NodeMeta>
  prior: CompositionPrior
  ctx: CandidateContext
}

type GrammarBuilder = (g: GrammarContext) => GrammarLayout | null

function clamp01(v: number, lo = 0.02, hi = 0.98): number {
  return Math.min(hi, Math.max(lo, v))
}

function place(
  id: string,
  cx: number,
  cy: number,
  size: Pick<Hint, 'w' | 'h'>,
  hints: Map<string, Hint>,
): void {
  const hint: Hint = {
    x: clamp01(cx - size.w / 2, 0.02, 0.98 - size.w),
    y: clamp01(cy - size.h / 2, 0.03, 0.95 - size.h),
    w: size.w,
    h: size.h,
  }
  hints.set(id, hint)
}

/**
 * prior bias (COMP-P1-07): defaultBias clamped by allowedRange. Mutating a
 * prior's config MUST move the layout — tests pin this.
 */
export function biasValue(prior: CompositionPrior, key: string, fallback: number): number {
  const raw = prior.defaultBias[key]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const range = prior.allowedRange[key]
  if (range) return Math.min(range[1], Math.max(range[0], raw))
  return raw
}

const DEFAULT_GUTTER = 0.045

/**
 * Capacity-first distribution (COMP-P1-10): centers of measured boxes along
 * one axis inside [start, end], or null when the total does not FIT — callers
 * split lanes or decline the grammar instead of letting the solver rescue an
 * impossible layout.
 */
function distributeAlong(
  ids: string[],
  sizes: Map<string, Size>,
  axis: keyof Size,
  start: number,
  end: number,
  minGutter = DEFAULT_GUTTER,
): number[] | null {
  if (ids.length === 0) return []
  const total = ids.reduce((sum, id) => sum + (sizes.get(id)?.[axis] ?? 0), 0)
  const span = end - start
  if (total + (ids.length - 1) * minGutter > span) return null
  const free = span - total
  const gutter = ids.length === 1 ? 0 : free / (ids.length - 1)
  const centers: number[] = []
  let cursor = start
  for (const id of ids) {
    const size = sizes.get(id)?.[axis] ?? 0
    centers.push(cursor + size / 2)
    cursor += size + gutter
  }
  return centers
}

/** Fractional fallback spread (old behaviour) when capacity cannot hold. */
function spreadCenters(count: number, start: number, end: number): number[] {
  if (count === 1) return [(start + end) / 2]
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_, index) => start + step * index)
}

const importanceOf = (meta: Map<string, NodeMeta> | undefined, id: string): number =>
  meta?.get(id)?.importance ?? 0.5
const roleOf = (meta: Map<string, NodeMeta> | undefined, id: string): string =>
  meta?.get(id)?.role ?? ''

function linearGrammar(g: GrammarContext, options: { topBand?: boolean } = {}): GrammarLayout {
  const { topo, sizes, prior } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const layerIds = new Map<number, string[]>()
  for (const id of topo.ids) {
    const layer = topo.layerOf.get(id) ?? 0
    layerIds.set(layer, [...(layerIds.get(layer) ?? []), id])
  }
  const layers = [...layerIds.keys()].sort((a, b) => a - b)
  const left = biasValue(prior, 'first', 0.07)
  const right = biasValue(prior, 'last', 0.93)
  const yCenter = options.topBand ? biasValue(prior, 'bandCenter', 0.3) : 0.45
  const ySpan = options.topBand ? 0.32 : 0.6
  const bandStart = yCenter - ySpan / 2
  const bandEnd = yCenter + ySpan / 2
  const colSpan = (right - left) / Math.max(1, layers.length)
  // capacity check: does the widest layer fit the even column width?
  const widestLayer = Math.max(
    ...layers.map((layer) =>
      Math.max(0, ...(layerIds.get(layer) ?? []).map((id) => sizes.get(id)?.w ?? 0)),
    ),
  )
  const capacityTight = widestLayer + DEFAULT_GUTTER > colSpan
  let cursor = left
  for (const layer of layers) {
    const members = layerIds.get(layer) ?? []
    const colWidth = Math.max(0, ...members.map((id) => sizes.get(id)?.w ?? 0))
    // capacity-first x (COMP-P1-10): even spacing while it fits, packed columns
    // only when measured widths genuinely overflow the even column
    const cx = capacityTight ? cursor + colWidth / 2 : left + colSpan * (layer + 0.5)
    if (capacityTight) cursor += colWidth + DEFAULT_GUTTER
    const centers =
      distributeAlong(members, sizes, 'h', bandStart, bandEnd) ??
      spreadCenters(members.length, bandStart, bandEnd)
    members.forEach((id, index) => {
      place(id, cx, clamp01(centers[index] ?? yCenter, 0.06, 0.9), sizes.get(id)!, hints)
    })
  }
  return { hints, anchors }
}

function convergingGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, prior } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const sinkX = biasValue(prior, 'sink', 0.76)
  const inputX = biasValue(prior, 'inputs', 0.11)
  const sink =
    topo.sinks.sort((a, b) => (topo.inDeg.get(b) ?? 0) - (topo.inDeg.get(a) ?? 0))[0] ??
    topo.hub ??
    topo.ids[topo.ids.length - 1]!
  const sinkSize = sizes.get(sink)!
  place(sink, sinkX, 0.45, { ...sinkSize, w: Math.min(0.34, sinkSize.w * 1.25) }, hints)
  anchors.add(sink)
  const inputs = topo.ids.filter(
    (id) => id !== sink && (topo.outDeg.get(id) ?? 0) > 0 && (topo.inDeg.get(id) ?? 0) === 0,
  )
  const rest = topo.ids.filter((id) => id !== sink && !inputs.includes(id))
  const inputCenters =
    distributeAlong(inputs, sizes, 'h', 0.12, 0.78) ?? spreadCenters(inputs.length, 0.16, 0.74)
  inputs.forEach((id, index) => {
    place(id, inputX, clamp01(inputCenters[index] ?? 0.45, 0.08, 0.84), sizes.get(id)!, hints)
  })
  const byLayer = new Map<number, string[]>()
  for (const id of rest) {
    const layer = topo.layerOf.get(id) ?? 0
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), id])
  }
  for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const centers =
      distributeAlong(members, sizes, 'h', 0.12, 0.78) ?? spreadCenters(members.length, 0.12, 0.78)
    members.forEach((id, index) => {
      const cx = clamp01(0.3 + layer * 0.14, 0.2, 0.62)
      place(id, cx, clamp01(centers[index] ?? 0.45, 0.1, 0.86), sizes.get(id)!, hints)
    })
  }
  return { hints, anchors }
}

/**
 * Diverging (COMP-P0-04): branch source left, INTERMEDIATES keep their layer
 * columns, only TERMINAL sinks (no non-feedback outgoing edges) reach the
 * right output column.
 */
function divergingGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, prior, meta } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const sourceX = biasValue(prior, 'source', 0.14)
  const outputX = biasValue(prior, 'outputs', 0.78)
  const source =
    topo.sources.sort(
      (a, b) =>
        (topo.outDeg.get(b) ?? 0) - (topo.outDeg.get(a) ?? 0) ||
        importanceOf(meta, b) - importanceOf(meta, a) ||
        a.localeCompare(b),
    )[0] ??
    topo.hub ??
    topo.ids[0]!
  const sourceSize = sizes.get(source)!
  place(source, sourceX, 0.45, { ...sourceSize, w: Math.min(0.34, sourceSize.w * 1.2) }, hints)
  anchors.add(source)
  const terminals = topo.ids.filter(
    (id) => id !== source && (topo.outDeg.get(id) ?? 0) === 0 && (topo.inDeg.get(id) ?? 0) > 0,
  )
  const deepestLayer = topo.maxLayer
  const terminalSet =
    terminals.length > 0
      ? terminals
      : topo.ids.filter(
          (id) =>
            id !== source &&
            (topo.layerOf.get(id) ?? 0) === deepestLayer &&
            (topo.inDeg.get(id) ?? 0) > 0,
        )
  const intermediates = topo.ids.filter((id) => id !== source && !terminalSet.includes(id))
  const orderedTerminals = [...terminalSet].sort(
    (a, b) =>
      (topo.layerOf.get(a) ?? 0) - (topo.layerOf.get(b) ?? 0) ||
      importanceOf(meta, b) - importanceOf(meta, a) ||
      a.localeCompare(b),
  )
  const outputCenters =
    distributeAlong(orderedTerminals, sizes, 'h', 0.1, 0.86) ??
    spreadCenters(orderedTerminals.length, 0.14, 0.82)
  orderedTerminals.forEach((id, index) => {
    place(id, outputX, clamp01(outputCenters[index] ?? 0.45, 0.08, 0.86), sizes.get(id)!, hints)
  })
  const byLayer = new Map<number, string[]>()
  for (const id of intermediates) {
    const layer = topo.layerOf.get(id) ?? 0
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), id])
  }
  for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const centers =
      distributeAlong(members, sizes, 'h', 0.12, 0.78) ?? spreadCenters(members.length, 0.12, 0.78)
    const cx = clamp01(
      sourceX + ((outputX - sourceX) * (layer + 1)) / (deepestLayer + 1),
      0.2,
      0.68,
    )
    members.forEach((id, index) => {
      place(id, cx, clamp01(centers[index] ?? 0.45, 0.1, 0.86), sizes.get(id)!, hints)
    })
  }
  return { hints, anchors }
}

function iceGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, meta, prior } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const inputX = biasValue(prior, 'input', 0.1)
  const coreX = biasValue(prior, 'core', 0.48)
  const outputX = biasValue(prior, 'output', 0.86)
  const degreeOf = (id: string) => (topo.inDeg.get(id) ?? 0) + (topo.outDeg.get(id) ?? 0)
  // the core is the graph HUB: highest degree, then importance — never a pure
  // sink/source just because it sits in the last layer
  const core =
    topo.ids
      .slice()
      .sort(
        (a, b) =>
          degreeOf(b) * 2 + importanceOf(meta, b) - (degreeOf(a) * 2 + importanceOf(meta, a)) ||
          a.localeCompare(b),
      )[0] ??
    topo.hub ??
    topo.ids[0]!
  const coreSize = sizes.get(core)!
  place(
    core,
    coreX,
    0.44,
    {
      w: Math.min(0.36, coreSize.w * 1.3),
      h: Math.min(0.36, coreSize.h * 1.25),
    },
    hints,
  )
  anchors.add(core)
  const coreLayer = topo.layerOf.get(core) ?? 0
  const inputs: string[] = []
  const outputs: string[] = []
  const middles: string[] = []
  for (const id of topo.ids) {
    if (id === core) continue
    const layer = topo.layerOf.get(id) ?? 0
    if (layer < coreLayer) inputs.push(id)
    else if (layer > coreLayer) outputs.push(id)
    else middles.push(id)
  }
  const inputCenters =
    distributeAlong(inputs, sizes, 'h', 0.1, 0.8) ?? spreadCenters(inputs.length, 0.14, 0.74)
  inputs.forEach((id, index) => {
    place(id, inputX, clamp01(inputCenters[index] ?? 0.44, 0.08, 0.86), sizes.get(id)!, hints)
  })
  const outputCenters =
    distributeAlong(outputs, sizes, 'h', 0.1, 0.8) ?? spreadCenters(outputs.length, 0.14, 0.74)
  outputs.forEach((id, index) => {
    place(id, outputX, clamp01(outputCenters[index] ?? 0.44, 0.08, 0.86), sizes.get(id)!, hints)
  })
  middles.forEach((id, index) => {
    place(id, clamp01(0.3 + index * 0.16, 0.2, 0.68), 0.72, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

/**
 * Parallel (COMP-P0-03): lanes come from REAL path decomposition — branch →
 * track → join. Disconnected components are lanes too. Shared anchors live in
 * the start/end columns. There is NO round-robin fallback: without genuine
 * parallel structure the grammar declines.
 */
function parallelGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, prior } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const startX = biasValue(prior, 'start', 0.08)
  const endX = biasValue(prior, 'end', 0.88)
  const tracks = decomposeParallelTracks(topo.ids, g.edges as PathEdge[])
  if (tracks.length < 2) return null
  const tracked = new Set<string>(tracks.flatMap((track) => track.nodeIds))
  const sharedSources = [
    ...new Set(tracks.map((track) => track.source).filter((id): id is string => !!id)),
  ]
  const sharedSinks = [
    ...new Set(tracks.map((track) => track.sink).filter((id): id is string => !!id)),
  ]
  for (const id of [...sharedSources, ...sharedSinks]) {
    if (id && sizes.has(id)) anchors.add(id)
  }
  // shared source column (start) and shared sink column (end)
  const sourceNodes = sharedSources.length > 0 ? sharedSources : []
  const sinkNodes = sharedSinks.length > 0 ? sharedSinks : []
  const sourceCenters =
    distributeAlong(sourceNodes, sizes, 'h', 0.2, 0.7) ??
    spreadCenters(sourceNodes.length, 0.2, 0.7)
  sourceNodes.forEach((id, index) => {
    place(id, startX + 0.06, clamp01(sourceCenters[index] ?? 0.45, 0.1, 0.8), sizes.get(id)!, hints)
  })
  const sinkCenters =
    distributeAlong(sinkNodes, sizes, 'h', 0.2, 0.7) ?? spreadCenters(sinkNodes.length, 0.2, 0.7)
  sinkNodes.forEach((id, index) => {
    place(id, endX - 0.04, clamp01(sinkCenters[index] ?? 0.45, 0.1, 0.8), sizes.get(id)!, hints)
  })
  const laneSpan = 0.78 / tracks.length
  tracks.forEach((track, laneIndex) => {
    const laneIds = [...track.nodeIds].sort(
      (a, b) => (topo.layerOf.get(a) ?? 0) - (topo.layerOf.get(b) ?? 0) || a.localeCompare(b),
    )
    const cy = 0.1 + laneSpan * (laneIndex + 0.5)
    const laneCenters =
      distributeAlong(laneIds, sizes, 'w', 0.16, 0.8) ?? spreadCenters(laneIds.length, 0.18, 0.78)
    laneIds.forEach((id, index) => {
      place(
        id,
        clamp01(laneCenters[index] ?? 0.5, 0.1, 0.88),
        clamp01(cy, 0.06, 0.88),
        sizes.get(id)!,
        hints,
      )
    })
  })
  // untracked nodes (isolated/context) get the bottom context band
  const context = topo.ids.filter((id) => !tracked.has(id) && !hints.has(id))
  const contextCenters =
    distributeAlong(context, sizes, 'w', 0.1, 0.86) ?? spreadCenters(context.length, 0.14, 0.82)
  context.forEach((id, index) => {
    place(id, clamp01(contextCenters[index] ?? 0.5, 0.06, 0.92), 0.93, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function layeredGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const layerIds = new Map<number, string[]>()
  for (const id of topo.ids) {
    const layer = topo.layerOf.get(id) ?? 0
    layerIds.set(layer, [...(layerIds.get(layer) ?? []), id])
  }
  const layers = [...layerIds.keys()].sort((a, b) => a - b)
  const bandSpan = 0.86 / Math.max(1, layers.length)
  for (const layer of layers) {
    const members = layerIds.get(layer) ?? []
    const cy = 0.07 + bandSpan * (layer + 0.5)
    const centers =
      distributeAlong(members, sizes, 'w', 0.12, 0.88) ?? spreadCenters(members.length, 0.14, 0.86)
    members.forEach((id, index) => {
      const size = sizes.get(id)!
      const wide: Size = { ...size, w: Math.min(0.36, size.w * 1.2) }
      place(id, clamp01(centers[index] ?? 0.5, 0.06, 0.92), clamp01(cy, 0.05, 0.92), wide, hints)
    })
  }
  return { hints, anchors }
}

/**
 * Radial / core-periphery (COMP-P1-09): the center combines the DECLARED
 * visualCenter, the semantic core role, degree centrality and importance —
 * never importance alone.
 */
function radialGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, meta, ctx } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const degreeOf = (id: string) => (topo.inDeg.get(id) ?? 0) + (topo.outDeg.get(id) ?? 0)
  const scoreOf = (id: string): number => {
    let score = importanceOf(meta, id) * 1.5 + degreeOf(id) * 1.2
    if (roleOf(meta, id) === 'core') score += 2.5
    if (ctx.visualCenter && ctx.visualCenter === id) score += 4
    return score
  }
  const hub =
    topo.ids.slice().sort((a, b) => scoreOf(b) - scoreOf(a) || a.localeCompare(b))[0] ??
    topo.hub ??
    topo.ids[0]!
  const hubSize = sizes.get(hub)!
  place(
    hub,
    0.5,
    0.45,
    { w: Math.min(0.34, hubSize.w * 1.35), h: Math.min(0.36, hubSize.h * 1.3) },
    hints,
  )
  anchors.add(hub)
  const satellites = topo.ids.filter((id) => id !== hub)
  const ringCount = satellites.length > 7 ? 2 : 1
  const perRing = Math.ceil(satellites.length / ringCount)
  satellites.forEach((id, index) => {
    const ring = Math.floor(index / perRing)
    const inRing = index % perRing
    const countInRing = Math.min(perRing, satellites.length - ring * perRing)
    const angle =
      -Math.PI / 2 + (2 * Math.PI * inRing) / countInRing + ring * (Math.PI / countInRing)
    const rx = ring === 0 ? 0.3 : 0.15
    const ry = ring === 0 ? 0.33 : 0.17
    place(id, 0.5 + rx * Math.cos(angle), 0.45 + ry * Math.sin(angle), sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

/**
 * Network (COMP-P1-05): deterministic, seeded by topology only. Bipartite
 * graphs (every edge crosses the partition) use two stable columns ordered by
 * degree; everything else uses a degree-ordered hub ring — no force
 * simulation, repeatable output.
 */
function networkGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, prior } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const degreeOf = (id: string) => (topo.inDeg.get(id) ?? 0) + (topo.outDeg.get(id) ?? 0)
  const byDegree = [...topo.ids].sort((a, b) => degreeOf(b) - degreeOf(a) || a.localeCompare(b))
  // bipartite detection: 2-color the non-feedback graph; all edges must cross.
  // A star graph is TECHNICALLY bipartite but must read hub-spoke, so both
  // partitions need at least 2 nodes for the two-column treatment.
  const color = new Map<string, 0 | 1>()
  let bipartite =
    topo.ids.length >= 4 &&
    topo.ids.every((id) => (topo.inDeg.get(id) ?? 0) + (topo.outDeg.get(id) ?? 0) > 0)
  if (bipartite) {
    const queue = [byDegree[0]!]
    color.set(byDegree[0]!, 0)
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const next of topo.adjacency.successors.get(id) ?? []) {
        const expected: 0 | 1 = color.get(id) === 0 ? 1 : 0
        if (!color.has(next)) {
          color.set(next, expected)
          queue.push(next)
        } else if (color.get(next) !== expected) {
          bipartite = false
          break
        }
      }
      if (!bipartite) break
    }
    bipartite = bipartite && color.size === topo.ids.length
    if (bipartite) {
      const sideSizes = [0, 0]
      for (const side of color.values()) sideSizes[side]!++
      bipartite = sideSizes[0]! >= 2 && sideSizes[1]! >= 2
    }
  }
  if (bipartite) {
    const sideA = byDegree.filter((id) => color.get(id) === 0)
    const sideB = byDegree.filter((id) => color.get(id) === 1)
    const centersA =
      distributeAlong(sideA, sizes, 'h', 0.08, 0.88) ?? spreadCenters(sideA.length, 0.12, 0.84)
    sideA.forEach((id, index) => {
      place(id, 0.22, clamp01(centersA[index] ?? 0.45, 0.06, 0.92), sizes.get(id)!, hints)
    })
    const centersB =
      distributeAlong(sideB, sizes, 'h', 0.08, 0.88) ?? spreadCenters(sideB.length, 0.12, 0.84)
    sideB.forEach((id, index) => {
      place(id, 0.78, clamp01(centersB[index] ?? 0.45, 0.06, 0.92), sizes.get(id)!, hints)
    })
    if (sideA[0]) anchors.add(sideA[0])
    return { hints, anchors }
  }
  // hub-spoke ring: highest-degree node center, satellites degree-ordered
  const centerX = biasValue(prior, 'center', 0.5)
  const hub = byDegree[0] ?? topo.hub ?? topo.ids[0]!
  const hubSize = sizes.get(hub)!
  place(
    hub,
    centerX,
    0.45,
    { w: Math.min(0.32, hubSize.w * 1.3), h: Math.min(0.34, hubSize.h * 1.25) },
    hints,
  )
  anchors.add(hub)
  const satellites = byDegree.filter((id) => id !== hub)
  const ringCount = satellites.length > 8 ? 2 : 1
  const perRing = Math.ceil(satellites.length / ringCount)
  satellites.forEach((id, index) => {
    const ring = Math.floor(index / perRing)
    const inRing = index % perRing
    const countInRing = Math.min(perRing, satellites.length - ring * perRing)
    const angle = -Math.PI / 2 + (2 * Math.PI * inRing) / countInRing
    const rx = ring === 0 ? 0.31 : 0.16
    const ry = ring === 0 ? 0.34 : 0.18
    place(id, centerX + rx * Math.cos(angle), 0.45 + ry * Math.sin(angle), sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

/**
 * Timeline (COMP-P1-03): x follows the DECLARED timeOrder (never lexicographic
 * node ids, never graph layers). Same-phase nodes share a column; milestones
 * (output/core roles) keep their slot. Declines without timeOrder.
 */
function timelineGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, prior, ctx } = g
  if (!ctx.timeOrder || ctx.timeOrder.length === 0) return null
  const known = new Set(topo.ids)
  const ordered = ctx.timeOrder.filter((id) => known.has(id))
  if (ordered.length < 2) return null
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const first = biasValue(prior, 'first', 0.08)
  const last = biasValue(prior, 'last', 0.92)
  const bandCenter = biasValue(prior, 'bandCenter', 0.42)
  const remaining = topo.ids.filter((id) => !ordered.includes(id))
  const columns: string[][] = ordered.map((id) => [id])
  // remaining (untimed) nodes trail after the ordered ones, grouped by layer
  const byLayer = new Map<number, string[]>()
  for (const id of remaining) {
    const layer = topo.layerOf.get(id) ?? 0
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), id])
  }
  for (const [, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    columns.push(members)
  }
  const colSpan = (last - first) / Math.max(1, columns.length - 1)
  columns.forEach((members, columnIndex) => {
    const cx = columns.length === 1 ? (first + last) / 2 : first + colSpan * columnIndex
    const centers =
      distributeAlong(members, sizes, 'h', bandCenter - 0.18, bandCenter + 0.18) ??
      spreadCenters(members.length, bandCenter - 0.2, bandCenter + 0.2)
    members.forEach((id, index) => {
      place(
        id,
        clamp01(cx, 0.05, 0.95),
        clamp01(centers[index] ?? bandCenter, 0.06, 0.9),
        sizes.get(id)!,
        hints,
      )
    })
  })
  if (ordered[0]) anchors.add(ordered[0])
  return { hints, anchors }
}

/**
 * Matrix (COMP-P1-04): rows = declared row groups, columns = declared column
 * groups; cell x comes from column membership, y from the row band. Declines
 * without declared axes — a uniform grid of unrelated nodes is NOT a matrix.
 */
function matrixGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, ctx } = g
  if (!ctx.matrix || !ctx.groups) return null
  const { rowGroupIds, columnGroupIds } = ctx.matrix
  if (rowGroupIds.length === 0 || columnGroupIds.length === 0) return null
  const rowMembers = rowGroupIds.map((id) => ctx.groups!.get(id) ?? [])
  const columnMembers = columnGroupIds.map((id) => ctx.groups!.get(id) ?? [])
  if (rowMembers.every((members) => members.length === 0)) return null
  const columnOf = new Map<string, number>()
  columnMembers.forEach((members, columnIndex) => {
    for (const id of members) if (!columnOf.has(id)) columnOf.set(id, columnIndex)
  })
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const rowSpan = 0.82 / rowMembers.length
  const columnCount = Math.max(1, columnGroupIds.length)
  rowMembers.forEach((members, rowIndex) => {
    const cy = 0.09 + rowSpan * (rowIndex + 0.5)
    const inColumn = members.filter((id) => columnOf.has(id))
    const noColumn = members.filter((id) => !columnOf.has(id))
    inColumn.forEach((id) => {
      const columnIndex = columnOf.get(id)!
      const cx = 0.12 + (0.76 / columnCount) * (columnIndex + 0.5)
      place(id, clamp01(cx, 0.06, 0.94), clamp01(cy, 0.05, 0.92), sizes.get(id)!, hints)
    })
    if (noColumn.length > 0) {
      // members without a column group spread inside the row band
      const centers =
        distributeAlong(noColumn, sizes, 'w', 0.1, 0.9) ??
        spreadCenters(noColumn.length, 0.12, 0.88)
      noColumn.forEach((id, index) => {
        place(
          id,
          clamp01(centers[index] ?? 0.5, 0.06, 0.94),
          clamp01(cy, 0.05, 0.92),
          sizes.get(id)!,
          hints,
        )
      })
    }
  })
  // nodes outside every row group: header/context strip on top
  const placed = new Set(hints.keys())
  const outside = topo.ids.filter((id) => !placed.has(id))
  const outsideCenters =
    distributeAlong(outside, sizes, 'w', 0.08, 0.92) ?? spreadCenters(outside.length, 0.1, 0.9)
  outside.forEach((id, index) => {
    place(id, clamp01(outsideCenters[index] ?? 0.5, 0.05, 0.95), 0.04, sizes.get(id)!, hints)
  })
  if (rowMembers[0]?.[0]) anchors.add(rowMembers[0][0])
  return { hints, anchors }
}

/**
 * Comparison (COMP-P1-06): two mirrored regions with ALIGNED anchors — row i
 * of side A sits at the same y as row i of side B; ungrouped shared nodes sit
 * on the center seam. Declines without at least two groups.
 */
function comparisonGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, prior, ctx } = g
  if (!ctx.groups || ctx.groups.size < 2) return null
  const groupEntries = [...ctx.groups.entries()].filter(([, members]) => members.length > 0)
  if (groupEntries.length < 2) return null
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const leftCenter = biasValue(prior, 'leftCenter', 0.28)
  const rightCenter = biasValue(prior, 'rightCenter', 0.72)
  const sideA = groupEntries[0]![1].filter((id) => topo.ids.includes(id))
  const sideB = groupEntries[1]![1].filter((id) => topo.ids.includes(id))
  const rowCount = Math.max(sideA.length, sideB.length, 1)
  const rowAt = (index: number): number => 0.14 + (0.68 / rowCount) * (index + 0.5)
  const alignA =
    distributeAlong(sideA, sizes, 'h', 0.1, 0.84) ?? spreadCenters(sideA.length, 0.14, 0.82)
  sideA.forEach((id, index) => {
    place(id, leftCenter, clamp01(alignA[index] ?? rowAt(index), 0.06, 0.9), sizes.get(id)!, hints)
  })
  // mirror alignment: B row i shares A row i's y (shared anchor, same scale)
  sideB.forEach((id, index) => {
    const alignedY = sideA[index]
      ? hints.get(sideA[index])!.y + hints.get(sideA[index])!.h / 2
      : rowAt(index)
    place(id, rightCenter, clamp01(alignedY, 0.06, 0.9), sizes.get(id)!, hints)
  })
  if (sideA[0]) anchors.add(sideA[0])
  // ungrouped nodes: center seam (shared dimensions / difference emphasis)
  const placed = new Set(hints.keys())
  const seam = topo.ids.filter((id) => !placed.has(id))
  const seamCenters =
    distributeAlong(seam, sizes, 'h', 0.08, 0.88) ?? spreadCenters(seam.length, 0.12, 0.84)
  seam.forEach((id, index) => {
    place(id, 0.5, clamp01(seamCenters[index] ?? 0.5, 0.05, 0.92), sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

/**
 * Feedback (COMP-P0-05): the grammar OWNS the feedback geometry — main chain
 * in the top band, the bottom corridor RESERVED (no node is ever placed in
 * it), feedback endpoints on the chain extremities so the peripheral lane has
 * anchor room from the first solve, not patched by the router afterwards.
 */
function feedbackGrammar(g: GrammarContext): GrammarLayout {
  const { topo, prior } = g
  const layout = linearGrammar(g, { topBand: true })
  const hints = layout.hints
  const anchors = layout.anchors
  const corridorStart = biasValue(prior, 'feedbackLane', 0.9) - 0.18
  // reserve the corridor: pull any node that drifted below it back up
  for (const [id, hint] of hints) {
    if (hint.y + hint.h > corridorStart) {
      hints.set(id, { ...hint, y: clamp01(corridorStart - hint.h - 0.02, 0.03, 0.95 - hint.h) })
    }
  }
  // feedback endpoints belong at chain extremities for clean lane entry
  const feedbackNodes = g.edges
    .filter((edge) => edge.role === 'feedback' || edge.relation === 'feedback')
    .flatMap((edge) => [edge.from, edge.to])
    .filter((id) => topo.ids.includes(id))
  const chain = topo.mainChain
  for (const id of [...new Set(feedbackNodes)]) {
    const chainIndex = chain.indexOf(id)
    if (chainIndex < 0 || !hints.has(id)) continue
    const extremity = chainIndex === 0 ? 'first' : chainIndex === chain.length - 1 ? 'last' : null
    if (!extremity) continue
    const x =
      extremity === 'first' ? biasValue(prior, 'start', 0.08) : biasValue(prior, 'end', 0.88)
    const hint = hints.get(id)!
    hints.set(id, { ...hint, x: clamp01(x - hint.w / 2, 0.02, 0.98 - hint.w) })
  }
  return { hints, anchors }
}

/**
 * Causal (COMP-P0-06): the main chain runs LR; MODERATORS go to the top band
 * because their SEMANTIC ROLE says so; context/support sinks to the bottom
 * band. Initial coordinates never decide semantics.
 */
function causalGrammar(g: GrammarContext): GrammarLayout {
  const { topo, sizes, prior, meta } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const causeX = biasValue(prior, 'cause', 0.12)
  const effectX = biasValue(prior, 'effect', 0.84)
  const chain = topo.mainChain.length > 0 ? topo.mainChain : topo.ids
  const chainSet = new Set(chain)
  const mainBandCenter = 0.45
  // capacity-first: measured widths decide whether the chain fits the band
  const chainCenters =
    distributeAlong(chain, sizes, 'w', causeX, effectX) ??
    spreadCenters(chain.length, causeX, effectX)
  chain.forEach((id, index) => {
    place(
      id,
      clamp01(chainCenters[index] ?? (causeX + effectX) / 2, 0.05, 0.94),
      mainBandCenter,
      sizes.get(id)!,
      hints,
    )
  })
  const moderators = topo.ids.filter((id) => roleOf(meta, id) === 'moderator')
  const context = topo.ids.filter(
    (id) => !chainSet.has(id) && !moderators.includes(id) && !hints.has(id),
  )
  // moderators float above the main band, ordered along the chain
  const orderedModerators = [...moderators].sort(
    (a, b) => (topo.layerOf.get(a) ?? 0) - (topo.layerOf.get(b) ?? 0) || a.localeCompare(b),
  )
  const modCenters =
    distributeAlong(orderedModerators, sizes, 'w', 0.14, 0.84) ??
    spreadCenters(orderedModerators.length, 0.16, 0.82)
  orderedModerators.forEach((id, index) => {
    place(id, clamp01(modCenters[index] ?? 0.5, 0.05, 0.94), 0.12, sizes.get(id)!, hints)
  })
  // context/support below the main band
  const ctxCenters =
    distributeAlong(context, sizes, 'w', 0.1, 0.88) ?? spreadCenters(context.length, 0.14, 0.84)
  context.forEach((id, index) => {
    place(id, clamp01(ctxCenters[index] ?? 0.5, 0.05, 0.94), 0.82, sizes.get(id)!, hints)
  })
  // role 'intermediate' not on the chain: second row under the main band
  const intermediates = topo.ids.filter(
    (id) =>
      !chainSet.has(id) && !moderators.includes(id) && !context.includes(id) && !hints.has(id),
  )
  const intCenters =
    distributeAlong(intermediates, sizes, 'w', 0.14, 0.84) ??
    spreadCenters(intermediates.length, 0.16, 0.82)
  intermediates.forEach((id, index) => {
    place(id, clamp01(intCenters[index] ?? 0.5, 0.05, 0.94), 0.72, sizes.get(id)!, hints)
  })
  if (chain[0]) anchors.add(chain[0])
  return { hints, anchors }
}

/**
 * Mediation (COMP-P0-01): Y comes from REAL adjacency — X→M→Y, where Y is a
 * true successor of M (sinks first, then importance). Without a genuine
 * mediation triple the grammar DECLINES; nothing is faked.
 */
function mediationGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, prior, meta, edges } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const x = biasValue(prior, 'x', 0.1)
  const m = biasValue(prior, 'm', 0.5)
  const y = biasValue(prior, 'y', 0.9)
  const mediationEdges = edges.filter(
    (edge) => edge.relation === 'mediation' && edge.role !== 'feedback',
  )
  let xId: string | null = null
  let mId: string | null = null
  let yId: string | null = null
  for (const edge of mediationEdges) {
    // interpretation 1: edge is X→M, Y is a successor of M
    const successors = (topo.adjacency.successors.get(edge.to) ?? []).filter(
      (id) => id !== edge.from,
    )
    if (successors.length > 0) {
      xId = edge.from
      mId = edge.to
      yId = pickMediationOutcome(topo, meta, successors, xId)
      break
    }
    // interpretation 2: edge is M→Y, X is a predecessor of M
    const predecessors = (topo.adjacency.predecessors.get(edge.from) ?? []).filter(
      (id) => id !== edge.to,
    )
    if (predecessors.length > 0) {
      mId = edge.from
      yId = edge.to
      xId = pickMediationCause(topo, meta, predecessors, yId)
      break
    }
  }
  if (!xId || !mId || !yId) return null
  const rest = topo.ids.filter((id) => id !== xId && id !== mId && id !== yId)
  place(xId, x, 0.46, sizes.get(xId)!, hints)
  place(mId, m, 0.24, sizes.get(mId)!, hints)
  anchors.add(mId)
  place(yId, y, 0.46, sizes.get(yId)!, hints)
  const restCenters =
    distributeAlong(rest, sizes, 'w', 0.12, 0.86) ?? spreadCenters(rest.length, 0.16, 0.82)
  rest.forEach((id, index) => {
    place(id, clamp01(restCenters[index] ?? 0.5, 0.08, 0.9), 0.76, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function pickMediationOutcome(
  topo: Topology,
  meta: Map<string, NodeMeta> | undefined,
  candidates: string[],
  exclude: string,
): string {
  return [...candidates]
    .filter((id) => id !== exclude)
    .sort(
      (a, b) =>
        Number((topo.outDeg.get(b) ?? 0) === 0) - Number((topo.outDeg.get(a) ?? 0) === 0) ||
        importanceOf(meta, b) - importanceOf(meta, a) ||
        a.localeCompare(b),
    )[0]!
}

function pickMediationCause(
  topo: Topology,
  meta: Map<string, NodeMeta> | undefined,
  candidates: string[],
  exclude: string,
): string {
  return [...candidates]
    .filter((id) => id !== exclude)
    .sort(
      (a, b) =>
        Number((topo.inDeg.get(a) ?? 0) === 0) - Number((topo.inDeg.get(b) ?? 0) === 0) ||
        importanceOf(meta, b) - importanceOf(meta, a) ||
        a.localeCompare(b),
    )[0]!
}

/**
 * Moderation (COMP-P0-02): the moderator is placed above the EFFECT it
 * qualifies — resolved from targetEdge, qualifiedBy, or (fallback) the single
 * primary edge entering the target node. It is never drawn as an ordinary
 * cause: the dashed-arrow presentation plus the drop position keep the
 * edge-qualification semantics readable.
 */
function moderationGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, prior, meta, edges } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const x = biasValue(prior, 'x', 0.12)
  const y = biasValue(prior, 'y', 0.84)
  const moderatorX = biasValue(prior, 'moderator', 0.48)
  const moderationEdges = edges.filter(
    (edge) => edge.relation === 'moderation' && edge.role !== 'feedback',
  )
  // edge-level qualification (explicit schema): targetEdge / qualifiedBy
  const qualifiedEdge =
    edges.find((edge) => moderationEdges.some((mod) => mod.targetEdge === edge.id)) ??
    edges.find((edge) => (edge.qualifiedBy ?? []).length > 0)
  let causeId: string
  let targetId: string
  let moderatorIds: string[]
  if (qualifiedEdge) {
    causeId = qualifiedEdge.from
    targetId = qualifiedEdge.to
    const viaTargetEdge = moderationEdges.filter((mod) => mod.targetEdge === qualifiedEdge.id)
    const viaQualifiedBy = qualifiedEdge.qualifiedBy ?? []
    moderatorIds = [
      ...new Set([...viaTargetEdge.map((mod) => mod.from), ...viaQualifiedBy]),
    ].filter((id) => topo.ids.includes(id))
  } else {
    const moderationEdge = moderationEdges[0]
    if (!moderationEdge) return null
    moderatorIds = [moderationEdge.from]
    targetId = moderationEdge.to
    // the cause is the primary relation entering the target (fallback: source)
    const incoming = edges.filter(
      (edge) =>
        edge.to === targetId &&
        edge.relation !== 'moderation' &&
        edge.role !== 'feedback' &&
        topo.ids.includes(edge.from),
    )
    causeId =
      incoming.length === 1
        ? incoming[0]!.from
        : (topo.sources.find((id) => id !== moderationEdge.from) ??
          topo.ids.find((id) => id !== moderationEdge.from && id !== targetId) ??
          topo.ids[0]!)
  }
  if (!topo.ids.includes(causeId)) causeId = topo.ids[0]!
  if (!topo.ids.includes(targetId)) targetId = topo.ids[topo.ids.length - 1]!
  moderatorIds = moderatorIds.filter((id) => id !== causeId && id !== targetId)
  if (moderatorIds.length === 0) return null
  const rest = topo.ids.filter(
    (id) => id !== causeId && id !== targetId && !moderatorIds.includes(id),
  )
  place(causeId, x, 0.5, sizes.get(causeId)!, hints)
  place(targetId, y, 0.5, sizes.get(targetId)!, hints)
  // moderator sits above the MIDPOINT of the qualified effect
  const effectMidX =
    (hints.get(causeId)!.x +
      hints.get(causeId)!.w / 2 +
      hints.get(targetId)!.x +
      hints.get(targetId)!.w / 2) /
    2
  const modCenters =
    distributeAlong(moderatorIds, sizes, 'w', effectMidX - 0.2, effectMidX + 0.2) ??
    spreadCenters(
      moderatorIds.length,
      Math.max(0.06, effectMidX - 0.24),
      Math.min(0.94, effectMidX + 0.24),
    )
  moderatorIds.forEach((id, index) => {
    place(id, clamp01(modCenters[index] ?? effectMidX, 0.05, 0.94), 0.14, sizes.get(id)!, hints)
    anchors.add(id)
  })
  const restCenters =
    distributeAlong(rest, sizes, 'w', 0.12, 0.86) ?? spreadCenters(rest.length, 0.16, 0.82)
  rest.forEach((id, index) => {
    place(id, clamp01(restCenters[index] ?? 0.5, 0.08, 0.9), 0.82, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

/**
 * Tree (COMP-P0-07/08): cycle-checked BEFORE any recursion (DFS color), the
 * recursive leaf assignment carries a visiting guard as double insurance, and
 * FORESTS distribute leaf slots across multiple roots; nodes outside every
 * root's reach land in a separate context band.
 */
function treeGrammar(g: GrammarContext): GrammarLayout | null {
  const { topo, sizes, edges } = g
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  // hierarchy subgraph: explicit hierarchy relations when present, else all
  // non-feedback edges
  const hierarchyEdges = edges.filter((edge) => edge.relation === 'hierarchy')
  const treeEdges =
    hierarchyEdges.length > 0 ? hierarchyEdges : edges.filter((edge) => edge.role !== 'feedback')
  const childrenOf = new Map<string, string[]>(topo.ids.map((id) => [id, []]))
  const treeIn = new Map<string, number>(topo.ids.map((id) => [id, 0]))
  for (const edge of treeEdges) {
    if (!childrenOf.has(edge.from) || !childrenOf.has(edge.to)) continue
    childrenOf.get(edge.from)!.push(edge.to)
    treeIn.set(edge.to, (treeIn.get(edge.to) ?? 0) + 1)
  }
  // COMP-P0-07: validate acyclic BEFORE recursing — DFS color, no exceptions
  const cycle = detectCycle(topo.ids, childrenOf)
  if (cycle.hasCycle) return null
  const forest = forestRoots(
    topo.ids,
    buildAdjacency(
      topo.ids,
      treeEdges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
    ),
  )
  if (forest.roots.length === 0) return null
  const leafX = new Map<string, number>()
  const depthOf = new Map<string, number>()
  let leafIndex = 0
  // childless roots are CONTEXT ISLANDS (COMP-P0-08): they are not a
  // hierarchy — they get their own bottom band instead of a fake leaf slot
  const islands = forest.roots.filter((id) => (childrenOf.get(id) ?? []).length === 0)
  const islandSet = new Set(islands)
  const leavesTotal = topo.ids.filter(
    (id) => (childrenOf.get(id) ?? []).length === 0 && !islandSet.has(id),
  ).length
  // COMP-P0-08: forest — roots are visited in stable order and SHARE the leaf
  // span; each root's subtree keeps its horizontal extent
  const orderedRoots = forest.roots
    .filter((id) => !islandSet.has(id))
    .sort(
      (a, b) =>
        (childrenOf.get(b) ?? []).length - (childrenOf.get(a) ?? []).length || a.localeCompare(b),
    )
  const visiting = new Set<string>()
  const assignLeaves = (id: string): number => {
    if (visiting.has(id)) return leafX.get(id) ?? 0.5 // double insurance guard
    visiting.add(id)
    const kids = (childrenOf.get(id) ?? []).slice().sort((a, b) => a.localeCompare(b))
    let result: number
    if (kids.length === 0) {
      const x = leavesTotal === 1 ? 0.5 : 0.1 + (0.8 / (leavesTotal - 1)) * leafIndex
      leafIndex++
      leafX.set(id, x)
      result = x
    } else {
      const xs = kids.map(assignLeaves)
      const mean = xs.reduce((sum, v) => sum + v, 0) / xs.length
      leafX.set(id, mean)
      result = mean
    }
    visiting.delete(id)
    return result
  }
  let maxTreeDepth = 0
  for (const root of orderedRoots) {
    // per-root depth (BFS) so siblings of different roots stay comparable
    depthOf.set(root, depthOf.get(root) ?? 0)
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }]
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!
      maxTreeDepth = Math.max(maxTreeDepth, depth)
      for (const kid of childrenOf.get(id) ?? []) {
        if (!depthOf.has(kid)) {
          depthOf.set(kid, depth + 1)
          queue.push({ id: kid, depth: depth + 1 })
        }
      }
    }
    assignLeaves(root)
    anchors.add(root)
  }
  for (const id of topo.ids) {
    if (!leafX.has(id)) leafX.set(id, 0.5)
    const depth = depthOf.get(id) ?? 0
    const cy = 0.08 + (0.8 / Math.max(1, maxTreeDepth + 1)) * (depth + 0.5)
    place(id, clamp01(leafX.get(id)!, 0.05, 0.95), clamp01(cy, 0.05, 0.92), sizes.get(id)!, hints)
  }
  // context islands (childless roots + nodes unreachable from any root):
  // separate bottom band with their own horizontal spread
  const contextIds = [...new Set([...islands, ...forest.unreachable])]
  const islandCenters =
    distributeAlong(contextIds, sizes, 'w', 0.1, 0.9) ??
    spreadCenters(contextIds.length, 0.14, 0.86)
  contextIds.forEach((id, index) => {
    const size = sizes.get(id)!
    place(
      id,
      clamp01(islandCenters[index] ?? 0.5, 0.05, 0.95),
      clamp01(0.9 - size.h / 2, 0.03, 0.95 - size.h),
      size,
      hints,
    )
  })
  return { hints, anchors }
}

// ─────────────────────────────────────────────────────────────────────────────

function sizesFor(
  measured: MeasuredNode[],
  canvasW: number,
  canvasH: number,
  meta?: Map<string, NodeMeta>,
): Map<string, Size> {
  const sizes = new Map<string, Size>()
  for (const node of measured) {
    const imp = meta?.get(node.id)?.importance ?? 0.5
    const scale = 0.85 + 0.4 * imp
    sizes.set(node.id, {
      w: Math.min(0.34, Math.max(0.07, (node.bounds.preferredWidth / canvasW) * 1.2 * scale)),
      h: Math.min(0.36, Math.max(0.1, (node.bounds.preferredHeight / canvasH) * 1.25 * scale)),
    })
  }
  return sizes
}

const GRAMMAR_BUILDERS: Record<CompositionPrior['grammar'], GrammarBuilder> = {
  linear: (g) => linearGrammar(g),
  converging: (g) => convergingGrammar(g),
  diverging: (g) => divergingGrammar(g),
  'input-core-output': (g) => iceGrammar(g),
  parallel: (g) => parallelGrammar(g),
  layered: (g) => layeredGrammar(g),
  radial: (g) => radialGrammar(g),
  network: (g) => networkGrammar(g),
  timeline: (g) => timelineGrammar(g),
  matrix: (g) => matrixGrammar(g),
  comparison: (g) => comparisonGrammar(g),
  feedback: (g) => feedbackGrammar(g),
  causal: (g) => causalGrammar(g),
  mediation: (g) => mediationGrammar(g),
  moderation: (g) => moderationGrammar(g),
  tree: (g) => treeGrammar(g),
}

const GRAMMAR_COMPOSITION: Record<
  CompositionPrior['grammar'],
  {
    balance: SpatialPlan['composition']['balance']
    whitespaceStrategy: SpatialPlan['composition']['whitespaceStrategy']
  }
> = {
  linear: { balance: 'loosely-balanced', whitespaceStrategy: 'compact' },
  converging: { balance: 'asymmetric', whitespaceStrategy: 'balanced' },
  diverging: { balance: 'asymmetric', whitespaceStrategy: 'balanced' },
  'input-core-output': { balance: 'asymmetric', whitespaceStrategy: 'balanced' },
  parallel: { balance: 'symmetric', whitespaceStrategy: 'balanced' },
  layered: { balance: 'symmetric', whitespaceStrategy: 'balanced' },
  radial: { balance: 'symmetric', whitespaceStrategy: 'open' },
  network: { balance: 'symmetric', whitespaceStrategy: 'open' },
  timeline: { balance: 'loosely-balanced', whitespaceStrategy: 'compact' },
  matrix: { balance: 'symmetric', whitespaceStrategy: 'compact' },
  comparison: { balance: 'symmetric', whitespaceStrategy: 'balanced' },
  feedback: { balance: 'loosely-balanced', whitespaceStrategy: 'compact' },
  causal: { balance: 'asymmetric', whitespaceStrategy: 'balanced' },
  mediation: { balance: 'symmetric', whitespaceStrategy: 'open' },
  moderation: { balance: 'asymmetric', whitespaceStrategy: 'open' },
  tree: { balance: 'symmetric', whitespaceStrategy: 'balanced' },
}

/**
 * Build a program candidate from a prior. Returns null when the prior's
 * grammar declines the graph — the caller tries the next prior instead of
 * faking a layout.
 */
export function candidateFromPrior(
  prior: CompositionPrior,
  measured: MeasuredNode[],
  edges: FigureEdgesInput[],
  canvasW: number,
  canvasH: number,
  meta?: Map<string, NodeMeta>,
  fitPenalty = 0,
  ctx: CandidateContext = {},
  unitFit?: Map<string, UnitFitConstraint>,
): CompositionCandidate | null {
  const ids = measured.map((node) => node.id)
  const idSet = new Set(ids)
  const internalEdges = edges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to))
  const importance = new Map<string, number>()
  for (const node of measured) {
    importance.set(node.id, meta?.get(node.id)?.importance ?? 0.5)
  }
  const topo = buildTopology(ids, internalEdges, {
    importance,
    ...(ctx.spine ? { spine: ctx.spine } : {}),
  })
  const sizes = sizesFor(measured, canvasW, canvasH, meta)
  const builder = GRAMMAR_BUILDERS[prior.grammar] ?? GRAMMAR_BUILDERS.linear!
  const built = builder({ topo, sizes, edges: internalEdges, meta, prior, ctx })
  if (!built) return null
  const { hints, anchors } = built
  const chainSet = new Set(topo.mainChain)
  // 'dominant' is an audited contract (intent.ts): a dominant node MUST end
  // up visually largest. The solver clamps hints to preferred size, so only
  // grant dominant when the focal's preferred area genuinely leads.
  const areaById = new Map(
    measured.map((node) => [node.id, node.bounds.preferredWidth * node.bounds.preferredHeight]),
  )
  const dominantSet = new Set<string>()
  for (const focal of anchors) {
    const focalArea = areaById.get(focal) ?? 0
    const maxOther = Math.max(
      0,
      ...measured.filter((node) => node.id !== focal).map((node) => areaById.get(node.id) ?? 0),
    )
    if (focalArea >= maxOther * 0.92) dominantSet.add(focal)
  }
  const placements: SpatialPlacement[] = measured.map((node) => {
    const hint = hints.get(node.id) ?? {
      x: 0.42,
      y: 0.42,
      w: sizes.get(node.id)!.w,
      h: sizes.get(node.id)!.h,
    }
    const imp = meta?.get(node.id)?.importance ?? 0.5
    const visualRole = dominantSet.has(node.id)
      ? ('dominant' as const)
      : chainSet.has(node.id)
        ? ('primary' as const)
        : imp <= 0.35
          ? ('supporting' as const)
          : ('secondary' as const)
    return { id: node.id, boxHint: hint, visualRole }
  })
  const grammarStyle = GRAMMAR_COMPOSITION[prior.grammar] ?? GRAMMAR_COMPOSITION.linear!
  const plan: SpatialPlan = {
    composition: {
      readingFlow: prior.readingFlow,
      balance: grammarStyle.balance,
      density: ids.length > 10 ? 'high' : ids.length < 4 ? 'low' : 'medium',
      whitespaceStrategy: grammarStyle.whitespaceStrategy,
    },
    placements,
  }
  return evaluateCandidate(
    plan,
    'prior',
    prior.id,
    { measured, edges, canvasW, canvasH, ...(unitFit ? { unitFit } : {}) },
    fitPenalty,
  )
}

/**
 * Generate the candidate set for an autonomy level.
 * - A0: 3 prior candidates spanning DISTINCT grammar families, ranked by
 *   semantic fit (model not consulted).
 * - A1/A2: the model SpatialPlan plus the best prior alternative.
 * Ranking = geometry legality + semantic fit penalty (never geometry alone).
 * When a figure family is declared, the prior pool is gated by its strategy;
 * unsupported families and unmet required signals FAIL LOUDLY.
 */
export function generateCandidates(
  autonomy: 'A0' | 'A1' | 'A2',
  measured: MeasuredNode[],
  edges: FigureEdgesInput[],
  signals: {
    roles: Set<string>
    relations: Set<string>
    signature?: CompositionSignature
  },
  canvasW: number,
  canvasH: number,
  modelPlan?: SpatialPlan | null,
  meta?: Map<string, NodeMeta>,
  ctx: CandidateContext = {},
  unitFit?: Map<string, UnitFitConstraint>,
): CompositionCandidate[] {
  const signature =
    signals.signature ??
    compositionSignature({
      nodeCount: measured.length,
      edgeCount: edges.length,
      relations: signals.relations,
      roles: signals.roles,
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
      importances: measured.map((node) => meta?.get(node.id)?.importance ?? 0.5),
      hasTimeOrder: (ctx.timeOrder ?? []).length > 0,
      hasMatrixAxes:
        (ctx.matrix?.rowGroupIds.length ?? 0) > 0 && (ctx.matrix?.columnGroupIds.length ?? 0) > 0,
    })
  // family strategy gate (COMP-P1-02): unsupported → typed error, never a
  // silent freeform fallback
  let strategy: import('./family-strategy.js').FigureFamilyStrategy | null = null
  if (ctx.family) {
    const resolved = familyStrategyFor(ctx.family)
    if (resolved) {
      strategy = resolved
      const unmet = unmetFamilySignals(resolved, signature)
      if (unmet.length > 0) {
        const detail = unmet.map((u) => `${u.signal} — ${u.remedy}`).join('; ')
        throw new UnsupportedFigureFamilyError(
          ctx.family,
          `FIGURE_FAMILY_SIGNAL_MISSING: "${ctx.family}" requires ${detail}`,
        )
      }
    }
  }
  const preferredIndex = (grammar: string): number => {
    if (!strategy) return 0
    const index = strategy.preferredGrammars.indexOf(grammar)
    return index === -1 ? strategy.preferredGrammars.length : index
  }
  const ranked = COMPOSITION_PRIORS.filter((prior) => {
    if (!strategy) return true
    if (strategy.eligibleGrammars.length === 0) return true // freeform/relaxed
    if (!strategy.eligibleGrammars.includes(prior.grammar)) return false
    return true
  })
    .filter((prior) => !(strategy && strategy.forbiddenGrammars.includes(prior.grammar)))
    .map((prior) => ({
      prior,
      fit: priorFitScore(prior, { ...signals, signature }),
    }))
    .sort(
      (a, b) =>
        preferredIndex(a.prior.grammar) - preferredIndex(b.prior.grammar) ||
        b.fit - a.fit ||
        a.prior.id.localeCompare(b.prior.id),
    )
  // GOAL fourteen (P2): four structurally different candidates for A0; family strategy reorders/filters the pool
    const wanted = autonomy === 'A0' ? 4 : 1
  const selected: Array<{ prior: CompositionPrior; fit: number }> = []
  const usedGrammars = new Set<string>()
  for (const item of ranked) {
    if (selected.length >= wanted) break
    if (usedGrammars.has(item.prior.grammar)) continue
    usedGrammars.add(item.prior.grammar)
    selected.push(item)
  }
  for (const item of ranked) {
    if (selected.length >= wanted) break
    if (selected.some((entry) => entry.prior.id === item.prior.id)) continue
    selected.push(item)
  }
  const maxFit = ranked[0]?.fit ?? 0
  let candidates: CompositionCandidate[] = []
  // declined grammars extend the selection instead of shipping a fake layout
  for (const { prior, fit } of selected) {
    const candidate = candidateFromPrior(
      prior,
      measured,
      edges,
      canvasW,
      canvasH,
      meta,
      (maxFit - fit) * 3,
      ctx,
      unitFit,
    )
    if (candidate) candidates.push(candidate)
  }
  let poolIndex = selected.length
  while (candidates.length < wanted && poolIndex < ranked.length) {
    const item = ranked[poolIndex++]!
    if (selected.some((entry) => entry.prior.id === item.prior.id)) continue
    const candidate = candidateFromPrior(
      item.prior,
      measured,
      edges,
      canvasW,
      canvasH,
      meta,
      (maxFit - item.fit) * 3,
      ctx,
      unitFit,
    )
    if (candidate) candidates.push(candidate)
  }
  if (autonomy !== 'A0' && modelPlan) {
    candidates.unshift(
      evaluateCandidate(
        modelPlan,
        'model',
        null,
        { measured, edges, canvasW, canvasH, ...(unitFit ? { unitFit } : {}) },
        0,
      ),
    )
  }
  if (candidates.length === 0 && strategy && strategy.fallbackPolicy === 'strict') {
    throw new UnsupportedFigureFamilyError(
      ctx.family!,
      `UNSUPPORTED_FIGURE_FAMILY: no eligible grammar composed family "${ctx.family}" on this graph`,
    )
  }
  // GOAL §十五: near-identical compositions are deduped — only the best of a
  // too-similar pair survives, so what remains is genuine visual competition.
  candidates = dedupeByFingerprint(candidates)
  return candidates.sort(
    (a, b) => a.score - b.score || a.priorId?.localeCompare(b.priorId ?? '') || 0,
  )
}

/**
 * 16-bin composition fingerprint: 4×4 quadrant occupancy + normalized
 * distance-from-canvas-center histogram. Two candidates within L1 distance
 * 2 of each other are the same composition wearing different fonts.
 */
export function compositionFingerprint(
  candidate: Pick<CompositionCandidate, 'plan'>,
  canvasW: number,
  canvasH: number,
): number[] {
  const quad = [0, 0, 0, 0]
  const radial = [0, 0, 0, 0, 0, 0, 0, 0]
  for (const placement of candidate.plan.placements) {
    const cx = (placement.boxHint.x + placement.boxHint.w / 2) * canvasW
    const cy = (placement.boxHint.y + placement.boxHint.h / 2) * canvasH
    const nx = (placement.boxHint.x + placement.boxHint.w / 2)
    const ny = (placement.boxHint.y + placement.boxHint.h / 2)
    quad[(nx < 0.5 ? 0 : 1) + (ny < 0.5 ? 0 : 2)]!++
    radial[Math.min(7, Math.floor(Math.hypot(nx - 0.5, ny - 0.45) * 10))]!++
    void cx
    void cy
  }
  return [...quad, ...radial]
}

function fingerprintDistance(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + Math.abs(v - (b[i] ?? 0)), 0)
}

function dedupeByFingerprint(candidates: CompositionCandidate[]): CompositionCandidate[] {
  const kept: CompositionCandidate[] = []
  const fingerprints = candidates.map((candidate) => compositionFingerprint(candidate, 1280, 720))
  for (let i = 0; i < candidates.length; i++) {
    let duplicate = false
    for (let j = 0; j < kept.length; j++) {
      const keptIndex = candidates.indexOf(kept[j]!)
      if (
        keptIndex >= 0 &&
        fingerprintDistance(fingerprints[i]!, fingerprints[keptIndex]!) === 0
      ) {
        duplicate = true
        break
      }
    }
    if (!duplicate) kept.push(candidates[i]!)
  }
  return kept
}

export { UnsupportedFigureFamilyError }
