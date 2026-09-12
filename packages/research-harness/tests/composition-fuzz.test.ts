/**
 * section 29 Fuzz / property tests. A deterministic seeded generator produces the
 * required graph shapes; every shape runs through the FULL orchestrator.
 *
 * Invariants (per shape, every run):
 *   - terminates (vitest timeout is the watchdog; shapes are bounded)
 *   - no NaN / infinite coordinates anywhere in the result
 *   - no negative or zero-dimension placements
 *   - every known plan node is placed exactly once
 *   - every route references known nodes only
 *   - same seed → bit-identical result (determinism)
 */
import { describe, expect, it } from 'vitest'
import { orchestrateFigure, type OrchestrationResult } from '../src/orchestrator/create-figure.js'
import { generateCandidates } from '../src/composition/candidate.js'
import type { FigureEdgesInput } from '../src/composition/candidate.js'
import { estimatorMeasurer, measureNode, type MeasuredNode } from '../src/measurement/measure.js'

/** mulberry32 — small deterministic PRNG */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
const measurer = estimatorMeasurer()
const measure = (ids: string[]): MeasuredNode[] =>
  ids.map((id) => measureNode({ id, title: `节点${id}` }, SPEC, measurer))

interface Shape {
  name: string
  ids: string[]
  edges: FigureEdgesInput[]
}

function shape(
  name: string,
  size: number,
  build: (rand: () => number) => FigureEdgesInput[],
  seed = 7,
): Shape {
  const ids = Array.from({ length: size }, (_, index) => `n${index}`)
  return { name, ids, edges: build(rng(seed)) }
}

function chainShape(name: string, size: number): Shape {
  return shape(name, size, () => {
    const edges: FigureEdgesInput[] = []
    for (let i = 0; i + 1 < size; i++) {
      edges.push({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, role: 'main', relation: 'process' })
    }
    return edges
  })
}

function buildShapes(): Shape[] {
  const shapes: Shape[] = []
  // DAG: each node links to 1-2 later nodes
  shapes.push(
    shape('dag', 12, (rand) => {
      const edges: FigureEdgesInput[] = []
      const seen = new Set<string>()
      for (let i = 0; i < 12; i++) {
        const count = 1 + Math.floor(rand() * 2)
        for (let k = 0; k < count; k++) {
          const target = i + 1 + Math.floor(rand() * (12 - i - 1))
          const key = `n${i}>n${target}`
          if (target < 12 && target > i && !seen.has(key)) {
            seen.add(key)
            edges.push({
              id: `e${i}-${target}-${k}`,
              from: `n${i}`,
              to: `n${target}`,
              role: 'main',
              relation: 'causal',
            })
          }
        }
      }
      return edges
    }),
  )
  shapes.push(chainShape('chain', 8))
  // fan-in: many sources → one sink
  shapes.push(
    shape('fan-in', 9, () =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `e${i}`,
        from: `n${i}`,
        to: 'n8',
        role: 'main' as const,
        relation: 'causal',
      })),
    ),
  )
  // fan-out: one source → many sinks
  shapes.push(
    shape('fan-out', 9, () =>
      Array.from({ length: 8 }, (_, i) => ({
        id: `e${i}`,
        from: 'n0',
        to: `n${i + 1}`,
        role: 'main' as const,
        relation: 'process',
      })),
    ),
  )
  // disconnected: three separate 3-node chains
  shapes.push(
    shape('disconnected', 9, () => {
      const edges: FigureEdgesInput[] = []
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < 2; i++) {
          edges.push({
            id: `e${c}-${i}`,
            from: `n${c * 3 + i}`,
            to: `n${c * 3 + i + 1}`,
            role: 'main',
            relation: 'process',
          })
        }
      }
      return edges
    }),
  )
  // multi-root tree: two roots fan out independently
  shapes.push(
    shape('multi-root-tree', 9, () => {
      const edges: FigureEdgesInput[] = []
      for (let i = 1; i <= 3; i++) {
        edges.push({ id: `el${i}`, from: 'n0', to: `n${i}`, role: 'main', relation: 'hierarchy' })
        edges.push({
          id: `er${i}`,
          from: 'n4',
          to: `n${i + 4}`,
          role: 'main',
          relation: 'hierarchy',
        })
      }
      return edges
    }),
  )
  // cycle: a→b→c→a plus tail
  shapes.push(
    shape('cycle', 6, () => [
      { id: 'e0', from: 'n0', to: 'n1', role: 'main', relation: 'process' },
      { id: 'e1', from: 'n1', to: 'n2', role: 'main', relation: 'process' },
      { id: 'e2', from: 'n2', to: 'n0', role: 'main', relation: 'process' },
      { id: 'e3', from: 'n2', to: 'n3', role: 'main', relation: 'process' },
      { id: 'e4', from: 'n4', to: 'n5', role: 'main', relation: 'causal' },
    ]),
  )
  // feedback cycle: main chain + explicit feedback edge (legitimate)
  shapes.push(
    shape('feedback-cycle', 6, () => [
      { id: 'e0', from: 'n0', to: 'n1', role: 'main', relation: 'process' },
      { id: 'e1', from: 'n1', to: 'n2', role: 'main', relation: 'process' },
      { id: 'e2', from: 'n2', to: 'n3', role: 'main', relation: 'process' },
      { id: 'f0', from: 'n3', to: 'n0', role: 'feedback', relation: 'feedback' },
    ]),
  )
  // multi-edge: same pair with different relations
  shapes.push(
    shape('multi-edge', 5, () => [
      { id: 'e0', from: 'n0', to: 'n1', role: 'main', relation: 'causal' },
      { id: 'e1', from: 'n0', to: 'n1', role: 'main', relation: 'data-flow' },
      {
        id: 'e2',
        from: 'n0',
        to: 'n1',
        role: 'main',
        relation: 'association',
        presentation: 'line',
      },
      { id: 'e3', from: 'n1', to: 'n2', role: 'main', relation: 'process' },
    ]),
  )
  shapes.push(shape('single-node', 1, () => []))
  shapes.push(
    shape('thirty-nodes', 30, (rand) => {
      const edges: FigureEdgesInput[] = []
      const seen = new Set<string>()
      for (let i = 0; i < 30; i++) {
        const count = Math.floor(rand() * 3)
        for (let k = 0; k < count; k++) {
          const target = i + 1 + Math.floor(rand() * (30 - i - 1))
          const key = `n${i}>n${target}`
          if (target < 30 && target > i && !seen.has(key)) {
            seen.add(key)
            edges.push({
              id: `e${i}-${target}-${k}`,
              from: `n${i}`,
              to: `n${target}`,
              role: 'main',
              relation: 'causal',
            })
          }
        }
      }
      // guarantee no isolated graph: chain backbone
      for (let i = 0; i + 1 < 30; i++) {
        edges.push({
          id: `bb${i}`,
          from: `n${i}`,
          to: `n${i + 1}`,
          role: 'main',
          relation: 'process',
        })
      }
      return edges
    }),
  )
  // duplicate labels: distinct node ids sharing the SAME visible title
  shapes.push(
    shape('duplicate-labels', 4, () => [
      { id: 'e0', from: 'n0', to: 'n1', role: 'main', relation: 'causal' },
      { id: 'e1', from: 'n1', to: 'n2', role: 'main', relation: 'process' },
      { id: 'e2', from: 'n2', to: 'n3', role: 'main', relation: 'process' },
    ]),
  )
  return shapes
}

function assertFiniteGeometry(result: OrchestrationResult): void {
  const known = new Set((result.plan?.nodes ?? []).map((node) => node.id))
  // boxHints: finite, positive, within canvas
  for (const placement of result.best?.plan.placements ?? []) {
    for (const value of [
      placement.boxHint.x,
      placement.boxHint.y,
      placement.boxHint.w,
      placement.boxHint.h,
    ]) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(placement.boxHint.w).toBeGreaterThan(0)
    expect(placement.boxHint.h).toBeGreaterThan(0)
    expect(known.has(placement.id)).toBe(true)
  }
  // solved geometry: finite, no negative sizes
  for (const placement of result.best?.solve.placements ?? []) {
    expect(Number.isFinite(placement.x)).toBe(true)
    expect(Number.isFinite(placement.y)).toBe(true)
    expect(placement.w).toBeGreaterThan(0)
    expect(placement.h).toBeGreaterThan(0)
    expect(known.has(placement.id)).toBe(true)
  }
  // measured bounds sane
  for (const node of result.measured ?? []) {
    expect(Number.isFinite(node.bounds.preferredWidth)).toBe(true)
    expect(node.bounds.preferredWidth).toBeGreaterThan(0)
    expect(node.bounds.preferredHeight).toBeGreaterThan(0)
  }
  // routes reference known nodes only
  for (const route of result.routes ?? []) {
    expect(known.has(route.fromId)).toBe(true)
    expect(known.has(route.toId)).toBe(true)
  }
  // critic scores are finite numbers
  for (const [key, value] of Object.entries(result.critic?.scores ?? {})) {
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(10)
    void key
  }
}

describe('fuzz invariants over required graph shapes', () => {
  const shapes = buildShapes()

  it('generateCandidates never NaNs, never fakes nodes, and is deterministic', () => {
    for (const shape of shapes) {
      const measured = measure(shape.ids)
      const meta = new Map(shape.ids.map((id) => [id, { importance: 0.5 }]))
      const signals = {
        roles: new Set(['input', 'core', 'output']),
        relations: new Set(shape.edges.map((edge) => edge.relation)),
      }
      const run = () =>
        generateCandidates('A0', measured, shape.edges, signals, 1280, 720, null, meta)
      const candidates = run()
      const again = run()
      expect(candidates).toEqual(again) // deterministic
      for (const candidate of candidates) {
        const placedIds = new Set(candidate.plan.placements.map((placement) => placement.id))
        for (const id of shape.ids) {
          expect(placedIds.has(id)).toBe(true) // no node silently missing
        }
        for (const placement of candidate.plan.placements) {
          expect(placement.boxHint.w).toBeGreaterThan(0)
          expect(placement.boxHint.h).toBeGreaterThan(0)
        }
      }
    }
  })

  it('ORCH-P0-05: the route-fix budget belongs to each CANDIDATE, not the run', async () => {
    // the 12-node DAG forces several candidates through route fixes: the
    // ladder re-uses L2 on later candidates. Under the OLD run-global
    // `routeRetried` flag at most ONE 'L2 ROUTE_FIX' could ever appear in a
    // run — two or more proves the budget is per-candidate again.
    const dag = shapes.find((s) => s.name === 'dag')!
    const plan = {
      thesis: 'fuzz dag budget',
      figureType: 'input-core-output',
      nodes: dag.ids.map((id, index) => ({
        id,
        type: 'process',
        semanticLabel: `节点${index}`,
        visible: { title: `节点${index}` },
        importance: 0.5,
        role: 'intermediate',
      })),
      edges: dag.edges,
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
    }
    const result = await orchestrateFigure(
      { thesis: plan.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => plan, compose: async () => null },
    )
    const l2Count = (result.repairs ?? []).filter((repair) => repair === 'L2 ROUTE_FIX').length
    expect(l2Count).toBeGreaterThanOrEqual(2)
  })

  for (const shape of shapes) {
    it(`full orchestration survives "${shape.name}" (${shape.ids.length} nodes)`, async () => {
      const duplicateTitles = shape.name === 'duplicate-labels'
      const plan = {
        thesis: `fuzz ${shape.name}`,
        figureType: 'input-core-output',
        nodes: shape.ids.map((id, index) => ({
          id,
          type: 'process',
          semanticLabel: `节点${index}`,
          // duplicate-labels shape: identical visible titles, distinct ids —
          // internal identity must survive title collision (COMP-P1-12)
          visible: { title: duplicateTitles ? '同名节点' : `节点${index}` },
          importance: 0.5,
          role: 'intermediate',
        })),
        edges: shape.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          role: edge.role,
          relation: edge.relation,
          ...(edge.presentation ? { presentation: edge.presentation } : {}),
        })),
        groups: [],
        globalIntent: { emphasis: [], secondary: [], optional: [] },
      }
      const run = () =>
        orchestrateFigure(
          {
            thesis: plan.thesis,
            canvasW: 1280,
            canvasH: 720,
            maxRecompose: 1,
            maxSemanticReplans: 1,
          },
          { semanticPlan: async () => plan, compose: async () => null },
        )
      const result = await run()
      expect(result.plan?.nodes).toHaveLength(shape.ids.length)
      assertFiniteGeometry(result)
      // determinism: same input twice → identical placements + routes
      const repeat = await run()
      expect(repeat.best?.plan).toEqual(result.best?.plan)
      expect(repeat.routes).toEqual(result.routes)
    }, 10_000)
  }
})
