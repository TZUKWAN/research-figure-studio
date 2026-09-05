/**
 * COMP-P1-11/12 — multi-edge identity (edge.id over endpoint keys) and
 * semantic-ID / visible-title decoupling.
 */
import { describe, expect, it } from 'vitest'
import { orchestrateFigure } from '../src/orchestrator/create-figure.js'
import { compileSemanticAttempt } from '../src/orchestrator/semantic-attempt.js'
import { criticVerdict } from '../src/critic/metric-critic.js'
import { auditScientific } from '../src/critic/scientific-critic.js'
import { routeEdgesWithObstacles } from '../src/routing/router.js'
import { parseFigurePlanV2WithDiagnostics } from '../src/semantic/figure-plan.js'
import { SEMANTIC_NODE_STYLES } from '../src/components/semantic-styles.js'
import { resolveDomain } from '../src/contract/domain-profile.js'

const specFor = (type: keyof typeof SEMANTIC_NODE_STYLES) => {
  const style = SEMANTIC_NODE_STYLES[type]
  return {
    titleSizePt: style.titleSizePt,
    detailSizePt: style.detailSizePt,
    maxTitleLines: style.maxTitleLines,
    maxDetailLines: style.maxDetailLines,
    padX: style.padX,
    padY: style.padY,
    titleGapY: style.titleGapY,
    lineHeight: style.lineHeight,
    minWidth: style.minWidth,
    maxWidth: style.maxWidth,
    minHeight: style.minHeight,
    maxHeight: style.maxHeight,
  }
}

describe('COMP-P1-11: parallel relations between the SAME nodes stay distinct', () => {
  const multiEdgePlan = {
    thesis: '同一对实体携带多种关系',
    figureType: 'mechanism',
    nodes: [
      {
        id: 'a',
        type: 'model',
        semanticLabel: '模型A',
        visible: { title: '模型甲' },
        importance: 0.8,
        role: 'core',
      },
      {
        id: 'b',
        type: 'evidence',
        semanticLabel: '证据B',
        visible: { title: '证据乙' },
        importance: 0.6,
        role: 'output',
      },
    ],
    edges: [
      { id: 'ab-causal', from: 'a', to: 'b', role: 'main', relation: 'causal' },
      { id: 'ab-data', from: 'a', to: 'b', role: 'main', relation: 'data-flow' },
      {
        id: 'ab-hypo',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'association',
        presentation: 'line',
      },
    ],
    groups: [],
    globalIntent: { emphasis: [], secondary: [], optional: [] },
  }

  it('parser keeps three distinct edges with stable ids', () => {
    const { plan, errors } = parseFigurePlanV2WithDiagnostics(structuredClone(multiEdgePlan))
    expect(errors).toEqual([])
    expect(plan?.edges).toHaveLength(3)
    expect(new Set(plan?.edges.map((edge) => edge.id)).size).toBe(3)
  })

  it('priority index is keyed by edge id — no endpoint-key overwrite', () => {
    const domain = resolveDomain('general')
    const state = compileSemanticAttempt({
      plan: parseFigurePlanV2WithDiagnostics(structuredClone(multiEdgePlan)).plan!,
      attempt: 0,
      specFor,
      domain,
    })
    // all three ids present in the ID-keyed map
    expect(state.edgePriorityById.get('ab-causal')).toBe('primary')
    expect(state.edgePriorityById.get('ab-data')).toBe('primary')
    expect(state.edgePriorityById.get('ab-hypo')).toBe('secondary')
    // the pair fallback index keeps ALL priorities, not just the last one
    const pairPriorities = state.edgePriorityByPair.get('a\u0000b')
    expect(pairPriorities).toEqual(['primary', 'primary', 'secondary'])
  })

  it('the orchestrator routes each relation as its own connector', async () => {
    const result = await orchestrateFigure(
      { thesis: multiEdgePlan.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => multiEdgePlan },
    )
    expect(result.ok).toBe(true)
    const keys = new Set((result.routes ?? []).map((route) => route.semanticEdgeId))
    expect(keys).toContain('ab-causal')
    expect(keys).toContain('ab-data')
    expect(keys).toContain('ab-hypo')
    // the critic realizes all three declared connectors (id-based matching)
    expect(result.critic?.scores.scientificFidelity).toBeGreaterThan(5)
  })

  it('the scientific critic matches realization per edge, not per endpoint pair', () => {
    const domain = resolveDomain('general')
    const state = compileSemanticAttempt({
      plan: parseFigurePlanV2WithDiagnostics(structuredClone(multiEdgePlan)).plan!,
      attempt: 0,
      specFor,
      domain,
    })
    const placements = [
      { id: 'a', x: 200, y: 300, w: 200, h: 80 },
      { id: 'b', x: 800, y: 300, w: 200, h: 80 },
    ]
    const rectMap = new Map(placements.map((placement) => [placement.id, placement]))
    const routes = routeEdgesWithObstacles(
      state.edges.map((edge) => ({
        key: edge.id!,
        semanticEdgeId: edge.id,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
        presentation: (edge.presentation ?? 'arrow') as 'arrow',
        priority: state.edgePriorityById.get(edge.id!) ?? 'secondary',
      })),
      rectMap,
      { w: 1280, h: 720 },
      'LR',
    )
    expect(routes.every((route) => route.status === 'routed')).toBe(true)
    const issues = auditScientific({
      plan: state.plan,
      placements,
      routes,
      importance: state.importance,
    })
    // no "declared connectors not realized" false positive from pair collision
    expect(issues.some((issue) => issue.repairClass === 'ROUTE_FIX')).toBe(false)
    const verdict = criticVerdict({
      solve: { placements, issues: [], intentDriftPx: 0 },
      edges: state.edges,
      canvasW: 1280,
      canvasH: 720,
      importance: state.importance,
      routed: routes,
    })
    expect(verdict.hardGates.find((gate) => gate.gate === 'routes_feasible')?.pass).toBe(true)
  })
})

describe('COMP-P1-12: semantic id vs visible title are fully decoupled', () => {
  it('measurement keys by id; the title only carries display text', async () => {
    const trickyPlan = {
      thesis: '标题与ID完全不同',
      figureType: 'mechanism',
      nodes: [
        {
          id: 'node-1',
          type: 'mechanism',
          semanticLabel: '机制一',
          visible: { title: '完全不同的标题' },
          importance: 0.8,
          role: 'core',
        },
        {
          id: 'node-2',
          type: 'outcome',
          semanticLabel: '结果二',
          visible: { title: '另一个标题' },
          importance: 0.6,
          role: 'output',
        },
      ],
      edges: [{ id: 'e1', from: 'node-1', to: 'node-2', role: 'main', relation: 'causal' }],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
    }
    const result = await orchestrateFigure(
      { thesis: trickyPlan.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => trickyPlan },
    )
    expect(result.ok).toBe(true)
    // the geometry is keyed by semantic id — the visible titles never appear
    // as placement ids
    for (const placement of result.best?.solve.placements ?? []) {
      expect(['node-1', 'node-2']).toContain(placement.id)
    }
    // measured nodes carry BOTH: semantic id + display title
    const measured = new Map((result.measured ?? []).map((node) => [node.id, node]))
    expect(measured.get('node-1')?.title).toBe('完全不同的标题')
    expect(measured.get('node-2')?.title).toBe('另一个标题')
  })
})
