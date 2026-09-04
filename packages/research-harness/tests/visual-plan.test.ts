import { describe, expect, it } from 'vitest'
import { layoutMicro } from '../src/visual/microLayout.js'
import { normalizeVisualPlan } from '../src/visual/visualPlan.js'

const plan = {
  nodes: [
    {
      id: 'mechanism',
      semanticLabel: 'Attentional mechanism',
      visible: { title: 'Attention' },
    },
  ],
  edges: [{ id: 'modulates' }],
}

describe('model-authored visual plans', () => {
  it('preserves validated edge-bound micro units and relation presentations', () => {
    const visual = normalizeVisualPlan(
      {
        modules: [
          {
            moduleId: 'mechanism',
            microLayout: 'chips',
            units: [
              {
                id: 'modulator',
                label: 'Moderation',
                role: 'annotation',
                semanticEdgeId: 'modulates',
              },
            ],
          },
        ],
        relations: [{ semanticEdgeId: 'modulates', presentation: 'dashed-arrow' }],
      },
      plan,
    )

    expect(visual.modules[0]?.units[0]).toMatchObject({ semanticEdgeId: 'modulates' })
    expect(visual.relations).toEqual([
      { semanticEdgeId: 'modulates', presentation: 'dashed-arrow' },
    ])

    const layout = layoutMicro(
      visual.modules,
      new Map([['mechanism', { x: 120, y: 180, w: 240, h: 140 }]]),
    )
    expect(layout.units[0]).toMatchObject({
      moduleId: 'mechanism',
      semanticEdgeId: 'modulates',
    })
  })

  it('does not manufacture keyword chips when the designer deliberately omits units', () => {
    const visual = normalizeVisualPlan(
      {
        modules: [{ moduleId: 'mechanism', microLayout: 'chips', units: [] }],
      },
      plan,
    )
    expect(visual.modules).toEqual([])
  })
})
