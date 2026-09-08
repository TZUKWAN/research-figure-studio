import { test, expect } from '@playwright/test'
import { closeAndSaveVideo, screenshotPath } from './helpers'
import {
  createResearchFigure,
  launchResearchEditor,
  readPptxSlideXml,
  saveAndGetPath,
} from './helpers/research-figure'

/**
 * Research Figure EDIT (QA-P1-12): after the stub-driven creation, edit a node
 * title through the REAL canvas and verify the new text reaches the SAVED
 * PPTX XML through the real pipeline.
 *
 * The dblclick target is derived from the SAVED package itself (EMU offsets of
 * the shape whose text matches the fixture label), so the test does not guess layout: it
 * saves once, aims at the real shape, double-clicks, types, commits (Esc),
 * saves again and diffs the XML.
 */

const SLIDE_W_EMU = 12_192_000
const SLIDE_H_EMU = 6_858_000

function shapeCenterProportion(xml: string, textMarker: string): { x: number; y: number } {
  const shapes = xml.split('<p:sp>')
  for (const shape of shapes.slice(1)) {
    if (!shape.includes(textMarker)) continue
    const off = /<a:off x="(\d+)" y="(\d+)"/.exec(shape)
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(shape)
    if (!off || !ext) continue
    const cx = (Number(off[1]) + Number(ext[1]) / 2) / SLIDE_W_EMU
    const cy = (Number(off[2]) + Number(ext[2]) / 2) / SLIDE_H_EMU
    return { x: Math.min(0.95, Math.max(0.05, cx)), y: Math.min(0.95, Math.max(0.05, cy)) }
  }
  throw new Error(`shape with text "${textMarker}" not found in slide XML`)
}

test.describe('research figure edit', () => {
  test('double-click text edit reaches the saved package', async () => {
    test.setTimeout(180_000)
    const session = await launchResearchEditor()
    const { launched, editor } = session
    try {
      await createResearchFigure(session)
      await expect(editor.locator('.stage-wrap canvas').first()).toBeVisible()

      // first save pins the real solved geometry
      const savedPath = await saveAndGetPath(launched.app, editor)
      const xmlBefore = await readPptxSlideXml(savedPath)
      const target = shapeCenterProportion(xmlBefore, '酶促反应一')

      // double-click the REAL shape position on the Konva canvas.
      // force: the canvas is a bitmap — overlay chrome defeats Playwright's
      // actionability hit-test, but the events land on the canvas correctly.
      const canvas = editor.locator('.stage-wrap canvas').first()
      const box = await canvas.boundingBox()
      expect(box).not.toBeNull()
      await canvas.dblclick({
        position: { x: box!.width * target.x, y: box!.height * target.y },
        force: true,
      })

      // the DOM overlay contentEditable appears over the shape
      const textEditor = editor
        .locator('.stage-wrap textarea, .stage-wrap [contenteditable="true"]')
        .first()
      await textEditor.waitFor({ state: 'visible', timeout: 15_000 })
      await textEditor.fill('产物X')
      // Esc commits the text and returns to the shape-selected state
      await textEditor.press('Escape')

      // second save must carry the edit through the real pipeline
      const pathAfter = await saveAndGetPath(launched.app, editor)
      const xmlAfter = await readPptxSlideXml(pathAfter)
      expect(xmlAfter).toContain('产物X')
      await editor.screenshot({ path: screenshotPath('research-figure-edit') })
    } finally {
      await closeAndSaveVideo(launched, 'research-figure-edit')
      await session.stub.close()
    }
  })
})
