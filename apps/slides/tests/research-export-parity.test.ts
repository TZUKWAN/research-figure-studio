/**
 * RENDER-P1-07 (export parity, model level) + P1-06 (theme color fidelity).
 *
 * The figure a user SAW on the canvas at commit time must be the figure a
 * reopened deck (and therefore PNG/PDF export) renders: identical bounding
 * boxes, identical resolved colors, identical connector geometry. Pixel-level
 * screenshot regression is a separate visual-baseline effort; this pins the
 * deterministic geometry and color pipeline end to end through the archive.
 */
import { describe, expect, it, vi } from 'vitest'
import { commitSaved, openPptx, savePptx } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { makeTxnAccess } from './research-txn-mock'

const figurePlan = {
  thesis: '机制A经由过程B驱动结果C。',
  figureType: 'mechanism',
  narrative: {
    expressionMode: 'mechanism',
    complexity: 'compact',
    centralMessage: 'A驱动C',
    visualCenter: 'a',
    readingPath: ['a', 'b', 'c'],
    mustShow: ['a', 'b', 'c'],
    mayMerge: [],
    omitFromCanvas: [],
  },
  nodes: [
    {
      id: 'a',
      type: 'mechanism',
      semanticLabel: '机制A',
      visible: { title: '机制A' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'b',
      type: 'process',
      semanticLabel: '过程B',
      visible: { title: '过程B' },
      importance: 0.6,
      role: 'intermediate',
    },
    {
      id: 'c',
      type: 'outcome',
      semanticLabel: '结果C',
      visible: { title: '结果C' },
      importance: 0.8,
      role: 'output',
    },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
    { id: 'e2', from: 'b', to: 'c', role: 'main', relation: 'causal', presentation: 'arrow' },
  ],
  groups: [],
  globalIntent: { emphasis: ['a'], secondary: ['b'], optional: [] },
}

const spatialPlan = {
  composition: {
    readingFlow: 'LR',
    balance: 'loosely-balanced',
    density: 'medium',
    visualCenter: 'a',
    whitespaceStrategy: 'balanced',
  },
  placements: [
    { id: 'a', boxHint: { x: 0.1, y: 0.3, w: 0.24, h: 0.3 }, visualRole: 'dominant' },
    { id: 'b', boxHint: { x: 0.44, y: 0.34, w: 0.18, h: 0.2 }, visualRole: 'primary' },
    { id: 'c', boxHint: { x: 0.72, y: 0.34, w: 0.2, h: 0.22 }, visualRole: 'secondary' },
  ],
}

describe('canvas ↔ reopened deck parity (research figure)', () => {
  it('boxes, colors and connector geometry survive save → reopen byte surgery', async () => {
    const runLlm = vi.fn(async (system: string) => {
      if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
      if (system.includes('Composition Designer'))
        return { ok: true, text: JSON.stringify(spatialPlan) }
      return { ok: false, error: 'unexpected prompt' }
    })
    const { access, opened } = await makeTxnAccess(runLlm)
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'parity-figure',
        name: 'create_research_figure',
        input: { slideIndex: 0, thesis: figurePlan.thesis },
      },
    )
    expect(result.isError, result.output).toBeUndefined()

    // Canvas state at commit (what the user saw and what PNG export draws)
    const canvas = access.getSlides()[0]!
    commitSaved(opened)
    const bytes = await savePptx(opened)
    const reopened = await openPptx(bytes)
    const exportSlide = buildRenderSlide(reopened.deck.slides[0]!, reopened.deck.size, {
      fitWidthPx: 1280,
    })

    type Node = {
      sourceId: string
      box: { x: number; y: number; w: number; h: number }
      semanticMetadata?: Record<string, string>
      fill?: { kind: string; color?: string }
    }
    const solidColor = (node: Node): string | undefined =>
      node.fill?.kind === 'solid' ? node.fill.color?.toUpperCase() : undefined
    const flatten = (nodes: Array<Node>): Node[] =>
      nodes.flatMap((n) => [n, ...((n as unknown as { children?: Node[] }).children ?? [])])
    const canvasNodes = flatten(canvas.nodes as unknown as Array<Node>)
    const exportNodes = flatten(exportSlide.nodes as unknown as Array<Node>)
    const keyOf = (node: Node) =>
      node.semanticMetadata
        ? `${node.semanticMetadata.componentType}|${node.semanticMetadata.semanticNodeId ?? ''}|${node.semanticMetadata.visualUnitId ?? ''}|${node.semanticMetadata.semanticEdgeId ?? ''}`
        : node.sourceId
    const canvasByKey = new Map(canvasNodes.map((n) => [keyOf(n), n]))
    const exportByKey = new Map(exportNodes.map((n) => [keyOf(n), n]))

    // every research element on the canvas exists in the reopened render
    expect(exportByKey.size).toBeGreaterThanOrEqual(canvasByKey.size)
    for (const [key, canvasNode] of canvasByKey) {
      const exportNode = exportByKey.get(key)
      expect(exportNode, `missing after reopen: ${key}`).toBeTruthy()
      const d = (a: number, b: number) => Math.abs(a - b)
      expect(d(exportNode!.box.x, canvasNode.box.x)).toBeLessThanOrEqual(1.5)
      expect(d(exportNode!.box.y, canvasNode.box.y)).toBeLessThanOrEqual(1.5)
      expect(d(exportNode!.box.w, canvasNode.box.w)).toBeLessThanOrEqual(1.5)
      expect(d(exportNode!.box.h, canvasNode.box.h)).toBeLessThanOrEqual(1.5)
      // theme fill fidelity (P1-06): solid fills must carry the same hex
      const canvasFill = solidColor(canvasNode)
      if (canvasFill) {
        expect(solidColor(exportNode!)).toBe(canvasFill)
      }
    }

    // slide-level semantic graph rides the archive for AI re-editing
    const payload = exportSlide.researchMetadata
    expect(payload?.relations.map((r) => r.id)).toEqual(['e1', 'e2'])
  })

  it('read_slide recovers the semantic graph for AI re-editing (P0-11)', async () => {
    const runLlm = vi.fn(async (system: string) => {
      if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
      if (system.includes('Composition Designer'))
        return { ok: true, text: JSON.stringify(spatialPlan) }
      return { ok: false, error: 'unexpected prompt' }
    })
    const { access } = await makeTxnAccess(runLlm)
    const skill = createSlidesSkill(access as unknown as DeckAccess, 'research')
    const created = await skill.executeTool({
      id: 'ctx-figure',
      name: 'create_research_figure',
      input: { slideIndex: 0, thesis: figurePlan.thesis },
    })
    expect(created.isError, created.output).toBeUndefined()
    const read = await skill.executeTool({
      id: 'ctx-read',
      name: 'read_slide',
      input: { slideIndex: 0 },
    })
    expect(read.isError).toBeUndefined()
    expect(read.output).toContain('<research-figure-context>')
    expect(read.output).toContain('figure fig-')
    expect(read.output).toContain('e1')
    expect(read.output).toContain('research elements:')
  })
})
