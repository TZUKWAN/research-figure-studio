import { test, expect, type Page } from '@playwright/test'
import { launchShell, closeAndSaveVideo, activateHome, screenshotPath } from './helpers'

function setTheme(page: Page, theme: 'light' | 'dark' | 'system'): Promise<void> {
  return page.evaluate((t) => {
    const api = (window as unknown as { aiOffice: { setTheme(v: string): Promise<void> } }).aiOffice
    return api.setTheme(t)
  }, theme)
}

function bodyBg(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor)
}

/** relative luminance of a computed rgb()/rgba() string, 0 (black) – 255 (white) */
function luminance(rgb: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb)
  if (!m) throw new Error(`Unparseable color: ${rgb}`)
  return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
}

test.describe('theme visual adoption', () => {
  test('Shell Home surface follows the selected theme', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'theme-visual-shell' })
    try {
      const shellPage = await activateHome(launched.app)
      await expect(shellPage.locator('.recents')).toBeVisible()

      await setTheme(shellPage, 'light')
      await expect.poll(async () => luminance(await bodyBg(shellPage))).toBeGreaterThan(180)

      await setTheme(shellPage, 'dark')
      await expect.poll(async () => luminance(await bodyBg(shellPage))).toBeLessThan(80)
      await expect(shellPage.locator('.recents')).toBeVisible()
      await shellPage.screenshot({ path: screenshotPath('theme-shell-dark') })
    } finally {
      await closeAndSaveVideo(launched, 'theme-visual-shell')
    }
  })
})
