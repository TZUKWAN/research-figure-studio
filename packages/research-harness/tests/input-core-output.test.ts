import { describe, expect, it } from 'vitest'
import { layoutInputCoreOutput } from '../src/recipes/input-core-output.js'
import { auditInputCoreOutput } from '../src/qa/input-core-output.js'

const input = {
  inputNodes: [{ component: 'data-source', title: 'Input' }],
  coreNodes: [{ component: 'mechanism-module', title: 'Mechanism' }],
  outputNodes: [{ component: 'output-node', title: 'Output' }],
  edges: [
    { from: 'Input', to: 'Mechanism', role: 'main' as const },
    { from: 'Mechanism', to: 'Output', role: 'main' as const },
  ],
  canvasW: 1280,
  canvasH: 720,
}

describe('auditInputCoreOutput', () => {
  it('accepts a clean three-zone layout with its main flow', () => {
    const layout = layoutInputCoreOutput(input)
    const result = auditInputCoreOutput(layout, 1280, 720)

    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.metrics.mainConnectorCount).toBe(2)
  })

  it('resolves component widths against the full canvas, not the zone width', () => {
    const layout = layoutInputCoreOutput(input)
    expect(layout.elements.map((element) => element.w)).toEqual([205, 282, 205])
  })

  it('rejects a narrow canvas when a component crosses its assigned zone', () => {
    const layout = layoutInputCoreOutput({ ...input, canvasW: 400 })
    const result = auditInputCoreOutput(layout, 400, 720)

    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.includes('zone'))).toBe(true)
  })

  it('accepts and requires the explicit feedback edge when the plan declares one', () => {
    const layout = layoutInputCoreOutput({
      ...input,
      edges: [
        ...input.edges,
        { from: 'Output', to: 'Mechanism', role: 'feedback' as const, relation: 'feedback' },
      ],
    })
    expect(auditInputCoreOutput(layout, 1280, 720, { requireFeedback: true }).ok).toBe(true)

    layout.connectors.pop()
    const result = auditInputCoreOutput(layout, 1280, 720, { requireFeedback: true })
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.includes('feedback'))).toBe(true)
  })

  it('reports invalid geometry and connector references', () => {
    const layout = layoutInputCoreOutput(input)
    layout.elements[1]!.x = -20
    layout.connectors[0] = { fromIndex: 0, toIndex: 99, kind: 'straight', role: 'main' }

    const result = auditInputCoreOutput(layout, 1280, 720)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.includes('overflow'))).toBe(true)
    expect(result.issues.some((issue) => issue.includes('reference'))).toBe(true)
  })
})
