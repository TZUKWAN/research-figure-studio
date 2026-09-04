import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, screenshotPath, activateHome } from './helpers'

test.describe('home screen', () => {
  test('shows the file list, quick actions and tab bar', async () => {
    const launched = await launchShell({ onboardingSeen: true, videoDir: 'home-basics' })
    const page = await activateHome(launched.app)
    try {
      await expect(page.locator('.recent-table, .empty.proj-empty').first()).toBeVisible()
      await expect(page.locator('.quick-card').first()).toBeVisible()
      await expect(page.locator('.tab-bar .tab-item.tab-home')).toBeVisible()
      await page.screenshot({ path: screenshotPath('home-overview') })
    } finally {
      await closeAndSaveVideo(launched, 'home-basics')
    }
  })

  test('renders localized UI when GENOFFICE_LANG=zh-CN', async () => {
    const launched = await launchShell({
      onboardingSeen: true,
      lang: 'zh-CN',
      videoDir: 'home-zh-cn',
    })
    const page = await activateHome(launched.app)
    try {
      await expect(page.locator('.nav-item .nav-label').first()).toHaveText('最近')
      await page.screenshot({ path: screenshotPath('home-zh-cn') })
    } finally {
      await closeAndSaveVideo(launched, 'home-zh-cn')
    }
  })
})
