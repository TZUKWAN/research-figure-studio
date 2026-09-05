/**
 * RENDER-P0-07 / P0-13 / P1-04 / P1-05: real editability of a composite
 * research module — native group semantics, connector move-following across
 * save/reopen, ungroup identity preservation, and paste detachment.
 */
import { describe, expect, it } from 'vitest'
import {
  addElement,
  commitSaved,
  createBlankPptx,
  elementDurableId,
  openPptx,
  pasteElements,
  savePptx,
  setElementConnection,
  updateConnectorsForGroupChildMoved,
  updateConnectorsForMoved,
  elementSpid,
  type OpenedPptx,
  type Slide,
} from '@genoffice/pptx-engine'
import { runTxn } from '../src/main/ops/executor'
import '../src/main/ops/core-ops'
import '../src/main/ops/element-ops'
import '../src/main/ops/insert-ops'
import '../src/main/ops/slide-ops'

const PX = 9525
const toEmu = (px: number) => Math.round(px * PX)

async function makeModuleWithConnector() {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]!
  const parent = addElement(slide, {
    kind: 'roundRect',
    offset: { x: toEmu(100), y: toEmu(100), cx: toEmu(300), cy: toEmu(160) },
    paragraphs: [{ runs: [{ text: 'Module' }] }],
    semanticMetadata: {
      role: 'mechanism-module',
      themeFill: 'surface',
      themeStroke: 'accent',
      themeText: 'textPrimary',
      componentType: 'research-module',
      semanticNodeId: 'core',
    },
  })
  const unit = addElement(slide, {
    kind: 'roundRect',
    offset: { x: toEmu(110), y: toEmu(140), cx: toEmu(120), cy: toEmu(42) },
    paragraphs: [{ runs: [{ text: 'step' }] }],
    semanticMetadata: {
      role: 'visual-unit',
      themeFill: 'surface',
      themeStroke: 'accent',
      themeText: 'textPrimary',
      componentType: 'research-micro',
      semanticNodeId: 'core',
      parentModuleId: 'core',
      visualUnitId: 'u1',
    },
  })
  const target = addElement(slide, {
    kind: 'roundRect',
    offset: { x: toEmu(600), y: toEmu(120), cx: toEmu(140), cy: toEmu(90) },
    paragraphs: [{ runs: [{ text: 'Outcome' }] }],
    semanticMetadata: {
      role: 'output-node',
      themeFill: 'accent',
      themeStroke: 'accent',
      themeText: 'textPrimary',
      componentType: 'research-module',
      semanticNodeId: 'outcome',
    },
  })
  const connector = addElement(slide, {
    kind: 'lineArrow',
    offset: { x: toEmu(400), y: toEmu(180), cx: toEmu(200), cy: 0 },
    stroke: { color: '#333333', widthEmu: 19050 },
    semanticMetadata: {
      role: 'research-connector',
      themeFill: 'none',
      themeStroke: 'connector',
      themeText: 'none',
      componentType: 'research-connector',
      semanticEdgeId: 'e1',
      relationPresentation: 'arrow',
    },
  })
  expect(
    setElementConnection(slide, connector.id, {
      start: { id: elementSpid(parent)!, idx: 3 },
      end: { id: elementSpid(target)!, idx: 1 },
    }),
  ).toBe(true)
  return { opened, slide, parent, unit, target, connector }
}

type MetaView = {
  componentType?: string
  semanticNodeId?: string
  visualUnitId?: string
  semanticEdgeId?: string
  parentModuleId?: string
  derivedFrom?: string
}

function findMeta<
  T = {
    id: string
    transform: { offset: { x: number; y: number; cx: number; cy: number } }
    dirtyTransform?: boolean
    connection?: { start?: { id: number }; end?: { id: number } }
    semanticMetadata?: MetaView
  },
>(slide: Slide, match: (meta: MetaView) => boolean): T {
  const el = slide.elements.find((element) => match((element.semanticMetadata ?? {}) as MetaView))
  expect(el, 'element not found').toBeTruthy()
  return el as unknown as T
}

describe('composite module editability (native groups)', () => {
  it('moving the group moves children boxes and the bound connector follows', async () => {
    const { opened, parent, unit, target } = await makeModuleWithConnector()
    const r = runTxn(opened, {
      ops: [{ op: 'groupElements', target: { slide: 0 }, els: [parent.id, unit.id] }],
    })
    expect(r.applied).toBe(true)
    const slide1 = opened.deck.slides[0]!
    const group = slide1.elements.find((el) => el.type === 'group')!
    expect(group).toBeTruthy()

    // Move the GROUP only (connector geometry = bounding box of endpoints,
    // expressed via offset+flip: start = parent right-mid, end = target left-mid)
    const moved = runTxn(opened, {
      ops: [
        {
          op: 'setTransform',
          target: { slide: 0, el: group.id },
          box: { x: toEmu(160), y: toEmu(140), cx: toEmu(300), cy: toEmu(160) },
        },
      ],
    })
    expect(moved.applied).toBe(true)
    const slide2 = opened.deck.slides[0]!
    const conn2 = findMeta(slide2, (meta) => meta.semanticEdgeId === 'e1')
    // parent right-mid moved to (460, 220); target left-mid stays (600, 165)
    expect(conn2.transform.offset.x).toBe(toEmu(460))
    expect(conn2.transform.offset.y).toBe(toEmu(165))
    expect(conn2.transform.offset.cy).toBe(toEmu(55))
    expect(conn2.dirtyTransform).toBe(true)
    // Untouched target keeps its position
    const target2 = findMeta(slide2, (meta) => meta.semanticNodeId === 'outcome')
    expect(target2.transform.offset.x).toBe(toEmu(600))
  })

  it('moving a child inside the group re-lays its connectors via the group child path', async () => {
    const { opened, parent, unit } = await makeModuleWithConnector()
    runTxn(opened, {
      ops: [{ op: 'groupElements', target: { slide: 0 }, els: [parent.id, unit.id] }],
    })
    const slide1 = opened.deck.slides[0]!
    const group = slide1.elements.find((el) => el.type === 'group') as unknown as {
      id: string
      children: Array<{
        id: string
        semanticMetadata?: { componentType?: string; semanticNodeId?: string }
      }>
    }
    // After the group txn the model was reparsed: address the child by its
    // CURRENT parse-time id inside the group's children.
    const childId = group.children.find(
      (child) =>
        child.semanticMetadata?.componentType === 'research-module' &&
        child.semanticMetadata?.semanticNodeId === 'core',
    )!.id
    // In-group child edit: shift the PARENT inside the group coordinate system
    const moved = runTxn(opened, {
      ops: [
        {
          op: 'setTransform',
          target: { slide: 0, el: childId },
          group: group.id,
          absBox: { x: toEmu(130), y: toEmu(120), cx: toEmu(300), cy: toEmu(160) },
        },
      ],
    })
    expect(moved.applied).toBe(true)
    const slide2 = opened.deck.slides[0]!
    const conn2 = findMeta(slide2, (meta) => meta.semanticEdgeId === 'e1')
    // parent right-mid now (430, 200); target left-mid (600, 165)
    expect(conn2.transform.offset.x).toBe(toEmu(430))
    expect(conn2.transform.offset.y).toBe(toEmu(165))
    void updateConnectorsForGroupChildMoved
  })

  it('ungroup keeps semantic metadata and native ids usable', async () => {
    const { opened, parent, unit } = await makeModuleWithConnector()
    runTxn(opened, {
      ops: [{ op: 'groupElements', target: { slide: 0 }, els: [parent.id, unit.id] }],
    })
    const group = opened.deck.slides[0]!.elements.find((el) => el.type === 'group')!
    const ungrouped = runTxn(opened, {
      ops: [{ op: 'ungroupElement', target: { slide: 0, el: group.id } }],
    })
    expect(ungrouped.applied).toBe(true)
    const slide2 = opened.deck.slides[0]!
    const parent2 = findMeta(
      slide2,
      (meta) => meta.componentType === 'research-module' && meta.semanticNodeId === 'core',
    )
    const unit2 = findMeta(slide2, (meta) => meta.visualUnitId === 'u1')
    expect(unit2.semanticMetadata?.parentModuleId).toBe('core')
    // Durable ids survive the group cycle (P1-04)
    expect(elementDurableId(parent2 as never)).toBeTruthy()
    expect(elementDurableId(unit2 as never)).toBeTruthy()
  })

  it('pasting a research element detaches its semantic identity (P1-05)', async () => {
    const { opened, parent } = await makeModuleWithConnector()
    const items = [
      {
        xml: parent.anchor.originalXml,
        rels: [] as unknown[],
        parts: {} as Record<string, string>,
        contentTypes: {} as Record<string, string>,
      },
    ]
    const result = pasteElements(opened, 0, items as never, { dx: toEmu(40), dy: toEmu(40) })
    expect(result).toBeTruthy()
    // pasteElements reparses: read identity from the FRESH slide model
    const freshSlide = opened.deck.slides[0]!
    const clone = result!.elementIds
      .map((id) => freshSlide.elements.find((el) => el.id === id))
      .find((el) => el)?.semanticMetadata
    expect(clone?.componentType).toBe('research-module')
    expect(clone?.semanticNodeId).not.toBe('core')
    expect(clone?.semanticNodeId).toContain('@copy')
    expect(clone?.derivedFrom).toBe('core')
  })

  it('connector survives save → reopen → module move → save again (P0-13)', async () => {
    const { opened } = await makeModuleWithConnector()
    commitSaved(opened)
    const bytes1 = await savePptx(opened)
    const reopened = await openPptx(bytes1)
    const slide1 = reopened.deck.slides[0]!
    const conn = findMeta(slide1, (meta) => meta.semanticEdgeId === 'e1')
    expect(conn.connection?.start?.id).toBeTruthy()
    expect(conn.connection?.end?.id).toBeTruthy()

    // Move the module AFTER reopen (relative +50, +30): connector follows
    const module = findMeta(
      slide1,
      (meta) => meta.componentType === 'research-module' && meta.semanticNodeId === 'core',
    )
    module.transform.offset = {
      ...module.transform.offset,
      x: module.transform.offset.x + toEmu(50),
      y: module.transform.offset.y + toEmu(30),
    }
    module.dirtyTransform = true
    expect(updateConnectorsForMoved(slide1, [module.id])).toBe(1)
    // parent right-mid now (450, 210); target left-mid (600, 165)
    expect(conn.transform.offset.x).toBe(toEmu(450))
    expect(conn.transform.offset.y).toBe(toEmu(165))
    expect(conn.transform.offset.cy).toBe(toEmu(45))

    commitSaved(reopened)
    const bytes2 = await savePptx(reopened)
    const reopened2 = await openPptx(bytes2)
    const conn2 = findMeta(reopened2.deck.slides[0]!, (meta) => meta.semanticEdgeId === 'e1')
    expect(conn2.connection?.start?.id).toBeTruthy()
    expect(conn2.connection?.end?.id).toBeTruthy()
    expect(conn2.transform.offset.x).toBe(toEmu(450))
  })
})
