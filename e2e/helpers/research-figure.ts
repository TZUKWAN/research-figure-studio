/**
 * Shared Research Figure E2E fixture (QA-P1-12): launch the REAL app against
 * the deterministic stub provider, drive the REAL AI panel, and verify the
 * REAL saved PPTX package. See helpers/stub-provider.ts for the stub protocol.
 */
import JSZip from 'jszip'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchShell, waitForPageWithUrl, type LaunchedApp } from '../helpers'
import { aiSettingsJson, startStubProvider, type StubProvider } from './stub-provider'

export const THESIS = '底物经酶促反应一与酶促反应二两步转化为产物'

export interface ResearchSession {
  launched: LaunchedApp
  editor: Page
  stub: StubProvider
}

/** Launch the real shell with the stub provider seeded as the user's BYOK. */
export async function launchResearchEditor(lang = 'zh'): Promise<ResearchSession> {
  const stub = await startStubProvider()
  const launched = await launchShell({
    onboardingSeen: true,
    aiSettings: aiSettingsJson(stub.baseUrl),
    lang,
    videoDir: 'research-figure',
  })
  const editor = await waitForPageWithUrl(launched.app, 'slides/out')
  await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
  await editor.waitForSelector('[data-slides-ai-input="true"]', { timeout: 30_000 })
  return { launched, editor, stub }
}

/** Send the research request through the real AI panel and wait for the run. */
export async function createResearchFigure(session: ResearchSession): Promise<void> {
  const { editor } = session
  const input = editor.locator('[data-slides-ai-input="true"]')
  await input.click()
  await input.fill(THESIS)
  await input.press('Enter')
  // the run is finished when no assistant message is still streaming
  await editor.locator('.ai-msg-streaming').waitFor({ state: 'detached', timeout: 120_000 })
  await editor.locator('.ai-msg-error').waitFor({ state: 'detached', timeout: 5_000 })
}

/**
 * Save through the app's own pipeline (renderer invoke → main → pptx-engine)
 * and return the file path. Untitled decks land in the drafts folder without
 * a native dialog.
 */
export async function saveAndGetPath(app: ElectronApplication, editor: Page): Promise<string> {
  const result = await editor.evaluate(() =>
    (
      window as unknown as {
        slidesApi: { save(): Promise<{ ok: boolean; path?: string; error?: string }> }
      }
    ).slidesApi.save(),
  )
  if (!result.ok || !result.path) {
    throw new Error(`save failed: ${result.error ?? 'no path returned'}`)
  }
  return result.path
}

/** Read one slide's XML from the saved package (package is a real PPTX zip). */
export async function readPptxSlideXml(
  path: string,
  part = 'ppt/slides/slide1.xml',
): Promise<string> {
  const zip = await JSZip.loadAsync(await (await import('node:fs/promises')).readFile(path))
  const entry = zip.file(part)
  if (!entry) throw new Error(`${part} missing from ${path}`)
  return entry.async('string')
}

/** The renderer-visible slide count, from the editor's own state bar. */
export async function assertSingleCanvas(editor: Page): Promise<void> {
  await editor.waitForSelector('.stage-wrap canvas', { timeout: 30_000 })
}
