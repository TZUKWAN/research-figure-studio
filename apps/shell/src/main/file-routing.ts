/**
 * Single dispatch surface for "open this path" — extracted from index.ts
 * (audit DESKTOP-P0-01). The shell owns file association routing by
 * extension: .pptx owns the Slides editor, other recognized office formats
 * are surfaced as unsupported, everything else is ignored.
 */
import { existsSync } from 'node:fs'
import { shell } from 'electron'
import type { TabManager } from './tab-manager'

export const PPTX_RE = /\.pptx$/i

/** non-Slides formats we recognize but don't open — surfaced as a warning */
export const UNSUPPORTED_FILE_RE =
  /\.(docx|doc|rtf|odt|xlsx|xlsm|xls|csv|xlsb|ppt|pps|odp|ods|pdf|md|markdown|pages|key|numbers)$/i

/** Single source of truth for the Slides open-dialog filter. */
export const OPEN_DIALOG_EXTENSIONS = ['pptx']

/** Pure argv routing: no window/tab state needed (used before app ready). */
export function supportedFileIn(argv: string[]): string | null {
  return argv.find((arg) => PPTX_RE.test(arg) && existsSync(arg)) ?? null
}

export function unsupportedFileIn(argv: string[]): string | null {
  return argv.find((arg) => UNSUPPORTED_FILE_RE.test(arg) && existsSync(arg)) ?? null
}

export interface FileRoutingDeps {
  getTabManager(): TabManager | null
  /**
   * Localized warning for recognized-but-unsupported files. The warning only
   * fires for a file that EXISTS on disk with an unsupported extension —
   * unchanged pre-split behavior. i18n stays in index.ts.
   */
  notifyUnsupported(filePath: string): void
}

export interface FileRouting {
  /** the single router: the Slides extension owns the file; false = nothing opened */
  openDocumentPath(filePath: string): boolean
  /** Open a just-written Slides export; other exported formats are revealed. */
  openGeneratedDocument(filePath: string): boolean
  routeDocumentPath(filePath: string): boolean
}

export function initFileRouting(deps: FileRoutingDeps): FileRouting {
  function routeDocumentPath(filePath: string): boolean {
    if (!existsSync(filePath)) return false
    const manager = deps.getTabManager()
    if (!manager) return false
    if (PPTX_RE.test(filePath)) {
      const existing = manager.findSlidesTabByPath(filePath)
      if (existing) {
        manager.activateTab(existing)
      } else {
        // For a new tab the path goes through the pending queue; the renderer consumes it after mounting
        manager.openSlidesTab(filePath)
      }
      return true
    }
    deps.notifyUnsupported(filePath)
    return false
  }

  function openDocumentPath(filePath: string): boolean {
    return routeDocumentPath(filePath)
  }

  function openGeneratedDocument(filePath: string): boolean {
    if (PPTX_RE.test(filePath)) return openDocumentPath(filePath)
    if (!existsSync(filePath)) return false
    shell.showItemInFolder(filePath)
    return true
  }

  return { openDocumentPath, openGeneratedDocument, routeDocumentPath }
}
