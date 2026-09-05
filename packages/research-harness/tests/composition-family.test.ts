/**
 * COMP-P1-02..06 — FigureFamily strategy gating: unsupported families fail
 * loudly, required signals are enforced, and timeline/matrix/network/
 * comparison families compose with their dedicated grammars.
 */
import { describe, expect, it } from 'vitest'
import { orchestrateFigure } from '../src/orchestrator/create-figure.js'
import { generateCandidates } from '../src/composition/candidate.js'
import { estimatorMeasurer, measureNode } from '../src/measurement/measure.js'
import type { FigureFamily } from '../src/contract/figure-contract.js'

const measurer = estimatorMeasurer()
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
const measure = (ids: string[]) => ids.map((id) => measureNode({ id, title: id }, SPEC, measurer))

const baseContract = (figureFamily: FigureFamily) => ({
  centralClaim: 'c',
  figureFamily,
  domain: 'general',
  output: { context: 'presentation' as const, aspectRatio: 16 / 9 },
  evidenceMustShow: [],
  evidenceOptional: [],
  forbiddenClaims: [],
  visibleTextPolicy: { allowed: [], language: 'mixed' as const },
  provenance: [],
  editability: 'fully-native' as const,
})

const chainPlan = {
  thesis: '阶段流程',
  figureType: 'pipeline',
  nodes: [
    {
      id: 's1',
      type: 'process',
      semanticLabel: '阶段一',
      visible: { title: '阶段一' },
      importance: 0.5,
      role: 'input',
    },
    {
      id: 's2',
      type: 'process',
      semanticLabel: '阶段二',
      visible: { title: '阶段二' },
      importance: 0.6,
      role: 'intermediate',
    },
    {
      id: 's3',
      type: 'outcome',
      semanticLabel: '阶段三',
      visible: { title: '阶段三' },
      importance: 0.7,
      role: 'output',
    },
  ],
  edges: [
    { from: 's1', to: 's2', role: 'main', relation: 'process' },
    { from: 's2', to: 's3', role: 'main', relation: 'process' },
  ],
  groups: [],
  globalIntent: { emphasis: [], secondary: [], optional: [] },
}

describe('COMP-P1-02: FigureFamily strategy has real runtime force', () => {
  it('an unsupported family fails loudly instead of faking freeform', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('outreach') },
      { semanticPlan: async () => chainPlan },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('UNSUPPORTED_FIGURE_FAMILY')
    expect(result.error).toContain('outreach')
  })

  it('timeline without declared timeOrder is a MISSING-SIGNAL failure, not a silent grid', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('timeline') },
      { semanticPlan: async () => chainPlan }, // no timeOrder!
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('FIGURE_FAMILY_SIGNAL_MISSING')
    expect(result.error).toContain('timeOrder')
  })

  it('matrix without declared axes is a MISSING-SIGNAL failure', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('matrix') },
      { semanticPlan: async () => chainPlan }, // no matrix spec!
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('FIGURE_FAMILY_SIGNAL_MISSING')
    expect(result.error).toContain('matrix')
  })

  it('a supported family (pipeline) composes with its preferred grammar', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('pipeline') },
      { semanticPlan: async () => chainPlan },
    )
    expect(result.ok).toBe(true)
    // the winning prior must come from the pipeline-eligible grammar set
    const eligible = ['linear', 'parallel', 'layered']
    const winnerPrior = result.best?.priorId ? result.best.priorId : null
    expect(winnerPrior).not.toBeNull()
    const grammarOf: Record<string, string> = {
      'linear-process': 'linear',
      'multi-stage-pipeline': 'linear',
      'parallel-mechanisms': 'parallel',
      'layered-architecture': 'layered',
    }
    expect(eligible).toContain(grammarOf[winnerPrior!])
  })
})

describe('COMP-P1-03: timeline grammar follows DECLARED temporal order', () => {
  // ids are deliberately ANTI-alphabetical relative to time: alphabetical
  // order would be a-pub, b-post, c-run, d-pre — the exact reverse
  const timelineNodes = [
    {
      id: 'd-pre',
      type: 'process',
      semanticLabel: '准备',
      visible: { title: '准备' },
      importance: 0.5,
      role: 'input',
    },
    {
      id: 'c-run',
      type: 'process',
      semanticLabel: '执行',
      visible: { title: '执行' },
      importance: 0.7,
      role: 'intermediate',
    },
    {
      id: 'b-post',
      type: 'process',
      semanticLabel: '分析',
      visible: { title: '分析' },
      importance: 0.6,
      role: 'intermediate',
    },
    {
      id: 'a-pub',
      type: 'outcome',
      semanticLabel: '发表',
      visible: { title: '发表' },
      importance: 0.8,
      role: 'output',
    },
  ]
  const timelineOrder = ['d-pre', 'c-run', 'b-post', 'a-pub']

  it('column position follows timeOrder, never node id sorting', async () => {
    const { candidateFromPrior } = await import('../src/composition/candidate.js')
    const { priorById } = await import('../src/composition/priors.js')
    const edges = [
      { id: 'e0', from: 'd-pre', to: 'c-run', role: 'main' as const, relation: 'process' },
      { id: 'e1', from: 'c-run', to: 'b-post', role: 'main' as const, relation: 'process' },
      { id: 'e2', from: 'b-post', to: 'a-pub', role: 'main' as const, relation: 'process' },
    ]
    const candidate = candidateFromPrior(
      priorById('temporal-timeline')!,
      measure(['d-pre', 'c-run', 'b-post', 'a-pub']),
      edges,
      1280,
      720,
      undefined,
      0,
      { timeOrder: timelineOrder },
    )
    expect(candidate).not.toBeNull()
    const xOf = new Map(
      candidate!.plan.placements.map((p) => [p.id, p.boxHint.x + p.boxHint.w / 2]),
    )
    // declared temporal order — lexicographic order would reverse it
    expect(xOf.get('d-pre')!).toBeLessThan(xOf.get('c-run')!)
    expect(xOf.get('c-run')!).toBeLessThan(xOf.get('b-post')!)
    expect(xOf.get('b-post')!).toBeLessThan(xOf.get('a-pub')!)
  })

  it('declines when no timeOrder is declared', async () => {
    const { candidateFromPrior } = await import('../src/composition/candidate.js')
    const { priorById } = await import('../src/composition/priors.js')
    const candidate = candidateFromPrior(
      priorById('temporal-timeline')!,
      measure(['a', 'b', 'c']),
      [{ id: 'e0', from: 'a', to: 'b', role: 'main' as const, relation: 'process' }],
      1280,
      720,
    )
    expect(candidate).toBeNull()
  })

  it('family gate passes with timeOrder declared; the timeline prior is in the set', async () => {
    const timelinePlan = {
      thesis: '研究阶段',
      figureType: 'timeline',
      nodes: timelineNodes,
      edges: [
        { from: 'd-pre', to: 'c-run', role: 'main', relation: 'process' },
        { from: 'c-run', to: 'b-post', role: 'main', relation: 'process' },
        { from: 'b-post', to: 'a-pub', role: 'main', relation: 'process' },
      ],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
      timeOrder: timelineOrder,
    }
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('timeline') },
      { semanticPlan: async () => timelinePlan },
    )
    expect(result.ok).toBe(true)
    expect(result.candidates?.some((candidate) => candidate.priorId === 'temporal-timeline')).toBe(
      true,
    )
  })
})

describe('COMP-P1-04: matrix grammar aligns declared rows and columns', () => {
  const matrixPlan = {
    thesis: '条件×处理效应矩阵',
    figureType: 'matrix',
    nodes: [
      {
        id: 'r1c1',
        type: 'evidence',
        semanticLabel: '低条件A',
        visible: { title: '低×A' },
        importance: 0.5,
        role: 'support',
        groupId: 'row-low',
      },
      {
        id: 'r1c2',
        type: 'evidence',
        semanticLabel: '低条件B',
        visible: { title: '低×B' },
        importance: 0.5,
        role: 'support',
        groupId: 'row-low',
      },
      {
        id: 'r2c1',
        type: 'evidence',
        semanticLabel: '高条件A',
        visible: { title: '高×A' },
        importance: 0.6,
        role: 'support',
        groupId: 'row-high',
      },
      {
        id: 'r2c2',
        type: 'evidence',
        semanticLabel: '高条件B',
        visible: { title: '高×B' },
        importance: 0.7,
        role: 'support',
        groupId: 'row-high',
      },
    ],
    edges: [],
    groups: [
      { id: 'row-low', label: '低', memberIds: ['r1c1', 'r1c2'] },
      { id: 'row-high', label: '高', memberIds: ['r2c1', 'r2c2'] },
      { id: 'col-a', label: '处理A', memberIds: ['r1c1', 'r2c1'] },
      { id: 'col-b', label: '处理B', memberIds: ['r1c2', 'r2c2'] },
    ],
    globalIntent: { emphasis: [], secondary: [], optional: [] },
    matrix: {
      rowGroupIds: ['row-low', 'row-high'],
      columnGroupIds: ['col-a', 'col-b'],
      cellRelation: 'effect size',
    },
  }

  it('cells align to both axes (rows share y, columns share x)', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('matrix') },
      { semanticPlan: async () => matrixPlan },
    )
    expect(result.ok).toBe(true)
    expect(result.best?.priorId).toBe('matrix-grid')
    const place = new Map(
      (result.best?.plan.placements ?? []).map((p) => [
        p.id,
        { x: p.boxHint.x + p.boxHint.w / 2, y: p.boxHint.y + p.boxHint.h / 2 },
      ]),
    )
    // row alignment
    expect(Math.abs(place.get('r1c1')!.y - place.get('r1c2')!.y)).toBeLessThan(0.02)
    expect(Math.abs(place.get('r2c1')!.y - place.get('r2c2')!.y)).toBeLessThan(0.02)
    // column alignment
    expect(Math.abs(place.get('r1c1')!.x - place.get('r2c1')!.x)).toBeLessThan(0.02)
    expect(Math.abs(place.get('r1c2')!.x - place.get('r2c2')!.x)).toBeLessThan(0.02)
    // rows and columns genuinely differ
    expect(place.get('r1c1')!.y).not.toBeCloseTo(place.get('r2c1')!.y, 1)
  })
})

describe('COMP-P1-05: network layout is deterministic and topology-driven', () => {
  const networkEdges = [
    { id: 'e0', from: 'hub1', to: 'p1', role: 'main' as const, relation: 'association' },
    { id: 'e1', from: 'hub1', to: 'p2', role: 'main' as const, relation: 'association' },
    { id: 'e2', from: 'hub1', to: 'p3', role: 'main' as const, relation: 'association' },
    { id: 'e3', from: 'hub1', to: 'p4', role: 'main' as const, relation: 'association' },
  ]

  it('network grammar: the degree hub owns the center, deterministically', async () => {
    const { candidateFromPrior } = await import('../src/composition/candidate.js')
    const { priorById } = await import('../src/composition/priors.js')
    const prior = priorById('network-graph')!
    const ids = ['hub1', 'p1', 'p2', 'p3', 'p4']
    const meta = new Map(ids.map((id) => [id, { importance: id === 'hub1' ? 0.9 : 0.4 }]))
    const run = () => candidateFromPrior(prior, measure(ids), networkEdges, 1280, 720, meta, 0, {})
    const c1 = run()
    const c2 = run()
    expect(c1).not.toBeNull()
    // deterministic: same input → identical geometry (no force simulation)
    expect(c1!.plan).toEqual(c2!.plan)
    const place = new Map(
      c1!.plan.placements.map((p) => [
        p.id,
        { x: p.boxHint.x + p.boxHint.w / 2, y: p.boxHint.y + p.boxHint.h / 2 },
      ]),
    )
    const radial = (id: string) => Math.hypot(place.get(id)!.x - 0.5, place.get(id)!.y - 0.45)
    expect(radial('hub1')).toBeLessThan(0.02) // the hub IS the center
    for (const satellite of ['p1', 'p2', 'p3', 'p4']) {
      expect(radial(satellite)).toBeGreaterThan(radial('hub1'))
    }
  })

  it('network family composes end-to-end and repeats exactly', async () => {
    const networkPlan = {
      thesis: '合作网络',
      figureType: 'network',
      nodes: [
        {
          id: 'hub1',
          type: 'actor',
          semanticLabel: '核心机构',
          visible: { title: '核心机构' },
          importance: 0.9,
          role: 'core',
        },
        {
          id: 'p1',
          type: 'actor',
          semanticLabel: '成员一',
          visible: { title: '成员一' },
          importance: 0.4,
          role: 'support',
        },
        {
          id: 'p2',
          type: 'actor',
          semanticLabel: '成员二',
          visible: { title: '成员二' },
          importance: 0.4,
          role: 'support',
        },
        {
          id: 'p3',
          type: 'actor',
          semanticLabel: '成员三',
          visible: { title: '成员三' },
          importance: 0.4,
          role: 'support',
        },
        {
          id: 'p4',
          type: 'actor',
          semanticLabel: '成员四',
          visible: { title: '成员四' },
          importance: 0.4,
          role: 'support',
        },
      ],
      edges: networkEdges.map(({ from, to, relation }) => ({ from, to, role: 'main', relation })),
      groups: [],
      globalIntent: { emphasis: ['hub1'], secondary: [], optional: [] },
    }
    const run = () =>
      orchestrateFigure(
        { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('network') },
        { semanticPlan: async () => networkPlan },
      )
    const r1 = await run()
    const r2 = await run()
    expect(r1.ok).toBe(true)
    // deterministic: identical runs produce identical geometry
    expect(r1.best?.plan).toEqual(r2.best?.plan)
    expect(r1.candidates?.some((candidate) => candidate.priorId === 'network-graph')).toBe(true)
  })
})

describe('COMP-P1-06: comparison mirrors two regions with aligned anchors', () => {
  const comparisonPlan = {
    thesis: '东西部方案对比',
    figureType: 'comparison',
    nodes: [
      {
        id: 'ea',
        type: 'method',
        semanticLabel: '东部要素一',
        visible: { title: '东部一' },
        importance: 0.6,
        role: 'support',
        groupId: 'east',
      },
      {
        id: 'eb',
        type: 'method',
        semanticLabel: '东部要素二',
        visible: { title: '东部二' },
        importance: 0.6,
        role: 'support',
        groupId: 'east',
      },
      {
        id: 'wa',
        type: 'method',
        semanticLabel: '西部要素一',
        visible: { title: '西部一' },
        importance: 0.6,
        role: 'support',
        groupId: 'west',
      },
      {
        id: 'wb',
        type: 'method',
        semanticLabel: '西部要素二',
        visible: { title: '西部二' },
        importance: 0.6,
        role: 'support',
        groupId: 'west',
      },
      {
        id: 'shared',
        type: 'context',
        semanticLabel: '共同目标',
        visible: { title: '共同目标' },
        importance: 0.8,
        role: 'core',
      },
    ],
    edges: [
      { from: 'ea', to: 'shared', role: 'main', relation: 'association' },
      { from: 'wa', to: 'shared', role: 'main', relation: 'association' },
    ],
    groups: [
      { id: 'east', label: '东部', memberIds: ['ea', 'eb'] },
      { id: 'west', label: '西部', memberIds: ['wa', 'wb'] },
    ],
    globalIntent: { emphasis: ['shared'], secondary: [], optional: [] },
  }

  it('row i of side A aligns with row i of side B; shared nodes on the seam', async () => {
    const result = await orchestrateFigure(
      { thesis: 'x', canvasW: 1280, canvasH: 720, contract: baseContract('comparison') },
      { semanticPlan: async () => comparisonPlan },
    )
    expect(result.ok).toBe(true)
    expect(result.best?.priorId).toBe('comparison-mirror')
    const place = new Map(
      (result.best?.plan.placements ?? []).map((p) => [
        p.id,
        { x: p.boxHint.x + p.boxHint.w / 2, y: p.boxHint.y + p.boxHint.h / 2 },
      ]),
    )
    // mirrored columns
    expect(place.get('ea')!.x).toBeLessThan(0.45)
    expect(place.get('wa')!.x).toBeGreaterThan(0.55)
    // aligned rows: east row 1 shares y with west row 1
    expect(Math.abs(place.get('ea')!.y - place.get('wa')!.y)).toBeLessThan(0.02)
    expect(Math.abs(place.get('eb')!.y - place.get('wb')!.y)).toBeLessThan(0.02)
    // shared anchor on the center seam
    expect(Math.abs(place.get('shared')!.x - 0.5)).toBeLessThan(0.2)
  })
})

describe('family gating inside generateCandidates', () => {
  it('forbidden grammars never appear in the candidate set', () => {
    const ids = ['a', 'b', 'c', 'd']
    const edges = [
      { id: 'e0', from: 'a', to: 'b', role: 'main' as const, relation: 'causal' },
      { id: 'e1', from: 'b', to: 'c', role: 'main' as const, relation: 'process' },
      { id: 'e2', from: 'c', to: 'd', role: 'main' as const, relation: 'process' },
    ]
    const candidates = generateCandidates(
      'A0',
      measure(ids),
      edges,
      { roles: new Set(['input', 'output']), relations: new Set(['causal', 'process']) },
      1280,
      720,
      null,
      undefined,
      { family: 'timeline', timeOrder: ['a', 'b', 'c', 'd'] },
    )
    // timeline family: radial/matrix are forbidden; only timeline/linear eligible
    const allowed = ['temporal-timeline', 'linear-process', 'multi-stage-pipeline']
    for (const candidate of candidates) {
      expect(allowed).toContain(candidate.priorId)
    }
    expect(candidates.some((candidate) => candidate.priorId === 'temporal-timeline')).toBe(true)
  })
})
