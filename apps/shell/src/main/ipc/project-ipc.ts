/**
 * Project (classification) IPC surface — extracted from index.ts and hardened
 * (audit DESKTOP-P0-02/03/04). Project ids are storage-id validated, names are
 * bounded strings, moved/imported paths are canonicalized .pptx paths, and the
 * sender must host app content. ProjectStore mutation failures throw
 * ProjectStoreError, which becomes an IPC rejection the renderer surfaces —
 * a failed write is never reported as success.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  assertBoundedString,
  assertPlainObject,
  assertSafeInt,
  assertTrustedIpcSender,
  checkFilePath,
  showOpenDialogWithMemory,
  type SenderTrustOptions,
} from '@genoffice/electron-utils'
import { assertStorageId, type ProjectStore } from '@genoffice/project-store'
import { PROJECT_CHANNELS } from '../../shared/home-api'
import { OPEN_DIALOG_EXTENSIONS } from '../file-routing'
import type { HomeStringKey } from '../home-strings'

export interface ProjectIpcDeps {
  senderTrust: SenderTrustOptions
  tm(
    key: HomeStringKey,
    params?: Parameters<typeof import('../home-strings').homeI18n>[2],
  ): string
  getShellWindow(): BrowserWindow | null
  getProjectStore(): ProjectStore
}

const PROJECT_NAME_MAX = 200
const TIMELINE_LIMIT_MAX = 1_000

export function registerProjectIpc(deps: ProjectIpcDeps): void {
  const { senderTrust: trust } = deps

  const assertSender = (event: unknown, label: string): void => {
    assertTrustedIpcSender(event as Parameters<typeof assertTrustedIpcSender>[0], trust, label)
  }

  ipcMain.handle(PROJECT_CHANNELS.list, () => deps.getProjectStore().listProjectsSummary())

  ipcMain.handle(PROJECT_CHANNELS.files, (event, rawArgs: unknown) => {
    assertSender(event, 'project:files')
    const args = assertPlainObject(rawArgs, 'project:files args')
    return deps.getProjectStore().listProjectFiles(assertStorageId(args.projectId, 'project id'))
  })

  ipcMain.handle(PROJECT_CHANNELS.create, (event, rawArgs: unknown) => {
    assertSender(event, 'project:create')
    const args = assertPlainObject(rawArgs, 'project:create args')
    const store = deps.getProjectStore()
    const project = store.createProject(
      assertBoundedString(args.name, 'project name', PROJECT_NAME_MAX),
    )
    return store.listProjectsSummary().find((summary) => summary.id === project.id) ?? project
  })

  ipcMain.handle(PROJECT_CHANNELS.rename, (event, rawArgs: unknown) => {
    assertSender(event, 'project:rename')
    const args = assertPlainObject(rawArgs, 'project:rename args')
    deps.getProjectStore().renameProject(
      assertStorageId(args.id, 'project id'),
      assertBoundedString(args.name, 'project name', PROJECT_NAME_MAX),
    )
  })

  ipcMain.handle(PROJECT_CHANNELS.delete, (event, rawArgs: unknown) => {
    assertSender(event, 'project:delete')
    const args = assertPlainObject(rawArgs, 'project:delete args')
    deps.getProjectStore().deleteProject(assertStorageId(args.id, 'project id'))
  })

  ipcMain.handle(PROJECT_CHANNELS.moveFile, (event, rawArgs: unknown) => {
    assertSender(event, 'project:moveFile')
    const args = assertPlainObject(rawArgs, 'project:moveFile args')
    // Mapping records may outlive the file itself, so existence is not required
    // here — but the path must at least be an absolute .pptx reference.
    const check = checkFilePath(args.filePath, { extensions: ['pptx'] })
    if (!check.ok) throw new TypeError('Invalid project:moveFile filePath')
    deps
      .getProjectStore()
      .moveFileToProject(check.resolved, assertStorageId(args.projectId, 'project id'))
  })

  ipcMain.handle(PROJECT_CHANNELS.importFiles, async (event, rawArgs: unknown) => {
    assertSender(event, 'project:importFiles')
    const args = assertPlainObject(rawArgs, 'project:importFiles args')
    const projectId = assertStorageId(args.projectId, 'project id')
    const store = deps.getProjectStore()
    const win = deps.getShellWindow()
    if (!win || win.isDestroyed()) return []
    const result = await showOpenDialogWithMemory(dialog, win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: deps.tm('filterSupported'), extensions: OPEN_DIALOG_EXTENSIONS }],
    })
    if (result.canceled) return []
    const imported: string[] = []
    for (const filePath of result.filePaths) {
      try {
        store.moveFileToProject(filePath, projectId)
        imported.push(filePath)
      } catch (err) {
        console.warn('[project] import failed:', filePath, err)
      }
    }
    return imported
  })

  ipcMain.handle(PROJECT_CHANNELS.timeline, (event, rawArgs: unknown) => {
    assertSender(event, 'project:timeline')
    const args = assertPlainObject(rawArgs, 'project:timeline args')
    const limit =
      args.limit === undefined
        ? undefined
        : assertSafeInt(args.limit, 'timeline limit', { min: 1, max: TIMELINE_LIMIT_MAX })
    return deps.getProjectStore().getProjectTimeline(assertStorageId(args.projectId, 'project id'), limit)
  })
}
