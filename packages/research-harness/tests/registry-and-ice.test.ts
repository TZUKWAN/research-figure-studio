import { describe, expect, it } from 'vitest'
import {
  getComponentSpec,
  resolveSize,
  RESEARCH_COMPONENT_REGISTRY,
} from '../src/components/registry.js'
import { layoutInputCoreOutput } from '../src/recipes/input-core-output.js'

describe('ResearchComponentRegistry', () => {
  it('exposes the core research component kinds', () => {
    for (const k of [
      'data-source',
      'process-node',
      'model-module',
      'mechanism-module',
      'output-node',
      'evidence-node',
      'annotation',
      'section-container',
    ]) {
      expect(RESEARCH_COMPONENT_REGISTRY.has(k), k).toBe(true)
    }
  })

  it('throws on unknown kind', () => {
    expect(() => getComponentSpec('nope')).toThrow(/Unknown research component/)
  })

  it('resolveSize honors minimums on tiny canvases', () => {
    const s = resolveSize('mechanism-module', 200, 150)
    const spec = getComponentSpec('mechanism-module')
    expect(s.w).toBeGreaterThanOrEqual(spec.minWpx)
    expect(s.h).toBeGreaterThanOrEqual(spec.minHpx)
  })

  it('scales with canvas size', () => {
    const small = resolveSize('process-node', 1280, 720)
    const large = resolveSize('process-node', 2560, 1440)
    expect(large.w).toBeGreaterThan(small.w)
  })
})

describe('layoutInputCoreOutput', () => {
  const plan = {
    inputNodes: [
      { component: 'data-source', title: 'Multi-source data' },
      { component: 'evidence-node', title: 'Evidence' },
    ],
    coreNodes: [
      { component: 'mechanism-module', title: 'Feature encoding' },
      { component: 'model-module', title: 'State predictor' },
    ],
    outputNodes: [{ component: 'output-node', title: 'Service decision' }],
    feedback: true,
    canvasW: 1280,
    canvasH: 720,
  }

  it('places all elements inside the canvas', () => {
    const l = layoutInputCoreOutput(plan)
    expect(l.elements).toHaveLength(5)
    for (const e of l.elements) {
      expect(e.x).toBeGreaterThanOrEqual(0)
      expect(e.y).toBeGreaterThanOrEqual(0)
      expect(e.x + e.w).toBeLessThanOrEqual(1280)
      expect(e.y + e.h).toBeLessThanOrEqual(720)
    }
  })

  it('keeps zones ordered left-to-right without overlap', () => {
    const l = layoutInputCoreOutput(plan)
    expect(l.regions.input.x + l.regions.input.w).toBeLessThanOrEqual(l.regions.core.x)
    expect(l.regions.core.x + l.regions.core.w).toBeLessThanOrEqual(l.regions.output.x)
  })

  it('emits connectors exclusively from the declared semantic edges', () => {
    const l = layoutInputCoreOutput({
      ...plan,
      edges: [
        // fan-in: both inputs feed the first core module (group semantics)
        { from: 'input', to: 'Feature encoding', role: 'main' },
        { from: 'Feature encoding', to: 'State predictor', role: 'main' },
        { from: 'State predictor', to: 'Service decision', role: 'main' },
        {
          from: 'Service decision',
          to: 'Feature encoding',
          role: 'feedback',
          relation: 'feedback',
        },
      ],
    })
    const main = l.connectors.filter((c) => c.role === 'main')
    expect(main).toHaveLength(4)
    expect(main[0]).toMatchObject({ fromIndex: 0, toIndex: 2 })
    expect(main[1]).toMatchObject({ fromIndex: 1, toIndex: 2 })
    expect(main[2]).toMatchObject({ fromIndex: 2, toIndex: 3 })
    expect(main[3]).toMatchObject({ fromIndex: 3, toIndex: 4 })
    const feedback = l.connectors.filter((c) => c.role === 'feedback')
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toMatchObject({ fromIndex: 4, toIndex: 2, kind: 'elbow' })
    expect(feedback[0]?.laneY).toBe(l.regions.feedbackLaneY)
    // no edges declared → no connectors at all (no implicit chain)
    expect(layoutInputCoreOutput({ ...plan, feedback: false }).connectors).toEqual([])
  })

  it('centers single-element zones vertically', () => {
    const l = layoutInputCoreOutput({ ...plan, feedback: false })
    const out = l.elements[l.elements.length - 1]
    const mid = out.y + out.h / 2
    expect(Math.abs(mid - 360)).toBeLessThanOrEqual(2)
  })

  it('handles empty zones gracefully', () => {
    const l = layoutInputCoreOutput({
      inputNodes: [],
      coreNodes: [{ component: 'process-node', title: 'Only core' }],
      outputNodes: [],
      canvasW: 1280,
      canvasH: 720,
    })
    expect(l.elements).toHaveLength(1)
    expect(l.connectors).toHaveLength(0)
  })
})
