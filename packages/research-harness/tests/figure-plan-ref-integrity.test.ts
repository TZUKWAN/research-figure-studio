/**
 * P0-3 (production closure): reference-typed FigurePlan fields must never be
 * silently dropped. Every dangling reference is a SCHEMA ERROR with the exact
 * field and id, so the bounded repair loop can fix the REAL problem — a
 * silent .filter(id => ids.has(id)) destroys research semantics instead.
 *
 * Coverage: mustShow, readingPath, visualCenter, evidenceMustShow, mayMerge,
 * timeOrder, primarySpine, matrix axes, group.memberIds, node.groupId,
 * globalIntent lists, edge.targetEdge, edge.qualifiedBy.
 */
import { describe, expect, it } from 'vitest'
import { parseFigurePlanV2WithDiagnostics } from '../src/semantic/figure-plan.js'

function basePlan(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    thesis: 'A causes B',
    figureType: 'mechanism',
    nodes: [
      { id: 'a', type: 'mechanism', semanticLabel: 'A', visible: { title: 'A' } },
      { id: 'b', type: 'outcome', semanticLabel: 'B', visible: { title: 'B' } },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', relation: 'causal' }],
    groups: [{ id: 'g1', memberIds: ['a', 'b'] }],
    ...overrides,
  }
}

function expectDangling(overrides: Record<string, unknown>, expectedFragment: string) {
  const result = parseFigurePlanV2WithDiagnostics(basePlan(overrides))
  expect(result.plan).toBeNull()
  expect(result.errors.some((error) => error.includes(expectedFragment))).toBe(true)
}

describe('FigurePlan dangling references are hard errors (P0-3)', () => {
  it('narrative.mustShow → missing node', () => {
    expectDangling(
      { narrative: { expressionMode: 'mechanism', mustShow: ['a', 'evidence-x'] } },
      'narrative.mustShow references missing node "evidence-x"',
    )
  })

  it('narrative.readingPath → missing node', () => {
    expectDangling(
      { narrative: { expressionMode: 'mechanism', readingPath: ['a', 'phase-3'] } },
      'narrative.readingPath references missing node "phase-3"',
    )
  })

  it('narrative.visualCenter → missing node', () => {
    expectDangling(
      { narrative: { expressionMode: 'mechanism', visualCenter: 'ghost-center' } },
      'narrative.visualCenter references missing node "ghost-center"',
    )
  })

  it('narrative.evidenceMustShow → missing node', () => {
    expectDangling(
      { narrative: { expressionMode: 'mechanism', evidenceMustShow: ['ev-x'] } },
      'narrative.evidenceMustShow references missing node "ev-x"',
    )
  })

  it('narrative.mayMerge → missing member', () => {
    expectDangling(
      { narrative: { expressionMode: 'mechanism', mayMerge: [['a', 'merged-x']] } },
      'narrative.mayMerge[0] references missing node "merged-x"',
    )
  })

  it('timeOrder → missing node', () => {
    expectDangling(
      {
        narrative: { expressionMode: 'timeline' },
        timeOrder: ['a', 'b', 'phase-3'],
      },
      'timeOrder references missing node "phase-3"',
    )
  })

  it('primarySpine → missing node', () => {
    expectDangling(
      { primarySpine: ['a', 'spine-x'] },
      'primarySpine references missing node "spine-x"',
    )
  })

  it('matrix.rowGroupIds → missing group', () => {
    expectDangling(
      {
        narrative: { expressionMode: 'matrix' },
        matrix: { rowGroupIds: ['g1', 'r2'], columnGroupIds: ['g1'] },
      },
      'matrix.rowGroupIds references missing group "r2"',
    )
  })

  it('matrix.columnGroupIds → missing group', () => {
    expectDangling(
      {
        narrative: { expressionMode: 'matrix' },
        matrix: { rowGroupIds: ['g1'], columnGroupIds: ['c9'] },
      },
      'matrix.columnGroupIds references missing group "c9"',
    )
  })

  it('group.memberIds → missing member', () => {
    const result = parseFigurePlanV2WithDiagnostics(
      basePlan({ groups: [{ id: 'g1', memberIds: ['a', 'b', 'ghost-member'] }] }),
    )
    expect(result.plan).toBeNull()
    expect(
      result.errors.some((error) =>
        error.includes('group "g1" memberIds references missing node "ghost-member"'),
      ),
    ).toBe(true)
  })

  it('node.groupId → missing group', () => {
    const result = parseFigurePlanV2WithDiagnostics(
      basePlan({
        nodes: [
          {
            id: 'a',
            type: 'mechanism',
            semanticLabel: 'A',
            visible: { title: 'A' },
            groupId: 'no-such-group',
          },
          { id: 'b', type: 'outcome', semanticLabel: 'B', visible: { title: 'B' } },
        ],
      }),
    )
    expect(result.plan).toBeNull()
    expect(
      result.errors.some((error) =>
        error.includes('groupId references missing group "no-such-group"'),
      ),
    ).toBe(true)
  })

  it('globalIntent.emphasis → missing node', () => {
    expectDangling(
      { globalIntent: { emphasis: ['a', 'sec-x'] } },
      'globalIntent.emphasis references missing node "sec-x"',
    )
  })

  it('edge.qualifiedBy → missing node', () => {
    const result = parseFigurePlanV2WithDiagnostics(
      basePlan({
        edges: [{ id: 'e1', from: 'a', to: 'b', relation: 'causal', qualifiedBy: ['moderator-x'] }],
      }),
    )
    expect(result.plan).toBeNull()
    expect(
      result.errors.some((error) =>
        error.includes('qualifiedBy references missing node "moderator-x"'),
      ),
    ).toBe(true)
  })

  it('edge.targetEdge → missing edge id', () => {
    const result = parseFigurePlanV2WithDiagnostics(
      basePlan({
        edges: [{ id: 'e1', from: 'a', to: 'b', relation: 'moderation', targetEdge: 'e-missing' }],
      }),
    )
    expect(result.plan).toBeNull()
    expect(result.errors.some((error) => error.includes('targetEdge "e-missing"'))).toBe(true)
  })

  it('a fully valid plan with every reference type still parses', () => {
    const result = parseFigurePlanV2WithDiagnostics(
      basePlan({
        narrative: {
          expressionMode: 'mechanism',
          complexity: 'compact',
          visualCenter: 'a',
          readingPath: ['a', 'b'],
          mustShow: ['a', 'b'],
          mayMerge: [],
          evidenceMustShow: ['a'],
        },
        primarySpine: ['a', 'b'],
        timeOrder: ['a', 'b'],
        globalIntent: { emphasis: ['a'], secondary: ['b'], optional: [] },
      }),
    )
    expect(result.errors).toEqual([])
    expect(result.plan?.narrative?.mustShow).toEqual(['a', 'b'])
    expect(result.plan?.timeOrder).toEqual(['a', 'b'])
    expect(result.plan?.primarySpine).toEqual(['a', 'b'])
    expect(result.plan?.narrative?.visualCenter).toBe('a')
  })
})
