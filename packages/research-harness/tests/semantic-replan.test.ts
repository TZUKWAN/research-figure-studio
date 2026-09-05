/**
 * ORCH-P0-01/02/03/04 — real semantic replan, schema repair loop, derived
 * state consistency, and per-candidate visualPlan ownership.
 */
import { describe, expect, it } from 'vitest'
import { orchestrateFigure } from '../src/orchestrator/create-figure.js'
import { compileSemanticAttempt, planSemanticFigure } from '../src/orchestrator/semantic-attempt.js'
import { SEMANTIC_NODE_STYLES } from '../src/components/semantic-styles.js'
import { resolveDomain } from '../src/contract/domain-profile.js'
import type { FigurePlanV2 } from '../src/semantic/figure-plan.js'

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

/** 5-node sparse plan: content density < 1.5 → semantic-replan decision. */
const sparsePlan = {
  thesis: '两个变量的粗糙关系',
  figureType: 'causal-model',
  nodes: [
    {
      id: 'a',
      type: 'variable',
      semanticLabel: '变量A',
      visible: { title: '变量A' },
      importance: 0.5,
      role: 'input',
    },
    {
      id: 'b',
      type: 'variable',
      semanticLabel: '变量B',
      visible: { title: '变量B' },
      importance: 0.6,
      role: 'output',
    },
    {
      id: 'c',
      type: 'process',
      semanticLabel: '过程C',
      visible: { title: '过程C' },
      importance: 0.5,
      role: 'intermediate',
    },
    {
      id: 'd',
      type: 'process',
      semanticLabel: '过程D',
      visible: { title: '过程D' },
      importance: 0.5,
      role: 'intermediate',
    },
    {
      id: 'e',
      type: 'outcome',
      semanticLabel: '结果E',
      visible: { title: '结果E' },
      importance: 0.7,
      role: 'output',
    },
  ],
  edges: [
    { from: 'a', to: 'c', role: 'main', relation: 'causal' },
    { from: 'a', to: 'd', role: 'main', relation: 'causal' },
    { from: 'b', to: 'c', role: 'main', relation: 'causal' },
    { from: 'b', to: 'd', role: 'main', relation: 'causal' },
    { from: 'c', to: 'e', role: 'main', relation: 'process' },
    { from: 'd', to: 'e', role: 'main', relation: 'process' },
  ],
  groups: [],
  globalIntent: { emphasis: [], secondary: [], optional: [] },
}

/** rich 4-node plan: composes cleanly on one pass */
const richPlan: FigurePlanV2 = {
  thesis: '多源输入经核心机制产生服务决策',
  figureType: 'input-core-output',
  narrative: {
    expressionMode: 'mechanism' as const,
    complexity: 'rich' as const,
    centralMessage: '机制',
    mustShow: [],
    mayMerge: [],
    omitFromCanvas: [],
  },
  nodes: [
    {
      id: 'in1',
      type: 'data-source',
      semanticLabel: '多源访谈数据',
      visible: { title: '访谈数据', detail: '12场半结构化访谈' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'in2',
      type: 'data-source',
      semanticLabel: '平台日志数据',
      visible: { title: '日志数据', detail: '90天行为日志' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'core',
      type: 'mechanism',
      semanticLabel: '跨文化认知机制',
      visible: { title: '认知机制', detail: '编码与饱和' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'out',
      type: 'outcome',
      semanticLabel: '服务决策',
      visible: { title: '服务决策', detail: '投放策略' },
      importance: 0.7,
      role: 'output',
    },
  ],
  edges: [
    { from: 'in1', to: 'core', role: 'main', relation: 'causal' },
    { from: 'in2', to: 'core', role: 'main', relation: 'causal' },
    { from: 'core', to: 'out', role: 'main', relation: 'process' },
  ],
  groups: [],
  globalIntent: { emphasis: ['core'], secondary: [], optional: [] },
}

describe('ORCH-P0-01: SEMANTIC_REPLAN really replaces the FigurePlan', () => {
  it('calls the planner again with critique, swaps plan and ALL derived state', async () => {
    const calls: Array<{ thesis: string; feedback?: string }> = []
    // deterministic semantic failure: plan 1 carries a forbidden claim, which
    // only a NEW plan can fix — recomposition cannot remove the text
    const violatingPlan = {
      ...structuredClone(sparsePlan),
      nodes: sparsePlan.nodes.map((node) =>
        node.id === 'b' ? { ...node, visible: { title: '量子疗愈变量B' } } : node,
      ),
    }
    const contract = {
      centralClaim: '两个变量的粗糙关系',
      figureFamily: 'freeform' as const,
      domain: 'general',
      output: { context: 'presentation' as const, aspectRatio: 16 / 9 },
      evidenceMustShow: [],
      evidenceOptional: [],
      forbiddenClaims: ['量子疗愈'],
      visibleTextPolicy: { allowed: [], language: 'mixed' as const },
      provenance: [],
      editability: 'fully-native' as const,
    }
    const result = await orchestrateFigure(
      {
        thesis: sparsePlan.thesis,
        canvasW: 1280,
        canvasH: 720,
        autonomyOverride: 'A2',
        maxRecompose: 2,
        contract,
      },
      {
        semanticPlan: async (thesis, feedback) => {
          calls.push({ thesis, feedback })
          if (calls.length === 1) return violatingPlan
          return richPlan
        },
        compose: async () => null,
      },
    )
    expect(result.ok).toBe(true)
    // the planner was called for the initial plan AND for the replan
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[1]!.feedback).toContain('rejected by scientific review')
    expect(calls[1]!.feedback).toContain('量子疗愈')
    // a REAL L6 repair was applied — not a recompose masquerading as one
    expect(result.repairs).toContain('L6 SEMANTIC_REPLAN')
    expect(result.semanticReplans).toBe(1)
    // the FINAL plan is the second plan — old nodes are gone
    expect(result.plan?.nodes.map((node) => node.id)).toEqual(['in1', 'in2', 'core', 'out'])
    expect(result.plan?.nodes.some((node) => node.id === 'a')).toBe(false)
    // derived state was rebuilt: routes reference ONLY the new plan's edges
    for (const route of result.routes ?? []) {
      expect(['in1', 'in2', 'core', 'out']).toContain(route.fromId)
      expect(['in1', 'in2', 'core', 'out']).toContain(route.toId)
    }
    // derived state was rebuilt: measured matches the NEW plan's node ids
    expect(result.measured?.map((node) => node.id).sort()).toEqual(['core', 'in1', 'in2', 'out'])
    // trace records the replan as real events
    const stages = result.trace.map((event) => event.stage)
    expect(stages).toContain('semantic.replan.started')
    expect(stages).toContain('semantic.replan.completed')
  })

  it('degrades honestly to recompose when the replan budget is spent', async () => {
    const violatingPlan = {
      ...structuredClone(sparsePlan),
      nodes: sparsePlan.nodes.map((node) =>
        node.id === 'b' ? { ...node, visible: { title: '量子疗愈变量B' } } : node,
      ),
    }
    const contract = {
      centralClaim: '两个变量的粗糙关系',
      figureFamily: 'freeform' as const,
      domain: 'general',
      output: { context: 'presentation' as const, aspectRatio: 16 / 9 },
      evidenceMustShow: [],
      evidenceOptional: [],
      forbiddenClaims: ['量子疗愈'],
      visibleTextPolicy: { allowed: [], language: 'mixed' as const },
      provenance: [],
      editability: 'fully-native' as const,
    }
    const result = await orchestrateFigure(
      {
        thesis: sparsePlan.thesis,
        canvasW: 1280,
        canvasH: 720,
        autonomyOverride: 'A2',
        maxRecompose: 1,
        maxSemanticReplans: 0,
        contract,
      },
      {
        semanticPlan: async () => violatingPlan,
        compose: async () => null,
      },
    )
    // budget 0 → L6 never fires; the ladder must not lie about it
    expect(result.semanticReplans ?? 0).toBe(0)
    expect(result.repairs ?? []).not.toContain('L6 SEMANTIC_REPLAN')
    // and the run must NOT claim success while the violating plan ships
    expect(result.ok).toBe(false)
    expect(result.critic?.verdict).toBe('RECOMPOSE')
  })
})

describe('ORCH-P0-02: semantic parse/repair loop with SPECIFIC errors', () => {
  it('repairs an invalid plan by feeding the EXACT validation errors back', async () => {
    const feedbacks: Array<string | undefined> = []
    let call = 0
    const result = await orchestrateFigure(
      { thesis: richPlan.thesis, canvasW: 1280, canvasH: 720 },
      {
        semanticPlan: async (_thesis, feedback) => {
          feedbacks.push(feedback)
          call++
          if (call === 1) {
            return {
              ...richPlan,
              edges: [{ from: 'in1', to: 'ghost-node', role: 'main', relation: 'causal' }],
            }
          }
          return richPlan
        },
      },
    )
    expect(result.ok).toBe(true)
    expect(call).toBe(2)
    // the repair feedback names the actual defect, not "schema failed"
    expect(feedbacks[1]).toContain('ghost-node')
    expect(feedbacks[1]).toContain('references missing node')
    expect(result.semanticDiagnostics?.[0]?.kind).toBe('FIGURE_PLAN_SCHEMA_ERROR')
    expect(result.semanticDiagnostics?.[0]?.errors[0]).toContain('ghost-node')
  })

  it('records parse errors and schema errors as DIFFERENT kinds', async () => {
    const parseResult = await planSemanticFigure({
      thesis: 't',
      semanticPlan: async () => {
        throw new Error('Unexpected token < in JSON at position 0')
      },
      maxSchemaRepairs: 0,
    })
    expect(parseResult.plan).toBeNull()
    expect(parseResult.failureKind).toBe('MODEL_OUTPUT_PARSE_ERROR')

    const schemaResult = await planSemanticFigure({
      thesis: 't',
      semanticPlan: async () => ({ nodes: [] }),
      maxSchemaRepairs: 0,
    })
    expect(schemaResult.plan).toBeNull()
    expect(schemaResult.failureKind).toBe('FIGURE_PLAN_SCHEMA_ERROR')
    expect(schemaResult.errors.join('; ')).toContain('nodes')
  })

  it('bounded: initial + 2 schema repairs, then a specific failure', async () => {
    let calls = 0
    const result = await planSemanticFigure({
      thesis: 't',
      semanticPlan: async (_thesis, feedback) => {
        calls++
        if (calls > 1) {
          // the repair feedback names the exact defect: unknown endpoint x9
          expect(feedback).toContain('references missing node "x9"')
        }
        return {
          thesis: 't',
          nodes: [
            {
              id: 'a',
              type: 'process',
              semanticLabel: 'A',
              visible: { title: 'A' },
              importance: 0.5,
              role: 'core',
            },
          ],
          edges: [{ from: 'a', to: 'x9', role: 'main', relation: 'causal' }],
        }
      },
    })
    expect(calls).toBe(3) // initial + 2 repairs
    expect(result.plan).toBeNull()
    expect(result.attemptsUsed).toBe(3)
    expect(result.schemaRepairsUsed).toBe(2)
    expect(result.diagnostics).toHaveLength(3)
    for (const entry of result.diagnostics) {
      expect(entry.kind).toBe('FIGURE_PLAN_SCHEMA_ERROR')
      expect(entry.errors[0]).toContain('x9')
    }
  })
})

describe('ORCH-P0-03: compileSemanticAttempt is the single compiler', () => {
  it('derives ALL collections consistently from one plan', () => {
    const domain = resolveDomain('general')
    const state = compileSemanticAttempt({
      plan: structuredClone(richPlan),
      attempt: 0,
      specFor,
      domain,
    })
    const nodeIds = new Set(state.plan.nodes.map((node) => node.id))
    expect(new Set(state.measured.map((node) => node.id))).toEqual(nodeIds)
    expect(new Set(state.importance.keys())).toEqual(nodeIds)
    expect(new Set(state.meta.keys())).toEqual(nodeIds)
    for (const [id] of state.groupIds) expect(nodeIds.has(id)).toBe(true)
    for (const edge of state.edges) {
      expect(nodeIds.has(edge.from)).toBe(true)
      expect(nodeIds.has(edge.to)).toBe(true)
    }
    // multi-edge-safe priority index: stable id AND pair array
    for (const edge of state.edges) {
      expect(state.edgePriorityById.has(edge.id!)).toBe(true)
    }
  })

  it('keeps measured node ids decoupled from visible titles (COMP-P1-12)', () => {
    const domain = resolveDomain('general')
    const state = compileSemanticAttempt({
      plan: structuredClone(richPlan),
      attempt: 0,
      specFor,
      domain,
    })
    const core = state.measured.find((node) => node.id === 'core')!
    expect(core.title).toBe('认知机制') // visible text
    expect(core.id).toBe('core') // semantic identity
  })

  it('recomputes forbidden hits per plan (no stale contract hits)', () => {
    const domain = resolveDomain('general')
    const claims = ['量子疗愈']
    const withHit = {
      ...structuredClone(richPlan),
      nodes: richPlan.nodes.map((node) =>
        node.id === 'core' ? { ...node, visible: { title: '量子疗愈机制', detail: '' } } : node,
      ),
    }
    const hitState = compileSemanticAttempt({
      plan: withHit,
      attempt: 0,
      specFor,
      domain,
      forbiddenClaims: claims,
    })
    expect(hitState.forbiddenHits).toEqual(['量子疗愈'])
    const cleanState = compileSemanticAttempt({
      plan: structuredClone(richPlan),
      attempt: 0,
      specFor,
      domain,
      forbiddenClaims: claims,
    })
    expect(cleanState.forbiddenHits).toEqual([])
  })
})

describe('ORCH-P0-04: visualPlan belongs to its own candidate', () => {
  it('a decomposition whose spatial plan is unusable ships an EMPTY visualPlan', async () => {
    const result = await orchestrateFigure(
      { thesis: richPlan.thesis, canvasW: 1280, canvasH: 720, autonomyOverride: 'A2' },
      {
        semanticPlan: async () => richPlan,
        compose: async () => ({
          // placements reference an UNKNOWN id → normalizeSpatialPlan drops
          // them all → the spatial plan is null. The decomposition authored
          // in the SAME response dies WITH it (no last-non-empty-wins).
          composition: { readingFlow: 'LR' },
          placements: [{ id: 'unknown-node', boxHint: { x: 0.2, y: 0.3, w: 0.2, h: 0.2 } }],
          visualPlan: {
            modules: [
              { moduleId: 'core', microLayout: 'chips', units: [{ id: 'u1', label: '编码' }] },
            ],
          },
        }),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.best?.source).toBe('prior')
    // the winner (prior) authored NO decomposition → result must be empty
    expect(result.visualPlan?.modules ?? []).toEqual([])
  })

  it('the winner keeps its OWN decomposition', async () => {
    const result = await orchestrateFigure(
      { thesis: richPlan.thesis, canvasW: 1280, canvasH: 720, autonomyOverride: 'A2' },
      {
        semanticPlan: async () => richPlan,
        compose: async () => ({
          composition: { readingFlow: 'LR', visualCenter: 'core' },
          placements: [
            { id: 'in1', boxHint: { x: 0.05, y: 0.2, w: 0.16, h: 0.2 }, visualRole: 'secondary' },
            { id: 'in2', boxHint: { x: 0.05, y: 0.6, w: 0.16, h: 0.2 }, visualRole: 'secondary' },
            { id: 'core', boxHint: { x: 0.42, y: 0.35, w: 0.22, h: 0.3 }, visualRole: 'dominant' },
            { id: 'out', boxHint: { x: 0.8, y: 0.35, w: 0.16, h: 0.2 }, visualRole: 'primary' },
          ],
          visualPlan: {
            modules: [
              {
                moduleId: 'core',
                microLayout: 'chips',
                units: [{ id: 'u1', label: '编码', semanticNodeId: 'core' }],
              },
            ],
          },
        }),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.best?.source).toBe('model')
    expect(result.visualPlan?.modules).toHaveLength(1)
    expect(result.visualPlan?.modules[0]?.moduleId).toBe('core')
  })
})
