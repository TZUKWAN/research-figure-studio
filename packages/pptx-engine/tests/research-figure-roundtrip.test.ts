import { describe, expect, it } from 'vitest'
import {
  addElement,
  applyThemeToArchive,
  commitSaved,
  createBlankPptx,
  elementDurableId,
  elementSpid,
  openPptx,
  remapDeckColors,
  reparseDeck,
  savePptx,
  setElementConnection,
  updateConnectorsForMoved,
  type OpenedPptx,
  type SemanticMetadata,
  type Slide,
  type ThemeSpec,
} from '../src/index'
import {
  componentThemeTokens,
  connectorColor,
  getThemeById,
  resolveComponentColors,
} from '@genoffice/theme-engine'
import {
  layoutHorizontalPipeline,
  type HorizontalPipelineLayout,
  layoutInputCoreOutput,
  type IceLayout,
} from '@genoffice/research-harness'
import { runTxn } from '../../../apps/slides/src/main/ops/executor'
import '../../../apps/slides/src/main/ops/core-ops'
import '../../../apps/slides/src/main/ops/element-ops'
import '../../../apps/slides/src/main/ops/slide-ops'

const PX_TO_EMU = 9525

const TARGET_THEME: ThemeSpec = {
  name: 'Research Roundtrip Theme',
  colors: {
    dk1: '18212B',
    lt1: 'EEF4F8',
    dk2: '263746',
    lt2: 'D9E5ED',
    accent1: 'B23A48',
    accent2: '2F6690',
    accent3: '6A994E',
    accent4: 'BC6C25',
    accent5: '5E548E',
    accent6: '3A7D44',
    hlink: '1D4ED8',
    folHlink: '7C3AED',
  },
}

function metadataForComponent(component: string): SemanticMetadata {
  const tokens = componentThemeTokens(component)
  return {
    role: component,
    themeFill: tokens.fill,
    themeStroke: tokens.stroke,
    themeText: tokens.text,
    componentType: 'research-module',
  }
}

function connectorMetadata(role: 'main' | 'feedback'): SemanticMetadata {
  return {
    role: `${role}-connector`,
    themeFill: 'none',
    themeStroke: 'connector',
    themeText: 'none',
    componentType: 'research-connector',
  }
}

function toEmu(value: number): number {
  return Math.round(value * PX_TO_EMU)
}

type RecipeLayout = IceLayout | HorizontalPipelineLayout

function inputCoreOutputLayout(): IceLayout {
  return layoutInputCoreOutput({
    inputNodes: [{ component: 'data-source', title: 'Observed data' }],
    coreNodes: [{ component: 'mechanism-module', title: 'Mechanism model' }],
    outputNodes: [{ component: 'output-node', title: 'Validated result' }],
    canvasW: 1280,
    canvasH: 720,
    edges: [
      { from: 'Observed data', to: 'Mechanism model', role: 'main' },
      { from: 'Mechanism model', to: 'Validated result', role: 'main' },
      { from: 'Validated result', to: 'Mechanism model', role: 'feedback', relation: 'feedback' },
    ],
  })
}

async function createResearchFigure(
  layout: RecipeLayout = inputCoreOutputLayout(),
): Promise<{ opened: OpenedPptx; slide: Slide }> {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]!
  const theme = getThemeById('academic-blue')!
  const nodeElements = layout.elements.map((placement) => {
    const colors = resolveComponentColors(placement.component, theme.roles)
    return addElement(slide, {
      kind: placement.preset,
      offset: {
        x: toEmu(placement.x),
        y: toEmu(placement.y),
        cx: toEmu(placement.w),
        cy: toEmu(placement.h),
      },
      paragraphs: [{ runs: [{ text: placement.title, color: colors.text }] }],
      fillColor: colors.fill,
      stroke: { color: colors.stroke, widthEmu: 19050 },
      semanticMetadata: metadataForComponent(placement.component),
    })
  })

  for (const route of layout.connectors) {
    const from = layout.elements[route.fromIndex]!
    const to = layout.elements[route.toIndex]!
    const feedback = route.role === 'feedback'
    const p1 = feedback
      ? { x: from.x + from.w / 2, y: from.y + from.h, idx: 2 }
      : { x: from.x + from.w, y: from.y + from.h / 2, idx: 3 }
    const p2 = feedback
      ? { x: to.x + to.w / 2, y: to.y + to.h, idx: 2 }
      : { x: to.x, y: to.y + to.h / 2, idx: 1 }
    const connector = addElement(slide, {
      kind: feedback ? 'lineBent' : route.kind === 'curved' ? 'lineCurved' : 'line',
      offset: {
        x: toEmu(Math.min(p1.x, p2.x)),
        y: toEmu(Math.min(p1.y, p2.y)),
        cx: Math.max(toEmu(Math.abs(p2.x - p1.x)), 1),
        cy: Math.max(toEmu(Math.abs(p2.y - p1.y)), 1),
      },
      stroke: { color: connectorColor(theme.roles), widthEmu: 19050 },
      semanticMetadata: connectorMetadata(route.role),
    })
    expect(
      setElementConnection(
        slide,
        connector.id,
        {
          start: { id: elementSpid(nodeElements[route.fromIndex]!)!, idx: p1.idx },
          end: { id: elementSpid(nodeElements[route.toIndex]!)!, idx: p2.idx },
        },
        route.laneY != null ? toEmu(route.laneY) : undefined,
      ),
    ).toBe(true)
  }

  return { opened, slide }
}

function metadataList(slide: Slide): SemanticMetadata[] {
  return slide.elements.flatMap((element) =>
    element.semanticMetadata ? [element.semanticMetadata] : [],
  )
}

describe('research figure model and OOXML round-trip', () => {
  it('keeps Recipe metadata, bound endpoints, and theme roles across archive surgery and reopen', async () => {
    const { opened, slide } = await createResearchFigure()
    const before = metadataList(slide)
    expect(before).toHaveLength(6)

    commitSaved(opened)
    expect(applyThemeToArchive(opened, TARGET_THEME)).toBeGreaterThan(0)
    expect(remapDeckColors(opened, TARGET_THEME)).toBeGreaterThan(0)
    const themed = reparseDeck(opened)
    const themedSlide = themed.deck.slides[0]!
    expect(metadataList(themedSlide)).toEqual(before)

    const output = themedSlide.elements.find(
      (element) => element.semanticMetadata?.role === 'output-node',
    )!
    const outputSpid = elementSpid(output)!
    output.transform.offset = {
      ...output.transform.offset,
      x: output.transform.offset.x + toEmu(120),
      y: output.transform.offset.y + toEmu(80),
    }
    output.dirtyTransform = true
    expect(updateConnectorsForMoved(themedSlide, [output.id])).toBe(2)

    const reopened = await openPptx(await savePptx(themed))
    const finalSlide = reopened.deck.slides[0]!
    expect(metadataList(finalSlide)).toEqual(before)
    const connectors = finalSlide.elements.filter(
      (element) => element.semanticMetadata?.componentType === 'research-connector',
    )
    expect(connectors).toHaveLength(3)
    expect(
      connectors.every(
        (connector) =>
          connector.connection?.start?.id != null && connector.connection?.end?.id != null,
      ),
    ).toBe(true)
    expect(connectors.some((connector) => connector.connection?.start?.id === outputSpid)).toBe(
      true,
    )
    expect(connectors.some((connector) => connector.connection?.end?.id === outputSpid)).toBe(true)
    const feedbackConnector = connectors.find(
      (connector) => connector.semanticMetadata?.role === 'feedback-connector',
    )
    if (!feedbackConnector || feedbackConnector.type !== 'shape') {
      throw new Error('feedback connector was not reopened as a shape')
    }
    expect(feedbackConnector.adjust?.rfsRouteY).toBe(
      toEmu(inputCoreOutputLayout().regions.feedbackLaneY!),
    )
  })

  it('keeps Horizontal Pipeline metadata and endpoint bindings through save and reopen', async () => {
    const layout = layoutHorizontalPipeline({
      nodes: [
        { component: 'data-source', title: 'Observed data' },
        { component: 'mechanism-module', title: 'Mechanism model' },
        { component: 'output-node', title: 'Validated result' },
      ],
      canvasW: 1280,
      canvasH: 720,
      edges: [
        { from: 'Observed data', to: 'Mechanism model', role: 'main' },
        { from: 'Mechanism model', to: 'Validated result', role: 'main' },
      ],
    })
    const { opened, slide } = await createResearchFigure(layout)
    const before = metadataList(slide)
    expect(before).toHaveLength(5)

    commitSaved(opened)
    expect(applyThemeToArchive(opened, TARGET_THEME)).toBeGreaterThan(0)
    const reopened = await openPptx(await savePptx(reparseDeck(opened)))
    const finalSlide = reopened.deck.slides[0]!
    expect(metadataList(finalSlide)).toEqual(before)
    const connectors = finalSlide.elements.filter(
      (element) => element.semanticMetadata?.componentType === 'research-connector',
    )
    expect(connectors).toHaveLength(2)
    expect(
      connectors.every((connector) => connector.connection?.start && connector.connection.end),
    ).toBe(true)
  })
})

describe('transaction rollback on real model and OOXML state', () => {
  it('restores themed archive bytes, metadata, and endpoint relations after a later op fails', async () => {
    const { opened, slide } = await createResearchFigure()
    commitSaved(opened)
    const baselineSlideXml = opened.archive.readText(slide.path)!
    const baselineThemeXml = opened.archive.readText('ppt/theme/theme1.xml')!
    const target = slide.elements.find(
      (element) => element.semanticMetadata?.role === 'mechanism-module',
    )!
    const connector = slide.elements.find(
      (element) => element.semanticMetadata?.componentType === 'research-connector',
    )!
    const output = slide.elements.find(
      (element) => element.semanticMetadata?.role === 'output-node',
    )!
    const targetDurableId = elementDurableId(target)!

    const result = runTxn(opened, {
      ops: [
        {
          op: 'setConnectorEndpoints',
          target: { slide: 0, el: connector.id },
          p1: { x: 1000000, y: 1000000 },
          p2: { x: 5000000, y: 3000000 },
          start: { targetId: target.id, idx: 3 },
          end: { targetId: output.id, idx: 1 },
        },
        { op: 'applyTheme', name: TARGET_THEME.name, colors: TARGET_THEME.colors },
        { op: 'deleteElement', target: { slide: 0, el: targetDurableId } },
        {
          op: 'setTransform',
          target: { slide: 0, el: targetDurableId },
          box: { x: 0, y: 0, cx: 1000000, cy: 1000000 },
        },
      ],
    })

    expect(result.applied).toBe(false)
    expect(result.failures?.[0]?.index).toBe(3)
    expect(opened.archive.readText(slide.path)).toBe(baselineSlideXml)
    expect(opened.archive.readText('ppt/theme/theme1.xml')).toBe(baselineThemeXml)

    const restoredSlide = opened.deck.slides[0]!
    const restoredTarget = restoredSlide.elements.find(
      (element) => elementDurableId(element) === targetDurableId,
    )!
    expect(restoredTarget.semanticMetadata).toEqual(target.semanticMetadata)
    expect(restoredSlide.elements.filter((element) => element.connection)).toHaveLength(3)

    const reopened = await openPptx(await savePptx(opened))
    const finalSlide = reopened.deck.slides[0]!
    expect(
      finalSlide.elements.find((element) => elementDurableId(element) === targetDurableId)
        ?.semanticMetadata,
    ).toEqual(target.semanticMetadata)
    expect(finalSlide.elements.filter((element) => element.connection)).toHaveLength(3)
  })
})
