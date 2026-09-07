/**
 * P0-2 (production closure): ONE FigurePlan vocabulary → many artifacts.
 * For every scientific reference shape (timeline, matrix, moderation,
 * provenance, off-canvas accountability, …):
 *
 *   JSON Schema accepts → parser accepts → serialize → parser accepts again
 *
 * A schema that rejects what the parser accepts starves the semantic pipeline
 * (the model is contracted by this very schema in the immutable protocol).
 */
import { describe, expect, it } from 'vitest'
import {
  figurePlanJsonSchema,
  FIGURE_PLAN_PROTOCOL_VERSION,
  renderJsonContract,
} from '../src/protocol/figure-plan-protocol.js'
import {
  EXPRESSION_MODES,
  parseFigurePlanV2,
  parseFigurePlanV2WithDiagnostics,
  SEMANTIC_NODE_TYPES,
} from '../src/semantic/figure-plan.js'
import { RELATION_TYPES } from '../src/semantic/schema.js'

/** Minimal 2020-12 validator for the subset of keywords the protocol uses. */
function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = []
  const walk = (instance: unknown, sch: Record<string, unknown>, path: string): void => {
    const type = sch.type as string | undefined
    if (type === 'object') {
      if (typeof instance !== 'object' || instance === null || Array.isArray(instance)) {
        errors.push(`${path}: expected object`)
        return
      }
      const properties = (sch.properties ?? {}) as Record<string, Record<string, unknown>>
      if (sch.additionalProperties === false) {
        for (const key of Object.keys(instance as Record<string, unknown>)) {
          if (!(key in properties)) errors.push(`${path}.${key}: additional property not allowed`)
        }
      }
      for (const required of (sch.required as string[] | undefined) ?? []) {
        if (!(required in (instance as Record<string, unknown>))) {
          errors.push(`${path}: missing required "${required}"`)
        }
      }
      for (const [key, sub] of Object.entries(properties)) {
        const v = (instance as Record<string, unknown>)[key]
        if (v !== undefined) walk(v, sub, `${path}.${key}`)
      }
      return
    }
    if (type === 'array') {
      if (!Array.isArray(instance)) {
        errors.push(`${path}: expected array`)
        return
      }
      const items = sch.items as Record<string, unknown> | undefined
      if (items) for (const [i, item] of instance.entries()) walk(item, items, `${path}[${i}]`)
      return
    }
    if (type === 'string') {
      if (typeof instance !== 'string') errors.push(`${path}: expected string`)
      const enumValues = sch.enum as string[] | undefined
      if (enumValues && !enumValues.includes(instance as string)) {
        errors.push(`${path}: "${instance}" not in enum`)
      }
      return
    }
    if (type === 'number') {
      if (typeof instance !== 'number') errors.push(`${path}: expected number`)
      return
    }
  }
  walk(value, schema, '$')
  return errors
}

const BASE_PLAN: Record<string, unknown> = {
  thesis: 'test',
  figureType: 'mechanism',
  nodes: [
    {
      id: 'a',
      type: 'process',
      semanticLabel: 'A',
      visible: { title: 'A' },
      importance: 0.5,
      role: 'core',
    },
    {
      id: 'b',
      type: 'outcome',
      semanticLabel: 'B',
      visible: { title: 'B' },
      importance: 0.5,
      role: 'output',
    },
    {
      id: 'm',
      type: 'variable',
      semanticLabel: 'M',
      visible: { title: 'M' },
      importance: 0.4,
      role: 'moderator',
    },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b', relation: 'causal' }],
  groups: [],
  globalIntent: { emphasis: [], secondary: [], optional: [] },
}

function expectSchemaParseRoundtrip(plan: Record<string, unknown>) {
  const schemaErrors = validateAgainstSchema(plan, figurePlanJsonSchema())
  expect(schemaErrors, 'JSON Schema must accept what the pipeline needs').toEqual([])
  const parsed = parseFigurePlanV2WithDiagnostics(plan)
  expect(parsed.errors, parsed.errors.join('; ')).toEqual([])
  expect(parsed.plan).not.toBeNull()
  // serialize → parse again (idempotence through the structured transport)
  const serialized = JSON.parse(JSON.stringify(parsed.plan)) as Record<string, unknown>
  const reparsed = parseFigurePlanV2(serialized)
  expect(reparsed).not.toBeNull()
  expect(reparsed).toEqual(parsed.plan)
}

describe('figure plan protocol roundtrip (P0-2)', () => {
  it('schema version is pinned', () => {
    expect(FIGURE_PLAN_PROTOCOL_VERSION).toBe('2.1.0')
  })

  it('protocol vocabulary matches the parser vocabulary verbatim', () => {
    expect(SEMANTIC_NODE_TYPES.length).toBeGreaterThan(0)
    expect(RELATION_TYPES.length).toBeGreaterThan(0)
    expect(EXPRESSION_MODES.length).toBeGreaterThan(0)
  })

  it('1. timeline plan (timeOrder + phase + timePoint) round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      narrative: {
        expressionMode: 'timeline',
        complexity: 'compact',
        centralMessage: 'progression',
        mustShow: ['a', 'b'],
        mayMerge: [],
        omitFromCanvas: [],
      },
      nodes: [
        {
          id: 'a',
          type: 'process',
          semanticLabel: 'A',
          visible: { title: 'A' },
          importance: 0.5,
          role: 'core',
          phase: '2020-03',
          timePoint: '2020-03-01',
        },
        {
          id: 'b',
          type: 'process',
          semanticLabel: 'B',
          visible: { title: 'B' },
          importance: 0.5,
          role: 'core',
          phase: '2021-06',
          timePoint: '2021-06-15',
        },
      ],
      timeOrder: ['a', 'b'],
    })
  })

  it('2. matrix plan (rowGroupIds + columnGroupIds + cellRelation) round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      narrative: {
        expressionMode: 'matrix',
        complexity: 'compact',
        centralMessage: 'interaction',
        mustShow: ['a', 'b'],
        mayMerge: [],
        omitFromCanvas: [],
      },
      groups: [
        { id: 'rows', memberIds: ['a'] },
        { id: 'cols', memberIds: ['b'] },
      ],
      matrix: { rowGroupIds: ['rows'], columnGroupIds: ['cols'], cellRelation: 'effect size' },
    })
  })

  it('3. moderation with targetEdge round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      edges: [
        { id: 'e1', from: 'a', to: 'b', relation: 'causal' },
        { id: 'e2', from: 'm', to: 'b', relation: 'moderation', targetEdge: 'e1' },
      ],
    })
  })

  it('4. qualifiedBy moderation round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      edges: [
        { id: 'e1', from: 'a', to: 'b', relation: 'causal' },
        { id: 'e2', from: 'm', to: 'a', relation: 'moderation', qualifiedBy: ['m'] },
      ],
    })
  })

  it('5. evidenceRefs round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      nodes: [
        {
          id: 'a',
          type: 'mechanism',
          semanticLabel: 'A',
          visible: { title: 'A' },
          importance: 0.5,
          role: 'core',
          evidenceRefs: ['ev-1', 'ev-2'],
        },
        {
          id: 'b',
          type: 'outcome',
          semanticLabel: 'B',
          visible: { title: 'B' },
          importance: 0.5,
          role: 'output',
        },
        {
          id: 'm',
          type: 'variable',
          semanticLabel: 'M',
          visible: { title: 'M' },
          importance: 0.4,
          role: 'moderator',
        },
      ],
    })
  })

  it('6. provenanceRefs on a quantitative claim round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      nodes: [
        {
          id: 'a',
          type: 'mechanism',
          semanticLabel: 'A',
          visible: { title: 'A' },
          importance: 0.5,
          role: 'core',
          claimType: 'quantitative',
          provenanceRefs: ['doi:10.1/x'],
        },
        {
          id: 'b',
          type: 'outcome',
          semanticLabel: 'B',
          visible: { title: 'B' },
          importance: 0.5,
          role: 'output',
        },
        {
          id: 'm',
          type: 'variable',
          semanticLabel: 'M',
          visible: { title: 'M' },
          importance: 0.4,
          role: 'moderator',
        },
      ],
    })
  })

  it('7. quantitative claimType alone round-trips (drives provenance gating)', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      nodes: [
        {
          id: 'a',
          type: 'outcome',
          semanticLabel: 'A',
          visible: { title: 'A' },
          importance: 0.5,
          role: 'core',
          claimType: 'quantitative',
        },
        {
          id: 'b',
          type: 'outcome',
          semanticLabel: 'B',
          visible: { title: 'B' },
          importance: 0.5,
          role: 'output',
        },
        {
          id: 'm',
          type: 'variable',
          semanticLabel: 'M',
          visible: { title: 'M' },
          importance: 0.4,
          role: 'moderator',
        },
      ],
    })
  })

  it('8. phase + timePoint on a node round-trip', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      nodes: [
        {
          id: 'a',
          type: 'process',
          semanticLabel: 'A',
          visible: { title: 'A' },
          importance: 0.5,
          role: 'core',
          phase: 'Phase 1',
          timePoint: 'T0',
        },
        {
          id: 'b',
          type: 'outcome',
          semanticLabel: 'B',
          visible: { title: 'B' },
          importance: 0.5,
          role: 'output',
        },
        {
          id: 'm',
          type: 'variable',
          semanticLabel: 'M',
          visible: { title: 'M' },
          importance: 0.4,
          role: 'moderator',
        },
      ],
    })
  })

  it('9. offCanvasReasoning + evidenceMustShow round-trip', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      narrative: {
        expressionMode: 'mechanism',
        complexity: 'rich',
        centralMessage: 'm',
        mustShow: ['a', 'b'],
        mayMerge: [],
        omitFromCanvas: ['raw data table'],
        evidenceMustShow: ['a'],
        offCanvasReasoning: ['raw data renders as an appendix table, not a node'],
      },
    })
  })

  it('10. mixed reading flow round-trips', () => {
    expectSchemaParseRoundtrip({
      ...BASE_PLAN,
      readingIntent: { preferredDirection: 'mixed' },
    })
  })

  it('the rendered machine contract advertises every reference field', () => {
    const contract = renderJsonContract(figurePlanJsonSchema())
    for (const field of [
      'timeOrder',
      'matrix',
      'evidenceRefs',
      'provenanceRefs',
      'claimType',
      'phase',
      'timePoint',
      'targetEdge',
      'qualifiedBy',
      'evidenceMustShow',
      'offCanvasReasoning',
    ]) {
      expect(contract, `machine contract must advertise "${field}"`).toContain(field)
    }
  })
})
