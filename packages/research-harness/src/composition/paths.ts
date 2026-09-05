/**
 * Deterministic graph utilities for composition grammars (audit COMP-P0-01
 * through COMP-P0-08). Every function is pure, bounded and order-stable:
 * grammars must never infinite-loop on cyclic or disconnected input, and must
 * never invent structure from node id naming.
 */
import type { RelationType } from '../semantic/schema.js'

/** Minimal edge view; FigureEdgesInput satisfies this structurally. */
export interface PathEdge {
  from: string
  to: string
  role?: string
  relation?: string
}

export interface Adjacency {
  successors: Map<string, string[]>
  predecessors: Map<string, string[]>
  /** endpoint pair → ALL edges between them (multi-edge safe, COMP-P1-11) */
  edgesBetween: Map<string, PathEdge[]>
  inDeg: Map<string, number>
  outDeg: Map<string, number>
}

export function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`
}

/**
 * Adjacency over NON-feedback edges (feedback cycles are legitimate science,
 * not layout topology). Deterministic: successors keep insertion order of the
 * edge list, which callers sort explicitly when order matters.
 */
export function buildAdjacency(ids: string[], edges: PathEdge[]): Adjacency {
  const known = new Set(ids)
  const successors = new Map<string, string[]>(ids.map((id) => [id, []]))
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]))
  const edgesBetween = new Map<string, PathEdge[]>()
  const inDeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const outDeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue
    successors.get(edge.from)!.push(edge.to)
    predecessors.get(edge.to)!.push(edge.from)
    outDeg.set(edge.from, (outDeg.get(edge.from) ?? 0) + 1)
    inDeg.set(edge.to, (inDeg.get(edge.to) ?? 0) + 1)
    const key = pairKey(edge.from, edge.to)
    edgesBetween.set(key, [...(edgesBetween.get(key) ?? []), edge])
  }
  return { successors, predecessors, edgesBetween, inDeg, outDeg }
}

export interface CycleInfo {
  hasCycle: boolean
  /** nodes participating in at least one back edge (deterministic subset) */
  cycleNodes: string[]
}

/**
 * DFS color cycle detection over an explicit adjacency map (COMP-P0-07).
 * Bounded by |V|+|E| — no recursion without a visiting guard.
 */
export function detectCycle(ids: string[], successors: Map<string, string[]>): CycleInfo {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(ids.map((id) => [id, WHITE]))
  const cycleNodes = new Set<string>()
  // explicit stack of [node, successor-index]; recursion is data, not calls
  for (const root of ids) {
    if (color.get(root) !== WHITE) continue
    const stack: Array<{ node: string; index: number }> = [{ node: root, index: 0 }]
    color.set(root, GRAY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const next = (successors.get(frame.node) ?? [])[frame.index]
      if (next === undefined) {
        color.set(frame.node, BLACK)
        stack.pop()
        continue
      }
      frame.index++
      const state = color.get(next) ?? WHITE
      if (state === GRAY) {
        cycleNodes.add(next)
        cycleNodes.add(frame.node)
      } else if (state === WHITE) {
        color.set(next, GRAY)
        stack.push({ node: next, index: 0 })
      }
    }
  }
  return { hasCycle: cycleNodes.size > 0, cycleNodes: [...cycleNodes].sort() }
}

/**
 * Kahn topological order, or null when the graph contains a cycle.
 */
export function topologicalOrder(
  ids: string[],
  successors: Map<string, string[]>,
  inDeg: Map<string, number>,
): string[] | null {
  const indegree = new Map(inDeg)
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of successors.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1)
      if ((indegree.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  return order.length === ids.length ? order : null
}

const PRIMARY_RELATIONS: ReadonlySet<string> = new Set<RelationType>([
  'causal',
  'process',
  'data-flow',
  'transformation',
  'mediation',
])

function edgeWeight(relation: string | undefined): number {
  return relation && PRIMARY_RELATIONS.has(relation) ? 0.5 : 0
}

/**
 * Main chain selection (COMP-P1-08), in strict priority order:
 *   1. the declared semantic spine (primarySpine / readingPath)
 *   2. the importance-weighted longest path over primary relations
 *   3. the plain longest path
 *   4. greedy walk (cycle fallback) — lexicographic only as the final tie-break
 */
export function weightedMainChain(
  ids: string[],
  adjacency: Adjacency,
  edges: PathEdge[],
  importance: Map<string, number>,
  spine?: string[],
): string[] {
  if (ids.length === 0) return []
  // 1) declared spine wins when it references real nodes
  if (spine && spine.length > 0) {
    const known = new Set(ids)
    const filtered = spine.filter((id) => known.has(id))
    if (filtered.length >= 2) return filtered
  }
  const primarySucc = new Map<string, string[]>()
  const primaryIn = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const id of ids) primarySucc.set(id, [])
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    if (!primarySucc.has(edge.from) || !primaryIn.has(edge.to)) continue
    if (edgeWeight(edge.relation) > 0) {
      primarySucc.get(edge.from)!.push(edge.to)
      primaryIn.set(edge.to, (primaryIn.get(edge.to) ?? 0) + 1)
    }
  }
  const hasPrimary = ids.some((id) => (primarySucc.get(id) ?? []).length > 0)
  const order = topologicalOrder(ids, adjacency.successors, adjacency.inDeg)
  if (order) {
    // longest path DP: score = node importance + primary-edge bonus
    const weightOf = (id: string) => importance.get(id) ?? 0.5
    const best = new Map<string, { score: number; prev: string | null }>(
      ids.map((id) => [id, { score: weightOf(id), prev: null }]),
    )
    for (const id of order) {
      const entry = best.get(id)!
      for (const next of adjacency.successors.get(id) ?? []) {
        const gain =
          weightOf(next) + (hasPrimary && edgeWeightFor(adjacency, id, next) > 0 ? 0.5 : 0)
        const candidate = entry.score + gain
        const current = best.get(next)!
        if (candidate > current.score + 1e-9) {
          best.set(next, { score: candidate, prev: id })
        }
      }
    }
    let tail: string | null = null
    let tailScore = -Infinity
    for (const [id, entry] of best) {
      if (entry.score > tailScore + 1e-9) {
        tailScore = entry.score
        tail = id
      }
    }
    const chain: string[] = []
    let cursor: string | null = tail
    while (cursor) {
      chain.unshift(cursor)
      cursor = best.get(cursor)!.prev
    }
    return chain
  }
  // 4) cyclic graph: greedy walk with a visited guard (never loops)
  const start =
    [...ids].sort(
      (a, b) => (adjacency.inDeg.get(a) ?? 0) - (adjacency.inDeg.get(b) ?? 0) || a.localeCompare(b),
    )[0] ?? ids[0]!
  const chain: string[] = []
  const visited = new Set<string>()
  let current: string | undefined = start
  while (current && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    const successors = (adjacency.successors.get(current) ?? [])
      .filter((next) => !visited.has(next))
      .sort((a, b) => (importance.get(b) ?? 0.5) - (importance.get(a) ?? 0.5) || a.localeCompare(b))
    current = successors[0]
  }
  return chain
}

function edgeWeightFor(adjacency: Adjacency, from: string, to: string): number {
  const edges = adjacency.edgesBetween.get(pairKey(from, to)) ?? []
  return Math.max(0, ...edges.map((edge) => edgeWeight(edge.relation)))
}

/** One parallel lane derived from REAL graph paths (never id arithmetic). */
export interface ParallelTrack {
  id: string
  nodeIds: string[]
  /** shared branch node feeding this track */
  source?: string
  /** shared join / terminal node this track enters */
  sink?: string
}

/**
 * Path decomposition (COMP-P0-03). Recognises the real parallel shape
 *
 *   Input ─┬→ PathA ─┐
 *          ├→ PathB ─┼→ Output
 *          └→ PathC ─┘
 *
 * by flood-filling from branch points to join points. Disconnected components
 * become their own tracks. Returns [] when the graph has NO genuine parallel
 * structure — callers must not fall back to round-robin lane assignment.
 */
export function decomposeParallelTracks(ids: string[], edges: PathEdge[]): ParallelTrack[] {
  if (ids.length === 0) return []
  const adjacency = buildAdjacency(ids, edges)
  const { inDeg, outDeg, successors } = adjacency
  // weakly-connected components over non-feedback edges
  const components = weakComponents(ids, edges)
  if (components.length >= 2) {
    return components
      .map((members, index) => ({
        id: `track-${index + 1}`,
        nodeIds: members,
      }))
      .sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.id.localeCompare(b.id))
  }
  const shared = new Set<string>()
  for (const id of ids) {
    if ((outDeg.get(id) ?? 0) > 1 || (inDeg.get(id) ?? 0) > 1) shared.add(id)
  }
  const branchNodes = ids.filter((id) => (outDeg.get(id) ?? 0) > 1 && (inDeg.get(id) ?? 0) === 0)
  const seeds =
    branchNodes.length > 0
      ? branchNodes
      : ids.filter((id) => !shared.has(id) && (inDeg.get(id) ?? 0) === 0)
  if (seeds.length === 0) return []
  const tracks: ParallelTrack[] = []
  const assigned = new Set<string>(shared)
  for (const seed of seeds) {
    for (const first of successors.get(seed) ?? []) {
      if (assigned.has(first) || shared.has(first)) continue
      const track: string[] = []
      let cursor: string | undefined = first
      let sink: string | undefined
      // bounded forward walk: stop at shared nodes (join/branch) or assigned
      while (cursor && !assigned.has(cursor) && !shared.has(cursor)) {
        assigned.add(cursor)
        track.push(cursor)
        const next: string[] = successors.get(cursor) ?? []
        if (next.length === 0) {
          sink = undefined
          break
        }
        if (next.length > 1) {
          // this track hits another branch — stop the lane here
          break
        }
        cursor = next[0]
        if (cursor && (shared.has(cursor) || assigned.has(cursor))) {
          sink = cursor
          cursor = undefined
        }
      }
      if (track.length > 0) {
        tracks.push({
          id: `track-${tracks.length + 1}`,
          nodeIds: track,
          source: seed,
          ...(sink ? { sink } : {}),
        })
      }
    }
  }
  if (tracks.length < 2) return []
  // leftover unassigned nodes: park them in the last track's context — no,
  // they stay untracked; the grammar places them in a context band.
  return tracks
}

/** Weakly-connected components over non-feedback edges, stable order. */
export function weakComponents(ids: string[], edges: PathEdge[]): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    const root = parent.get(id) ?? id
    if (root === id) return id
    const top = find(root)
    parent.set(id, top)
    return top
  }
  for (const edge of edges) {
    if (edge.role === 'feedback') continue
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue
    const a = find(edge.from)
    const b = find(edge.to)
    if (a !== b) parent.set(a, b)
  }
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const key = find(id)
    groups.set(key, [...(groups.get(key) ?? []), id])
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
}

/**
 * Forest roots for the tree grammar (COMP-P0-08): all in-degree-0 nodes of
 * the hierarchy subgraph, plus nodes unreachable from any root (context
 * islands) returned separately.
 */
export function forestRoots(
  ids: string[],
  adjacency: Adjacency,
): { roots: string[]; unreachable: string[] } {
  const roots = ids.filter((id) => (adjacency.inDeg.get(id) ?? 0) === 0)
  const reachable = new Set<string>()
  for (const root of roots) {
    const stack = [root]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const next of adjacency.successors.get(id) ?? []) stack.push(next)
    }
  }
  const unreachable = ids.filter((id) => !reachable.has(id))
  return { roots, unreachable }
}
