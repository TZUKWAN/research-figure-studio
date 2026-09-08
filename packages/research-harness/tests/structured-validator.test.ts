/**
 * P0-2 (production closure 2): structured output validators execute the REAL
 * runtime parsers — a typeof check is not schema validation.
 *
 * Planner: parseFigurePlanV2WithDiagnostics with exact diagnostics.
 * Designer: parseSpatialPlanWithDiagnostics — placement ids must resolve to
 * FigurePlan nodes, boxHints must be 0..1 fractions, visualPlan refs must
 * resolve. Empty placements stay legal (documented fallback contract).
 */
import { describe, expect, it } from 'vitest'
import { parseFigurePlanV2WithDiagnostics } from '../src/semantic/figure-plan.js'
import { parseSpatialPlanWithDiagnostics } from '../src/composition/spatial-plan.js'

const PLAN_NODES = [
  { id: 'a', semanticLabel: 'A', visible: { title: 'A' } },
  { id: 'b', semanticLabel: 'B', visible: { title: 'B' } },
]
const PLAN_EDGE_IDS = ['e1']

describe('planner validator runs the production parser (P0-2)', () => {
  it('a valid plan parses and the parsed plan comes back', () => {
    const parsed = parseFigurePlanV2WithDiagnostics({
      thesis: 'A causes B',
      figureType: 'mechanism',
      nodes: [
        { id: 'a', type: 'mechanism', semanticLabel: 'A', visible: { title: 'A' } },
        { id: 'b', type: 'outcome', semanticLabel: 'B', visible: { title: 'B' } },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', relation: 'causal' }],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
    })
    expect(parsed.errors).toEqual([])
    expect(parsed.plan?.nodes).toHaveLength(2)
  })

  it('a dangling mustShow yields the EXACT diagnostic (fed to repair)', () => {
    const parsed = parseFigurePlanV2WithDiagnostics({
      thesis: 'x',
      figureType: 'mechanism',
      nodes: [{ id: 'a', type: 'process', semanticLabel: 'A', visible: { title: 'A' } }],
      edges: [],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
      narrative: { expressionMode: 'mechanism', mustShow: ['ghost'] },
    })
    expect(parsed.plan).toBeNull()
    expect(parsed.errors).toContain('narrative.mustShow references missing node "ghost"')
  })

  it('importance stays clamped-repaired (format normalize is allowed)', () => {
    const parsed = parseFigurePlanV2WithDiagnostics({
      thesis: 'x',
      figureType: 'mechanism',
      nodes: [
        { id: 'a', type: 'process', semanticLabel: 'A', visible: { title: 'A' }, importance: 1.4 },
      ],
      edges: [],
      groups: [],
      globalIntent: { emphasis: [], secondary: [], optional: [] },
    })
    expect(parsed.plan?.nodes[0]?.importance).toBe(1)
  })
})

const SPATIAL_PLAN_NODES = PLAN_NODES

describe('designer validator (parseSpatialPlanWithDiagnostics)', () => {
  const base = {
    composition: {
      readingFlow: 'LR',
      balance: 'loosely-balanced',
      density: 'medium',
      visualCenter: 'a',
      whitespaceStrategy: 'balanced',
    },
    placements: [
      { id: 'a', boxHint: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, visualRole: 'dominant' },
      { id: 'b', boxHint: { x: 0.5, y: 0.2, w: 0.3, h: 0.3 }, visualRole: 'secondary' },
    ],
  }

  it('accepts a valid plan and returns the normalized spatial plan', () => {
    const { plan, visualPlan, errors } = parseSpatialPlanWithDiagnostics(
      base,
      SPATIAL_PLAN_NODES.map((n) => n.id),
      { edgeIds: PLAN_EDGE_IDS },
    )
    expect(errors).toEqual([])
    expect(plan?.placements).toHaveLength(2)
    expect(visualPlan?.modules ?? []).toHaveLength(0)
  })

  it('rejects a placement referencing a missing node with the exact id', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        placements: [
          ...base.placements,
          { id: 'ghost', boxHint: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 }, visualRole: 'primary' },
        ],
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
    )
    expect(plan).toBeNull()
    expect(errors.some((e) => e.includes('placement "ghost" references missing node'))).toBe(true)
  })

  it('rejects out-of-range boxHint fractions', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        placements: [
          { id: 'a', boxHint: { x: 0.1, y: 0.2, w: 1.7, h: 0.3 }, visualRole: 'dominant' },
        ],
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
    )
    expect(plan).toBeNull()
    expect(errors.some((e) => e.includes('boxHint.w=1.7 outside 0..1'))).toBe(true)
  })

  it('rejects an unsupported reading flow', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        composition: { ...base.composition, readingFlow: 'diagonal' },
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
    )
    expect(plan).toBeNull()
    expect(errors.some((e) => e.includes('composition.readingFlow "diagonal" unsupported'))).toBe(
      true,
    )
  })

  it('rejects an unsupported visualRole', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        placements: [{ id: 'a', boxHint: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, visualRole: 'hero' }],
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
    )
    expect(plan).toBeNull()
    expect(errors.some((e) => e.includes('visualRole "hero" unsupported'))).toBe(true)
  })

  it('empty placements stay legal (documented deterministic fallback contract)', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      { composition: base.composition, placements: [] },
      SPATIAL_PLAN_NODES.map((n) => n.id),
    )
    // legal fallback: plan stays null but with ZERO errors — the orchestrator
    // treats a null model plan as the deterministic-priors signal
    expect(errors).toEqual([])
    expect(plan).toBeNull()
  })

  it('visualPlan module referencing a missing node is a hard error', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        visualPlan: {
          modules: [
            {
              moduleId: 'ghost-module',
              microLayout: 'rows',
              units: [{ id: 'u1', label: 'x', role: 'substep' }],
            },
          ],
        },
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
      { edgeIds: PLAN_EDGE_IDS },
    )
    expect(plan).toBeNull()
    expect(
      errors.some((e) => e.includes('visualPlan module "ghost-module" references missing node')),
    ).toBe(true)
  })

  it('visualPlan unit referencing a missing edge is a hard error', () => {
    const { plan, errors } = parseSpatialPlanWithDiagnostics(
      {
        ...base,
        visualPlan: {
          modules: [
            {
              moduleId: 'a',
              microLayout: 'rows',
              units: [{ id: 'u1', label: 'x', role: 'condition', semanticEdgeId: 'e-missing' }],
            },
          ],
        },
      },
      SPATIAL_PLAN_NODES.map((n) => n.id),
      { edgeIds: PLAN_EDGE_IDS },
    )
    expect(plan).toBeNull()
    expect(errors.some((e) => e.includes('references missing edge "e-missing"'))).toBe(true)
  })
})
