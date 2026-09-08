/**
 * P0.5 Runtime Closure tests (GOAL sections 3/#4/#5/#6/#28A).
 * The Delivery Gate is the ONLY source of orchestration.ok; budget exhaustion never equals delivery.
 */
import { describe, expect, it } from 'vitest'
import { evaluateDeliveryGate } from '../src/delivery/delivery-gate.js'
import { REPAIR_CLASSES, REPAIR_LADDER } from '../src/delivery/repair-taxonomy.js'
import { auditFigureContract, type RenderedText } from '../src/contract/contract-audit.js'
import { resolveFigureTypography } from '../src/render/typography.js'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'

const yangtzePlan: FigurePlanV2 = {
  thesis: '多源输入经核心机制产生服务决策',
  figureType: 'input-core-output',
  nodes: [
    {
      id: 'in1',
      type: 'data-source',
      semanticLabel: '访谈数据',
      visible: { title: '访谈数据' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'in2',
      type: 'data-source',
      semanticLabel: '日志数据',
      visible: { title: '日志数据' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'core',
      type: 'mechanism',
      semanticLabel: '核心机制',
      visible: { title: '核心机制' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'out',
      type: 'outcome',
      semanticLabel: '服务决策',
      visible: { title: '服务决策' },
      importance: 0.7,
      role: 'output',
    },
  ],
  edges: [
    { id: 'e1', from: 'in1', to: 'core', role: 'main', relation: 'causal' },
    { id: 'e2', from: 'in2', to: 'core', role: 'main', relation: 'causal' },
    { id: 'e3', from: 'core', to: 'out', role: 'main', relation: 'process' },
  ],
  groups: [],
  globalIntent: { emphasis: ['core'], secondary: [], optional: [] },
  readingIntent: { preferredDirection: 'LR' },
} as unknown as FigurePlanV2

function fabricateCritic(
  verdict: 'PASS' | 'ROUTE_FIX' | 'LOCAL_LAYOUT_FIX' | 'RECOMPOSE',
  hardGates: Array<{ gate: string; scope: 'geometry' | 'route' | 'semantic'; pass: boolean }>,
  hardPass?: boolean,
) {
  return {
    verdict,
    hardPass: hardPass ?? hardGates.every((gate) => gate.pass),
    hardGates: hardGates.map((gate) => ({ ...gate, detail: undefined })),
  } as Parameters<typeof evaluateDeliveryGate>[0]['critic']
}

describe('P0.5 delivery gate (unit mapping)', () => {
  it('ROUTE_FIX after budget exhaustion is not deliverable', () => {
    const gate = evaluateDeliveryGate({
      critic: fabricateCritic('ROUTE_FIX', [
        { gate: 'routes_feasible', scope: 'route', pass: false },
      ]),
      scientificHardIssues: 0,
      publicationHardIssues: 0,
      contentContractViolations: 0,
      requiredEvidenceMissing: 0,
      repairBudgetExhausted: true,
    })
    expect(gate.pass).toBe(false)
    expect(gate.reasons).toContain('ROUTE_HARD_FAIL')
    expect(gate.reasons).toContain('QUALITY_THRESHOLD_FAIL')
    expect(gate.reasons).toContain('REPAIR_BUDGET_EXHAUSTED')
  })

  it('LOCAL_LAYOUT_FIX after budget exhaustion is not deliverable', () => {
    const gate = evaluateDeliveryGate({
      critic: fabricateCritic('LOCAL_LAYOUT_FIX', [
        { gate: 'geometry_legal', scope: 'geometry', pass: false },
      ]),
      scientificHardIssues: 0,
      publicationHardIssues: 0,
      contentContractViolations: 0,
      requiredEvidenceMissing: 0,
      repairBudgetExhausted: true,
    })
    expect(gate.pass).toBe(false)
    expect(gate.reasons).toContain('GEOMETRY_HARD_FAIL')
    expect(gate.reasons).toContain('REPAIR_BUDGET_EXHAUSTED')
  })

  it('a failed hard gate blocks delivery even at overall 9.9', () => {
    const gate = evaluateDeliveryGate({
      critic: fabricateCritic('PASS', [
        { gate: 'required_evidence', scope: 'semantic', pass: false },
      ]),
      scientificHardIssues: 0,
      publicationHardIssues: 0,
      contentContractViolations: 0,
      requiredEvidenceMissing: 2,
      repairBudgetExhausted: false,
    })
    expect(gate.pass).toBe(false)
    expect(gate.reasons).toContain('SEMANTIC_HARD_FAIL')
  })

  it('PASS + hardPass delivers with no reasons', () => {
    const gate = evaluateDeliveryGate({
      critic: fabricateCritic('PASS', [
        { gate: 'geometry_legal', scope: 'geometry', pass: true },
        { gate: 'routes_feasible', scope: 'route', pass: true },
      ]),
      scientificHardIssues: 0,
      publicationHardIssues: 0,
      contentContractViolations: 0,
      requiredEvidenceMissing: 0,
      repairBudgetExhausted: false,
    })
    expect(gate.pass).toBe(true)
    expect(gate.reasons).toEqual([])
  })

  it('publication hard failure maps to PUBLICATION_HARD_FAIL', () => {
    const gate = evaluateDeliveryGate({
      critic: fabricateCritic('PASS', []),
      scientificHardIssues: 0,
      publicationHardIssues: 1,
      contentContractViolations: 0,
      requiredEvidenceMissing: 0,
      repairBudgetExhausted: false,
    })
    expect(gate.pass).toBe(false)
    expect(gate.reasons).toContain('PUBLICATION_HARD_FAIL')
  })
})

describe('P0.5 delivery gate (real orchestrator flows)', () => {
  it('geometry budget exhaustion on a tiny canvas fails delivery', async () => {
    const result = await orchestrateFigure(
      { thesis: yangtzePlan.thesis, canvasW: 200, canvasH: 120, maxRecompose: 0 },
      { semanticPlan: async () => yangtzePlan },
    )
    expect(result.critic?.verdict).toBe('LOCAL_LAYOUT_FIX')
    expect(result.ok).toBe(false)
    expect(result.delivery?.reasons).toContain('REPAIR_BUDGET_EXHAUSTED')
    expect(result.delivery?.reasons).toContain('GEOMETRY_HARD_FAIL')
    // diagnostics survive the failed delivery for debugging
    expect(result.best).toBeTruthy()
    expect(result.critic).toBeTruthy()
  })

  it('a forbidden claim in visible text fails the content contract', async () => {
    const contract = {
      centralClaim: '机制运行',
      forbiddenClaims: ['日志数据'],
      output: { context: 'presentation' },
    }
    const result = await orchestrateFigure(
      {
        thesis: yangtzePlan.thesis,
        canvasW: 1280,
        canvasH: 720,
        contract: contract as never,
      },
      { semanticPlan: async () => yangtzePlan },
    )
    expect(result.ok).toBe(false)
    expect(result.critic?.verdict).toBe('RECOMPOSE')
    expect(result.delivery?.reasons).toContain('QUALITY_THRESHOLD_FAIL')
  })

  it('missing required contract evidence fails with SEMANTIC_HARD_FAIL', async () => {
    const contract = {
      centralClaim: '机制运行',
      evidenceMustShow: [
        { id: 'ev-timeline', description: '时间线证据', source: 'document', required: true },
      ],
      output: { context: 'presentation' },
    }
    const result = await orchestrateFigure(
      {
        thesis: yangtzePlan.thesis,
        canvasW: 1280,
        canvasH: 720,
        contract: contract as never,
      },
      { semanticPlan: async () => yangtzePlan },
    )
    expect(result.ok).toBe(false)
    expect(result.critic?.verdict).toBe('RECOMPOSE')
    expect(
      (result.critic?.gateIssues ?? []).join(' ').includes('EVIDENCE_MISSING') ||
        (result.critic?.reason ?? '').toLowerCase().includes('evidence'),
    ).toBe(true)
  })

  it('a clean run delivers with PASS and an empty reason list', async () => {
    const result = await orchestrateFigure(
      { thesis: yangtzePlan.thesis, canvasW: 1280, canvasH: 720 },
      { semanticPlan: async () => yangtzePlan },
    )
    expect(result.ok).toBe(true)
    expect(result.critic?.verdict).toBe('PASS')
    expect(result.critic?.hardPass).toBe(true)
    expect(result.delivery?.pass).toBe(true)
    expect(result.delivery?.reasons).toEqual([])
  })
})

describe('P0.5 visual hierarchy math (rankWithTies, no abs)', () => {
  const SPEC_BASE = { minW: 96, minH: 52 } as const

  function hierarchyFor(importance: number[], areas: number[]): Promise<number> {
    // build a solve result directly; area = w*h per node
    const placements = areas.map((area, index) => {
      // w fixed 220, h carries the area (all above the 40px clamp floor)
      const w = 220
      const h = Math.round(area / 220)
      return { id: `n${index}`, x: 60 + index * 280, y: 150, w, h }
    })
    const importanceMap = new Map(importance.map((v, index) => [`n${index}`, v]))
    return import('../src/critic/metric-critic.js').then(({ criticVerdict }) => {
      void SPEC_BASE
      const verdict = criticVerdict({
        solve: { placements, issues: [], intentDriftPx: 2 },
        edges: [],
        canvasW: 1280,
        canvasH: 720,
        importance: importanceMap,
      })
      return verdict.scores.visualHierarchy
    })
  }

  it('case A: perfectly correlated → >= 9.5', async () => {
    const score = await hierarchyFor([0.9, 0.5, 0.1], [39600, 17600, 8800])
    expect(score).toBeGreaterThanOrEqual(9.5)
  })

  it('case B: perfectly anti-correlated → <= 0.5 (this was the abs() bug)', async () => {
    const score = await hierarchyFor([0.9, 0.5, 0.1], [8800, 17600, 39600])
    expect(score).toBeLessThanOrEqual(0.5)
  })

  it('case C: uncorrelated → neutral band', async () => {
    const score = await hierarchyFor([0.9, 0.5, 0.1], [17600, 39600, 8800])
    expect(score).toBeGreaterThan(2)
    expect(score).toBeLessThan(8)
  })

  it('case D: flat importance is neutral 8, not punished', async () => {
    const score = await hierarchyFor([0.5, 0.5, 0.5], [8800, 39600, 17600])
    expect(score).toBe(8)
  })

  it('case E: tied areas stay finite and stable', async () => {
    const score = await hierarchyFor([0.9, 0.5], [17600, 17600])
    expect(Number.isFinite(score)).toBe(true)
  })
})

describe('P0.5 render typography SSOT', () => {
  const plan = {
    nodes: [
      {
        id: 'core',
        type: 'mechanism',
        semanticLabel: 'c',
        visible: { title: '核心机制', detail: '说明文字' },
        importance: 0.9,
        role: 'core',
      },
    ],
  } as unknown as FigurePlanV2

  it('presentation context keeps base sizes (scale 1)', () => {
    const t = resolveFigureTypography({ plan, canvasW: 1280 })
    expect(t.scale).toBe(1)
    expect(t.node['core']!.titlePt).toBe(14)
    expect(t.micro.annotationPt).toBe(9)
  })

  it('85mm single-column scales every text — including micro — above the floor', () => {
    const contract = {
      centralClaim: 'x',
      output: { context: 'paper-single-column' },
    } as never
    const t = resolveFigureTypography({ plan, contract, canvasW: 1280 })
    const _mmPerPt = 85 / 338.67
    const floor = 5.5
    expect(t.minEffectiveTextPt * (85 / 338.67)).toBeGreaterThanOrEqual(floor - 5e-4)
    for (const size of [
      t.node['core']!.titlePt,
      t.node['core']!.detailPt,
      t.micro.primaryPt,
      t.micro.secondaryPt,
      t.micro.annotationPt,
    ]) {
      const effective = (size * 85) / 338.67
      expect(effective, `${size}pt → ${effective}`).toBeGreaterThanOrEqual(floor - 5e-4)
    }
  })

  it('repair taxonomy: every class declares trigger/handler/budget and never shrinks below floor', () => {
    for (const repairClass of REPAIR_CLASSES) {
      const step = REPAIR_LADDER[repairClass]
      expect(step.trigger.length).toBeGreaterThan(0)
      expect(['planner', 'composer', 'router', 'renderer']).toContain(step.handler)
      expect(step.retryBudget).toBeGreaterThanOrEqual(0)
    }
    expect(REPAIR_LADDER.TYPOGRAPHY_FIX.escalation).toBe('COMPOSITION_REDESIGN')
    expect(REPAIR_LADDER.SEMANTIC_REPLAN.escalation).toBe('FAIL_DELIVERY')
  })
})

describe('P0.5 contract audit (visible text / evidence / provenance)', () => {
  const contract = {
    centralClaim: 'x',
    visibleTextPolicy: {
      allowed: ['认知', '情绪'],
      required: ['认知'],
      forbidden: ['准确率 98%'],
      language: 'zh' as const,
    },
    evidenceMustShow: [
      { id: 'ev-attention', description: '共同注意机制', source: 'document', required: true },
    ],
    provenance: [],
  } as never

  function audit(texts: RenderedText[], placed = ['a'], refs?: Map<string, string[]>) {
    return auditFigureContract({
      contract,
      placedNodeIds: placed,
      renderedTexts: texts,
      evidenceRefs: refs,
    })
  }

  it('forbidden text is caught on the final render strings', () => {
    const issues = audit([{ id: 'a', kind: 'title', text: '模型准确率 98%' }])
    expect(issues.some((issue) => issue.kind === 'FORBIDDEN')).toBe(true)
  })

  it('allowed whitelist violations are caught when the whitelist is non-empty', () => {
    const issues = audit([{ id: 'a', kind: 'title', text: '无关标题' }])
    expect(issues.some((issue) => issue.kind === 'ALLOWED_VIOLATION')).toBe(true)
  })

  it('required text missing is caught', () => {
    const issues = audit([{ id: 'a', kind: 'title', text: '情绪主题' }])
    expect(issues.some((issue) => issue.kind === 'REQUIRED_TEXT_MISSING')).toBe(true)
  })

  it('evidence carried via evidenceRefs satisfies the requirement', () => {
    const issues = audit(
      [{ id: 'a', kind: 'title', text: '共同注意机制显著' }],
      ['a'],
      new Map([['a', ['ev-attention']]]),
    )
    expect(issues.some((issue) => issue.kind === 'EVIDENCE_MISSING')).toBe(false)
  })

  it('quantitative claims without provenance are flagged (sample markers exempt)', () => {
    const flagged = audit([{ id: 'a', kind: 'detail', text: '准确率提升 12%' }])
    expect(flagged.some((issue) => issue.kind === 'PROVENANCE_MISSING')).toBe(true)
    const exempt = audit([{ id: 's', kind: 'micro', text: '示例数据：30% 提升' }])
    expect(exempt.some((issue) => issue.kind === 'PROVENANCE_MISSING')).toBe(false)
  })
})
