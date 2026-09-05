import { test, expect } from '@playwright/test'
import { closeAndSaveVideo, screenshotPath, waitForPageWithUrl, launchShell } from './helpers'
import {
  createResearchFigure,
  launchResearchEditor,
  readPptxSlideXml,
  saveAndGetPath,
} from './helpers/research-figure'

/**
 * Research Figure ROUNDTRIP (QA-P1-12): create → save → close → REOPEN the
 * real file in a fresh app instance and confirm the figure survives: the
 * package keeps the semantic node metadata and the reopened editor renders
 * the canvas without errors.
 */
test.describe('research figure roundtrip', () => {
  test('save → reopen keeps semantic metadata and renders', async () => {
    test.setTimeout(240_000)
    const session = await launchResearchEditor()
    const { launched, editor } = session
    let savedPath: string
    try {
      await createResearchFigure(session)
      savedPath = await saveAndGetPath(launched.app, editor)

      // the saved package carries the semantic identity (persisted metadata)
      const xml = await readPptxSlideXml(savedPath)
      expect(xml).toMatch(/semanticNodeId|research-module|底物/u)
    } finally {
      await closeAndSaveVideo(launched, 'research-figure-roundtrip-save')
      await session.stub.close()
    }

    // fresh instance reopens the SAME file through the REAL open path
    const second = await launchShell({
      onboardingSeen: true,
      openFile: savedPath,
      lang: 'zh',
      videoDir: 'research-figure-roundtrip-reopen',
    })
    try {
      const editor2 = await waitForPageWithUrl(second.app, 'slides/out')
      await editor2.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
      // no crash dialog / error overlay on reopen
      await expect(editor2.locator('.ai-msg-error')).toHaveCount(0)
      await editor2.screenshot({ path: screenshotPath('research-figure-roundtrip-reopen') })
    } finally {
      await closeAndSaveVideo(second, 'research-figure-roundtrip-reopen')
    }
  })
})
