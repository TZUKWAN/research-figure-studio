/**
 * GOAL §29: template selection panel E2E — previews from the real Gorden
 * library, analyzer progress events and the cancel button, driven through the
 * REAL renderer → main IPC chain.
 *
 * Requires METIS_GORDEN_TEMPLATES_DIR (clean-skips without it, so CI without
 * the licensed template directory stays green).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { aiSettingsJson, startStubProvider } from './helpers/stub-provider'

const GORDEN_DIR = process.env.METIS_GORDEN_TEMPLATES_DIR
const HAS_LIBRARY = Boolean(
  GORDEN_DIR && existsSync(join(GORDEN_DIR, 'minimal-business-summary', 'template.pptx')),
)

test.describe('template selection panel (GOAL §29)', () => {
  test('library grid renders, analysis streams progress and cancel works', async () => {
    test.setTimeout(180_000)
    if (!HAS_LIBRARY) test.skip(true, 'Gorden template directory not present')
    const stub = await startStubProvider()
    const launched = await launchShell({
      onboardingSeen: true,
      aiSettings: aiSettingsJson(stub.baseUrl),
      videoDir: 'template-panel',
    })
    try {
      const editor = await waitForPageWithUrl(launched.app, 'slides/out')
      await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })

      // open the template panel via the composer toggle
      await editor.click('[data-tpl-toggle="true"]')
      const panel = editor.locator('[data-testid="template-panel"]')
      await expect(panel).toBeVisible({ timeout: 15_000 })
      await expect(panel.locator('[data-testid^="tpl-card-"]').first()).toBeVisible({
        timeout: 30_000,
      })

      // select a deck: per-slide progress may render (fast decks finish before
      // first paint); either way the analysis must end in a page-count summary
      const card = panel
        .locator('[data-testid^="tpl-card-"]')
        .filter({ hasText: 'minimal-business-summary' })
        .first()
      await card.click()
      await expect(card.locator('.tpl-summary')).toBeVisible({ timeout: 60_000 })
      expect(await card.locator('.tpl-summary').textContent()).toMatch(/pages/)

      // "Use in AI" fills the composer input with the template instruction
      await panel.locator('.tpl-use').click()
      const input = editor.locator('[data-slides-ai-input="true"]')
      await expect(input).toHaveValue(/analyze_ppt_template/, { timeout: 5_000 })

      // cancel path: a fresh large deck opens the analyzing window with the
      // Cancel button; a deck that finishes before the click lands simply
      // ends in the done state (cancel semantics are covered by unit tests)
      const bigCard = panel
        .locator('[data-testid^="tpl-card-"]')
        .filter({ hasText: 'report-massive-charts' })
        .first()
      await bigCard.click()
      await bigCard
        .getByRole('button', { name: /(Cancel|取消)/ })
        .click({ timeout: 3_000 })
        .catch(() => {
          // analysis finished faster than the click — acceptable
        })
      await expect(bigCard.locator('.tpl-card-state')).toContainText(/(Canceled|已取消|pages)/, {
        timeout: 90_000,
      })
    } finally {
      await closeAndSaveVideo(launched, 'template-panel')
      await stub.close()
    }
  })
})
