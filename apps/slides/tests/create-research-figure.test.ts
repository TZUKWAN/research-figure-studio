import { describe, expect, it, vi } from 'vitest'
import {
  addElement,
  createBlankPptx,
  deleteElement,
  openPptx,
  setElementTextBodyProps,
} from '@genoffice/pptx-engine'
import { buildRenderSlide, EMU_PER_PX_96, type RenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'

const EMU = EMU_PER_PX_96

async function makeAccess(runLlm: DeckAccess['runLlm']) {
  const opened = await openPptx(await createBlankPptx())
  const modelSlide = opened.deck.slides[0]!
  let rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
  const addElementOp = vi.fn(async (op: any) => {
    const element = addElement(modelSlide, {
      kind: op.kind,
      offset: {
        x: Math.round(op.xPx * EMU),
        y: Math.round(op.yPx * EMU),
        cx: Math.round(op.wPx * EMU),
        cy: Math.round(op.hPx * EMU),
      },
      ...(op.paragraphs ? { paragraphs: op.paragraphs } : {}),
      ...(op.fillColor ? { fillColor: op.fillColor } : {}),
      ...(op.stroke ? { stroke: op.stroke } : {}),
      ...(op.semanticMetadata ? { semanticMetadata: op.semanticMetadata } : {}),
      bodyPr: { insetsEmu: { l: 0, t: 0, r: 0, b: 0 } },
    })
    rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
    return { slide: rendered, sourceId: element.id }
  })
  const setTextBodyProps = vi.fn(async (op: any) => {
    if (!setElementTextBodyProps(modelSlide, op.sourceId, op.props)) return null
    rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
    return rendered
  })
  const editConnectorEndpoints = vi.fn(async (op: any) => {
    const element = modelSlide.elements.find((e) => e.id === op.sourceId)
    if (!element) return null
    const update = element as { connector?: any }
    update.connector = {
      startTargetId: op.start.targetId,
      startIdx: op.start.idx,
      endTargetId: op.end.targetId,
      endIdx: op.end.idx,
      ...(op.routeYPx !== undefined ? { routeYPx: op.routeYPx } : {}),
    }
    rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
    return rendered
  })
  const removeElement = vi.fn(async (op: any) => {
    if (!deleteElement(opened, modelSlide, op.sourceId)) return null
    rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
    return rendered
  })
  // the wired executor also commits the slide-level semantic payload via txn
  const applyTxn = vi.fn(async () => ({ applied: true }))
  ;(window as any).slidesApi = {
    addElement: addElementOp,
    applyTxn,
    setTextBodyProps,
    editConnectorEndpoints,
    deleteElement: removeElement,
  }
  const applySlide = vi.fn((_index: number, slide: RenderSlide) => {
    rendered = slide
  })
  const access = {
    getSlides: () => [rendered],
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide,
    applyDeck: vi.fn(),
    fitWidthPx: 1280,
    runLlm,
  } as unknown as DeckAccess
  return { access, addElementOp, editConnectorEndpoints, removeElement, openEd: () => rendered }
}

describe('create_research_figure production integration', () => {
  it('renders explicit visual units and semantically presented connectors by semantic ID', async () => {
    const figurePlan = {
      thesis: '共同注意通过同步化提升协作效率，情绪传播受用户角色调节。',
      figureType: 'mechanism',
      narrative: {
        expressionMode: 'mechanism',
        complexity: 'compact',
        centralMessage: '共同注意提升协作效率',
        visualCenter: 'shared-attention',
        readingPath: ['shared-attention', 'sync', 'collab'],
        mustShow: ['shared-attention', 'sync', 'collab'],
        mayMerge: [],
        omitFromCanvas: ['background theory'],
      },
      nodes: [
        {
          id: 'shared-attention',
          type: 'mechanism',
          semanticLabel: '共同注意机制',
          visible: { title: '共同注意' },
          importance: 0.9,
          role: 'core',
        },
        {
          id: 'sync',
          type: 'process',
          semanticLabel: '同步化过程',
          visible: { title: '同步化' },
          importance: 0.7,
          role: 'intermediate',
        },
        {
          id: 'collab',
          type: 'outcome',
          semanticLabel: '协作效率结果',
          visible: { title: '协作效率' },
          importance: 0.8,
          role: 'output',
        },
      ],
      edges: [
        {
          id: 'e1',
          from: 'shared-attention',
          to: 'sync',
          role: 'main',
          relation: 'causal',
          presentation: 'arrow',
        },
        {
          id: 'e2',
          from: 'sync',
          to: 'collab',
          role: 'main',
          relation: 'causal',
          presentation: 'arrow',
        },
        {
          id: 'e3',
          from: 'sync',
          to: 'collab',
          role: 'main',
          relation: 'moderation',
          presentation: 'dashed-arrow',
          label: '由角色调节',
        },
      ],
      groups: [],
      globalIntent: { emphasis: ['shared-attention'], secondary: ['sync'], optional: [] },
    }
    const spatialPlan = {
      composition: {
        readingFlow: 'LR',
        balance: 'loosely-balanced',
        density: 'medium',
        visualCenter: 'shared-attention',
        whitespaceStrategy: 'balanced',
      },
      placements: [
        {
          id: 'shared-attention',
          boxHint: { x: 0.08, y: 0.3, w: 0.28, h: 0.42 },
          visualRole: 'dominant',
        },
        { id: 'sync', boxHint: { x: 0.46, y: 0.32, w: 0.2, h: 0.22 }, visualRole: 'primary' },
        { id: 'collab', boxHint: { x: 0.72, y: 0.3, w: 0.22, h: 0.24 }, visualRole: 'secondary' },
      ],
      visualPlan: {
        modules: [
          {
            moduleId: 'shared-attention',
            microLayout: 'chips',
            units: [
              {
                id: 'sa-1',
                label: '视线汇聚',
                role: 'substep',
                semanticNodeId: 'shared-attention',
              },
              {
                id: 'sa-2',
                label: '共同指认',
                role: 'substep',
                semanticNodeId: 'shared-attention',
              },
              { id: 'sa-3', label: '角色调节', role: 'condition', semanticEdgeId: 'e3' },
            ],
          },
        ],
        relations: [{ semanticEdgeId: 'e3', presentation: 'dashed-arrow' }],
      },
    }
    const runLlm = vi.fn(async (system: string) => {
      if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
      if (system.includes('Composition Designer'))
        return { ok: true, text: JSON.stringify(spatialPlan) }
      return { ok: false, error: 'unexpected prompt' }
    })
    const { access, addElementOp, editConnectorEndpoints } = await makeAccess(runLlm)
    const result = await createSlidesSkill(access, 'research').executeTool({
      id: 'create-semantic-figure',
      name: 'create_research_figure',
      input: {
        slideIndex: 0,
        thesis: figurePlan.thesis,
        capability: {
          calibration: { spatialPlanning: 'strong', jsonReliability: 'high' },
        },
      },
    })

    expect(result.isError, result.output).toBeUndefined()
    expect(result.output).not.toContain('Failed')
    expect(runLlm).toHaveBeenCalledTimes(2)
    const metadata = addElementOp.mock.calls.map(([op]) => op.semanticMetadata ?? {})
    expect(metadata.filter((m) => m.componentType === 'research-module')).toHaveLength(3)
    expect(metadata.filter((m) => m.componentType === 'research-micro')).toHaveLength(3)
    expect(metadata.filter((m) => m.componentType === 'research-connector')).toHaveLength(3)
    expect(
      metadata.filter((m) => m.componentType === 'research-connector').map((m) => m.semanticEdgeId),
    ).toEqual(['e1', 'e2', 'e3'])
    expect(editConnectorEndpoints).toHaveBeenCalledTimes(3)
  })

  it('leaves a statement as one clean expression without cards or connectors', async () => {
    const plan = {
      thesis: '取消算法约束堆叠。全部交给提示词。',
      figureType: 'statement',
      narrative: {
        expressionMode: 'statement',
        complexity: 'minimal',
        centralMessage: '取消算法约束堆叠。全部交给提示词。',
        mustShow: ['statement'],
        mayMerge: [],
        omitFromCanvas: ['implementation details'],
      },
      nodes: [
        {
          id: 'statement',
          type: 'annotation',
          semanticLabel: '取消算法约束堆叠。全部交给提示词。',
          visible: { title: '取消算法约束堆叠。全部交给提示词。' },
          importance: 1,
          role: 'core',
        },
      ],
      edges: [],
      groups: [],
      globalIntent: { emphasis: ['statement'], secondary: [], optional: [] },
    }
    const spatial = {
      composition: {
        readingFlow: 'mixed',
        balance: 'asymmetric',
        density: 'low',
        visualCenter: 'statement',
        whitespaceStrategy: 'open',
      },
      placements: [
        {
          id: 'statement',
          boxHint: { x: 0.12, y: 0.38, w: 0.76, h: 0.3 },
          visualRole: 'dominant',
        },
      ],
    }
    const runLlm = vi.fn(async (system: string) => {
      if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(plan) }
      return { ok: true, text: JSON.stringify(spatial) }
    })
    const { access, addElementOp, editConnectorEndpoints } = await makeAccess(runLlm)
    const result = await createSlidesSkill(access, 'research').executeTool({
      id: 'create-statement',
      name: 'create_research_figure',
      input: {
        slideIndex: 0,
        thesis: plan.thesis,
        capability: {
          calibration: { spatialPlanning: 'strong', jsonReliability: 'high' },
        },
      },
    })

    expect(result.isError, result.output).toBeUndefined()
    const metadata = addElementOp.mock.calls.map(([op]) => op.semanticMetadata ?? {})
    expect(metadata).toHaveLength(1)
    expect(metadata[0]?.componentType).toBe('research-module')
    expect(editConnectorEndpoints).not.toHaveBeenCalled()
  })
})
