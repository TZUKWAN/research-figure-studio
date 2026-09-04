import { describe, expect, it } from 'vitest'
import {
  RELATION_PRESENTATIONS,
  RELATION_TYPES,
  endpointTable,
  parseSemanticEdges,
  resolveEdge,
  type SemanticEdgeInput,
} from '../src/semantic/schema.js'
import { parseFigurePlanV2 } from '../src/semantic/figure-plan.js'

describe('RELATION_TYPES', () => {
  it('covers the scientific relation vocabulary', () => {
    expect([...RELATION_TYPES]).toEqual([
      'causal',
      'process',
      'data-flow',
      'transformation',
      'association',
      'mediation',
      'moderation',
      'feedback',
      'inhibition',
      'mapping',
      'hierarchy',
      'bidirectional',
    ])
  })

  it('keeps semantic relations separate from their visual presentation', () => {
    expect([...RELATION_PRESENTATIONS]).toEqual([
      'arrow',
      'line',
      'dashed-arrow',
      'inhibition',
      'feedback-loop',
      'junction',
      'containment',
      'proximity',
      'alignment',
      'annotation',
    ])
  })
})

describe('parseSemanticEdges', () => {
  it('parses explicit edges and defaults relation to process', () => {
    const edges = parseSemanticEdges([
      { from: 'A', to: 'B', role: 'main' },
      { from: 'C', to: 'A', role: 'feedback', relation: 'feedback', label: 'revises' },
    ])
    expect(edges).toMatchObject([
      {
        id: 'edge:A->B:process:0',
        from: 'A',
        to: 'B',
        role: 'main',
        relation: 'process',
        presentation: 'arrow',
      },
      {
        id: 'edge:C->A:feedback:1',
        from: 'C',
        to: 'A',
        role: 'feedback',
        relation: 'feedback',
        presentation: 'feedback-loop',
        label: 'revises',
      },
    ])
  })

  it('repairs enum casing and rejects unknown relations or roles', () => {
    expect(
      parseSemanticEdges([{ from: 'A', to: 'B', role: 'main', relation: 'Causal' }]),
    ).toMatchObject([
      { id: 'edge:A->B:causal:0', from: 'A', to: 'B', role: 'main', relation: 'causal' },
    ])
    expect(
      parseSemanticEdges([{ from: 'A', to: 'B', role: 'main', relation: 'teleports' }]),
    ).toBeNull()
    expect(parseSemanticEdges([{ from: 'A', to: 'B', role: 'sideways' }])).toBeNull()
    expect(parseSemanticEdges([{ from: '', to: 'B', role: 'main' }])).toBeNull()
    expect(parseSemanticEdges([{ from: 'A', to: 'A', role: 'main' }])).toBeNull()
    expect(parseSemanticEdges('nope')).toBeNull()
  })

  it('rejects duplicate endpoints with the same role', () => {
    expect(
      parseSemanticEdges([
        { from: 'A', to: 'B', role: 'main' },
        { from: 'A', to: 'B', role: 'main' },
      ]),
    ).toBeNull()
  })

  it('resolves against endpoint tables and validates reachability', () => {
    const fromTable = endpointTable([
      { ref: 'A', indices: [0] },
      { ref: 'grp1', indices: [0, 1] },
    ])
    const toTable = endpointTable([
      { ref: 'B', indices: [1] },
      { ref: 'grp2', indices: [1, 2] },
    ])
    const edges = parseSemanticEdges(
      [
        { from: 'A', to: 'B', role: 'main' },
        { from: 'grp1', to: 'grp2', role: 'main', relation: 'data-flow' },
      ],
      [fromTable, toTable],
    )
    expect(edges).not.toBeNull()
    expect(resolveEdge({ from: 'A', to: 'B', role: 'main' }, fromTable, toTable)).toMatchObject([
      {
        id: 'edge:A->B:process:0',
        fromIndex: 0,
        toIndex: 1,
        role: 'main',
        relation: 'process',
        presentation: 'arrow',
      },
    ])
    // region refs expand to the explicit cartesian product of members
    expect(
      resolveEdge(
        { from: 'grp1', to: 'grp2', role: 'main', relation: 'data-flow' },
        fromTable,
        toTable,
      ),
    ).toMatchObject([
      {
        id: 'edge:grp1->grp2:data-flow:0',
        fromIndex: 0,
        toIndex: 1,
        role: 'main',
        relation: 'data-flow',
        presentation: 'arrow',
      },
      {
        id: 'edge:grp1->grp2:data-flow:0',
        fromIndex: 0,
        toIndex: 2,
        role: 'main',
        relation: 'data-flow',
        presentation: 'arrow',
      },
      // the (1,1) self pair is dropped: a placement cannot relate to itself
      {
        id: 'edge:grp1->grp2:data-flow:0',
        fromIndex: 1,
        toIndex: 2,
        role: 'main',
        relation: 'data-flow',
        presentation: 'arrow',
      },
    ])
    // unknown ref rejects the whole parsed list
    expect(
      parseSemanticEdges([{ from: 'ghost', to: 'B', role: 'main' }], [fromTable, toTable]),
    ).toBeNull()
  })

  it('resolves empty when a ref only exists on the wrong side', () => {
    const fromTable = endpointTable([{ ref: 'A', indices: [0] }])
    const toTable = endpointTable([{ ref: 'B', indices: [1] }])
    expect(
      resolveEdge({ from: 'B', to: 'A', role: 'main' } as SemanticEdgeInput, fromTable, toTable),
    ).toEqual([])
  })

  it('keeps moderation targetEdge passthrough', () => {
    const edges = parseSemanticEdges([
      { id: 'm1', from: 'mod', to: 'B', targetEdge: 'e1', role: 'main', relation: 'moderation' },
    ])
    expect(edges?.[0]).toMatchObject({ id: 'm1', targetEdge: 'e1', relation: 'moderation' })
  })

  it('assigns stable IDs and relation-aware visual defaults', () => {
    const edges = parseSemanticEdges([
      { from: 'A', to: 'B', role: 'main', relation: 'causal' },
      { from: 'B', to: 'A', role: 'feedback', relation: 'feedback' },
      { from: 'C', to: 'D', role: 'main', relation: 'inhibition' },
    ])
    expect(edges).toMatchObject([
      { id: 'edge:A->B:causal:0', presentation: 'arrow' },
      { id: 'edge:B->A:feedback:1', presentation: 'feedback-loop' },
      { id: 'edge:C->D:inhibition:2', presentation: 'inhibition' },
    ])
  })

  it('allows distinct semantic relationships between the same endpoints', () => {
    const edges = parseSemanticEdges([
      { id: 'causes', from: 'A', to: 'B', role: 'main', relation: 'causal' },
      {
        id: 'moderates',
        from: 'A',
        to: 'B',
        role: 'main',
        relation: 'moderation',
        presentation: 'dashed-arrow',
      },
    ])
    expect(edges).toMatchObject([
      { id: 'causes', presentation: 'arrow' },
      { id: 'moderates', presentation: 'dashed-arrow' },
    ])
  })
})

describe('parseFigurePlanV2', () => {
  it('accepts a minimal statement without a spine or a density gate', () => {
    const plan = parseFigurePlanV2({
      thesis: '取消算法约束堆叠。全部交给提示词。',
      figureType: 'statement',
      narrative: {
        expressionMode: 'statement',
        complexity: 'minimal',
        centralMessage: '取消算法约束堆叠。全部交给提示词。',
        mustShow: ['thesis'],
        mayMerge: [],
        omitFromCanvas: ['implementation detail'],
      },
      nodes: [
        {
          id: 'thesis',
          type: 'annotation',
          semanticLabel: '取消算法约束堆叠。全部交给提示词。',
          visible: { title: '取消算法约束堆叠。全部交给提示词。' },
          importance: 1,
          role: 'core',
        },
      ],
      edges: [],
      groups: [],
      globalIntent: { emphasis: ['thesis'], secondary: [], optional: [] },
    })
    expect(plan?.narrative).toMatchObject({
      expressionMode: 'statement',
      complexity: 'minimal',
      centralMessage: '取消算法约束堆叠。全部交给提示词。',
    })
    expect(plan?.primarySpine).toBeUndefined()
    expect(plan?.nodes).toHaveLength(1)
  })
})
