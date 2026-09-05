/**
 * RENDER-P0-08/09/10 + P1-01: extended semantic metadata and the slide-level
 * research payload survive archive surgery and save→reopen; unknown versions
 * degrade gracefully instead of being dropped; every scientific primitive
 * keeps its preset through the round trip.
 */
import { describe, expect, it } from 'vitest'
import {
  addElement,
  commitSaved,
  createBlankPptx,
  getSlideResearchMetadata,
  openPptx,
  parseSemanticMetadata,
  savePptx,
  setSlideResearchMetadata,
  serializeSemanticMetadata,
  type ResearchFigureSlidePayload,
} from '../src/index'

const FULL_METADATA = {
  role: 'model-module',
  themeFill: 'primary',
  themeStroke: 'primary',
  themeText: 'textPrimary',
  componentType: 'research-module',
  semanticNodeId: 'core',
  researchMetadataVersion: 2,
  figureRunId: 'fig-test-01',
  figureFamily: 'mechanism',
  domain: 'cs-ml',
  primitiveKind: 'model-module',
  evidenceRefs: 'ev:1;ev:2',
  provenanceRefs: 'doi:10.1/xyz',
}

async function makeDeck(): Promise<{ reopened: Awaited<ReturnType<typeof openPptx>> }> {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]!
  const el = addElement(slide, {
    kind: 'roundRect',
    offset: { x: 952500, y: 952500, cx: 1905000, cy: 952500 },
    paragraphs: [{ runs: [{ text: 'core' }] }],
    semanticMetadata: FULL_METADATA,
  })
  const payload: ResearchFigureSlidePayload = {
    schemaVersion: 1,
    figureRunId: 'fig-test-01',
    figureFamily: 'mechanism',
    domain: 'cs-ml',
    thesis: 'A → B through C',
    nodes: [
      {
        id: 'core',
        title: 'Core',
        type: 'mechanism',
        primitiveKind: 'model-module',
        detailDisposition: 'promoted-to-units',
      },
      {
        id: 'out',
        title: 'Out',
        type: 'outcome',
        primitiveKind: 'output-node',
        detailDisposition: 'render-in-parent',
      },
    ],
    relations: [
      {
        id: 'e1',
        from: 'core',
        to: 'out',
        relation: 'causal',
        presentation: 'arrow',
        status: 'rendered',
      },
      {
        id: 'e2',
        from: 'core',
        to: 'out',
        relation: 'correlation',
        presentation: 'alignment',
        status: 'spatial',
        reason: 'relation expressed through alignment rather than a connector',
      },
      {
        id: 'e3',
        from: 'out',
        to: 'core',
        relation: 'feedback',
        presentation: 'arrow',
        status: 'suppressed',
        reason: 'connector density cap: expressed spatially',
      },
    ],
    typography: { fontScale: 1.2, measurer: 'calibrated-estimator' },
  }
  expect(setSlideResearchMetadata(slide, payload)).toBe(true)
  commitSaved(opened)
  const bytes = await savePptx(opened)
  const reopened = await openPptx(bytes)
  return { reopened }
}

describe('extended research metadata round trip (P0-08/09/10)', () => {
  it('per-shape extended refs and the slide payload survive save→reopen', async () => {
    const { reopened } = await makeDeck()
    const slide = reopened.deck.slides[0]!
    const el = slide.elements.find((e) => e.semanticMetadata?.semanticNodeId === 'core')!
    expect(el.semanticMetadata).toMatchObject({
      ...FULL_METADATA,
      semanticNodeId: 'core',
    })
    const payload = getSlideResearchMetadata(slide)
    expect(payload?.schemaVersion).toBe(1)
    expect(payload?.figureRunId).toBe('fig-test-01')
    expect(payload?.nodes).toHaveLength(2)
    expect(payload?.relations.map((r) => r.status)).toEqual(['rendered', 'spatial', 'suppressed'])
    expect(payload?.typography?.fontScale).toBe(1.2)
  })

  it('parses future rfs payloads without dropping readable fields (P0-09)', () => {
    const future =
      'rfs:v9|role=x|themeFill=f|themeStroke=s|themeText=t|componentType=research-module|someFuture=1'
    const parsed = parseSemanticMetadata(future)
    expect(parsed?.role).toBe('x')
    expect(parsed?.componentType).toBe('research-module')
    // unrelated strings still return null
    expect(parseSemanticMetadata('some random description')).toBeNull()
    // round trip through the serializer keeps the version
    const serialized = serializeSemanticMetadata(FULL_METADATA)
    expect(serialized).toContain('researchMetadataVersion=2')
    expect(parseSemanticMetadata(serialized)?.figureRunId).toBe('fig-test-01')
  })

  it('a foreign slide name is not mistaken for research metadata', () => {
    expect(parseSemanticMetadata('rfs:v1|role=x|themeFill=f|themeStroke=s|themeText=t')).toBeNull()
  })
})

describe('scientific primitive fixtures (P1-01)', () => {
  const PRIMITIVES: Array<[string, string]> = [
    ['can', 'data-store'],
    ['chevron', 'process-stage'],
    ['homePlate', 'reaction-stage'],
    ['diamond', 'condition'],
    ['parallelogram', 'tensor'],
    ['pentagon', 'metric'],
    ['flowChartPredefinedProcess', 'device'],
  ]

  for (const [preset, kind] of PRIMITIVES) {
    it(`round trips ${kind} as native preset "${preset}" with editable text and metadata`, async () => {
      const opened = await openPptx(await createBlankPptx())
      const slide = opened.deck.slides[0]!
      addElement(slide, {
        kind: preset,
        offset: { x: 952500, y: 952500, cx: 1905000, cy: 952500 },
        paragraphs: [{ runs: [{ text: `${kind} label` }] }],
        semanticMetadata: {
          role: kind,
          themeFill: 'surface',
          themeStroke: 'primary',
          themeText: 'textPrimary',
          componentType: 'research-module',
          primitiveKind: kind,
          domain: 'general',
          researchMetadataVersion: 2,
        },
      })
      commitSaved(opened)
      const reopened = await openPptx(await savePptx(opened))
      const el = reopened.deck.slides[0]!.elements[0] as {
        presetGeometry?: string
        semanticMetadata?: { primitiveKind?: string }
        text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
      }
      expect(el.presetGeometry).toBe(preset)
      expect(el.semanticMetadata?.primitiveKind).toBe(kind)
      expect(el.text?.paragraphs[0]?.runs[0]?.text).toBe(`${kind} label`)
    })
  }
})
