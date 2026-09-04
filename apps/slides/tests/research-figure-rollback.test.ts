import { describe, expect, it, vi } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { RenderSlide } from '@genoffice/pptx-render'
import { onResearchAction, type ResearchActionEvent } from '@genoffice/research-harness'

const slide = { widthPx: 1280, heightPx: 720, nodes: [] } as unknown as RenderSlide

describe('research figure rollback', () => {
  it('reverts already-created elements when a later node fails', async () => {
    const applySlide = vi.fn()
    const deleteElement = vi.fn(async () => slide)
    let addCount = 0
    ;(window as any).slidesApi = {
      addElement: vi.fn(async () => {
        addCount++
        return addCount === 1 ? { slide, sourceId: 'created-node' } : null
      }),
      setTextBodyProps: vi.fn(async () => slide),
      deleteElement,
    }
    const access = {
      getSlides: () => [slide],
      getCurrent: () => 0,
      getSelectedIds: () => [],
      applySlide,
      applyDeck: vi.fn(),
      fitWidthPx: 1280,
    } as unknown as DeckAccess
    const events: ResearchActionEvent[] = []
    const unsubscribe = onResearchAction((event) => events.push(event))

    const skill = createSlidesSkill(access, 'research')
    const planResult = await skill.executeTool({
      id: 'rollback-plan',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [{ id: 'input', role: 'input' }],
        nodes: [
          { region: 'input', component: 'input-node', title: 'First' },
          { region: 'input', component: 'input-node', title: 'Second' },
        ],
        edges: [{ from: 'First', to: 'Second', role: 'main' }],
        negativeConstraints: [],
      },
    })
    expect(planResult.isError).toBeUndefined()

    const result = await skill.executeTool({
      id: 'rollback-test',
      name: 'create_input_core_output',
      input: {
        slideIndex: 0,
        inputNodes: [
          { component: 'input-node', title: 'First' },
          { component: 'input-node', title: 'Second' },
        ],
        coreNodes: [],
        outputNodes: [],
      },
    })

    unsubscribe()
    expect(result.isError).toBe(true)
    expect(deleteElement).toHaveBeenCalledWith({ slideIndex: 0, sourceId: 'created-node' })
    expect(events.map((event) => event.type)).toEqual([
      'researchActionStarted',
      'researchActionCommitted',
      'researchActionReverted',
    ])
    expect(applySlide).toHaveBeenCalledWith(0, slide)
  })
})
