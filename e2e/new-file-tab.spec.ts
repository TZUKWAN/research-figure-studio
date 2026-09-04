import { test, expect } from '@playwright/test'
import {
  launchShell,
  closeAndSaveVideo,
  waitForPageWithUrl,
  screenshotPath,
  activateHome,
} from './helpers'

test.describe('new file from home', () => {
  test('AI Slides quick card opens a Slides editor tab', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'new-slides-tab' })
    const { app } = launched
    try {
      const page = await activateHome(app)
      await expect(page.locator('.quick-card', { hasText: 'New Canvas' })).toHaveCount(1)

      const editorTabs = page.locator('.tab-bar .tab-item:not(.tab-home)')
      const tabCountBefore = await editorTabs.count()
      await page.locator('.quick-card', { hasText: 'New Canvas' }).click()

      await expect(editorTabs).toHaveCount(tabCountBefore + 1)
      await expect(editorTabs.last()).toHaveClass(/active/)
      await page.screenshot({ path: screenshotPath('new-slides-tab-bar') })

      // the Slides editor loads in a WebContentsView, which surfaces as a new
      // page — poll for it instead of waitForLoadState, which hangs on Linux
      // when Playwright attaches mid-navigation and misses lifecycle events
      const editorPage = await waitForPageWithUrl(app, 'slides/out')
      await editorPage.waitForSelector('.stage-wrap canvas', { timeout: 20_000 })
      await editorPage.screenshot({ path: screenshotPath('new-slides-editor') })
    } finally {
      await closeAndSaveVideo(launched, 'new-slides-tab')
    }
  })
})
