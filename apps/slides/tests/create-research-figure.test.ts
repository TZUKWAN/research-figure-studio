import { describe, expect, it, vi } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { makeTxnAccess } from './research-txn-mock'

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

function researchRunLlm() {
  return vi.fn(async (system: string) => {
    if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
    if (system.includes('Composition Designer'))
      return { ok: true, text: JSON.stringify(spatialPlan) }
    return { ok: false, error: 'unexpected prompt' }
  })
}

describe('create_research_figure production integration', () => {
  it('commits one atomic transaction: exact geometry, grouped units, bound connectors', async () => {
    const { access, applyTxn, opened } = await makeTxnAccess(researchRunLlm())
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'create-semantic-figure',
        name: 'create_research_figure',
        input: {
          slideIndex: 0,
          thesis: figurePlan.thesis,
          capability: {
            calibration: { spatialPlanning: 'strong', jsonReliability: 'high' },
          },
        },
      },
    )

    expect(result.isError, result.output).toBeUndefined()
    expect(runLlmCallsHasBothRoles(applyTxn)).toBe(true)
    // One atomic transaction carries the whole figure (P0-12)
    const req = applyTxn.mock.calls[0]![0] as { ops: Array<Record<string, unknown>> }
    const opNames = req.ops.map((op) => op.op)
    expect(opNames.filter((name) => name === 'addElement').length).toBe(9) // 3 modules + 3 units + 3 connectors
    expect(opNames.filter((name) => name === 'setConnectorEndpoints').length).toBe(3)
    // The decomposed module closes as a native group (P0-07)
    expect(opNames.filter((name) => name === 'groupElements').length).toBe(1)
    expect(opNames).toContain('setSlideResearchMetadata')

    // Model-level truth: modules, units, connectors, bindings, group
    const slide = opened.deck.slides[0]!
    const allElements: Array<{
      semanticMetadata?: {
        componentType?: string
        semanticEdgeId?: string
        semanticNodeId?: string
        parentModuleId?: string
        visualUnitId?: string
        figureRunId?: string
        domain?: string
      }
      transform: { offset: { x: number; y: number; cx: number; cy: number } }
      connection?: { start?: { id: number }; end?: { id: number } }
      type: string
    }> = []
    const collect = (els: typeof allElements) => {
      for (const el of els) {
        allElements.push(el)
        if (el.type === 'group')
          collect((el as unknown as { children: typeof allElements }).children)
      }
    }
    collect(slide.elements as unknown as typeof allElements)
    const modules = allElements.filter(
      (el) => el.semanticMetadata?.componentType === 'research-module',
    )
    const micros = allElements.filter(
      (el) => el.semanticMetadata?.componentType === 'research-micro',
    )
    const connectors = allElements.filter(
      (el) => el.semanticMetadata?.componentType === 'research-connector',
    )
    expect(modules).toHaveLength(3)
    expect(micros).toHaveLength(3)
    expect(connectors).toHaveLength(3)
    expect(connectors.map((el) => el.semanticMetadata?.semanticEdgeId)).toEqual(['e1', 'e2', 'e3'])
    expect(
      connectors.every((el) => el.connection?.start?.id != null && el.connection?.end?.id != null),
    ).toBe(true)
    // Multi-edge (P0-14): e2 and e3 share the sync→collab pair but stay distinct connectors
    const syncCollab = connectors.filter(
      (el) =>
        el.semanticMetadata?.semanticEdgeId === 'e2' ||
        el.semanticMetadata?.semanticEdgeId === 'e3',
    )
    expect(syncCollab).toHaveLength(2)
    // Extended metadata round-trips in the model (P0-08)
    const module = modules.find((el) => el.semanticMetadata?.semanticNodeId === 'shared-attention')!
    expect(module.semanticMetadata?.figureRunId).toMatch(/^fig-/)
    expect(module.semanticMetadata?.domain).toBeTruthy()
    // Micro units inherit the module identity (P0-06)
    for (const micro of micros) {
      expect(micro.semanticMetadata?.parentModuleId).toBe('shared-attention')
      expect(micro.semanticMetadata?.visualUnitId).toBeTruthy()
    }
    // Slide-level payload written in the same transaction (P0-10)
    const payload = slideResearchPayload(slide)
    expect(payload?.schemaVersion).toBe(1)
    expect(payload?.relations.map((r) => r.id)).toEqual(['e1', 'e2', 'e3'])
    expect(payload?.relations.every((r) => r.status === 'rendered')).toBe(true)
    // EXACT-GEOMETRY (P0-01): micro units sit inside their solved parent box
    const parentBox = module.transform.offset
    for (const micro of micros) {
      const b = micro.transform.offset
      expect(b.x).toBeGreaterThanOrEqual(parentBox.x)
      expect(b.y).toBeGreaterThanOrEqual(parentBox.y)
      expect(b.x + b.cx).toBeLessThanOrEqual(parentBox.x + parentBox.cx + 1)
      expect(b.y + b.cy).toBeLessThanOrEqual(parentBox.y + parentBox.cy + 1)
    }
  })

  it('production path invariant: per-element addElement is never the production writer (PHASE-0A)', async () => {
    const { access, applyTxn } = await makeTxnAccess(researchRunLlm())
    // Instrumentation guard: the legacy inline production path used
    // window.slidesApi.addElement per node/unit/connector. The only legal
    // writer for create_research_figure is the single atomic applyTxn.
    const addElementSpy = vi.fn(async () => null)
    ;(window as unknown as Record<string, unknown>).slidesApi = {
      ...((window as unknown as { slidesApi: object }).slidesApi ?? {}),
      addElement: addElementSpy,
    }
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'path-invariant',
        name: 'create_research_figure',
        input: { slideIndex: 0, thesis: figurePlan.thesis },
      },
    )
    expect(result.isError, result.output).toBeUndefined()
    expect(addElementSpy).not.toHaveBeenCalled()
    expect(applyTxn).toHaveBeenCalledTimes(1)
    expect((applyTxn.mock.calls[0]![0] as { isolation?: string }).isolation).toBe('atomic')
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
    const { access } = await makeTxnAccess(runLlm)
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'create-statement',
        name: 'create_research_figure',
        input: {
          slideIndex: 0,
          thesis: plan.thesis,
          capability: {
            calibration: { spatialPlanning: 'strong', jsonReliability: 'high' },
          },
        },
      },
    )

    expect(result.isError, result.output).toBeUndefined()
    expect(result.output).toContain('1 nodes, 0 native-bound connectors')
    expect(result.output).not.toContain('Element ids: ,')
  })
})

// helpers against the real model
import type { Slide } from '@genoffice/pptx-engine'
import { getSlideResearchMetadata } from '@genoffice/pptx-engine/research-metadata'

function slideResearchPayload(slide: Slide) {
  return getSlideResearchMetadata(slide)
}

function runLlmCallsHasBothRoles(applyTxn: { mock: { calls: unknown[] } }): boolean {
  return applyTxn.mock.calls.length === 1
}
