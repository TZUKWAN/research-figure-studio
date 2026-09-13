/**
 * GOAL §43: NON-SKIPPED TemplatePanel E2E using the project's OWN generated
 * fixtures (GOAL §42) — runs 100% on GitHub CI with no external template
 * directory. Drives the real user path: empty state → Import (stubbed native
 * picker, the same pattern as the export spec) → managed copy → analysis with
 * progress → summary → persistence across relaunch → remove.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { aiSettingsJson, startStubProvider } from './helpers/stub-provider'

const FIXTURE = join(process.cwd(), 'e2e', 'fixtures', 'templates', 'minimal-academic.pptx')
const BROKEN = join(process.cwd(), 'e2e', 'fixtures', 'templates', 'broken-template.pptx')

async function openTemplatePanel(launched: Parameters<typeof waitForPageWithUrl>[0]) {
  const editor = await waitForPageWithUrl(launched.app, 'slides/out')
  await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
  await editor.click('[data-tpl-toggle="true"]')
  const panel = editor.locator('[data-testid="template-panel"]')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  return { editor, panel }
}

test.describe('template import (owned fixtures, GOAL §42/§43)', () => {
  test('import → analyze → persisted across relaunch → remove', async () => {
    test.setTimeout(240_000)
    expect(existsSync(FIXTURE), 'owned fixture must exist (globalSetup generates it)').toBe(true)
    const stub = await startStubProvider()
    const launched = await launchShell({
      onboardingSeen: true,
      aiSettings: aiSettingsJson(stub.baseUrl),
      videoDir: 'template-import-owned',
    })
    try {
      // no METIS_GORDEN_TEMPLATES_DIR: the Local Reference section is absent,
      // the panel shows the usable empty state (GOAL §11)
      const { panel } = await openTemplatePanel(launched)
      await expect(panel.locator('[data-testid="tpl-empty"]')).toBeVisible()
      await expect(panel.locator('[data-testid^="tpl-card-"]')).toHaveCount(0)

      // stub the native picker to return the owned fixture, then Import
      await launched.app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog
      }, FIXTURE)
      await panel.locator('[data-testid="tpl-empty"] .tpl-use').click()

      // the imported card appears and analysis completes with a page summary
      const card = panel.locator('[data-testid^="tpl-card-user-"]').first()
      await expect(card).toBeVisible({ timeout: 20_000 })
      await expect(card.locator('.tpl-summary')).toBeVisible({ timeout: 60_000 })
      expect(await card.locator('.tpl-summary').textContent()).toMatch(/pages/)
      // per-page detail strip rendered from the analyzed deck (GOAL §16)
      await expect(panel.locator('[data-testid="tpl-detail"]')).toBeVisible({
        timeout: 30_000,
      })
    } finally {
      await closeAndSaveVideo(launched, 'template-import-owned')
      await stub.close()
    }

    // GOAL §8/§9: persistence — a full relaunch still lists the template
    const stub2 = await startStubProvider()
    const relaunched = await launchShell({
      onboardingSeen: true,
      aiSettings: aiSettingsJson(stub2.baseUrl),
      userDataDir: launched.userDataDir,
      videoDir: 'template-import-owned-relaunch',
    })
    try {
      const { panel: panel2 } = await openTemplatePanel(relaunched)
      const card2 = panel2.locator('[data-testid^="tpl-card-user-"]').first()
      await expect(card2).toBeVisible({ timeout: 20_000 })

      // remove from library; the ORIGINAL fixture file must survive
      await card2
        .getByRole('button', {
          name: /(Remove|移除|削除|제거|Supprimer|Entfernen|Quitar|ลบ|Hapus|Удалить|إزالة|Rimuovi|Usuń|Verwijderen|हटाएँ)/,
        })
        .first()
        .click()
      await expect(panel2.locator('[data-testid^="tpl-card-user-"]')).toHaveCount(0, {
        timeout: 20_000,
      })
    } finally {
      await closeAndSaveVideo(relaunched, 'template-import-owned-relaunch')
      await stub2.close()
    }
    expect(existsSync(FIXTURE)).toBe(true)
  })

  test('broken template import shows a typed error and the app keeps running (GOAL §41/§26)', async () => {
    expect(existsSync(BROKEN), 'broken fixture must exist').toBe(true)
    const stub = await startStubProvider()
    const launched = await launchShell({
      onboardingSeen: true,
      aiSettings: aiSettingsJson(stub.baseUrl),
      videoDir: 'template-import-broken',
    })
    try {
      const { editor, panel } = await openTemplatePanel(launched)
      await launched.app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog
      }, BROKEN)
      await panel.locator('[data-testid="tpl-empty"] .tpl-use').click()
      // typed error, visible in the panel — never a crash
      await expect(panel.locator('[data-testid="tpl-import-error"]')).toBeVisible({
        timeout: 20_000,
      })
      // the app is still alive: the panel and canvas remain interactive
      await expect(panel).toBeVisible()
      await expect(editor.locator('.stage-wrap canvas').first()).toBeVisible()
    } finally {
      await closeAndSaveVideo(launched, 'template-import-broken')
      await stub.close()
    }
  })
})
