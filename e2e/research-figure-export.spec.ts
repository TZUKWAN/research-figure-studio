import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { closeAndSaveVideo } from './helpers'
import {
  createResearchFigure,
  launchResearchEditor,
  readPptxSlideXml,
  saveAndGetPath,
} from './helpers/research-figure'

/**
 * Research Figure EXPORT (QA-P1-12): create via the stub-driven REAL pipeline,
 * then export PDF through the app's REAL menu command, REAL renderer PNG
 * rasterization and REAL printToPDF. The native save dialog is answered by the
 * test (a fixed temp path) — everything after the dialog is the real pipeline.
 */
test.describe('research figure export', () => {
  test('menu export produces a real PDF of the figure', async () => {
    test.setTimeout(180_000)
    const session = await launchResearchEditor()
    const { launched, editor } = session
    try {
      await createResearchFigure(session)

      // answer the native save dialog with a fixed temp path, then trigger the
      // app's own menu command so the whole renderer→main export chain runs
      const target = join(await mkdtemp(join(tmpdir(), 'metis-export-')), 'figure.pdf')
      await launched.app.evaluate(({ dialog }, filePath) => {
        const stubbed = ((options?: unknown) => {
          void options
          return Promise.resolve({ canceled: false, filePath })
        }) as typeof dialog.showSaveDialog
        ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = stubbed
      }, target)
      const clicked = await launched.app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu()
        if (!menu) return 'no menu'
        const walk = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
          for (const item of items) {
            if (item.submenu) {
              const found = walk((item.submenu as Electron.Menu).items)
              if (found) return found
            }
            if (item.label.includes('PDF')) return item
          }
          return null
        }
        const pdfItem = walk(menu.items)
        if (!pdfItem) return 'no pdf item'
        pdfItem.click()
        return 'clicked'
      })
      expect(clicked).toBe('clicked')

      // the status bar reports the export outcome; the file must exist and be
      // a real PDF (%PDF header) produced from the rendered figure
      await expect
        .poll(() => existsSync(target) && statSync(target).size > 1000, { timeout: 60_000 })
        .toBe(true)
      const head = readFileSync(target).subarray(0, 5).toString()
      expect(head).toBe('%PDF-')

      // and the deck itself still saves a valid PPTX alongside (sanity)
      const pptxPath = await saveAndGetPath(launched.app, editor)
      const xml = await readPptxSlideXml(pptxPath)
      expect(xml).toContain('<p:sp>')
    } finally {
      await closeAndSaveVideo(launched, 'research-figure-export')
      await session.stub.close()
    }
  })
})
