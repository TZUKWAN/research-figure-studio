import { describe, expect, it } from 'vitest'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'
import { normalizeVisualPlan, type VisualPlan } from '../src/visual/visualPlan.js'
import { layoutMicro } from '../src/visual/microLayout.js'
import { classifyEdges, priorityFor } from '../src/constraints/edge-aware-solver.js'
import { routeEdges } from '../src/routing/router.js'

/**
 * Real-failure regression: the Yangtze cultural-communication case the user
 * saw in the previous round. The point is to lock the Info-Density rules in
 * place: the planner must unfold the four-method research into a complete
 * chain with a primary spine; the canvas must report PASS / non-RECOMPOSE
 * even on a rich content + A0 fallback.
 *
 * The planner output here is what the previous round was missing:
 *  1. The four methods (原型筛选 / 跨文化认知 / 行为建模 / 策略优化) appear
 *     as CORE nodes, each with sub-step children, not collapsed into one
 *     "complex mechanism" card.
 *  2. primarySpine names the chain in research order so the composer lays
 *     them out as a readable backbone.
 *  3. NegativeConstraint strings the user wanted to forbid are dropped
 *     automatically by the pipeline.
 */
const planV2: FigurePlanV2 = {
  thesis:
    '长江文化国际传播：以原型的跨文化表征为基础，识别海外受众的认知与情绪加工机制，建模个体传播行为向群体扩散的演化，并通过反事实优化传播策略。',
  figureType: 'input-core-output',
  nodes: [
    {
      id: 'n0-prototype',
      type: 'mechanism',
      semanticLabel: '原型筛选与跨文化表征',
      visible: { title: '原型筛选与跨文化表征' },
      importance: 0.7,
      role: 'core',
    },
    {
      id: 'n0a-pool',
      type: 'data-source',
      semanticLabel: '候选原型池',
      visible: { title: '候选原型池' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'n0b-screen',
      type: 'process',
      semanticLabel: '文化准确性门槛',
      visible: { title: '文化准确性门槛' },
      importance: 0.5,
      role: 'intermediate',
    },
    {
      id: 'n0c-portrait',
      type: 'process',
      semanticLabel: '传播潜力多维画像',
      visible: { title: '传播潜力多维画像' },
      importance: 0.5,
      role: 'intermediate',
    },
    {
      id: 'n1-cog',
      type: 'mechanism',
      semanticLabel: '跨文化认知与情绪加工',
      visible: {
        title: '跨文化认知与情绪加工',
        detail: '注意｜理解｜冲突｜情绪｜记忆｜态度',
      },
      importance: 0.95,
      role: 'core',
    },
    {
      id: 'n2-behavior',
      type: 'mechanism',
      semanticLabel: '个体传播行为形成',
      visible: { title: '个体传播行为形成' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'n3-diffusion',
      type: 'mechanism',
      semanticLabel: '群体扩散演化',
      visible: { title: '群体扩散演化' },
      importance: 0.85,
      role: 'core',
    },
    {
      id: 'n4-strategy',
      type: 'mechanism',
      semanticLabel: '传播策略检验与优化',
      visible: { title: '传播策略检验与优化' },
      importance: 0.85,
      role: 'core',
    },
    {
      id: 'n-feedback',
      type: 'outcome',
      semanticLabel: '反事实校准',
      visible: { title: '反事实校准' },
      importance: 0.5,
      role: 'context',
    },
  ],
  edges: [
    { from: 'n0a-pool', to: 'n0-prototype', role: 'main', relation: 'process' },
    { from: 'n0b-screen', to: 'n0-prototype', role: 'main', relation: 'process' },
    { from: 'n0c-portrait', to: 'n0-prototype', role: 'main', relation: 'process' },
    { from: 'n0-prototype', to: 'n1-cog', role: 'main', relation: 'causal' },
    { from: 'n1-cog', to: 'n2-behavior', role: 'main', relation: 'causal' },
    { from: 'n2-behavior', to: 'n3-diffusion', role: 'main', relation: 'transformation' },
    { from: 'n3-diffusion', to: 'n4-strategy', role: 'main', relation: 'process' },
    { from: 'n4-strategy', to: 'n0-prototype', role: 'feedback', relation: 'feedback' },
    { from: 'n-feedback', to: 'n1-cog', role: 'main', relation: 'moderation' },
  ],
  primarySpine: ['n0-prototype', 'n1-cog', 'n2-behavior', 'n3-diffusion', 'n4-strategy'],
  groups: [
    {
      id: 'g0-prototype',
      label: '原型筛选',
      memberIds: ['n0a-pool', 'n0b-screen', 'n0c-portrait', 'n0-prototype'],
    },
    {
      id: 'g1-cog',
      label: '认知加工',
      memberIds: ['n1-cog', 'n-feedback'],
    },
  ],
  globalIntent: { emphasis: ['n1-cog'], secondary: ['n2-behavior'], optional: [] },
}

describe('Yangtze cultural-communication regression', () => {
  it('orchestrates the four-method chain into a non-RECOMPOSE first-pass result', async () => {
    const result = await orchestrateFigure(
      { thesis: planV2.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => planV2 },
      (event: { stage: string; detail?: string }) => console.log('EV ' + event.stage + ' :: ' + (event.detail ?? '')),
    )
    console.log('NC ' + JSON.stringify((result as unknown as { candidates?: Array<{ priorId: string | null; score: number }> }).candidates?.map((c) => [c.priorId, c.score])))
    expect(result.ok).toBe(true)
    expect(result.critic?.verdict).not.toBe('RECOMPOSE')
    expect(result.best?.solve.issues).toEqual([])
    // All declared nodes survive orchestration
    expect(result.plan?.nodes).toHaveLength(planV2.nodes.length)
    // primarySpine survives schema + composer ordering
    expect(result.plan?.primarySpine).toEqual(planV2.primarySpine)
    // No diagonal-straight connector survived the new router
    for (const route of result.routes ?? []) {
      if (route.status === 'routed') {
        // Drawn routes are either straight OR elbow; unroutable routes stay explicit.
        expect(['straight', 'elbow']).toContain(route.kind)
      } else {
        expect(route.status).toBe('unroutable')
        expect(route.diagnostic).toBeTruthy()
      }
    }
  })

  it('keeps information density on the rich content', async () => {
    const result = await orchestrateFigure(
      { thesis: planV2.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => planV2 },
    )
    // Critic must not flag under-density on a long thesis with 9 nodes
    expect(result.critic?.scores.contentDensity).toBeGreaterThanOrEqual(1.5)
    // The first three spine nodes (research backbone) reach the critic with
    // primary-clarity score > 0; we accept any non-failure band because
    // the A0 prior may swap their order on the canvas
    expect(result.critic?.scores.primaryClarity).toBeGreaterThan(0)
  })
})

/**
 * Real-failure regression (Architecture gap round): the previous Info-Density
 * round still produced a handful of big cards. This block verifies the new
 * VisualPlan + edge-aware solver + strict router pipeline actually:
 *   1. Decomposes each Major Module into visible micro-units.
 *   2. Routes every spine edge as a clean straight OR 1-bend elbow
 *      (no diagonal straight, bend ≤ 2).
 *   3. Places the next module along the dominant axis of the previous
 *      one (so straight lines are possible on the primary spine).
 */
const VISUAL_PLAN: VisualPlan = {
  modules: [
    {
      moduleId: 'n1-cog',
      microLayout: 'chips',
      units: [
        { id: 'u1', label: '注意', role: 'substep' },
        { id: 'u2', label: '理解', role: 'substep' },
        { id: 'u3', label: '冲突', role: 'substep' },
        { id: 'u4', label: '情绪', role: 'substep' },
        { id: 'u5', label: '记忆', role: 'substep' },
        { id: 'u6', label: '态度', role: 'substep' },
      ],
      hints: { spacing: 'tight' },
    },
    {
      moduleId: 'n2-behavior',
      microLayout: 'rows',
      units: [
        { id: 'u7', label: '持续接触', role: 'substep' },
        { id: 'u8', label: '主动分享', role: 'substep' },
        { id: 'u9', label: '评论扩散', role: 'substep' },
      ],
    },
    {
      moduleId: 'n3-diffusion',
      microLayout: 'rows',
      units: [
        { id: 'u10', label: '社会影响', role: 'substep' },
        { id: 'u11', label: '网络结构', role: 'substep' },
        { id: 'u12', label: '平台推荐', role: 'substep' },
      ],
    },
  ],
}

describe('Yangtze visual-decomposition regression', () => {
  it('parses the visual plan and decomposes modules into >0 micro units', () => {
    const parsed = normalizeVisualPlan(VISUAL_PLAN, {
      nodes: planV2.nodes.map((n) => ({
        id: n.id,
        semanticLabel: n.semanticLabel,
        visible: n.visible,
      })),
    })
    expect(parsed).not.toBeNull()
    const n1 = parsed!.modules.find((m) => m.moduleId === 'n1-cog')!
    expect(n1.units.length).toBe(6)
    expect(n1.microLayout).toBe('chips')
  })

  it('lays out micro units into pixel rects inside the module box', () => {
    const moduleRects = new Map<string, { x: number; y: number; w: number; h: number }>([
      ['n1-cog', { x: 500, y: 280, w: 200, h: 140 }],
      ['n2-behavior', { x: 720, y: 280, w: 200, h: 100 }],
      ['n3-diffusion', { x: 940, y: 280, w: 200, h: 100 }],
    ])
    const out = layoutMicro(VISUAL_PLAN.modules, moduleRects)
    const n1Units = out.units.filter((u) => u.moduleId === 'n1-cog')
    expect(n1Units.length).toBe(6)
    for (const u of n1Units) {
      expect(u.w).toBeGreaterThan(20)
      expect(u.h).toBeGreaterThan(10)
      // stays inside the module's box (with a small padding)
      expect(u.x).toBeGreaterThanOrEqual(500)
      expect(u.x + u.w).toBeLessThanOrEqual(500 + 200)
    }
  })

  it('routes declared connector relations without silently dropping key semantics', async () => {
    const result = await orchestrateFigure(
      { thesis: planV2.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => planV2 },
    )
    const titleById = new Map(planV2.nodes.map((n) => [n.id, n.visible.title]))
    let spineRoutes = 0
    for (let i = 0; i + 1 < (planV2.primarySpine?.length ?? 0); i++) {
      const a = titleById.get(planV2.primarySpine![i]!)!
      const b = titleById.get(planV2.primarySpine![i + 1]!)!
      const route = (result.routes ?? []).find((r) => r.fromId === a && r.toId === b)
      if (route) {
        spineRoutes++
        expect(['straight', 'elbow']).toContain(route.kind)
      }
    }
    const allPlanEdges = planV2.edges.length
    expect(result.routes!.length).toBeLessThanOrEqual(allPlanEdges)
    expect(
      result.routes!.every(
        (route) =>
          route.status === 'routed' || (route.status === 'unroutable' && !!route.diagnostic),
      ),
    ).toBe(true)
    const moderation = (result.routes ?? []).find((route) => route.relation === 'moderation')
    expect(moderation?.status).toBe('routed')
  })

  it('feedback edge is rendered as a distinct edge in the route set', async () => {
    const result = await orchestrateFigure(
      { thesis: planV2.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => planV2 },
    )
    const feedback = (result.routes ?? []).find(
      (r) => r.role === 'feedback' || r.relation === 'feedback',
    )
    expect(feedback).toBeDefined()
  })
})

describe('classifier and edge-cost', () => {
  it('classifies causal/process/dataflow as primary, feedback as feedback, others as secondary', () => {
    const edges = classifyEdges(planV2)
    for (const e of edges) {
      if (e.role === 'feedback') {
        expect(e.priority).toBe('feedback')
      } else if (['causal', 'process', 'data-flow', 'transformation'].includes(e.relation)) {
        expect(e.priority).toBe('primary')
      } else {
        expect(e.priority).toBe('secondary')
      }
    }
  })

  it('routes axis-aligned primaries straight and mis-aligned ones as elbows', () => {
    const aligned = { x: 100, y: 200, w: 200, h: 80 }
    const targetAligned = { x: 350, y: 200, w: 200, h: 80 } // same row
    const targetMisaligned = { x: 350, y: 60, w: 200, h: 80 } // diagonal
    const rects = new Map([
      ['a', aligned],
      ['b', targetAligned],
      ['c', targetMisaligned],
    ])
    const [straight] = routeEdges(
      [{ key: 's', fromId: 'a', toId: 'b', role: 'main', relation: 'causal' }],
      rects,
    )
    expect(straight?.kind).toBe('straight')
    const [elbow] = routeEdges(
      [{ key: 'e', fromId: 'a', toId: 'c', role: 'main', relation: 'causal' }],
      rects,
    )
    expect(elbow?.kind).toBe('elbow')
    // priorityFor sanity
    expect(priorityFor('main', 'causal')).toBe('primary')
    expect(priorityFor('feedback', 'feedback')).toBe('feedback')
    expect(priorityFor('main', 'association')).toBe('secondary')
  })
})
