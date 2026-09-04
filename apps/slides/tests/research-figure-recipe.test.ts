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

const slide = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

describe('research figure recipes', () => {
  it('requires a FigurePlan before executing a research recipe', async () => {
    const skill = createSlidesSkill(
      {
        getSlides: () => [slide],
        getCurrent: () => 0,
        getSelectedIds: () => [],
        applySlide: vi.fn(),
        applyDeck: vi.fn(),
        fitWidthPx: 1280,
      } as unknown as DeckAccess,
      'research',
    )

    const result = await skill.executeTool({
      id: 'recipe-without-plan',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [{ component: 'data-source', title: 'Input' }],
        coreNodes: [{ component: 'mechanism-module', title: 'Core' }],
        outputNodes: [{ component: 'output-node', title: 'Output' }],
      },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('plan_research_figure')
  })

  it('stops a recipe before writing the next node after cancellation', async () => {
    const controller = new AbortController()
    let addCalls = 0
    const addElement = vi.fn(async () => {
      addCalls++
      if (addCalls === 1) controller.abort()
      return { slide, sourceId: `created-${addCalls}` }
    })
    const setTextBodyProps = vi.fn(async () => slide)
    const editConnectorEndpoints = vi.fn(async () => slide)
    const deleteElement = vi.fn(async () => slide)
    ;(window as any).slidesApi = {
      addElement,
      setTextBodyProps,
      editConnectorEndpoints,
      deleteElement,
    }
    const skill = createSlidesSkill(
      {
        getSlides: () => [slide],
        getCurrent: () => 0,
        getSelectedIds: () => [],
        applySlide: vi.fn(),
        applyDeck: vi.fn(),
        fitWidthPx: 1280,
      } as unknown as DeckAccess,
      'research',
    )
    const planResult = await skill.executeTool({
      id: 'cancel-plan',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [
          { id: 'input', role: 'input' },
          { id: 'core', role: 'core' },
          { id: 'output', role: 'output' },
        ],
        nodes: [
          { region: 'input', component: 'data-source', title: 'Input' },
          { region: 'core', component: 'mechanism-module', title: 'Core' },
          { region: 'output', component: 'output-node', title: 'Output' },
        ],
        edges: [
          { from: 'input', to: 'core', role: 'main' },
          { from: 'core', to: 'output', role: 'main' },
        ],
        negativeConstraints: [],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool(
      {
        id: 'cancel-recipe',
        name: 'create_input_core_output',
        input: {
          slideIndex: 0,
          inputNodes: [{ component: 'data-source', title: 'Input' }],
          coreNodes: [{ component: 'mechanism-module', title: 'Core' }],
          outputNodes: [{ component: 'output-node', title: 'Output' }],
        },
      },
      controller.signal,
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('cancelled')
    expect(addElement).toHaveBeenCalledOnce()
    expect(deleteElement).toHaveBeenCalledOnce()
    expect(editConnectorEndpoints).not.toHaveBeenCalled()
  })

  it('rejects recipe nodes that differ from the latest FigurePlan before native mutation', async () => {
    const skill = createSlidesSkill(
      {
        getSlides: () => [slide],
        getCurrent: () => 0,
        getSelectedIds: () => [],
        applySlide: vi.fn(),
        applyDeck: vi.fn(),
        fitWidthPx: 1280,
      } as unknown as DeckAccess,
      'research',
    )
    const planResult = await skill.executeTool({
      id: 'plan-for-recipe-guard',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [
          { id: 'input', role: 'input' },
          { id: 'core', role: 'core' },
          { id: 'output', role: 'output' },
        ],
        nodes: [
          { region: 'input', component: 'data-source', title: 'Observed data' },
          { region: 'core', component: 'mechanism-module', title: 'Mechanism' },
          { region: 'output', component: 'output-node', title: 'Validated result' },
        ],
        edges: [
          { from: 'input', to: 'core', role: 'main' },
          { from: 'core', to: 'output', role: 'main' },
        ],
        negativeConstraints: ['No overlap'],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool({
      id: 'recipe-with-unrelated-nodes',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [{ component: 'data-source', title: 'Unrelated input' }],
        coreNodes: [{ component: 'mechanism-module', title: 'Mechanism' }],
        outputNodes: [{ component: 'output-node', title: 'Validated result' }],
      },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('does not match the current FigurePlan')
  })

  it('rejects precise recipe labels without provenance before native mutation', async () => {
    const addElement = vi.fn(async () => ({ slide, sourceId: 'created-node' }))
    const setTextBodyProps = vi.fn(async () => slide)
    const editConnectorEndpoints = vi.fn(async () => slide)
    ;(window as any).slidesApi = { addElement, setTextBodyProps, editConnectorEndpoints }
    const skill = createSlidesSkill(
      {
        getSlides: () => [slide],
        getCurrent: () => 0,
        getSelectedIds: () => [],
        applySlide: vi.fn(),
        applyDeck: vi.fn(),
        fitWidthPx: 1280,
      } as unknown as DeckAccess,
      'research',
    )
    const planResult = await skill.executeTool({
      id: 'plan-with-figure',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [
          { id: 'input', role: 'input' },
          { id: 'core', role: 'core' },
          { id: 'output', role: 'output' },
        ],
        nodes: [
          { region: 'input', component: 'data-source', title: 'Observed data' },
          { region: 'core', component: 'mechanism-module', title: 'Accuracy 98.5%' },
          { region: 'output', component: 'output-node', title: 'Validated outcome' },
        ],
        edges: [
          { from: 'input', to: 'core', role: 'main' },
          { from: 'core', to: 'output', role: 'main' },
        ],
        negativeConstraints: ['No overlap'],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool({
      id: 'recipe-with-figure',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [{ component: 'data-source', title: 'Observed data' }],
        coreNodes: [{ component: 'mechanism-module', title: 'Accuracy 98.5%' }],
        outputNodes: [{ component: 'output-node', title: 'Validated outcome' }],
      },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('dataSource')
    expect(addElement).not.toHaveBeenCalled()

    const sampleResult = await skill.executeTool({
      id: 'recipe-with-sample-figure',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [{ component: 'data-source', title: 'Observed data' }],
        coreNodes: [{ component: 'mechanism-module', title: 'Accuracy 98.5%' }],
        outputNodes: [{ component: 'output-node', title: 'Validated outcome' }],
        dataSource: 'sample',
      },
    })

    expect(sampleResult.isError).toBeUndefined()
    expect(sampleResult.output).toContain('illustrative')
  })

  it('fits generated labels through the real renderer before post-write audit', async () => {
    const opened = await openPptx(await createBlankPptx())
    const modelSlide = opened.deck.slides[0]!
    let rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
    const toEmu = (px: number) => Math.round(px * EMU_PER_PX_96)
    const addElementOp = vi.fn(async (op: any) => {
      const el = addElement(modelSlide, {
        kind: op.kind,
        offset: { x: toEmu(op.xPx), y: toEmu(op.yPx), cx: toEmu(op.wPx), cy: toEmu(op.hPx) },
        ...(op.paragraphs ? { paragraphs: op.paragraphs } : {}),
        ...(op.fillColor ? { fillColor: op.fillColor } : {}),
        ...(op.stroke
          ? { stroke: { color: op.stroke.color, widthEmu: toEmu(op.stroke.widthPt / 0.75) } }
          : {}),
        ...(op.semanticMetadata ? { semanticMetadata: op.semanticMetadata } : {}),
      })
      rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
      return { slide: rendered, sourceId: el.id }
    })
    const setTextBodyProps = vi.fn(async (op: any) => {
      if (!setElementTextBodyProps(modelSlide, op.sourceId, op.props)) return null
      rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
      return rendered
    })
    const editConnectorEndpoints = vi.fn(async (_op: any) => rendered)
    const removeElement = vi.fn(async (op: any) => {
      if (!deleteElement(opened, modelSlide, op.sourceId)) return null
      rendered = buildRenderSlide(modelSlide, opened.deck.size, { fitWidthPx: 1280 })
      return rendered
    })
    ;(window as any).slidesApi = {
      addElement: addElementOp,
      editConnectorEndpoints,
      setTextBodyProps,
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
    } as unknown as DeckAccess

    const skill = createSlidesSkill(access, 'research')
    const planResult = await skill.executeTool({
      id: 'render-audit-plan',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [
          { id: 'input', role: 'input' },
          { id: 'core', role: 'core' },
          { id: 'output', role: 'output' },
        ],
        nodes: [
          { region: 'input', component: 'data-source', title: 'Experimental Data' },
          { region: 'core', component: 'mechanism-module', title: 'Mechanism Model' },
          { region: 'output', component: 'output-node', title: 'Validated Outcome' },
        ],
        edges: [
          { from: 'input', to: 'core', role: 'main' },
          { from: 'core', to: 'output', role: 'main' },
          { from: 'output', to: 'core', role: 'feedback' },
        ],
        negativeConstraints: ['No overlapping nodes'],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool({
      id: 'render-audit-test',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [
          {
            component: 'data-source',
            title: 'Experimental Data',
            subtitle: 'Observed measurements',
          },
        ],
        coreNodes: [
          {
            component: 'mechanism-module',
            title: 'Mechanism Model',
            subtitle: 'Representation and inference',
          },
        ],
        outputNodes: [
          {
            component: 'output-node',
            title: 'Validated Outcome',
            subtitle: 'Evidence-backed result',
          },
        ],
        feedback: true,
      },
    })

    expect(result.isError).toBeUndefined()
    expect(addElementOp).toHaveBeenCalledTimes(6)
    expect(addElementOp.mock.calls.slice(0, 3).map(([op]) => op.wPx)).toEqual([205, 282, 205])
    expect(setTextBodyProps).toHaveBeenCalledTimes(3)
    for (const [call] of setTextBodyProps.mock.calls) {
      expect(call.props).toEqual({ autofit: 'shrink' })
    }
    expect(editConnectorEndpoints).toHaveBeenCalledTimes(3)
    expect(
      editConnectorEndpoints.mock.calls.map(([call]) => [call.start?.idx, call.end?.idx]),
    ).toEqual([
      [3, 1],
      [3, 1],
      [2, 2],
    ])
    expect(editConnectorEndpoints.mock.calls.map(([call]) => [call.x1Px, call.x2Px])).toEqual([
      [306, 468],
      [750, 943],
      [1045.5, 609],
    ])
    expect(editConnectorEndpoints.mock.calls[2]?.[0]?.routeYPx).toBe(691)
    expect(removeElement).not.toHaveBeenCalled()
  })

  it('anchors a generic horizontal connector at the two facing edges', async () => {
    const connectorSlide = {
      widthPx: 1280,
      heightPx: 720,
      nodes: [
        { sourceId: 'left', type: 'shape', box: { x: 100, y: 300, w: 200, h: 100 } },
        { sourceId: 'right', type: 'shape', box: { x: 400, y: 300, w: 200, h: 100 } },
      ],
    } as unknown as RenderSlide
    const addElement = vi.fn(async () => ({ slide: connectorSlide, sourceId: 'connector' }))
    const editConnectorEndpoints = vi.fn(async () => connectorSlide)
    const applySlide = vi.fn()
    ;(window as any).slidesApi = { addElement, editConnectorEndpoints }
    const access = {
      getSlides: () => [connectorSlide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide,
      applyDeck: vi.fn(),
      fitWidthPx: 1280,
    } as unknown as DeckAccess

    const result = await createSlidesSkill(access, 'research').executeTool({
      id: 'connector-test',
      name: 'add_connector',
      input: { slideIndex: 0, fromId: 'left', toId: 'right', kind: 'straight' },
    })

    expect(result.isError).toBeUndefined()
    expect(addElement).toHaveBeenCalledWith(
      expect.objectContaining({ xPx: 300, yPx: 350, wPx: 100, hPx: 1 }),
    )
    expect(editConnectorEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        x1Px: 300,
        y1Px: 350,
        x2Px: 400,
        y2Px: 350,
        start: { targetId: 'left', idx: 3 },
        end: { targetId: 'right', idx: 1 },
      }),
    )
  })

  it('exposes and executes the audited horizontal pipeline recipe', async () => {
    const addElement = vi.fn(async () => ({
      slide,
      sourceId: `created-${addElement.mock.calls.length}`,
    }))
    const editConnectorEndpoints = vi.fn(async (_op: any) => slide)
    const setTextBodyProps = vi.fn(async () => slide)
    const applySlide = vi.fn()
    ;(window as any).slidesApi = { addElement, editConnectorEndpoints, setTextBodyProps }
    const access = {
      getSlides: () => [slide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide,
      applyDeck: vi.fn(),
      fitWidthPx: 1280,
    } as unknown as DeckAccess
    const skill = createSlidesSkill(access, 'research')

    expect(skill.tools.some((tool) => tool.name === 'create_horizontal_pipeline')).toBe(true)
    const planResult = await skill.executeTool({
      id: 'pipeline-plan',
      name: 'plan_research_figure',
      input: {
        figureType: 'horizontal-pipeline',
        readingDirection: 'LR',
        regions: [{ id: 'pipeline', role: 'context' }],
        nodes: [
          { region: 'pipeline', component: 'data-source', title: 'Input' },
          { region: 'pipeline', component: 'mechanism-module', title: 'Mechanism' },
          { region: 'pipeline', component: 'output-node', title: 'Output' },
        ],
        edges: [
          { from: 'Input', to: 'Mechanism', role: 'main' },
          { from: 'Mechanism', to: 'Output', role: 'main' },
        ],
        negativeConstraints: ['No overlap'],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool({
      id: 'pipeline-test',
      name: 'create_horizontal_pipeline',
      input: {
        slideIndex: 0,
        nodes: [
          { component: 'data-source', title: 'Input' },
          { component: 'mechanism-module', title: 'Mechanism' },
          { component: 'output-node', title: 'Output' },
        ],
      },
    })

    expect(result.isError).toBeUndefined()
    expect(addElement).toHaveBeenCalledTimes(5)
    expect(setTextBodyProps).toHaveBeenCalledTimes(3)
    expect(editConnectorEndpoints).toHaveBeenCalledTimes(2)
    expect(
      editConnectorEndpoints.mock.calls.map(([call]) => [call.start?.idx, call.end?.idx]),
    ).toEqual([
      [3, 1],
      [3, 1],
    ])
    expect(editConnectorEndpoints.mock.calls.map(([call]) => [call.x1Px, call.x2Px])).toEqual([
      [282, 314],
      [596, 628],
    ])
    expect(applySlide).toHaveBeenCalled()
  })
})
