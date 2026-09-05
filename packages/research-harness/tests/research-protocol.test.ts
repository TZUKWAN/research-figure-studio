import { describe, expect, it } from 'vitest'
import {
  downgradePresentation,
  figurePlanJsonSchema,
  parseFigurePlanV2,
  RELATION_PRESENTATIONS,
  RELATION_TYPES,
  renderJsonContract,
  RUNTIME_CAPABILITIES,
  runtimeCapabilities,
  SEMANTIC_NODE_TYPES,
  spatialPlanJsonSchema,
  FIGURE_PLAN_PROTOCOL_VERSION,
} from '../src'

/**
 * AI-P0-02/05: one vocabulary, one contract. The generated JSON Schemas must
 * reference the SAME constants the TypeScript parsers enforce, and the model
 * may only declare presentations the renderer realizes.
 */

const collectEnums = (node: unknown, property: string, out: string[][] = []): string[][] => {
  if (Array.isArray(node)) {
    for (const item of node) collectEnums(item, property, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const obj = node as Record<string, unknown>
  const inner = obj.properties as Record<string, unknown> | undefined
  if (inner && inner[property] && typeof inner[property] === 'object') {
    const e = (inner[property] as Record<string, unknown>).enum
    if (Array.isArray(e)) out.push(e as string[])
  }
  for (const value of Object.values(obj)) collectEnums(value, property, out)
  return out
}

describe('figure plan protocol (schema single source, AI-P0-02)', () => {
  it('edge relation enum equals RELATION_TYPES verbatim', () => {
    const schema = figurePlanJsonSchema()
    const enums = collectEnums(schema, 'relation')
    expect(enums.length).toBeGreaterThan(0)
    for (const e of enums) expect(e).toEqual([...RELATION_TYPES])
  })

  it('presentation enum equals the vocabulary and node types/roles match the parser', () => {
    const schema = figurePlanJsonSchema()
    for (const e of collectEnums(schema, 'presentation')) {
      expect(e).toEqual([...RELATION_PRESENTATIONS])
    }
    for (const e of collectEnums(schema, 'type')) {
      expect(e).toEqual([...SEMANTIC_NODE_TYPES])
    }
  })

  it('rejects values the parser rejects (schema ⇄ parser agreement)', () => {
    const schema = figurePlanJsonSchema()
    const presentationEnum = collectEnums(schema, 'presentation')[0] as string[]
    const relationEnum = collectEnums(schema, 'relation')[0] as string[]
    // parser: unknown presentation/relation strings are rejected (via normEnum → repair-or-null)
    expect(presentationEnum).not.toContain('junction-diagonal')
    expect(relationEnum).not.toContain('magic')
    // and the roundtrip holds: schema-rendered contract parses back as JSON
    expect(() => JSON.parse(renderJsonContract(schema))).not.toThrow()
  })

  it('is versioned', () => {
    expect(FIGURE_PLAN_PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('runtime capability contract (AI-P0-05)', () => {
  it('never declares junction: the renderer draws no junction dots today', () => {
    expect(RUNTIME_CAPABILITIES.declarablePresentations).not.toContain('junction')
    expect(RUNTIME_CAPABILITIES.connectorPresentations).not.toContain('junction')
  })

  it('connector + spatial sets cover exactly the declarable set', () => {
    const { connectorPresentations, spatialPresentations, declarablePresentations } =
      RUNTIME_CAPABILITIES
    expect([...connectorPresentations, ...spatialPresentations].sort()).toEqual(
      [...declarablePresentations].sort(),
    )
  })

  it('downgrades stale model output that declared an unrealized presentation', () => {
    const downgrade = downgradePresentation('junction')
    expect(downgrade).not.toBeNull()
    expect(downgrade?.fallback).toBe('arrow')
    expect(downgradePresentation('arrow')).toBeNull()
    expect(downgradePresentation('inhibition')).toBeNull()
    expect(downgradePresentation('containment')).toBeNull()
  })

  it('spatial plan schema honors the capability-filtered presentation set', () => {
    const caps = runtimeCapabilities()
    const schema = spatialPlanJsonSchema({
      presentations: [...caps.declarablePresentations],
      microLayouts: [...caps.microLayouts],
      shapes: [...caps.visualUnitShapes],
    })
    for (const e of collectEnums(schema, 'presentation')) {
      expect(e).not.toContain('junction')
    }
  })
})

describe('planner parse still accepts the protocol output', () => {
  it('a protocol-shaped minimal plan parses (statement mode, zero edges)', () => {
    const plan = parseFigurePlanV2({
      thesis: 'T',
      figureType: 'freeform',
      narrative: {
        expressionMode: 'statement',
        complexity: 'minimal',
        centralMessage: 'One claim',
        mustShow: [],
        mayMerge: [],
        omitFromCanvas: [],
      },
      nodes: [
        {
          id: 'n1',
          type: 'annotation',
          semanticLabel: 'The claim',
          visible: { title: 'The claim' },
          importance: 0.9,
          role: 'core',
        },
      ],
      edges: [],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
    })
    expect(plan).not.toBeNull()
    expect(plan?.edges).toHaveLength(0)
  })
})
