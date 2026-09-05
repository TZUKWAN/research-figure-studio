/**
 * RENDER-P0-01/02/03/05/06/14 + P1-03: the PURE native figure render plan.
 * Deterministic: exact solver geometry, explicit detail dispositions,
 * domain-inherited micro styling, one connector per edge with final-rect
 * anchors, and a documented z-order.
 */
import { describe, expect, it } from 'vitest'
import { getThemeById } from '@genoffice/theme-engine'
import {
  buildFigureRenderPlan,
  type FigureRenderInput,
} from '../src/renderer/research/native-figure-renderer'

const theme = getThemeById('academic-blue')!

function baseInput(_overrides?: Partial<FigureRenderInput>): FigureRenderInput {
  return {
    plan: {
      nodes: [
        {
          id: 'a',
          type: 'mechanism',
          visible: { title: 'Mechanism A', detail: 'the hidden detail text' },
        },
        { id: 'b', type: 'process', visible: { title: 'Process B' } },
        { id: 'c', type: 'outcome', visible: { title: 'Outcome C' } },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', relation: 'causal', presentation: 'arrow' },
        { id: 'e2', from: 'b', to: 'c', relation: 'causal', presentation: 'arrow' },
      ],
    },
    solve: {
      placements: [
        { id: 'a', x: 80, y: 200, w: 220, h: 190 },
        { id: 'b', x: 420, y: 240, w: 160, h: 80 },
        { id: 'c', x: 700, y: 240, w: 150, h: 80 },
      ],
    },
    routes: [
      {
        key: 'e1',
        semanticEdgeId: 'e1',
        fromId: 'a',
        toId: 'b',
        role: 'main',
        relation: 'causal',
        presentation: 'arrow',
        status: 'routed',
        kind: 'straight',
        start: { side: 'right', idx: 3 },
        end: { side: 'left', idx: 1 },
        laneOffsetPx: 0,
      },
      {
        key: 'e2',
        semanticEdgeId: 'e2',
        fromId: 'b',
        toId: 'c',
        role: 'main',
        relation: 'causal',
        presentation: 'arrow',
        status: 'routed',
        kind: 'straight',
        start: { side: 'right', idx: 3 },
        end: { side: 'left', idx: 1 },
        laneOffsetPx: 0,
      },
    ],
    visualPlan: { modules: [] },
    canvasW: 1280,
    canvasH: 720,
    theme: theme.roles,
    thesis: 'test thesis',
  }
}

describe('native figure render plan (pure)', () => {
  it('consumes solver geometry verbatim — module boxes equal placements', () => {
    const plan = buildFigureRenderPlan(baseInput())
    expect(plan.defects).toEqual([])
    for (const placement of baseInput().solve.placements) {
      const element = plan.elements.find((e) => e.specId === `module:${placement.id}`)!
      expect([element.x, element.y, element.w, element.h]).toEqual([
        placement.x,
        placement.y,
        placement.w,
        placement.h,
      ])
    }
  })

  it('detail without a module decomposition renders in the parent (P0-05)', () => {
    const plan = buildFigureRenderPlan(baseInput())
    const moduleA = plan.elements.find((e) => e.specId === 'module:a')!
    expect(moduleA.detailDisposition).toBe('render-in-parent')
    expect(moduleA.paragraphs).toHaveLength(2)
    expect(moduleA.paragraphs[1]!.runs[0]!.text).toBe('the hidden detail text')
    // slide payload records the disposition
    expect(plan.slideMetadata.nodes.find((n) => n.id === 'a')?.detailDisposition).toBe(
      'render-in-parent',
    )
  })

  it('micro units inherit the module kind style and stay inside the solved box (P0-06)', () => {
    const input = baseInput()
    input.visualPlan = {
      modules: [
        {
          moduleId: 'a',
          microLayout: 'rows',
          units: [
            { id: 'u1', label: 'step one', role: 'substep' },
            { id: 'u2', label: 'step two', role: 'substep' },
          ],
        },
      ],
    }
    const plan = buildFigureRenderPlan(input)
    expect(plan.defects).toEqual([])
    const parent = plan.elements.find((e) => e.specId === 'module:a')!
    const units = plan.elements.filter((e) => e.specId.startsWith('unit:a#'))
    expect(units).toHaveLength(2)
    for (const unit of units) {
      // inheritance: same resolved fill/stroke family as the module
      expect(unit.fillColor).toBe(parent.fillColor)
      expect(unit.stroke.color).toBe(parent.stroke.color)
      expect(unit.semanticMetadata?.parentModuleId).toBe('a')
      expect(unit.semanticMetadata?.componentType).toBe('research-micro')
      // no re-clamping: unit h is layoutMicro's output verbatim
      expect(unit.h).toBeGreaterThanOrEqual(42)
      expect(unit.y + unit.h).toBeLessThanOrEqual(parent.y + parent.h + 0.5)
      // grouped with the parent
      expect(unit.semanticMetadata?.visualUnitId).toBeTruthy()
    }
    // composite module closes as a group: parent first, then its units
    const group = plan.groups.find((g) => g.specId === 'module:a')!
    expect(group.memberSpecIds[0]).toBe('module:a')
    expect(group.memberSpecIds).toHaveLength(3)
  })

  it('shortfall between solved box and unit needs is a HARD defect (no silent inflation)', () => {
    const input = baseInput()
    input.visualPlan = {
      modules: [
        {
          moduleId: 'b',
          microLayout: 'rows',
          units: Array.from({ length: 5 }, (_, i) => ({
            id: `u${i}`,
            label: `step ${i}`,
            role: 'substep' as const,
          })),
        },
      ],
    }
    const plan = buildFigureRenderPlan(input)
    const hard = plan.defects.filter((d) => d.severity === 'hard')
    expect(hard.length).toBeGreaterThan(0)
    expect(hard[0]!.message).toContain('module "b"')
  })

  it('multi-edge pair keeps one connector per edge with distinct ids (P0-14)', () => {
    const input = baseInput()
    input.plan.edges.push({
      id: 'e3',
      from: 'b',
      to: 'c',
      relation: 'moderation',
      presentation: 'dashed-arrow',
    })
    input.routes.push({
      key: 'e3',
      semanticEdgeId: 'e3',
      fromId: 'b',
      toId: 'c',
      role: 'main',
      relation: 'moderation',
      presentation: 'dashed-arrow',
      status: 'routed',
      kind: 'elbow',
      start: { side: 'bottom', idx: 2 },
      end: { side: 'top', idx: 0 },
      laneOffsetPx: 12,
    })
    const plan = buildFigureRenderPlan(input)
    const connectors = plan.elements.filter((e) => e.specId.startsWith('connector:'))
    expect(connectors).toHaveLength(3)
    expect(new Set(connectors.map((e) => e.specId)).size).toBe(3)
    expect(connectors.map((e) => e.semanticMetadata?.semanticEdgeId)).toEqual(['e1', 'e2', 'e3'])
    // presentation drives the native kind: dashed moderation bends, arrows go straight
    expect(connectors[2]!.kind).toBe('lineBent')
    expect(connectors[0]!.kind).toBe('lineArrow')
    // bindings anchor to FINAL module rects
    for (const binding of plan.bindings) {
      expect(binding.start.targetSpecId).toMatch(/^module:/)
      expect(binding.end.targetSpecId).toMatch(/^module:/)
    }
  })

  it('z-order is deterministic: background < container < connector < node < annotation (P1-03)', () => {
    const input = baseInput()
    input.plan.nodes.unshift({
      id: 'bg',
      type: 'context',
      visible: { title: 'Context Region' },
    })
    input.plan.nodes.push({
      id: 'note',
      type: 'annotation',
      visible: { title: 'Note' },
    })
    input.solve.placements.unshift({ id: 'bg', x: 20, y: 20, w: 400, h: 300 })
    input.solve.placements.push({ id: 'note', x: 900, y: 100, w: 120, h: 60 })
    const plan = buildFigureRenderPlan(input)
    const tierOf = (specId: string) => plan.elements.find((e) => e.specId === specId)!.zTier
    expect(tierOf('module:bg')).toBeLessThan(tierOf('module:a'))
    expect(tierOf('module:bg')).toBeLessThan(tierOf('connector:e1'))
    expect(tierOf('connector:e1')).toBeLessThan(tierOf('module:b'))
    expect(tierOf('module:b')).toBeLessThan(tierOf('module:note'))
    // creation order is ascending by tier (deterministic z)
    for (let i = 1; i < plan.elements.length; i++) {
      expect(plan.elements[i]!.zTier).toBeGreaterThanOrEqual(plan.elements[i - 1]!.zTier)
    }
  })

  it('slide payload preserves suppressed relations (P0-10)', () => {
    const input = baseInput()
    input.plan.edges.push({
      id: 'e9',
      from: 'a',
      to: 'c',
      relation: 'correlation',
      presentation: 'alignment',
    })
    const plan = buildFigureRenderPlan(input)
    const e9 = plan.slideMetadata.relations.find((r) => r.id === 'e9')!
    expect(e9.status).toBe('spatial')
    expect(e9.reason).toContain('alignment')
    expect(plan.slideMetadata.schemaVersion).toBe(1)
    expect(plan.slideMetadata.thesis).toBe('test thesis')
  })
})
