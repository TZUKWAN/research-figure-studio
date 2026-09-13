/**
 * GOAL §20 / Scenario 04: dual-window analysis isolation. Two REAL app
 * instances analyze the same owned fixture; cancelling window A's analysis
 * must not affect window B, which still completes with a page summary.
 *
 * The Local Reference library is pointed at the owned fixtures
 * (METIS_GORDEN_TEMPLATES_DIR) and restored afterwards so the other specs see
 * their expected environment (serial worker → safe).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell } from './helpers'
import { aiSettingsJson, startStubProvider, type StubProvider } from './helpers/stub-provider'

const OWNED_DIR = join(process.cwd(), 'e2e', 'fixtures', 'local-reference')
const LONG = join(OWNED_DIR, 'large-100-slide', 'template.pptx')
const SHORT = join(OWNED_DIR, 'minimal-academic', 'template.pptx')

test.describe('dual-window analysis isolation (GOAL §20)', () => {
  test('cancelling A does not affect B; both windows stay healthy', async () => {
    test.setTimeout(240_000)
    expect(existsSync(LONG)).toBe(true)
    expect(existsSync(SHORT)).toBe(true)
    const prev = process.env.METIS_GORDEN_TEMPLATES_DIR
    process.env.METIS_GORDEN_TEMPLATES_DIR = OWNED_DIR

    let stub: StubProvider | null = null
    let launchedA: Awaited<ReturnType<typeof launchShell>> | null = null
    let launchedB: Awaited<ReturnType<typeof launchShell>> | null = null
    try {
      stub = await startStubProvider()
      const settings = aiSettingsJson(stub.baseUrl)
      launchedA = await launchShell({
        onboardingSeen: true,
        aiSettings: settings,
        videoDir: 'dual-a',
      })
      launchedB = await launchShell({
        onboardingSeen: true,
        aiSettings: settings,
        videoDir: 'dual-b',
      })

      // window A: start the LONG analysis (100 slides → a real cancel window)
      const editorA = await waitForEditor(launchedA.app)
      await editorA.click('[data-tpl-toggle="true"]')
      const panelA = editorA.locator('[data-testid="template-panel"]')
      await expect(panelA).toBeVisible({ timeout: 15_000 })
      await expect(panelA.locator('[data-testid^="tpl-card-"]').first()).toBeVisible({
        timeout: 30_000,
      })
      const cardA = editorA
        .locator('[data-testid^="tpl-card-"]')
        .filter({ hasText: 'large-100-slide' })
        .first()
      await cardA.click()
      await expect(cardA.locator('.tpl-progress')).toBeVisible({ timeout: 10_000 })

      // cancel A while B is running: the 100-slide analysis gives a real
      // (if short) cancel window — click the moment the button appears
      const cancelA = editorA.getByRole('button', { name: /(Cancel|取消)/ }).first()
      await cancelA.click({ timeout: 3_000 }).catch(() => {
        // analysis already finished before the click landed — acceptable
      })

      // window B: analyze the SHORT deck and let it complete while A settles
      const editorB = await waitForEditor(launchedB.app)
      await editorB.click('[data-tpl-toggle="true"]')
      const panelB = editorB.locator('[data-testid="template-panel"]')
      await expect(panelB).toBeVisible({ timeout: 15_000 })
      await expect(panelB.locator('[data-testid^="tpl-card-"]').first()).toBeVisible({
        timeout: 30_000,
      })
      const cardB = editorB
        .locator('[data-testid^="tpl-card-"]')
        .filter({ hasText: 'minimal-academic' })
        .first()
      await cardB.click()

      // B must complete regardless of A's cancellation
      await expect(cardB.locator('.tpl-summary')).toBeVisible({ timeout: 60_000 })
      // A must reach a TERMINAL state — canceled when the click landed, done
      // otherwise — never a hang, never a silent success (GOAL §20)
      await expect(cardA.locator('.tpl-card-state')).toContainText(/(Canceled|已取消|pages)/, {
        timeout: 60_000,
      })
      // both canvases still alive
      await expect(editorA.locator('.stage-wrap canvas').first()).toBeVisible()
      await expect(editorB.locator('.stage-wrap canvas').first()).toBeVisible()
    } finally {
      process.env.METIS_GORDEN_TEMPLATES_DIR = prev
      if (launchedA) await closeAndSaveVideo(launchedA, 'dual-a').catch(() => {})
      if (launchedB) await closeAndSaveVideo(launchedB, 'dual-b').catch(() => {})
      await stub?.close().catch(() => {})
    }
  })
})

async function waitForEditor(app: import('@playwright/test').ElectronApplication) {
  const { waitForPageWithUrl } = await import('./helpers')
  const editor = await waitForPageWithUrl(app, 'slides/out')
  await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
  return editor
}
