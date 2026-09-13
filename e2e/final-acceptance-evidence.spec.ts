/**
 * GOAL §46: final acceptance EVIDENCE — captures the real Template Center
 * (library grid, analysis summary, per-page detail) into
 * e2e/artifacts/final-user-acceptance/ as PNG screenshots of the REAL app.
 * Uses the owned local-reference fixtures; runs everywhere (no skip).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { aiSettingsJson, startStubProvider } from './helpers/stub-provider'

const OWNED_DIR = join(process.cwd(), 'e2e', 'fixtures', 'local-reference')
const EVIDENCE_DIR = join(process.cwd(), 'e2e', 'artifacts', 'final-user-acceptance')

test.describe('final acceptance evidence (GOAL §46)', () => {
  test('capture Template Center evidence screenshots', async () => {
    test.setTimeout(180_000)
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    process.env.METIS_GORDEN_TEMPLATES_DIR = OWNED_DIR

    const stub = await startStubProvider()
    const launched = await launchShell({
      onboardingSeen: true,
      aiSettings: aiSettingsJson(stub.baseUrl),
      videoDir: 'final-acceptance',
    })
    try {
      const editor = await waitForPageWithUrl(launched.app, 'slides/out')
      await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
      await editor.click('[data-tpl-toggle="true"]')
      const panel = editor.locator('[data-testid="template-panel"]')
      await expect(panel).toBeVisible({ timeout: 15_000 })
      await expect(panel.locator('[data-testid^="tpl-card-"]').first()).toBeVisible({
        timeout: 30_000,
      })

      // 01: the Template Center grid — WAIT for the preview bitmaps (decks
      // parse sequentially in the main process; the 100-slide deck is slow)
      await expect(panel.locator('[data-testid^="tpl-card-"]').nth(2)).toBeVisible()
      await expect(panel.locator('.tpl-thumb img').first()).toBeVisible({ timeout: 90_000 })
      await editor.screenshot({
        path: join(EVIDENCE_DIR, '01-template-center.png'),
        fullPage: false,
      })

      // 02: analysis completes → page summary + per-page detail strip
      const card = panel
        .locator('[data-testid^="tpl-card-"]')
        .filter({ hasText: 'minimal-academic' })
        .first()
      await card.click()
      await expect(card.locator('.tpl-summary')).toBeVisible({ timeout: 60_000 })
      await expect(panel.locator('[data-testid="tpl-detail"]')).toBeVisible({
        timeout: 30_000,
      })
      await editor.screenshot({
        path: join(EVIDENCE_DIR, '02-template-detail.png'),
        fullPage: false,
      })

      // 03: Use in AI → the composer input carries the localized instruction
      await panel.locator('.tpl-use-row .tpl-use').click()
      const input = editor.locator('[data-slides-ai-input="true"]')
      await expect(input).toHaveValue(/.+/)
      await editor.screenshot({
        path: join(EVIDENCE_DIR, '03-use-in-ai.png'),
        fullPage: false,
      })
    } finally {
      await closeAndSaveVideo(launched, 'final-acceptance')
      await stub.close()
      delete process.env.METIS_GORDEN_TEMPLATES_DIR
    }
  })
})
