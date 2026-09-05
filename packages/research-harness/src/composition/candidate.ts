/**
 * Candidate generation + ranking (Phase 3; P0 rewrite — Scientific Art Direction).
 *
 * Every prior now EXECUTES its own spatial grammar (no more "all priors are
 * longest-path columns with a different readingFlow"). Candidate selection
 * spans distinct grammar families, and ranking combines geometry legality
 * with semantic fit — never geometry alone.
 */
import type { MeasuredNode } from '../measurement/measure.js'
import { solveGeometry, type SolveResult } from '../constraints/solver.js'
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

export interface FigureEdgesInput {
  id?: string
  from: string
  to: string
  role: 'main' | 'feedback'
  relation: string
  presentation?: string
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
  /** weakly-connected components over non-feedback edges (parallel tracks) */
  components: string[][]
  mainChain: string[]
}

function buildTopology(ids: string[], edges: FigureEdgesInput[]): Topology {
  const sorted = [...ids].sort()
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  const layerOf = new Map<string, number>()
  for (const id of sorted) {
    inDeg.set(id, 0)
    outDeg.set(id, 0)
    layerOf.set(id, 0)
  }
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id) ?? id
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  for (const id of sorted) parent.set(id, id)
  for (const edge of edges) {
    if (!inDeg.has(edge.from) || !inDeg.has(edge.to)) continue
    if (edge.role === 'feedback') continue
    outDeg.set(edge.from, (outDeg.get(edge.from) ?? 0) + 1)
    inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1)
    adj.set(edge.from, [...(adj.get(edge.from) ?? []), edge.to])
    // union (undirected) for components
    const a = find(edge.from)
    const b = find(edge.to)
    if (a !== b) parent.set(a, b)
  }
  // longest-path layering (Kahn)
  const inCount = new Map(inDeg)
  const queue = sorted.filter((id) => (inCount.get(id) ?? 0) === 0)
  const order: string[] = []
  const maxLayerOf = new Map<string, number>()
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      maxLayerOf.set(next, Math.max(maxLayerOf.get(next) ?? 0, (maxLayerOf.get(id) ?? 0) + 1))
      inCount.set(next, (inCount.get(next) ?? 0) - 1)
      if ((inCount.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  for (const id of sorted) layerOf.set(id, maxLayerOf.get(id) ?? 0)
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
      for (const next of adj.get(id) ?? []) {
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
  const componentMap = new Map<string, string[]>()
  for (const id of sorted) {
    const key = find(id)
    componentMap.set(key, [...(componentMap.get(key) ?? []), id])
  }
  const components = [...componentMap.values()].sort((a, b) => a.length - b.length)
  // main chain: walk from a source greedily by layer
  const mainChain: string[] = []
  if (sorted.length > 0) {
    let current = sources.length > 0 ? sources.sort((a, b) => a.localeCompare(b))[0]! : sorted[0]!
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      visited.add(current)
      mainChain.push(current)
      const next = (adj.get(current) ?? [])
        .filter((n) => !visited.has(n))
        .sort((a, b) => (layerOf.get(a) ?? 0) - (layerOf.get(b) ?? 0) || a.localeCompare(b))[0]
      if (!next) break
      current = next
    }
  }
  return {
    ids: sorted,
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
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grammar builders: each returns per-node fraction hints + the anchor set
// ─────────────────────────────────────────────────────────────────────────────

interface GrammarLayout {
  hints: Map<string, Hint>
  anchors: Set<string>
}

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

function linearGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  options: { topBand?: boolean; moderatorsAbove?: boolean } = {},
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const layerIds = new Map<number, string[]>()
  for (const id of topo.ids) {
    const layer = topo.layerOf.get(id) ?? 0
    layerIds.set(layer, [...(layerIds.get(layer) ?? []), id])
  }
  const layers = [...layerIds.keys()].sort((a, b) => a - b)
  const left = 0.07
  const right = 0.93
  const colSpan = (right - left) / Math.max(1, layers.length)
  const yCenter = options.topBand ? 0.3 : 0.45
  const ySpan = options.topBand ? 0.32 : 0.6
  for (const layer of layers) {
    const members = layerIds.get(layer)!
    const cx = left + colSpan * (layer + 0.5)
    members.forEach((id, index) => {
      const size = sizes.get(id)!
      const offset =
        members.length === 1 ? 0 : (index - (members.length - 1) / 2) * (ySpan / members.length)
      const cy = clamp01(yCenter + offset, 0.06, 0.9)
      place(id, cx, cy, size, hints)
    })
  }
  if (options.moderatorsAbove) {
    // moderators/context float ABOVE the main flow row
    for (const id of topo.ids) {
      const hint = hints.get(id)
      if (!hint) continue
      const cy = hint.y + hint.h / 2
      if (cy > yCenter + 0.05) {
        hints.set(id, { ...hint, y: clamp01(0.06, 0.04, 0.9) })
      }
    }
  }
  return { hints, anchors }
}

function convergingGrammar(topo: Topology, sizes: Map<string, Size>): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const sink =
    topo.sinks.sort((a, b) => (topo.inDeg.get(b) ?? 0) - (topo.inDeg.get(a) ?? 0))[0] ??
    topo.hub ??
    topo.ids[topo.ids.length - 1]!
  const sinkSize = sizes.get(sink)!
  place(sink, 0.76, 0.45, { ...sinkSize, w: Math.min(0.34, sinkSize.w * 1.25) }, hints)
  anchors.add(sink)
  const inputs = topo.ids.filter(
    (id) => id !== sink && (topo.outDeg.get(id) ?? 0) > 0 && (topo.inDeg.get(id) ?? 0) === 0,
  )
  const rest = topo.ids.filter((id) => id !== sink && !inputs.includes(id))
  inputs.forEach((id, index) => {
    const cy = inputs.length === 1 ? 0.45 : 0.16 + (0.58 / (inputs.length - 1)) * index
    place(id, 0.11, clamp01(cy, 0.08, 0.84), sizes.get(id)!, hints)
  })
  const byLayer = new Map<number, string[]>()
  for (const id of rest) {
    const layer = topo.layerOf.get(id) ?? 0
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), id])
  }
  for (const [layer, members] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    members.forEach((id, index) => {
      const cx = clamp01(0.3 + layer * 0.14, 0.2, 0.62)
      const cy = clamp01(0.45 + (index - (members.length - 1) / 2) * 0.16, 0.1, 0.86)
      place(id, cx, cy, sizes.get(id)!, hints)
    })
  }
  return { hints, anchors }
}

function divergingGrammar(topo: Topology, sizes: Map<string, Size>): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const source = topo.sources[0] ?? topo.hub ?? topo.ids[0]!
  const sourceSize = sizes.get(source)!
  place(source, 0.14, 0.45, { ...sourceSize, w: Math.min(0.34, sourceSize.w * 1.2) }, hints)
  anchors.add(source)
  const outputs = topo.ids.filter((id) => id !== source && (topo.inDeg.get(id) ?? 0) > 0)
  outputs.forEach((id, index) => {
    const cy = outputs.length === 1 ? 0.45 : 0.14 + (0.62 / (outputs.length - 1)) * index
    place(id, 0.78, clamp01(cy, 0.08, 0.86), sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function iceGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  meta?: Map<string, NodeMeta>,
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const importanceOf = (id: string) => meta?.get(id)?.importance ?? 0.5
  const degreeOf = (id: string) => (topo.inDeg.get(id) ?? 0) + (topo.outDeg.get(id) ?? 0)
  // the core is the graph HUB: highest degree, then importance — never a pure
  // sink/source just because it sits in the last layer
  const core =
    topo.ids
      .slice()
      .sort(
        (a, b) =>
          degreeOf(b) * 2 + importanceOf(b) - (degreeOf(a) * 2 + importanceOf(a)) ||
          a.localeCompare(b),
      )[0] ??
    topo.hub ??
    topo.ids[0]!
  const coreSize = sizes.get(core)!
  place(
    core,
    0.48,
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
  inputs.forEach((id, index) => {
    const cy = inputs.length === 1 ? 0.44 : 0.14 + (0.6 / Math.max(1, inputs.length - 1)) * index
    place(id, 0.1, clamp01(cy, 0.08, 0.86), sizes.get(id)!, hints)
  })
  outputs.forEach((id, index) => {
    const cy = outputs.length === 1 ? 0.44 : 0.14 + (0.6 / Math.max(1, outputs.length - 1)) * index
    place(id, 0.86, clamp01(cy, 0.08, 0.86), sizes.get(id)!, hints)
  })
  middles.forEach((id, index) => {
    place(id, clamp01(0.3 + index * 0.16, 0.2, 0.68), 0.72, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function parallelGrammar(topo: Topology, sizes: Map<string, Size>): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const lanes =
    topo.components.length >= 2
      ? topo.components.sort((a, b) => b.length - a.length).slice(0, 4)
      : chunk(topo.ids, Math.min(4, Math.max(2, Math.ceil(topo.ids.length / 3))))
  const bandSpan = 0.84 / lanes.length
  lanes.forEach((lane, laneIndex) => {
    const laneIds = [...lane].sort(
      (a, b) => (topo.layerOf.get(a) ?? 0) - (topo.layerOf.get(b) ?? 0) || a.localeCompare(b),
    )
    const cy = 0.08 + bandSpan * (laneIndex + 0.5)
    laneIds.forEach((id, index) => {
      const cx = laneIds.length === 1 ? 0.5 : 0.12 + (0.76 / (laneIds.length - 1)) * index
      place(id, clamp01(cx, 0.06, 0.92), clamp01(cy, 0.06, 0.9), sizes.get(id)!, hints)
    })
  })
  return { hints, anchors }
}

function chunk<T>(items: T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, parts) }, () => [])
  items.forEach((item, index) => out[index % out.length]!.push(item))
  return out.filter((group) => group.length > 0)
}

function layeredGrammar(topo: Topology, sizes: Map<string, Size>): GrammarLayout {
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
    const members = layerIds.get(layer)!
    const cy = 0.07 + bandSpan * (layer + 0.5)
    members.forEach((id, index) => {
      const size = sizes.get(id)!
      const wide: Size = { ...size, w: Math.min(0.36, size.w * 1.2) }
      const cx = members.length === 1 ? 0.5 : 0.14 + (0.72 / (members.length - 1)) * index
      place(id, clamp01(cx, 0.06, 0.92), clamp01(cy, 0.05, 0.92), wide, hints)
    })
  }
  return { hints, anchors }
}

function radialGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  meta?: Map<string, NodeMeta>,
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const importanceOf = (id: string) => meta?.get(id)?.importance ?? 0.5
  const hub =
    topo.ids.slice().sort((a, b) => importanceOf(b) - importanceOf(a))[0] ??
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

function mediationGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  edges: FigureEdgesInput[],
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const mediationEdge = edges.find(
    (edge) => edge.relation === 'mediation' && edge.role !== 'feedback',
  )
  const xId = mediationEdge?.from ?? topo.sources[0] ?? topo.ids[0]!
  const mId = mediationEdge?.to ?? topo.hub ?? topo.ids[Math.min(1, topo.ids.length - 1)]!
  const outAdj = (topo.outDeg.get(mId) ?? 0) > 0
  const yId =
    topo.ids.find((id) => id !== xId && id !== mId && outAdj) ??
    topo.sinks[topo.sinks.length - 1] ??
    topo.ids[topo.ids.length - 1]!
  const rest = topo.ids.filter((id) => id !== xId && id !== mId && id !== yId)
  place(xId, 0.12, 0.46, sizes.get(xId)!, hints)
  place(mId, 0.48, 0.24, sizes.get(mId)!, hints)
  anchors.add(mId)
  place(yId, 0.84, 0.46, sizes.get(yId)!, hints)
  rest.forEach((id, index) => {
    place(id, clamp01(0.2 + index * 0.2, 0.08, 0.9), 0.76, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function moderationGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  edges: FigureEdgesInput[],
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const moderationEdge = edges.find(
    (edge) => edge.relation === 'moderation' && edge.role !== 'feedback',
  )
  const moderatorId = moderationEdge?.from ?? topo.ids[0]!
  const targetId = moderationEdge?.to ?? topo.ids[topo.ids.length - 1]!
  const causeId =
    topo.ids.find(
      (id) => id !== moderatorId && id !== targetId && (topo.outDeg.get(id) ?? 0) > 0,
    ) ??
    topo.sources[0] ??
    topo.ids[0]!
  const rest = topo.ids.filter((id) => id !== moderatorId && id !== targetId && id !== causeId)
  place(causeId, 0.12, 0.5, sizes.get(causeId)!, hints)
  place(targetId, 0.82, 0.5, sizes.get(targetId)!, hints)
  place(moderatorId, 0.47, 0.14, sizes.get(moderatorId)!, hints)
  anchors.add(moderatorId)
  rest.forEach((id, index) => {
    place(id, clamp01(0.2 + index * 0.2, 0.08, 0.9), 0.82, sizes.get(id)!, hints)
  })
  return { hints, anchors }
}

function treeGrammar(
  topo: Topology,
  sizes: Map<string, Size>,
  edges: FigureEdgesInput[],
): GrammarLayout {
  const hints = new Map<string, Hint>()
  const anchors = new Set<string>()
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    if (!topo.ids.includes(edge.from) || !topo.ids.includes(edge.to)) continue
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to])
  }
  const root = topo.root ?? topo.hub ?? topo.ids[0]!
  // leaf slots left-to-right, then parents centered over children
  const leafX = new Map<string, number>()
  let leafIndex = 0
  const leafCount = topo.ids.filter((id) => (children.get(id) ?? []).length === 0).length
  const assignLeaves = (id: string): number => {
    const kids = (children.get(id) ?? []).slice().sort((a, b) => a.localeCompare(b))
    if (kids.length === 0) {
      const x = leafCount === 1 ? 0.5 : 0.1 + (0.8 / (leafCount - 1)) * leafIndex
      leafIndex++
      leafX.set(id, x)
      return x
    }
    const xs = kids.map(assignLeaves)
    const mean = xs.reduce((sum, v) => sum + v, 0) / xs.length
    leafX.set(id, mean)
    return mean
  }
  assignLeaves(root)
  anchors.add(root)
  for (const id of topo.ids) {
    if (!leafX.has(id)) leafX.set(id, 0.5)
    const depth = topo.depthOf.get(id) ?? 0
    const cy = 0.08 + (0.8 / Math.max(1, topo.maxDepth + 1)) * (depth + 0.5)
    const size = sizes.get(id)!
    place(id, clamp01(leafX.get(id)!, 0.05, 0.95), clamp01(cy, 0.05, 0.92), size, hints)
  }
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
    const imp = meta?.get(node.title)?.importance ?? 0.5
    const scale = 0.85 + 0.4 * imp
    sizes.set(node.title, {
      w: Math.min(0.34, Math.max(0.07, (node.bounds.preferredWidth / canvasW) * 1.2 * scale)),
      h: Math.min(0.36, Math.max(0.1, (node.bounds.preferredHeight / canvasH) * 1.25 * scale)),
    })
  }
  return sizes
}

type GrammarBuilder = (
  topo: Topology,
  sizes: Map<string, Size>,
  edges: FigureEdgesInput[],
  meta?: Map<string, NodeMeta>,
) => GrammarLayout

const GRAMMAR_BUILDERS: Record<CompositionPrior['grammar'], GrammarBuilder> = {
  linear: (topo, sizes) => linearGrammar(topo, sizes),
  converging: (topo, sizes) => convergingGrammar(topo, sizes),
  diverging: (topo, sizes) => divergingGrammar(topo, sizes),
  'input-core-output': (topo, sizes, _edges, meta) => iceGrammar(topo, sizes, meta),
  parallel: (topo, sizes) => parallelGrammar(topo, sizes),
  layered: (topo, sizes) => layeredGrammar(topo, sizes),
  radial: (topo, sizes, _edges, meta) => radialGrammar(topo, sizes, meta),
  feedback: (topo, sizes) => linearGrammar(topo, sizes, { topBand: true }),
  causal: (topo, sizes) => linearGrammar(topo, sizes, { moderatorsAbove: true }),
  mediation: (topo, sizes, edges) => mediationGrammar(topo, sizes, edges),
  moderation: (topo, sizes, edges) => moderationGrammar(topo, sizes, edges),
  tree: (topo, sizes, edges) => treeGrammar(topo, sizes, edges),
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
  feedback: { balance: 'loosely-balanced', whitespaceStrategy: 'compact' },
  causal: { balance: 'asymmetric', whitespaceStrategy: 'balanced' },
  mediation: { balance: 'symmetric', whitespaceStrategy: 'open' },
  moderation: { balance: 'asymmetric', whitespaceStrategy: 'open' },
  tree: { balance: 'symmetric', whitespaceStrategy: 'balanced' },
}

/**
 * Build a program candidate from a prior: the prior's grammar builder decides
 * the topology; geometry is expressed as boxHints so the solver still legalizes
 * bounds/overlap without re-gridding the grammar.
 */
export function candidateFromPrior(
  prior: CompositionPrior,
  measured: MeasuredNode[],
  edges: FigureEdgesInput[],
  canvasW: number,
  canvasH: number,
  meta?: Map<string, NodeMeta>,
  fitPenalty = 0,
): CompositionCandidate {
  const ids = measured.map((node) => node.title)
  const idSet = new Set(ids)
  const internalEdges = edges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to))
  const topo = buildTopology(ids, internalEdges)
  const sizes = sizesFor(measured, canvasW, canvasH, meta)
  const builder = GRAMMAR_BUILDERS[prior.grammar] ?? GRAMMAR_BUILDERS.linear!
  const { hints, anchors } = builder(topo, sizes, internalEdges, meta)
  const chainSet = new Set(topo.mainChain)
  // 'dominant' is an audited contract (intent.ts): a dominant node MUST end
  // up visually largest. The solver clamps hints to preferred size, so only
  // grant dominant when the focal's preferred area genuinely leads.
  const areaById = new Map(
    measured.map((node) => [node.title, node.bounds.preferredWidth * node.bounds.preferredHeight]),
  )
  const dominantSet = new Set<string>()
  for (const focal of anchors) {
    const focalArea = areaById.get(focal) ?? 0
    const maxOther = Math.max(
      0,
      ...measured
        .filter((node) => node.title !== focal)
        .map((node) => areaById.get(node.title) ?? 0),
    )
    if (focalArea >= maxOther * 0.92) dominantSet.add(focal)
  }
  const placements: SpatialPlacement[] = measured.map((node) => {
    const hint = hints.get(node.title) ?? {
      x: 0.42,
      y: 0.42,
      w: sizes.get(node.title)!.w,
      h: sizes.get(node.title)!.h,
    }
    const imp = meta?.get(node.title)?.importance ?? 0.5
    const visualRole = dominantSet.has(node.title)
      ? ('dominant' as const)
      : chainSet.has(node.title)
        ? ('primary' as const)
        : imp <= 0.35
          ? ('supporting' as const)
          : ('secondary' as const)
    return { id: node.title, boxHint: hint, visualRole }
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
    { measured, edges, canvasW, canvasH },
    fitPenalty,
  )
}

/**
 * Generate the candidate set for an autonomy level.
 * - A0: 3 prior candidates spanning DISTINCT grammar families, ranked by
 *   semantic fit (model not consulted).
 * - A1/A2: the model SpatialPlan plus the best prior alternative.
 * Ranking = geometry legality + semantic fit penalty (never geometry alone).
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
): CompositionCandidate[] {
  const signature =
    signals.signature ??
    compositionSignature({
      nodeCount: measured.length,
      edgeCount: edges.length,
      relations: signals.relations,
      roles: signals.roles,
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
      importances: measured.map((node) => meta?.get(node.title)?.importance ?? 0.5),
    })
  const ranked = COMPOSITION_PRIORS.map((prior) => ({
    prior,
    fit: priorFitScore(prior, { ...signals, signature }),
  })).sort((a, b) => b.fit - a.fit || a.prior.id.localeCompare(b.prior.id))
  // GOAL §十四: four structurally different candidates for A0 (C1 conservative /
  // C2 focal / C3 editorial / C4 domain). Minimal statements still reduce.
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
  let candidates = selected.map(({ prior, fit }) =>
    candidateFromPrior(prior, measured, edges, canvasW, canvasH, meta, (maxFit - fit) * 3),
  )
  if (autonomy !== 'A0' && modelPlan) {
    candidates.unshift(
      evaluateCandidate(modelPlan, 'model', null, { measured, edges, canvasW, canvasH }, 0),
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
