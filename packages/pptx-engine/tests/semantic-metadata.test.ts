import { describe, expect, it } from 'vitest'
import {
  addElement,
  createBlankPptx,
  openPptx,
  savePptx,
  type SemanticMetadata,
} from '../src/index'

const META: SemanticMetadata = {
  role: 'mechanism-primary',
  themeFill: 'primary.100',
  themeStroke: 'primary.700',
  themeText: 'text.primary',
  componentType: 'research-module',
  semanticNodeId: 'mechanism-core',
  semanticEdgeId: 'edge:mechanism-outcome',
  relationPresentation: 'dashed-arrow',
}

describe('semantic metadata route B', () => {
  it('survives GenOffice save and reopen in cNvPr descr/title', async () => {
    const opened = await openPptx(await createBlankPptx())
    const slide = opened.deck.slides[0]!
    const created = addElement(slide, {
      kind: 'roundRect',
      offset: { x: 100000, y: 100000, cx: 1000000, cy: 500000 },
      paragraphs: [{ runs: [{ text: 'semantic node' }] }],
      semanticMetadata: META,
    })

    expect(created.semanticMetadata).toEqual(META)
    expect(created.anchor.originalXml).toContain('descr="rfs:v1|')
    expect(created.anchor.originalXml).toContain('title="rfs:v1|')

    const reopened = await openPptx(await savePptx(opened))
    const parsed = reopened.deck.slides[0]!.elements.find((el) => el.type === 'shape')
    expect(parsed?.semanticMetadata).toEqual(META)
  })
})
