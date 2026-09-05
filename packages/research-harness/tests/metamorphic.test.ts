import { describe, expect, it } from 'vitest'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'

/**
 * QA-P1-11: metamorphic tests. These encode relations between outputs that
 * MUST hold when the input changes in a meaning-preserving way:
 *   - node array permutation must not change the figure
 *   - modest label growth must not flip causal direction
 *   - proportional canvas scaling must preserve normalized topology
 *   - renaming node ids must not change the routed structure
 */

function basePlan(): FigurePlanV2 {
  return {
    thesis: '代谢通路:底物经酶1与酶2转化为产物并被反馈抑制',
    figureType: 'input-core-output',
    nodes: [
      {
        id: 'sub',
        type: 'data-source',
        semanticLabel: '底物',
        visible: { title: '底物' },
        importance: 0.4,
        role: 'input',
      },
      {
        id: 'e1',
        type: 'mechanism',
        semanticLabel: '酶促反应一',
        visible: { title: '酶促反应一' },
        importance: 0.9,
        role: 'core',
      },
      {
        id: 'e2',
        type: 'mechanism',
        semanticLabel: '酶促反应二',
        visible: { title: '酶促反应二' },
        importance: 0.7,
        role: 'core',
      },
      {
        id: 'out',
        type: 'outcome',
        semanticLabel: '产物',
        visible: { title: '产物' },
        importance: 0.6,
        role: 'output',
      },
    ],
    edges: [
      { from: 'sub', to: 'e1', role: 'main', relation: 'process' },
      { from: 'e1', to: 'e2', role: 'main', relation: 'process' },
      { from: 'e2', to: 'out', role: 'main', relation: 'transformation' },
    ],
    groups: [],
    globalIntent: { emphasis: ['e1'], secondary: [], optional: [] },
    readingIntent: { preferredDirection: 'LR' },
  } as FigurePlanV2
}

const LLN = { semanticPlan: async () => basePlan() }

type RouteTriple = Array<[string, string, string]>

function routeSignature(
  routes: Array<{ fromId: string; toId: string; status: string }>,
): RouteTriple {
  return routes
    .filter((route) => route.status === 'routed')
    .map((route) => [route.fromId, route.toId, route.status] as [string, string, string])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
}

describe('QA-P1-11: metamorphic relations', () => {
  it('permutation invariance: node order must not decide the composition', async () => {
    const resultA = await orchestrateFigure({ thesis: 'm', canvasW: 1280, canvasH: 720 }, LLN)
    const shuffled = basePlan()
    shuffled.nodes = [
      shuffled.nodes[2]!,
      shuffled.nodes[0]!,
      shuffled.nodes[3]!,
      shuffled.nodes[1]!,
    ]
    const resultB = await orchestrateFigure(
      { thesis: 'm', canvasW: 1280, canvasH: 720 },
      {
        semanticPlan: async () => shuffled,
      },
    )
    expect(routeSignature(resultA.routes ?? [])).toEqual(routeSignature(resultB.routes ?? []))
    expect(resultA.critic?.verdict).toBe(resultB.critic?.verdict)
    // normalized placement sets must agree: same ids, similar boxes
    const norm = (result: typeof resultA) =>
      new Map(
        (result.best?.solve.placements ?? []).map((p) => [
          p.id,
          `${Math.round(p.x / 40)}:${Math.round(p.y / 40)}:${Math.round(p.w / 40)}:${Math.round(p.h / 40)}`,
        ]),
      )
    const placementsA = norm(resultA)
    const placementsB = norm(resultB)
    expect([...placementsA.keys()].sort()).toEqual([...placementsB.keys()].sort())
    for (const [id, box] of placementsA) {
      expect(placementsB.get(id), `placement of ${id} changed under permutation`).toBe(box)
    }
  })

  it('label-length perturbation: longer titles may resize nodes but never flip causal direction', async () => {
    const long = basePlan()
    for (const node of long.nodes) {
      node.visible.title = `${node.visible.title}（含扩展说明文本）`
    }
    const result = await orchestrateFigure(
      { thesis: 'm', canvasW: 1280, canvasH: 720 },
      {
        semanticPlan: async () => long,
      },
    )
    const declared = basePlan()
      .edges.map((edge) => `${edge.from}->${edge.to}`)
      .sort()
    const realized = routeSignature(result.routes ?? [])
      .map(([from, to]) => `${from}->${to}`)
      .sort()
    expect(declared).toEqual(realized)
    expect(result.ok).toBe(true)
  })

  it('scale invariance: proportional canvas growth preserves normalized topology', async () => {
    const resultA = await orchestrateFigure({ thesis: 'm', canvasW: 1280, canvasH: 720 }, LLN)
    const resultB = await orchestrateFigure({ thesis: 'm', canvasW: 1920, canvasH: 1080 }, LLN)
    const normalized = (result: typeof resultA) => {
      const canvas = result === resultA ? { w: 1280, h: 720 } : { w: 1920, h: 1080 }
      return new Map(
        (result.best?.solve.placements ?? []).map((p) => [
          p.id,
          [
            Math.round(((p.x + p.w / 2) / canvas.w) * 20),
            Math.round(((p.y + p.h / 2) / canvas.h) * 20),
          ],
        ]),
      )
    }
    const a = normalized(resultA)
    const b = normalized(resultB)
    for (const [id, cell] of a) {
      const other = b.get(id)
      expect(other, `node ${id} missing in scaled canvas`).toBeDefined()
      // same 1/20th grid cell (±1 for solver granularity)
      expect(Math.abs(cell[0] - other![0])).toBeLessThanOrEqual(1)
      expect(Math.abs(cell[1] - other![1])).toBeLessThanOrEqual(1)
    }
  })

  it('id rename invariance: renaming ids must not change the routed structure', async () => {
    const renamed = basePlan()
    const mapping: Record<string, string> = { sub: 'z9', e1: 'y8', e2: 'x7', out: 'w6' }
    renamed.nodes = renamed.nodes.map((node) => ({ ...node, id: mapping[node.id]! }))
    renamed.edges = renamed.edges.map((edge) => ({
      ...edge,
      from: mapping[edge.from]!,
      to: mapping[edge.to]!,
    }))
    renamed.globalIntent = { emphasis: ['y8'], secondary: [], optional: [] }
    const resultA = await orchestrateFigure({ thesis: 'm', canvasW: 1280, canvasH: 720 }, LLN)
    const resultB = await orchestrateFigure(
      { thesis: 'm', canvasW: 1280, canvasH: 720 },
      {
        semanticPlan: async () => renamed,
      },
    )
    const unmap = (signature: RouteTriple): RouteTriple =>
      signature
        .map(([from, to, status]) => {
          const back = (id: string) =>
            Object.entries(mapping).find(([, newId]) => newId === id)?.[0] ?? id
          return [back(from), back(to), status] as [string, string, string]
        })
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    expect(unmap(routeSignature(resultB.routes ?? []))).toEqual(
      routeSignature(resultA.routes ?? []),
    )
    expect(resultA.critic?.verdict).toBe(resultB.critic?.verdict)
  })
})
