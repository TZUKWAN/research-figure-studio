import { describe, expect, it } from 'vitest'
import {
  auditScientific,
  contradictionIssues,
  cycleIssues,
  orphanIssues,
  duplicateTitleIssues,
  combinedDominanceRank,
  type ScientificIssue,
} from '../src/critic/scientific-critic.js'
import { validateDomain, validateFamily } from '../src/critic/family-validators.js'
import type { FigurePlanV2 } from '../src/semantic/figure-plan.js'
import type { SemanticEdge } from '../src/semantic/schema.js'
import type { RoutedEdge } from '../src/routing/router.js'

const rect = (id: string, x: number, y: number) => ({ id, x, y, w: 160, h: 60 })

const routed = (
  id: string,
  from: string,
  to: string,
  status: 'routed' | 'unroutable' = 'routed',
): RoutedEdge => ({
  key: id,
  semanticEdgeId: id,
  fromId: from,
  toId: to,
  role: 'main',
  relation: 'causal',
  status,
  laneOffsetPx: 0,
})

function planWith(overrides: Partial<FigurePlanV2>): FigurePlanV2 {
  return {
    thesis: 'test',
    figureType: 'mechanism',
    nodes: [],
    edges: [],
    groups: [],
    globalIntent: { emphasis: [], secondary: [], optional: [] },
    ...overrides,
  }
}

describe('QA-P0-05: direction audit across every reading flow', () => {
  const edge = (id: string, from: string, to: string): SemanticEdge => ({
    id,
    from,
    to,
    role: 'main',
    relation: 'causal',
    presentation: 'arrow',
  })

  const backwardsPairs = (
    direction: 'LR' | 'RL' | 'TB' | 'BT',
    a: { id: string; x: number; y: number },
    b: { id: string; x: number; y: number },
  ) =>
    auditScientific({
      plan: planWith({ edges: [edge('e1', a.id, b.id)] }),
      placements: [rect(a.id, a.x, a.y), rect(b.id, b.x, b.y)],
      direction,
    })

  it('LR flags a right-to-left causal step', () => {
    const issues = backwardsPairs('LR', { id: 'a', x: 900, y: 300 }, { id: 'b', x: 100, y: 300 })
    expect(issues.some((issue) => issue.message.includes('LR flow'))).toBe(true)
  })

  it('RL flags a left-to-right causal step (LR logic would have missed it)', () => {
    const issues = backwardsPairs('RL', { id: 'a', x: 100, y: 300 }, { id: 'b', x: 900, y: 300 })
    expect(issues.some((issue) => issue.message.includes('RL flow'))).toBe(true)
  })

  it('TB accepts an upward step that LR would wrongly flag', () => {
    // b sits ABOVE a: wrong for TB when a→b, fine for BT
    const a = { id: 'a', x: 300, y: 600 }
    const b = { id: 'b', x: 300, y: 100 }
    expect(
      auditScientific({
        plan: planWith({ edges: [edge('e1', 'a', 'b')] }),
        placements: [rect('a', a.x, a.y), rect('b', b.x, b.y)],
        direction: 'TB',
      }).some((issue) => issue.repairClass === 'COMPOSITION_REDESIGN'),
    ).toBe(true)
    expect(
      auditScientific({
        plan: planWith({ edges: [edge('e1', 'a', 'b')] }),
        placements: [rect('a', a.x, a.y), rect('b', b.x, b.y)],
        direction: 'BT',
      }).some((issue) => issue.repairClass === 'COMPOSITION_REDESIGN'),
    ).toBe(false)
  })

  it('radial without a declared center skips the direction audit instead of guessing', () => {
    const issues = auditScientific({
      plan: planWith({
        edges: [edge('e1', 'a', 'b')],
        readingIntent: { preferredDirection: 'radial' },
      }),
      placements: [rect('a', 900, 300), rect('b', 100, 300)],
    })
    expect(issues.some((issue) => issue.message.includes('flow'))).toBe(false)
  })

  it('mixed follows the declared readingPath order', () => {
    const issues = auditScientific({
      plan: planWith({
        edges: [edge('e1', 'a', 'b')],
        narrative: {
          expressionMode: 'mechanism',
          complexity: 'compact',
          centralMessage: 'x',
          mustShow: [],
          mayMerge: [],
          omitFromCanvas: [],
          readingPath: ['b', 'a'],
        },
        readingIntent: { preferredDirection: 'mixed' },
      }),
      placements: [rect('a', 100, 300), rect('b', 900, 300)],
    })
    // path says b(1) → a(2), so a→b reads backwards
    expect(issues.some((issue) => issue.message.includes('mixed flow'))).toBe(true)
  })

  it('hierarchy and association are exempt from monotonic flow checks', () => {
    const issues = auditScientific({
      plan: planWith({
        edges: [
          {
            id: 'h',
            from: 'a',
            to: 'b',
            role: 'main',
            relation: 'hierarchy',
            presentation: 'containment',
          },
          {
            id: 's',
            from: 'a',
            to: 'b',
            role: 'main',
            relation: 'association',
            presentation: 'line',
          },
        ],
      }),
      placements: [rect('a', 900, 300), rect('b', 100, 300)],
    })
    expect(issues.some((issue) => issue.repairClass === 'COMPOSITION_REDESIGN')).toBe(false)
  })
})

describe('QA-P0-07: multi-edge handling by edge id', () => {
  it('two relations on one pair stay distinct: both realized = no issue', () => {
    const edges: SemanticEdge[] = [
      { id: 'r1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      {
        id: 'r2',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'moderation',
        presentation: 'dashed-arrow',
      },
    ]
    const issues = auditScientific({
      plan: planWith({ edges }),
      placements: [rect('a', 100, 300), rect('b', 600, 300)],
      routes: [
        { ...routed('r1', 'a', 'b'), relation: 'causal' },
        { ...routed('r2', 'a', 'b'), relation: 'moderation' },
      ],
    })
    expect(issues.some((issue) => issue.repairClass === 'ROUTE_FIX')).toBe(false)
  })

  it('one of two same-pair relations unrealized is caught BY ID (endpoint maps would hide it)', () => {
    const edges: SemanticEdge[] = [
      { id: 'r1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      {
        id: 'r2',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'moderation',
        presentation: 'dashed-arrow',
      },
    ]
    const issues = auditScientific({
      plan: planWith({ edges }),
      placements: [rect('a', 100, 300), rect('b', 600, 300)],
      routes: [routed('r1', 'a', 'b')],
    })
    const unrealized = issues.find((issue) => issue.repairClass === 'ROUTE_FIX')
    expect(unrealized).toBeDefined()
    expect(unrealized?.affectedIds).toContain('r2')
  })
})

describe('QA-P1-01: structured contradiction audits', () => {
  it('flags promotion + inhibition on one pair without condition labels', () => {
    const edges: SemanticEdge[] = [
      { id: 'p', from: 'a', to: 'b', role: 'main', relation: 'promotion', presentation: 'arrow' },
      {
        id: 'i',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'inhibition',
        presentation: 'inhibition',
      },
    ]
    const found = contradictionIssues(edges)
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('contradictory')
  })

  it('condition labels disambiguate and clear the contradiction', () => {
    const edges: SemanticEdge[] = [
      {
        id: 'p',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'promotion',
        presentation: 'arrow',
        label: 'low dose',
      },
      {
        id: 'i',
        from: 'a',
        to: 'b',
        role: 'main',
        relation: 'inhibition',
        presentation: 'inhibition',
        label: 'high dose',
      },
    ]
    expect(contradictionIssues(edges)).toHaveLength(0)
  })

  it('mutual causal edges are flagged as undeclared feedback', () => {
    const edges: SemanticEdge[] = [
      { id: 'x', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      { id: 'y', from: 'b', to: 'a', role: 'main', relation: 'causal', presentation: 'arrow' },
    ]
    const found = contradictionIssues(edges)
    expect(found.some((issue) => issue.message.includes('feedback'))).toBe(true)
  })
})

describe('QA-P1-02: causal cycle policy', () => {
  it('a causal A→B→A cycle without feedback is a semantic issue', () => {
    const edges: SemanticEdge[] = [
      { id: '1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      { id: '2', from: 'b', to: 'a', role: 'main', relation: 'causal', presentation: 'arrow' },
    ]
    const found = cycleIssues(edges, 'causal-model')
    expect(found).toHaveLength(1)
    expect(found[0]!.message).toContain('cycle')
  })

  it('the same cycle through a declared feedback edge is legitimate', () => {
    const edges: SemanticEdge[] = [
      { id: '1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      {
        id: '2',
        from: 'b',
        to: 'a',
        role: 'feedback',
        relation: 'feedback',
        presentation: 'feedback-loop',
      },
    ]
    expect(cycleIssues(edges, 'causal-model')).toHaveLength(0)
  })

  it('network family tolerates directed cycles', () => {
    const edges: SemanticEdge[] = [
      { id: '1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
      { id: '2', from: 'b', to: 'a', role: 'main', relation: 'causal', presentation: 'arrow' },
    ]
    expect(cycleIssues(edges, 'network')).toHaveLength(0)
  })
})

describe('QA-P1-03: orphan audits', () => {
  const baseNodes = [
    {
      id: 'ev',
      type: 'evidence' as const,
      semanticLabel: 'ev',
      visible: { title: 'ev' },
      importance: 0.5,
      role: 'support' as const,
    },
    {
      id: 'm',
      type: 'mechanism' as const,
      semanticLabel: 'm',
      visible: { title: 'm' },
      importance: 0.9,
      role: 'core' as const,
    },
    {
      id: 'o1',
      type: 'outcome' as const,
      semanticLabel: 'o',
      visible: { title: 'o' },
      importance: 0.7,
      role: 'output' as const,
    },
    {
      id: 'o2',
      type: 'outcome' as const,
      semanticLabel: 'o2',
      visible: { title: 'o2' },
      importance: 0.5,
      role: 'output' as const,
    },
    {
      id: 'note',
      type: 'annotation' as const,
      semanticLabel: 'note',
      visible: { title: 'note' },
      importance: 0.3,
      role: 'support' as const,
    },
  ]

  it('evidence with no relation is flagged; connected evidence is not', () => {
    const plan = planWith({ nodes: baseNodes, edges: [] })
    const found = orphanIssues(plan)
    expect(found.some((issue) => issue.affectedIds.includes('ev'))).toBe(true)
    const connected = planWith({
      nodes: baseNodes,
      edges: [
        {
          id: 'e',
          from: 'm',
          to: 'ev',
          role: 'main',
          relation: 'association',
          presentation: 'line',
        },
      ],
    })
    expect(orphanIssues(connected).some((issue) => issue.affectedIds.includes('ev'))).toBe(false)
  })

  it('annotations without a target are flagged unless they are the visual center', () => {
    const plan = planWith({ nodes: baseNodes, edges: [] })
    expect(orphanIssues(plan, 'note').some((issue) => issue.affectedIds.includes('note'))).toBe(
      false,
    )
    expect(orphanIssues(plan).some((issue) => issue.affectedIds.includes('note'))).toBe(true)
  })

  it('minimal statements are exempt from orphan checks', () => {
    const plan = planWith({
      nodes: baseNodes,
      edges: [],
      narrative: {
        expressionMode: 'statement',
        complexity: 'minimal',
        centralMessage: 'x',
        mustShow: [],
        mayMerge: [],
        omitFromCanvas: [],
      },
    })
    expect(orphanIssues(plan)).toHaveLength(0)
  })
})

describe('QA-P1-04: duplicate labels are scoped to groups/panels', () => {
  it('the same title in different declared groups is legitimate comparison labeling', () => {
    const plan = planWith({
      nodes: [
        {
          id: 'a1',
          type: 'mechanism',
          semanticLabel: 'a1',
          visible: { title: '安慰剂' },
          importance: 0.5,
          role: 'core',
          groupId: 'control',
        },
        {
          id: 'a2',
          type: 'mechanism',
          semanticLabel: 'a2',
          visible: { title: '安慰剂' },
          importance: 0.5,
          role: 'core',
          groupId: 'treatment',
        },
      ],
    })
    expect(duplicateTitleIssues(plan)).toHaveLength(0)
  })

  it('duplicates with no grouping still merge', () => {
    const plan = planWith({
      nodes: [
        {
          id: 'a1',
          type: 'mechanism',
          semanticLabel: 'a1',
          visible: { title: '机制' },
          importance: 0.5,
          role: 'core',
        },
        {
          id: 'a2',
          type: 'mechanism',
          semanticLabel: 'a2',
          visible: { title: '机制' },
          importance: 0.5,
          role: 'core',
        },
      ],
    })
    expect(duplicateTitleIssues(plan)[0]!.affectedIds).toContain('机制')
  })
})

describe('QA-P1-05: dominance uses multiple signals, not area alone', () => {
  it('a centered mid-size node outranks an off-center giant', () => {
    const placements = [
      { id: 'core', x: 760, y: 340, w: 200, h: 100 },
      { id: 'giant', x: 1400, y: 40, w: 340, h: 200 },
      { id: 'filler', x: 100, y: 600, w: 120, h: 60 },
    ]
    expect(combinedDominanceRank('core', placements)).toBe(1)
  })

  it('an important node pushed to the periphery loses combined dominance', () => {
    const placements = [
      { id: 'important', x: 20, y: 20, w: 120, h: 60 },
      { id: 'bulk', x: 600, y: 320, w: 220, h: 110 },
    ]
    expect(combinedDominanceRank('important', placements)).toBe(2)
  })
})

describe('QA-P1-06: domain validators', () => {
  it('cs/ml demands data-flow relations when connectors exist', () => {
    const plan = planWith({
      nodes: [
        {
          id: 'src',
          type: 'data-source',
          semanticLabel: 's',
          visible: { title: 's' },
          importance: 0.5,
          role: 'input',
        },
        {
          id: 'mdl',
          type: 'model',
          semanticLabel: 'm',
          visible: { title: 'm' },
          importance: 0.9,
          role: 'core',
        },
      ],
      edges: [
        {
          id: 'e',
          from: 'src',
          to: 'mdl',
          role: 'main',
          relation: 'association',
          presentation: 'line',
        },
      ],
    })
    const found = validateDomain(plan, 'cs-ml')
    expect(found.some((issue) => issue.message.includes('data-flow'))).toBe(true)
  })

  it('materials: plain-arrow inhibition is rejected', () => {
    const plan = planWith({
      nodes: [],
      edges: [
        {
          id: 'e',
          from: 'a',
          to: 'b',
          role: 'main',
          relation: 'inhibition',
          presentation: 'arrow',
        },
      ],
    })
    expect(validateDomain(plan, 'materials-chemistry')).toHaveLength(1)
  })

  it('social science: mediators need both incoming and outgoing mediation', () => {
    const plan = planWith({
      nodes: [],
      edges: [
        {
          id: 'e1',
          from: 'x',
          to: 'm',
          role: 'main',
          relation: 'mediation',
          presentation: 'arrow',
        },
      ],
    })
    const found = validateDomain(plan, 'social-science')
    expect(found.some((issue) => issue.message.includes('mediators'))).toBe(true)
  })

  it('biomed: an activation edge with an inhibition marker inverts the sign', () => {
    const plan = planWith({
      nodes: [],
      edges: [
        {
          id: 'e',
          from: 'a',
          to: 'b',
          role: 'main',
          relation: 'promotion',
          presentation: 'inhibition',
        },
      ],
    })
    expect(validateDomain(plan, 'biomed')).toHaveLength(1)
  })

  it('unknown domains validate nothing', () => {
    expect(validateDomain(planWith({ nodes: [], edges: [] }), 'astrology')).toHaveLength(0)
  })
})

describe('QA-P1-07: family validators', () => {
  it('hierarchy rejects a node with two parents', () => {
    const plan = planWith({
      nodes: [],
      edges: [
        {
          id: 'h1',
          from: 'root',
          to: 'child',
          role: 'main',
          relation: 'hierarchy',
          presentation: 'containment',
        },
        {
          id: 'h2',
          from: 'root2',
          to: 'child',
          role: 'main',
          relation: 'hierarchy',
          presentation: 'containment',
        },
      ],
    })
    const found = validateFamily(plan, 'hierarchy')
    expect(found.some((issue) => issue.message.includes('more than one parent'))).toBe(true)
  })

  it('hierarchy accepts a proper tree', () => {
    const plan = planWith({
      nodes: [],
      edges: [
        {
          id: 'h1',
          from: 'root',
          to: 'a',
          role: 'main',
          relation: 'hierarchy',
          presentation: 'containment',
        },
        {
          id: 'h2',
          from: 'root',
          to: 'b',
          role: 'main',
          relation: 'hierarchy',
          presentation: 'containment',
        },
        {
          id: 'h3',
          from: 'a',
          to: 'c',
          role: 'main',
          relation: 'hierarchy',
          presentation: 'containment',
        },
      ],
    })
    expect(validateFamily(plan, 'hierarchy')).toHaveLength(0)
  })

  it('network flags isolated nodes', () => {
    const plan = planWith({
      nodes: [
        {
          id: 'in',
          type: 'mechanism',
          semanticLabel: 'i',
          visible: { title: 'i' },
          importance: 0.5,
          role: 'core',
        },
        {
          id: 'out',
          type: 'outcome',
          semanticLabel: 'o',
          visible: { title: 'o' },
          importance: 0.5,
          role: 'core',
        },
      ],
      edges: [
        {
          id: 'e',
          from: 'in',
          to: 'in2',
          role: 'main',
          relation: 'association',
          presentation: 'line',
        },
      ],
    })
    expect(validateFamily(plan, 'network').some((issue) => issue.affectedIds.includes('out'))).toBe(
      true,
    )
  })

  it('comparison demands at least two groups', () => {
    expect(
      validateFamily(planWith({ nodes: [], edges: [], groups: [] }), 'comparison'),
    ).toHaveLength(1)
    expect(
      validateFamily(
        planWith({
          nodes: [],
          edges: [],
          groups: [
            { id: 'g1', memberIds: ['a'] },
            { id: 'g2', memberIds: ['b'] },
          ],
        }),
        'comparison',
      ),
    ).toHaveLength(0)
  })
})

describe('scientific critic integration with the metric pipeline', () => {
  it('auditScientific stays quiet on a clean LR mechanism', () => {
    const plan = planWith({
      nodes: [
        {
          id: 'a',
          type: 'data-source',
          semanticLabel: 'a',
          visible: { title: 'A' },
          importance: 0.4,
          role: 'input',
        },
        {
          id: 'b',
          type: 'mechanism',
          semanticLabel: 'b',
          visible: { title: 'B' },
          importance: 0.9,
          role: 'core',
        },
        {
          id: 'c',
          type: 'outcome',
          semanticLabel: 'c',
          visible: { title: 'C' },
          importance: 0.6,
          role: 'output',
        },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
        { id: 'e2', from: 'b', to: 'c', role: 'main', relation: 'causal', presentation: 'arrow' },
      ],
    })
    const issues: ScientificIssue[] = auditScientific({
      plan,
      placements: [rect('a', 100, 300), rect('b', 500, 300), rect('c', 900, 300)],
      routes: [routed('e1', 'a', 'b'), routed('e2', 'b', 'c')],
      importance: new Map([
        ['a', 0.4],
        ['b', 0.9],
        ['c', 0.6],
      ]),
    })
    expect(issues).toEqual([])
  })
})
