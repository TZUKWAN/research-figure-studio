import { describe, expect, it } from 'vitest'
import { layoutInputCoreOutput } from '../src/recipes/input-core-output.js'
import { layoutHorizontalPipeline } from '../src/recipes/horizontal-pipeline.js'

const iceBase = {
  inputNodes: [
    { component: 'data-source', title: 'In1' },
    { component: 'data-source', title: 'In2' },
  ],
  coreNodes: [{ component: 'mechanism-module', title: 'Core' }],
  outputNodes: [{ component: 'output-node', title: 'Out' }],
  canvasW: 1280,
  canvasH: 720,
}

describe('edge-driven connector topology', () => {
  it('creates connectors exclusively from explicit edges (fan-in + feedback lane)', () => {
    const layout = layoutInputCoreOutput({
      ...iceBase,
      edges: [
        { from: 'In1', to: 'Core', role: 'main' },
        { from: 'In2', to: 'Core', role: 'main', relation: 'data-flow' },
        { from: 'Out', to: 'Core', role: 'feedback', relation: 'feedback' },
      ],
    })
    expect(layout.connectors).toEqual([
      { fromIndex: 0, toIndex: 2, kind: 'straight', role: 'main', relation: 'process' },
      { fromIndex: 1, toIndex: 2, kind: 'straight', role: 'main', relation: 'data-flow' },
      {
        fromIndex: 3,
        toIndex: 2,
        kind: 'elbow',
        role: 'feedback',
        relation: 'feedback',
        laneY: expect.any(Number),
      },
    ])
    expect(layout.regions.feedbackLaneY).toEqual(expect.any(Number))
  })

  it('emits zero connectors when no edges are declared — no implicit chain', () => {
    const layout = layoutInputCoreOutput(iceBase)
    expect(layout.connectors).toEqual([])
    expect(layout.regions.feedbackLaneY).toBeUndefined()
  })

  it('throws when an edge names an unknown node or region', () => {
    expect(() =>
      layoutInputCoreOutput({ ...iceBase, edges: [{ from: 'Ghost', to: 'Core', role: 'main' }] }),
    ).toThrow(/Ghost/)
  })

  it('resolves region-level refs to every member explicitly (fan-in)', () => {
    const layout = layoutInputCoreOutput({
      ...iceBase,
      edges: [{ from: 'input', to: 'core', role: 'main' }],
    })
    expect(layout.connectors).toEqual([
      { fromIndex: 0, toIndex: 2, kind: 'straight', role: 'main', relation: 'process' },
      { fromIndex: 1, toIndex: 2, kind: 'straight', role: 'main', relation: 'process' },
    ])
  })

  it('horizontal pipeline uses explicit edges only', () => {
    const nodes = [
      { component: 'data-source', title: 'A' },
      { component: 'mechanism-module', title: 'B' },
      { component: 'output-node', title: 'C' },
    ]
    expect(layoutHorizontalPipeline({ nodes, canvasW: 1280, canvasH: 720 }).connectors).toEqual([])
    const layout = layoutHorizontalPipeline({
      nodes,
      canvasW: 1280,
      canvasH: 720,
      edges: [{ from: 'A', to: 'B', role: 'main' }],
    })
    expect(layout.connectors).toEqual([
      { fromIndex: 0, toIndex: 1, kind: 'straight', role: 'main', relation: 'process' },
    ])
    expect(() =>
      layoutHorizontalPipeline({
        nodes,
        canvasW: 1280,
        canvasH: 720,
        edges: [{ from: 'A', to: 'Nope', role: 'main' }],
      }),
    ).toThrow(/Nope/)
  })
})
