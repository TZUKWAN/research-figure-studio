import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
}

interface FakeView {
  webContents: FakeWebContents
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
}

interface FakeShellWindow {
  on: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  getContentBounds: () => { x: number; y: number; width: number; height: number }
  contentView: {
    addChildView: ReturnType<typeof vi.fn>
    removeChildView: ReturnType<typeof vi.fn>
  }
}

let nextWebContentsId = 1

function makeFakeView(): FakeView {
  const listeners = new Map<string, () => void>()
  return {
    webContents: {
      id: nextWebContentsId++,
      listeners,
      on: vi.fn((event: string, handler: () => void) => listeners.set(event, handler)),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
  }
}

vi.mock('electron', () => ({ BrowserWindow: class {} }))

const createSlidesView = vi.fn(() => makeFakeView())
const requestSlidesClose = vi.fn(() => Promise.resolve(true))
const setActiveSlidesWebContents = vi.fn()
const slidesIsDirty = vi.fn(() => false)

vi.mock('../../slides/src/main/slides-main', () => ({
  createSlidesView: (...args: unknown[]) => createSlidesView(...(args as [])),
  requestSlidesClose: (...args: unknown[]) => requestSlidesClose(...(args as [])),
  setActiveSlidesWebContents: (...args: unknown[]) => setActiveSlidesWebContents(...args),
  slidesIsDirty: (...args: unknown[]) => slidesIsDirty(...(args as [])),
}))

import { TabManager } from '../src/main/tab-manager'

const TAB_STRIP_HEIGHT = 40
const WINDOW_WIDTH = 800
const WINDOW_HEIGHT = 600

let shellWindow: FakeShellWindow
let onChanged: ReturnType<typeof vi.fn>
let applyMenuFor: ReturnType<typeof vi.fn>
let manager: TabManager

function lastCreatedView(): FakeView {
  return createSlidesView.mock.results.at(-1)!.value as FakeView
}

function resizeHandler(): () => void {
  const call = shellWindow.on.mock.calls.find(([event]) => event === 'resize')
  expect(call).toBeDefined()
  return call![1] as () => void
}

function makeShellWindow(): FakeShellWindow {
  return {
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getContentBounds: () => ({ x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  }
}

function readShellSource(relativePath: string): string {
  return readFileSync(join(__dirname, '../src', relativePath), 'utf8')
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 1
  requestSlidesClose.mockImplementation(() => Promise.resolve(true))
  slidesIsDirty.mockImplementation(() => false)
  shellWindow = makeShellWindow()
  onChanged = vi.fn()
  applyMenuFor = vi.fn()
  manager = new TabManager(
    shellWindow as never,
    () => onChanged(),
    (kind) => applyMenuFor(kind),
  )
})

describe('TabManager in the slides-only shell', () => {
  it('exposes only Home and Slides in the shell call chain', () => {
    const homeApi = readShellSource('shared/home-api.ts')
    const tabsApi = readShellSource('shared/tabs-api.ts')
    const preload = readShellSource('preload/index.ts')
    const home = readShellSource('renderer/src/Home.tsx')
    const tabBar = readShellSource('renderer/src/TabBar.tsx')
    const appFrame = readShellSource('renderer/src/AppFrame.tsx')
    const main = readShellSource('main/index.ts')
    const strings = readShellSource('renderer/src/strings.ts')

    expect(homeApi).not.toMatch(/newDoc|newSheet|newMarkdown|newPdf/)
    expect(preload).not.toMatch(/newDoc|newSheet|newMarkdown|newPdf/)
    expect(strings).not.toMatch(/^\s+(newDoc|newSheet|newMarkdown|newPdf|filterPdf|filterMd):/m)
    const homeStrings = readShellSource('main/home-strings.ts')
    expect(homeStrings).not.toMatch(
      /^\s*(menuNewDoc|menuNewSheet|menuNewMarkdown|menuNewPdf|untitledSheet|untitledDoc|untitledMarkdown|untitledPdf|filterWord|filterExcel|filterPpt|filterMarkdown|filterPdf):/m,
    )
    expect(tabsApi).toContain("export type TabKind = 'home' | 'slides'")
    expect(tabsApi).not.toMatch(/'docs'|'sheets'|'pdf'|'markdown'/)
    const localFilters = home.match(/const FILTERS:[\s\S]*?\n\]/)?.[0] ?? ''
    expect(localFilters).not.toMatch(/filterDocs|filterSheets|filterPdf|filterMd/)
    expect(home).toContain("const OPEN_LOCAL_EXTENSIONS = '.pptx'")
    expect(tabBar).not.toMatch(
      /DocIcon|SheetIcon|PdfIcon|MarkdownIcon|docs:|sheets:|pdf:|markdown:/,
    )
    expect(appFrame).not.toMatch(/docs\/sheets/)
    expect(main).not.toMatch(/docs and sheets modules|apps\/docs\/out|apps\/sheets\/out/)
    // Handlers moved into main/ipc/* (God-file split); the open-dialog filter
    // single source of truth lives in main/file-routing.ts now.
    const fileRouting = readShellSource('main/file-routing.ts')
    const homeFileIpc = readShellSource('main/ipc/home-file-ipc.ts')
    const preferencesIpc = readShellSource('main/ipc/preferences-ipc.ts')
    expect(fileRouting).toMatch(/const OPEN_DIALOG_EXTENSIONS = \[\s*'pptx',?\s*\]/)
    expect(homeFileIpc).toMatch(/ipcMain\.handle\(HOME_CHANNELS\.recents/)
    expect(homeFileIpc).toMatch(/ipcMain\.handle\(HOME_CHANNELS\.starred/)
    expect(homeFileIpc).toMatch(/ipcMain\.handle\(HOME_CHANNELS\.statPaths/)
    expect(homeFileIpc).toMatch(/ipcMain\.handle\(HOME_CHANNELS\.toggleStar/)
    expect(homeFileIpc).toMatch(/ipcMain\.handle\(HOME_CHANNELS\.removeRecent/)
    expect(preferencesIpc).toMatch(/HOME_CHANNELS\.getDefaultSaveDir/)
    expect(preferencesIpc).toMatch(/HOME_CHANNELS\.pickDefaultSaveDir/)
  })

  it('starts with only the active, non-closable Home tab', () => {
    expect(manager.list()).toEqual([
      { id: 'home', kind: 'home', title: 'Metis Diagram', closable: false, active: true },
    ])
  })

  it('opens a slides tab, attaches its view, and activates it', () => {
    const id = manager.openSlidesTab()
    const view = lastCreatedView()

    expect(manager.list()).toEqual([
      { id: 'home', kind: 'home', title: 'Metis Diagram', closable: false, active: false },
      { id, kind: 'slides', title: 'AI Canvas', closable: true, active: true },
    ])
    expect(shellWindow.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })
    expect(setActiveSlidesWebContents).toHaveBeenLastCalledWith(view.webContents)
    expect(applyMenuFor).toHaveBeenLastCalledWith('slides')
  })

  it('assigns unique, monotonic IDs to Slides tabs', () => {
    expect(manager.openSlidesTab()).toBe('t1')
    expect(manager.openSlidesTab()).toBe('t2')
  })

  it('shows only the activated Slides view and refreshes its active target', () => {
    const firstId = manager.openSlidesTab()
    const firstView = lastCreatedView()
    manager.openSlidesTab()
    const secondView = lastCreatedView()

    manager.activateTab(firstId)

    expect(firstView.setVisible).toHaveBeenLastCalledWith(true)
    expect(secondView.setVisible).toHaveBeenLastCalledWith(false)
    expect(setActiveSlidesWebContents).toHaveBeenLastCalledWith(firstView.webContents)
    expect(applyMenuFor).toHaveBeenLastCalledWith('slides')
  })

  it('uses file basenames and keeps tab file bookkeeping in sync', () => {
    const id = manager.openSlidesTab('/tmp/deck.pptx')
    const view = lastCreatedView()

    expect(manager.list()[1]).toMatchObject({ id, title: 'deck.pptx', active: true })
    manager.setTabFileFor(view.webContents.id, '/tmp/final.pptx')
    expect(manager.list()[1]).toMatchObject({ title: 'final.pptx' })
    expect(manager.findSlidesTabByPath('/tmp/final.pptx')).toBe(id)

    const affected = manager.renameTabFile('/tmp/final.pptx', '/tmp/renamed.pptx')
    expect(affected).toEqual([{ kind: 'slides', webContents: view.webContents }])
    expect(manager.findSlidesTabByPath('/tmp/renamed.pptx')).toBe(id)
  })

  it('ignores activation and bookkeeping requests for unknown ids', () => {
    onChanged.mockClear()
    manager.activateTab('missing')
    manager.setTabFileFor(999, '/tmp/missing.pptx')
    expect(onChanged).not.toHaveBeenCalled()
    expect(manager.list()[0]!.active).toBe(true)
  })

  it('routes fullscreen and bleed bounds over the tab strip', () => {
    manager.openSlidesTab()
    const view = lastCreatedView()
    const fullBounds = { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
    const normalBounds = {
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    }

    manager.setContentBleed(view.webContents, true)
    expect(view.setBounds).toHaveBeenLastCalledWith(fullBounds)
    manager.setContentBleed(view.webContents, false)
    expect(view.setBounds).toHaveBeenLastCalledWith(normalBounds)
    view.webContents.listeners.get('enter-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith(fullBounds)
    view.webContents.listeners.get('leave-html-full-screen')!()
    expect(view.setBounds).toHaveBeenLastCalledWith(normalBounds)
  })

  it('re-lays out after a resize settles and skips it after destruction', async () => {
    manager.openSlidesTab()
    const view = lastCreatedView()
    view.setBounds.mockClear()
    let width = WINDOW_WIDTH
    let height = WINDOW_HEIGHT
    shellWindow.getContentBounds = () => ({ x: 0, y: 0, width, height })

    resizeHandler()()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT - TAB_STRIP_HEIGHT,
    })
    width = 1920
    height = 1080
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 0,
      y: TAB_STRIP_HEIGHT,
      width: 1920,
      height: 1080 - TAB_STRIP_HEIGHT,
    })

    view.setBounds.mockClear()
    resizeHandler()()
    shellWindow.isDestroyed.mockReturnValue(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(view.setBounds).toHaveBeenCalledTimes(1)
  })

  it('keeps Home open and removes a clean slides tab', async () => {
    await manager.closeTab('home')
    const id = manager.openSlidesTab()
    const view = lastCreatedView()
    await manager.closeTab(id)

    expect(manager.list()).toEqual([
      { id: 'home', kind: 'home', title: 'Metis Diagram', closable: false, active: true },
    ])
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('activates the previous Slides tab when closing the active tab', async () => {
    const firstId = manager.openSlidesTab()
    const firstView = lastCreatedView()
    const secondId = manager.openSlidesTab()

    await manager.closeTab(secondId)

    expect(manager.list().map((tab) => tab.id)).toEqual(['home', firstId])
    expect(manager.list()[1]!.active).toBe(true)
    expect(firstView.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('keeps the active tab when closing a background Slides tab', async () => {
    const backgroundId = manager.openSlidesTab()
    const activeId = manager.openSlidesTab()

    await manager.closeTab(backgroundId)

    expect(manager.list().map((tab) => tab.id)).toEqual(['home', activeId])
    expect(manager.list()[1]!.active).toBe(true)
  })

  it('guards dirty tabs and prevents duplicate close prompts', async () => {
    slidesIsDirty.mockReturnValue(true)
    let resolveGuard!: (ok: boolean) => void
    requestSlidesClose.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveGuard = resolve
        }),
    )
    const id = manager.openSlidesTab()
    const first = manager.closeTab(id)
    const second = manager.closeTab(id)
    resolveGuard(false)
    await Promise.all([first, second])

    expect(requestSlidesClose).toHaveBeenCalledTimes(1)
    expect(manager.findSlidesTabByPath('/tmp/missing.pptx')).toBeUndefined()
    expect(manager.list()).toHaveLength(2)
  })

  it('activates a dirty background tab before asking to close it', async () => {
    slidesIsDirty.mockReturnValue(true)
    requestSlidesClose.mockImplementation(() => Promise.resolve(false))
    const backgroundId = manager.openSlidesTab()
    manager.openSlidesTab()

    await manager.closeTab(backgroundId)

    expect(requestSlidesClose).toHaveBeenCalledTimes(1)
    expect(manager.list().find((tab) => tab.id === backgroundId)?.active).toBe(true)
    expect(manager.list()).toHaveLength(3)
  })

  it('reports dirty slides tabs and keeps Home pinned during reorder', () => {
    const firstId = manager.openSlidesTab()
    const firstView = lastCreatedView()
    const secondId = manager.openSlidesTab()
    slidesIsDirty.mockImplementation((id: number) => id === firstView.webContents.id)

    expect(manager.dirtySlidesTabs()).toEqual([{ id: firstId, webContents: firstView.webContents }])
    manager.reorderTab('home', 2)
    manager.reorderTab(secondId, 1)
    expect(manager.list().map((tab) => tab.id)).toEqual(['home', secondId, firstId])
  })

  it('does not report a rename when no Slides tab matches the old path', () => {
    onChanged.mockClear()

    expect(manager.renameTabFile('/tmp/missing.pptx', '/tmp/new.pptx')).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
  })
})
