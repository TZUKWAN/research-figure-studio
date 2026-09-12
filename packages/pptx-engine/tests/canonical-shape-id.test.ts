/**
 * GOAL §八-P0: canonicalPptShapeId is THE cross-layer shape identity.
 * Same bytes → same id across parse cycles; group children resolve to their
 * own cNvPr id (not the group's); missing child slices fall back to nvId.
 */
import { describe, expect, it } from 'vitest'
import {
  addElement,
  canonicalPptShapeId,
  createBlankPptx,
  openPptx,
  savePptx,
} from '../src/index'

function shapeXml(id: number, name: string): string {
  return (
    `<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="200" cy="80"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp>`
  )
}

describe('canonicalPptShapeId (GOAL §八)', () => {
  it('is stable across save → reopen for the same shape', async () => {
    const opened = await openPptx(await createBlankPptx())
    const slide = opened.deck.slides[0]!
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 914400, y: 914400, cx: 6096000, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'alpha' }] }],
    })
    addElement(slide, {
      kind: 'textbox',
      offset: { x: 914400, y: 2743200, cx: 6096000, cy: 914400 },
      paragraphs: [{ runs: [{ text: 'beta' }] }],
    })
    const before = slide.elements.map((el) => canonicalPptShapeId(el))
    expect(before).toHaveLength(2)
    expect(before.every((n) => n != null && n > 0)).toBe(true)
    expect(new Set(before).size).toBe(2) // unique within the slide

    const bytes2 = await savePptx(opened)
    const second = await openPptx(bytes2)
    const after = second.deck.slides[0]!.elements.map((el) => canonicalPptShapeId(el))
    expect(after).toEqual(before)
  })

  it('resolves a group child to its OWN cNvPr id via the child slice', async () => {
    const opened = await openPptx(await createBlankPptx())
    const childXml1 = shapeXml(21, 'kid1')
    const childXml2 = shapeXml(22, 'kid2')
    const groupXml =
      `<p:grpSp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:nvGrpSpPr><p:cNvPr id="20" name="grp"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="400" cy="200"/>` +
      `<a:chOff x="0" y="0"/><a:chExt cx="400" cy="200"/></a:xfrm></p:grpSpPr>` +
      childXml1 +
      childXml2 +
      `</p:grpSp>`
    const group = {
      id: 'grp_1',
      type: 'group',
      name: 'grp',
      transform: { offset: { x: 0, y: 0, cx: 400, cy: 200 } },
      anchor: { originalXml: groupXml },
      children: [
        { anchor: { originalXml: childXml1 }, nvId: 21 },
        { anchor: { originalXml: childXml2 }, nvId: 22 },
      ],
    }
    opened.deck.slides[0]!.elements.push(group as never)
    const grp = opened.deck.slides[0]!.elements[0] as unknown as {
      children: Array<Parameters<typeof canonicalPptShapeId>[0]>
    }
    const ids = grp.children.map((c) => canonicalPptShapeId(c))
    expect(ids).toEqual([21, 22])
  })

  it('falls back to the parsed nvId when the child has no byte slice', () => {
    expect(canonicalPptShapeId({ nvId: 33 } as never)).toBe(33)
  })
})
