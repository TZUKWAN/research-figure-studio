import { describe, expect, it } from 'vitest'
import {
  CRITIC_WEIGHTS,
  criticVerdict,
  type CriticScores,
} from '../src/critic/metric-critic.js'
import { auditScientific } from '../src/critic/scientific-critic.js'
import {
  compositionSignature,
  priorById,
  priorFitScore,
} from '../src/composition/priors.js'
import { candidateFromPrior, type FigureEdgesInput } from '../src/composition/candidate.js'
import { estimatorMeasurer, measureNode, type MeasuredNode } from '../src/measurement/measure.js'

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

function measure(titles: string[]): MeasuredNode[] {
  const measurer = estimatorMeasurer()
  return titles.map((title) => measureNode({ title }, SPEC, measurer))
}

describe('P0 critic architecture', () => {
  it('soft rubric weights sum to exactly 1.0', () => {
    const sum = Object.values(CRITIC_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  it('every weighted metric is computed (no constant placeholders)', () => {
    // two different layouts must produce different rubric values somewhere
    const a = criticVerdict({
      solve: {
        placements: [
          { id: 'A', x: 80, y: 300, w: 200, h: 80 },
          { id: 'B', x: 500, y: 300, w: 220, h: 80 },
        ],
        issues: [],
        intentDriftPx: 4,
      },
      edges: [{ from: 'A', to: 'B', role: 'main', relation: 'process' }],
      canvasW: 1280,
      canvasH: 720,
      importance: new Map([
        ['A', 0.4],
        ['B', 0.9],
      ]),
    })
    const b = criticVerdict({
      solve: {
        placements: [
          { id: 'A', x: 80, y: 80, w: 400, h: 90 },
          { id: 'B', x: 700, y: 500, w: 120, h: 50 },
        ],
        issues: [],
        intentDriftPx: 4,
      },
      edges: [{ from: 'A', to: 'B', role: 'main', relation: 'process' }],
      canvasW: 1280,
      canvasH: 720,
      importance: new Map([
        ['A', 0.4],
        ['B', 0.9],
      ]),
    })
    const differs = (Object.keys(CRITIC_WEIGHTS) as Array<keyof CriticScores>).some(
      (key) => a.scores[key] !== b.scores[key],
    )
    expect(differs).toBe(true)
    expect((a.scores as unknown as Record<string, unknown>).visualEconomy).toBeUndefined()
  })

  it('equal-size averaging with real importance spread depresses visualRestraint', () => {
    const placements = Array.from({ length: 4 }, (_, i) => ({
      id: `n${i}`,
      x: 100 + i * 260,
      y: 300,
      w: 200,
      h: 80,
    }))
    const importance = new Map([
      ['n0', 0.2],
      ['n1', 0.5],
      ['n2', 0.5],
      ['n3', 0.95],
    ])
    const verdict = criticVerdict({
      solve: { placements, issues: [], intentDriftPx: 4 },
      edges: [],
      canvasW: 1280,
      canvasH: 720,
      importance,
    })
    expect(verdict.scores.visualRestraint).toBeLessThan(8)
  })

  it('hard gate: unroutable declared connector blocks delivery as ROUTE_FIX', () => {
    const verdict = criticVerdict({
      solve: {
        placements: [
          { id: 'A', x: 100, y: 100, w: 160, h: 80 },
          { id: 'B', x: 600, y: 100, w: 160, h: 80 },
        ],
        issues: [],
        intentDriftPx: 2,
      },
      edges: [{ from: 'A', to: 'B', role: 'main', relation: 'causal' }],
      canvasW: 1280,
      canvasH: 720,
      importance: new Map(),
      routed: [
        {
          key: 'edge:A->B:causal:0',
          fromId: 'A',
          toId: 'B',
          role: 'main',
          relation: 'causal',
          status: 'unroutable',
          laneOffsetPx: 0,
          diagnostic: 'no legal orthogonal route',
        },
      ],
    })
    expect(verdict.hardPass).toBe(false)
    expect(verdict.verdict).toBe('ROUTE_FIX')
    expect(verdict.scores.scientificFidelity).toBe(0)
  })
})

describe('P0 scientific critic', () => {
  const plan = {
    thesis: 'x',
    figureType: 'mechanism',
    narrative: {
      expressionMode: 'mechanism' as const,
      complexity: 'compact' as const,
      centralMessage: 'x',
      mustShow: ['a', 'ghost'],
      mayMerge: [],
      omitFromCanvas: [],
    },
    nodes: [
      { id: 'a', visible: { title: 'A' } },
      { id: 'b', visible: { title: 'B' } },
      { id: 'ghost', visible: { title: 'Ghost' } },
    ],
    edges: [
      {
        id: 'e1',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'causal',
        presentation: 'arrow',
      },
    ],
    groups: [],
    globalIntent: { emphasis: [], secondary: [], optional: [] },
  } as unknown as Parameters<typeof auditScientific>[0]['plan']

  it('flags missing mustShow evidence as a hard SEMANTIC_REPLAN', () => {
    const issues = auditScientific({
      plan,
      placements: [
        { id: 'a', x: 100, y: 300, w: 160, h: 60 },
        { id: 'b', x: 600, y: 300, w: 160, h: 60 },
      ],
      routes: [
        {
          key: 'e1',
          fromId: 'a',
          toId: 'b',
          role: 'main',
          relation: 'causal',
          status: 'routed',
          laneOffsetPx: 0,
          kind: 'straight',
          start: { side: 'right', idx: 3 },
          end: { side: 'left', idx: 1 },
        },
      ],
    })
    const hard = issues.filter((issue) => issue.severity === 'hard')
    expect(hard).toHaveLength(1)
    expect(hard[0]?.repairClass).toBe('SEMANTIC_REPLAN')
    expect(hard[0]?.affectedIds).toContain('ghost')
  })

  it('flags unrealized declared connectors as a hard ROUTE_FIX', () => {
    const issues = auditScientific({
      plan,
      placements: [
        { id: 'a', x: 100, y: 300, w: 160, h: 60 },
        { id: 'b', x: 600, y: 300, w: 160, h: 60 },
      ],
      routes: [
        {
          key: 'e1',
          fromId: 'a',
          toId: 'b',
          role: 'main',
          relation: 'causal',
          status: 'unroutable',
          laneOffsetPx: 0,
        },
      ],
    })
    expect(issues.some((issue) => issue.repairClass === 'ROUTE_FIX' && issue.severity === 'hard')).toBe(
      true,
    )
  })

  it('directional relations reading backwards raise a composition redesign', () => {
    const issues = auditScientific({
      plan,
      placements: [
        { id: 'a', x: 900, y: 300, w: 160, h: 60 },
        { id: 'b', x: 100, y: 300, w: 160, h: 60 },
      ],
    })
    expect(
      issues.some((issue) => issue.repairClass === 'COMPOSITION_REDESIGN'),
    ).toBe(true)
  })
})

describe('P0 composition diversity', () => {
  const ids = ['hub', 's1', 's2', 's3', 's4', 's5', 'out']
  const measured = measure(ids)
  const edges: FigureEdgesInput[] = [
    { from: 's1', to: 'hub', role: 'main', relation: 'causal' },
    { from: 's2', to: 'hub', role: 'main', relation: 'causal' },
    { from: 's3', to: 'hub', role: 'main', relation: 'data-flow' },
    { from: 's4', to: 'hub', role: 'main', relation: 'association' },
    { from: 'hub', to: 's5', role: 'main', relation: 'process' },
    { from: 's5', to: 'out', role: 'main', relation: 'process' },
  ]
  const meta = new Map(
    ids.map((id) => [id, { importance: id === 'hub' ? 0.95 : 0.45 }]),
  )

  function fingerprint(candidate: ReturnType<typeof candidateFromPrior>): number[] {
    // 4x4 quadrant occupancy + normalized radial distance histogram (8 bins)
    const quad = [0, 0, 0, 0]
    const radial = [0, 0, 0, 0, 0, 0, 0, 0]
    for (const p of candidate.plan.placements) {
      const cx = p.boxHint.x + p.boxHint.w / 2
      const cy = p.boxHint.y + p.boxHint.h / 2
      quad[(cx < 0.5 ? 0 : 1) + (cy < 0.5 ? 0 : 2)]!++
      radial[Math.min(7, Math.floor(Math.hypot(cx - 0.5, cy - 0.45) * 10))]!++
    }
    return [...quad, ...radial]
  }

  it('core-periphery and linear-process produce genuinely different topologies', () => {
    const radialPrior = priorById('core-periphery')!
    const linearPrior = priorById('linear-process')!
    const radial = candidateFromPrior(radialPrior, measured, edges, 1280, 720, meta)
    const linear = candidateFromPrior(linearPrior, measured, edges, 1280, 720, meta)
    const fpRadial = fingerprint(radial)
    const fpLinear = fingerprint(linear)
    const l1 = fpRadial.reduce((sum, v, i) => sum + Math.abs(v - fpLinear[i]!), 0)
    expect(l1).toBeGreaterThanOrEqual(4)
  })

  it('signature-based fit picks the radial prior for a hub graph', () => {
    const signature = compositionSignature({
      nodeCount: ids.length,
      edgeCount: edges.length,
      relations: new Set(['causal', 'data-flow', 'process', 'association']),
      roles: new Set(['core', 'input', 'output']),
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
      importances: ids.map((id) => (id === 'hub' ? 0.95 : 0.45)),
    })
    const scored = ['core-periphery', 'linear-process', 'layered-architecture'].map((id) => ({
      id,
      fit: priorFitScore(priorById(id)!, {
        roles: new Set(['core', 'input', 'output']),
        relations: signature.relations,
        signature,
      }),
    }))
    const radial = scored.find((entry) => entry.id === 'core-periphery')!
    expect(radial.fit).toBeGreaterThanOrEqual(3)
    expect(radial.fit).toBeGreaterThan(scored.find((entry) => entry.id === 'linear-process')!.fit)
  })
})
