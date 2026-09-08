/**
 * P1-3 (production closure 2): weak-model Structured EditPlan.
 *
 * A model with NO reliable tool calling can still edit an existing research
 * figure: it returns ONE EditPlan over semantic ids, a deterministic executor
 * validates it against the recovered graph, and the edit applies as ONE
 * atomic transaction with fail-closed rollback. Bad target ids and failing
 * writes never leave a half-edited figure.
 */
import { describe, expect, it, vi } from 'vitest'
import { commitSaved, openPptx, savePptx } from '@genoffice/pptx-engine'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { parseEditPlan, collectSemanticElements } from '../src/renderer/research/edit-plan'
import { makeTxnAccess } from './research-txn-mock'

const figurePlan = {
  thesis: 'A促进B并产生C。',
  figureType: 'mechanism',
  narrative: {
    expressionMode: 'mechanism',
    complexity: 'compact',
    centralMessage: 'x',
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
      semanticLabel: 'A',
      visible: { title: 'A' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'b',
      type: 'process',
      semanticLabel: 'B',
      visible: { title: 'B' },
      importance: 0.6,
      role: 'intermediate',
    },
    {
      id: 'c',
      type: 'outcome',
      semanticLabel: 'C',
      visible: { title: 'C' },
      importance: 0.7,
      role: 'output',
    },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
  ],
  groups: [],
  globalIntent: { emphasis: ['a'], secondary: [], optional: [] },
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

const createRunLlm = () =>
  vi.fn(async (system: string) => {
    if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
    if (system.includes('Composition Designer'))
      return { ok: true, text: JSON.stringify(spatialPlan) }
    return { ok: false, error: 'unexpected prompt' }
  })

async function createFigure() {
  const harness = await makeTxnAccess(createRunLlm())
  const skill = createSlidesSkill(harness.access as unknown as DeckAccess, 'research')
  const created = await skill.executeTool({
    id: 'seed',
    name: 'create_research_figure',
    input: { slideIndex: 0, thesis: figurePlan.thesis },
  })
  expect(created.isError, created.output).toBeUndefined()
  return harness
}

describe('weak-model structured edit path (P1-3)', () => {
  it('a weak tool model edits via ONE EditPlan: move + text + add relation', async () => {
    const { access } = await createFigure()
    // The weak model returns a plan; it never chains tool calls.
    const editLlm = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        intent: 'make the mechanism clearer and add moderation',
        operations: [
          { type: 'move', targetSemanticId: 'a', dxPx: 40, dyPx: -20 },
          { type: 'edit-text', targetSemanticId: 'b', title: '过程B' },
          {
            type: 'add-relation',
            semanticEdgeId: 'e-mod',
            from: 'c',
            to: 'a',
            presentation: 'dashed-arrow',
          },
        ],
      }),
    }))
    ;(access as { runLlm: unknown }).runLlm = editLlm
    const skill = createSlidesSkill(access as unknown as DeckAccess, 'research')
    const result = await skill.executeTool({
      id: 'edit1',
      name: 'edit_research_figure',
      input: { instruction: '把机制右移一点，给过程B改标题，再加一条调节关系' },
    })
    expect(result.isError, result.output).toBeUndefined()
    expect(result.output).toContain('Applied 3 edit(s)')
    expect(editLlm).toHaveBeenCalledTimes(1) // ONE call, no tool loop
  })

  it('an invalid target semantic id is rejected BEFORE any write', async () => {
    const { access } = await createFigure()
    ;(access as { runLlm: unknown }).runLlm = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        intent: 'x',
        operations: [{ type: 'move', targetSemanticId: 'ghost', dxPx: 10, dyPx: 10 }],
      }),
    }))
    const skill = createSlidesSkill(access as unknown as DeckAccess, 'research')
    const result = await skill.executeTool({
      id: 'edit2',
      name: 'edit_research_figure',
      input: { instruction: '移动 ghost' },
    })
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('references missing node')
  })

  it('parse level: duplicate relation id, self relation, empty operations all rejected', () => {
    const nodeIds = new Set(['a', 'b'])
    const edgeIds = new Set(['e1'])
    const dup = parseEditPlan(
      {
        intent: 'x',
        operations: [
          {
            type: 'add-relation',
            semanticEdgeId: 'e1',
            from: 'a',
            to: 'b',
          },
        ],
      },
      { nodeIds, edgeIds },
    )
    expect(dup.plan).toBeNull()
    expect(dup.errors[0]).toContain('already exists')
    const self = parseEditPlan(
      {
        intent: 'x',
        operations: [{ type: 'add-relation', semanticEdgeId: 'e2', from: 'a', to: 'a' }],
      },
      { nodeIds, edgeIds },
    )
    expect(self.plan).toBeNull()
    expect(self.errors[0]).toContain('self relation')
    const empty = parseEditPlan({ intent: 'x', operations: [] }, { nodeIds, edgeIds })
    expect(empty.plan).toBeNull()
  })

  it('edits survive save → reopen (bytes)', async () => {
    const { access, opened } = await createFigure()
    ;(access as { runLlm: unknown }).runLlm = vi.fn(async () => ({
      ok: true,
      text: JSON.stringify({
        intent: 'rename B',
        operations: [{ type: 'edit-text', targetSemanticId: 'b', title: '过程B' }],
      }),
    }))
    const skill = createSlidesSkill(access as unknown as DeckAccess, 'research')
    const result = await skill.executeTool({
      id: 'edit3',
      name: 'edit_research_figure',
      input: { instruction: '把B改名为过程B' },
    })
    expect(result.isError, result.output).toBeUndefined()
    commitSaved(opened)
    const reopened = await openPptx(await savePptx(opened))
    const slide = reopened.deck.slides[0]!
    const bElement = slide.elements.find((el) => el.semanticMetadata?.semanticNodeId === 'b')
    expect(bElement).toBeTruthy()
  })

  it('the recovered graph (not a screenshot) drives editing', async () => {
    const { access } = await createFigure()
    const live = access.getSlides()[0]!
    const elements = collectSemanticElements(live)
    const modules = elements.filter((el) => el.componentType === 'research-module')
    expect(modules.length).toBeGreaterThanOrEqual(3)
    expect(modules.every((el) => el.semanticNodeId)).toBe(true)
    const connectors = elements.filter((el) => el.componentType === 'research-connector')
    expect(connectors.length).toBeGreaterThanOrEqual(1)
  })
})
