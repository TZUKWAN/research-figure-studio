import { describe, expect, it } from 'vitest'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'

const access = {
  getSlides: () => [],
  getCurrent: () => 0,
  getSelectedIds: () => [],
  applySlide: () => {},
  applyDeck: () => {},
  fitWidthPx: 1280,
} as unknown as DeckAccess

describe('Research Figure Mode', () => {
  it('reserves new-figure creation to create_research_figure (legacy recipes hidden)', () => {
    const skill = createSlidesSkill(access, 'research')

    expect(skill.tools.some((tool) => tool.name === 'generate_deck')).toBe(false)
    expect(skill.systemPrompt).not.toContain('generate_deck')
    expect(skill.tools.map((tool) => `${tool.name} ${tool.description}`).join('\n')).not.toContain(
      'generate_deck',
    )
    expect(skill.tools.some((tool) => tool.name === 'plan_deck')).toBe(false)
    // Acceptance RF-FIX-002: legacy recipe tools are hidden from the agent so a
    // NEW figure can only be produced by create_research_figure.
    expect(skill.tools.some((tool) => tool.name === 'create_research_figure')).toBe(true)
    expect(skill.tools.some((tool) => tool.name === 'plan_research_figure')).toBe(false)
    expect(skill.tools.some((tool) => tool.name === 'create_input_core_output')).toBe(false)
    expect(skill.tools.some((tool) => tool.name === 'create_horizontal_pipeline')).toBe(false)
  })

  it('validates and returns a FigurePlan, while rejecting hidden presentation calls', async () => {
    const skill = createSlidesSkill(access, 'research')
    const result = await skill.executeTool({
      id: 'plan-1',
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
          { region: 'input', component: 'input_card', title: 'Input' },
          { region: 'core', component: 'core_card', title: 'Core' },
          { region: 'output', component: 'output_card', title: 'Output' },
        ],
        edges: [{ from: 'input', to: 'core', role: 'main' }],
        negativeConstraints: ['No overlapping nodes'],
      },
    })
    expect(result.isError).not.toBe(true)
    expect(result.output).toContain('"figureType": "input-core-output"')
    expect(skill.buildContext!()).toContain('<figure-plan>')

    const blocked = await skill.executeTool({
      id: 'blocked-1',
      name: 'generate_deck',
      input: {},
    })
    expect(blocked.isError).toBe(true)
    expect(blocked.output).not.toContain('generate_deck')

    const invalidPlan = await skill.executeTool({
      id: 'invalid-plan-1',
      name: 'plan_research_figure',
      input: {
        figureType: 'input-core-output',
        readingDirection: 'LR',
        regions: [{ id: 'input', role: 'input' }],
        nodes: [{ region: 'input', component: 'input-node', title: 'Input' }],
        edges: [{ from: 'missing', to: 'input', role: 'main' }],
        negativeConstraints: [],
      },
    })
    expect(invalidPlan.isError).toBe(true)

    const presentation = createSlidesSkill(access)
    expect(presentation.tools.some((tool) => tool.name === 'plan_research_figure')).toBe(false)
  })

  it.each([
    {
      label: 'top-to-bottom reading direction',
      patch: { readingDirection: 'TB' },
    },
    {
      label: 'unsupported context region',
      patch: {
        regions: [
          { id: 'input', role: 'input' },
          { id: 'core', role: 'core' },
          { id: 'output', role: 'output' },
          { id: 'context', role: 'context' },
        ],
        nodes: [
          { region: 'input', component: 'input-node', title: 'Input' },
          { region: 'core', component: 'core-node', title: 'Core' },
          { region: 'output', component: 'output-node', title: 'Output' },
          { region: 'context', component: 'evidence-node', title: 'Context' },
        ],
      },
    },
    {
      label: 'unsupported annotation edge',
      patch: { edges: [{ from: 'input', to: 'core', role: 'annotation' }] },
    },
  ])('rejects $label before confirming an executable plan', async ({ patch }) => {
    const result = await createSlidesSkill(access, 'research').executeTool({
      id: `unsupported-${String(patch.readingDirection ?? patch.edges ?? patch.regions)}`,
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
          { region: 'input', component: 'input-node', title: 'Input' },
          { region: 'core', component: 'core-node', title: 'Core' },
          { region: 'output', component: 'output-node', title: 'Output' },
        ],
        edges: [
          { from: 'input', to: 'core', role: 'main' },
          { from: 'core', to: 'output', role: 'main' },
        ],
        negativeConstraints: [],
        ...patch,
      },
    })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('requires a valid')
  })
})
