import { describe, expect, it } from 'vitest'
import { layoutHorizontalPipeline } from '../src/recipes/horizontal-pipeline.js'
import { auditHorizontalPipeline } from '../src/qa/horizontal-pipeline.js'

const input = {
  nodes: [
    { component: 'data-source', title: 'Input' },
    { component: 'mechanism-module', title: 'Mechanism' },
    { component: 'output-node', title: 'Output' },
  ],
  canvasW: 1280,
  canvasH: 720,
}

describe('layoutHorizontalPipeline', () => {
  it('places a single baseline with connectors driven by explicit edges', () => {
    const layout = layoutHorizontalPipeline({
      ...input,
      edges: [
        { from: 'Input', to: 'Mechanism', role: 'main' as const },
        { from: 'Mechanism', to: 'Output', role: 'main' as const },
      ],
    })
    expect(layout.elements).toHaveLength(3)
    expect(layout.connectors).toEqual([
      { fromIndex: 0, toIndex: 1, kind: 'straight', role: 'main', relation: 'process' },
      { fromIndex: 1, toIndex: 2, kind: 'straight', role: 'main', relation: 'process' },
    ])
    expect(new Set(layout.elements.map((e) => e.y + e.h / 2)).size).toBe(1)
    expect(auditHorizontalPipeline(layout, 1280, 720).issues).toEqual([])
  })

  it('emits zero connectors when no edges are declared', () => {
    expect(layoutHorizontalPipeline(input).connectors).toEqual([])
  })
})

describe('auditHorizontalPipeline', () => {
  it('reports spacing, margin, overlap, overflow, and connector-direction violations', () => {
    const layout = layoutHorizontalPipeline(input)
    layout.elements[1]!.x += 40
    layout.elements[0]!.x = 10
    layout.elements[2]!.y = 700
    layout.connectors[1] = { fromIndex: 2, toIndex: 1, kind: 'straight', role: 'main' }

    const result = auditHorizontalPipeline(layout, 1280, 720)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.includes('spacing'))).toBe(true)
    expect(result.issues.some((issue) => issue.includes('margin'))).toBe(true)
    expect(result.issues.some((issue) => issue.includes('overflow'))).toBe(true)
    expect(result.issues.some((issue) => issue.includes('direction'))).toBe(true)
  })

  it('reports element overlap and invalid connector references', () => {
    const layout = layoutHorizontalPipeline(input)
    layout.elements[1]!.x = layout.elements[0]!.x + 10
    layout.connectors[0] = { fromIndex: 0, toIndex: 9, kind: 'straight', role: 'main' }

    const result = auditHorizontalPipeline(layout, 1280, 720)
    expect(result.issues.some((issue) => issue.includes('overlap'))).toBe(true)
    expect(result.issues.some((issue) => issue.includes('reference'))).toBe(true)
  })
})
