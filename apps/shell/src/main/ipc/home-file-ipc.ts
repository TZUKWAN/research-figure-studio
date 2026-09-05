/**
 * Home-file IPC surface (recent lists, open/rename/duplicate/delete/reveal) —
 * extracted from index.ts and hardened (audit DESKTOP-P0-03/04).
 *
 * Every handler validates its arguments at runtime (TypeScript annotations are
 * compile-time only; the renderer side of the preload boundary is untrusted
 * data), destructive/mutating handlers verify the sender hosts app content,
 * and every renderer-supplied PATH passes through checkFilePath: absolute,
 * canonicalized, extension-allowlisted, existing regular file — a directory
 * named `deck.pptx` can never be renamed, duplicated, or trashed.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, renameSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  assertTrustedIpcSender,
  checkFilePath,
  showOpenDialogWithMemory,
  type SenderTrustOptions,
} from '@genoffice/electron-utils'
import { slidesFileRenamed } from '../../../../slides/src/main/slides-main'
import type { RecentEntry, RecentPage, RenameResult } from '../../shared/home-api'
import { HOME_CHANNELS } from '../../shared/home-api'
import { OPEN_DIALOG_EXTENSIONS, PPTX_RE } from '../file-routing'
import type { HomeStringKey } from '../home-strings'
import { sanitizeFileName } from '../path-guard'
import { pageRecentPaths, normalizeRecentQuery } from '../recent-files'
import {
  pageStarredSlides,
  readPathList,
  readSlidesRecentFiles,
  readStarredSlides,
  recordSlidesRecentFile,
  removeSlidesRecentFiles,
  replaceSlidesPath,
  slidesPaths,
  statSlidesEntries,
  starredPath,
  writePathList,
} from '../recent-state'
import type { TabManager } from '../tab-manager'

/** Recents/starred pagination shape (mirrors the shell renderer's query). */
type RecentQuery = Parameters<typeof normalizeRecentQuery>[0]

export interface HomeFileIpcDeps {
  senderTrust: SenderTrustOptions
  tm(key: HomeStringKey, params?: Parameters<typeof import('../home-strings').homeI18n>[2]): string
  getShellWindow(): BrowserWindow | null
  getTabManager(): TabManager | null
  openDocumentPath(filePath: string): boolean
  newSlideTab(): void
  /** remember which project the next Slides save should land in (create-from-project flow) */
  setPendingProject(projectId: string): void
}

function stringPaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
}

/** Canonical home deck path: absolute, .pptx, existing regular file. */
function homeDeckPath(raw: unknown): string | null {
  const check = checkFilePath(raw, { extensions: ['pptx'], mustExist: true })
  return check.ok ? check.resolved : null
}

export function registerHomeFileIpc(deps: HomeFileIpcDeps): void {
  const { senderTrust: trust } = deps

  /** Sender gate for mutating/destructive channels: throws on a hostile frame. */
  const assertSender = (event: unknown, label: string): void => {
    assertTrustedIpcSender(event as Parameters<typeof assertTrustedIpcSender>[0], trust, label)
  }

  ipcMain.handle(HOME_CHANNELS.recents, (_event, query: unknown): RecentPage =>
    pageRecentPaths(
      readSlidesRecentFiles(),
      { ...normalizeRecentQuery(query as RecentQuery), ext: 'pptx' },
      new Set(readStarredSlides()),
    ),
  )

  ipcMain.handle(HOME_CHANNELS.starred, (_event, query: unknown): RecentPage =>
    pageStarredSlides(query),
  )

  ipcMain.handle(HOME_CHANNELS.statPaths, (_event, paths: unknown): RecentEntry[] =>
    statSlidesEntries(stringPaths(paths)),
  )

  ipcMain.handle(HOME_CHANNELS.toggleStar, (event, path: unknown) => {
    assertSender(event, 'home:toggle-star')
    const resolved = homeDeckPath(path)
    if (!resolved) return
    const starred = readPathList(starredPath())
    const next = starred.includes(resolved)
      ? starred.filter((item) => item !== resolved)
      : [...starred, resolved]
    writePathList(starredPath(), next)
  })

  ipcMain.handle(HOME_CHANNELS.getAppVersion, (): string => app.getVersion())

  ipcMain.handle(HOME_CHANNELS.openPath, (event, path: unknown) => {
    assertSender(event, 'home:open-path')
    // Any existing path is routed (the router itself warns for recognized but
    // unsupported extensions); only canonical .pptx decks reach a tab.
    const check = checkFilePath(path, { mustExist: true })
    if (check.ok) deps.openDocumentPath(check.resolved)
  })

  ipcMain.handle(HOME_CHANNELS.browse, async (event) => {
    assertSender(event, 'home:browse')
    const win =
      BrowserWindow.fromWebContents((event as Electron.IpcMainInvokeEvent).sender) ??
      deps.getShellWindow()
    if (!win) return
    const result = await showOpenDialogWithMemory(dialog, win, {
      title: deps.tm('dlgOpenTitle'),
      filters: [{ name: deps.tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS }],
      properties: ['openFile', 'multiSelections'],
    })
    if (!result.canceled) for (const path of result.filePaths) deps.openDocumentPath(path)
  })

  ipcMain.handle(HOME_CHANNELS.newSlide, (event, opts?: { projectId?: string }) => {
    assertSender(event, 'home:new-slide')
    if (opts?.projectId && opts.projectId !== 'default') {
      deps.setPendingProject(opts.projectId)
    }
    deps.newSlideTab()
  })

  ipcMain.handle(HOME_CHANNELS.removeRecent, (_event, paths: unknown) => {
    // list hygiene only — drops paths from the app-owned recent JSON
    removeSlidesRecentFiles(slidesPaths(stringPaths(paths)))
  })

  ipcMain.handle(HOME_CHANNELS.revealPath, (event, path: unknown) => {
    assertSender(event, 'home:reveal-path')
    const check = checkFilePath(path, { mustExist: true })
    if (check.ok) shell.showItemInFolder(check.resolved)
  })

  ipcMain.handle(
    HOME_CHANNELS.renameFile,
    (event, path: unknown, newName: unknown): RenameResult => {
      assertSender(event, 'home:rename-file')
      if (typeof path !== 'string' || typeof newName !== 'string')
        return { ok: false, error: deps.tm('errBadArgs') }
      // The new NAME is sanitized before it is ever joined onto a directory
      const name = sanitizeFileName(newName)
      if (!name.ok || !PPTX_RE.test(name.name)) return { ok: false, error: deps.tm('errBadName') }
      const resolved = homeDeckPath(path)
      if (!resolved) return { ok: false, error: deps.tm('errMissing') }
      const target = join(dirname(resolved), name.name)
      if (target === resolved) return { ok: true, path: resolved }
      if (existsSync(target)) return { ok: false, error: deps.tm('errExists') }
      try {
        renameSync(resolved, target)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : deps.tm('errRenameFailed'),
        }
      }
      replaceSlidesPath(resolved, target)
      // open tabs sync their title/path; the editor then syncs its internal save path and title bar
      const affected = deps.getTabManager()?.renameTabFile(resolved, target) ?? []
      for (const t of affected) {
        if (t.kind === 'slides') slidesFileRenamed(t.webContents, resolved, target)
      }
      return { ok: true, path: target }
    },
  )

  ipcMain.handle(HOME_CHANNELS.duplicateFile, (event, path: unknown) => {
    assertSender(event, 'home:duplicate-file')
    const resolved = homeDeckPath(path)
    if (!resolved) return
    const ext = extname(resolved)
    const base = basename(resolved, ext)
    const dir = dirname(resolved)
    for (let i = 1; ; i++) {
      const target = join(dir, `${base} ${deps.tm('copySuffix')}${i === 1 ? '' : ` ${i}`}${ext}`)
      if (existsSync(target)) continue
      copyFileSync(resolved, target)
      recordSlidesRecentFile(target)
      return
    }
  })

  ipcMain.handle(HOME_CHANNELS.deleteFiles, async (event, paths: unknown) => {
    assertSender(event, 'home:delete-files')
    // trash is destructive: only canonical, existing, regular .pptx files pass
    const list = slidesPaths(stringPaths(paths))
      .map((p) => homeDeckPath(p))
      .filter((p): p is string => p !== null)
    for (const p of list) {
      try {
        await shell.trashItem(p)
      } catch {
        // file already gone or trash unavailable; still drop it from the list
      }
    }
    removeSlidesRecentFiles(list)
    const drop = new Set(list)
    writePathList(
      starredPath(),
      readPathList(starredPath()).filter((path) => !drop.has(path)),
    )
  })

  ipcMain.handle(HOME_CHANNELS.openTrash, () => {
    if (process.platform === 'darwin') {
      void shell.openPath(join(app.getPath('home'), '.Trash'))
    } else if (process.platform === 'win32') {
      spawn('explorer.exe', ['shell:RecycleBin'], { detached: true }).unref()
    } else {
      void shell.openPath(join(app.getPath('home'), '.local', 'share', 'Trash', 'files'))
    }
  })
}
