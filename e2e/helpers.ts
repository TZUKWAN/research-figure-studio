/**
 * Shared launcher for Electron E2E tests.
 *
 * Each test boots the built shell (`apps/shell/out`) against a scratch
 * userData dir (via GENOFFICE_USER_DATA) so runs never touch real settings
 * and never collide with a running install's single-instance lock.
 * Build first: `npm run build:all`.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

export const SHELL_DIR = resolve(__dirname, '../apps/shell')
export const ARTIFACTS_DIR = resolve(__dirname, 'artifacts')

const SHELL_MAIN = join(SHELL_DIR, 'out/main/index.js')

interface LaunchOptions {
  /** reuse a previous scratch dir to simulate a second launch */
  userDataDir?: string
  /** UI language override (GENOFFICE_LANG); defaults to English for stable assertions */
  lang?: string
  /** pre-seed app-settings.json with onboardingSeen=true to start at the home screen */
  onboardingSeen?: boolean
  /** pre-seed ai-settings.json (BYOK) — e.g. a deterministic stub provider */
  aiSettings?: string
  /** subdir of e2e/artifacts to store this launch's video in */
  videoDir: string
  /** absolute document path passed as argv, opened in an editor tab on launch */
  openFile?: string
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

/**
 * Every live ElectronApplication this worker launched. Serial workers own at
 * most one app at a time; a sweep at close time guarantees no instance ever
 * dangles into Playwright's worker teardown (a lingering instance wedges the
 * worker for 90 s and fails the whole run as "1 error was not a part of any
 * test" even when every test passed).
 */

export async function launchShell(options: LaunchOptions): Promise<LaunchedApp> {
  if (!existsSync(SHELL_MAIN)) {
    throw new Error(`Missing build output at ${SHELL_MAIN} — run \`npm run build:all\` first`)
  }
  const userDataDir = options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'genoffice-e2e-')))
  if (options.onboardingSeen) {
    await writeFile(
      join(userDataDir, 'app-settings.json'),
      JSON.stringify({ onboardingSeen: true }),
    )
  }
  if (options.aiSettings) {
    await writeFile(join(userDataDir, 'ai-settings.json'), options.aiSettings)
  }
  const require = createRequire(join(SHELL_DIR, 'package.json'))
  const executablePath = require('electron') as unknown as string
  // ELECTRON_RUN_AS_NODE (set by VS Code/CI hosts) would boot Electron as
  // plain Node with no windows — strip it so the app always starts as an app
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...hostEnv } = process.env
  // Linux CI runners restrict unprivileged user namespaces (no usable SUID
  // sandbox) and run under xvfb without GPU — without these the window opens
  // but the renderer never loads. The suite drives trusted local builds only.
  // Switches go before the app path so Chromium is guaranteed to consume them
  // and they never leak into the argv the app parses for documents to open.
  const args: string[] = []
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
  args.push(SHELL_DIR)
  if (options.openFile) args.push(options.openFile)
  const app = await electron.launch({
    executablePath,
    args,
    env: {
      ...hostEnv,
      GENOFFICE_USER_DATA: userDataDir,
      GENOFFICE_LANG: options.lang ?? 'en',
      // unattended runs must not spawn a system PDF viewer after exports —
      // the child process blocks app.quit() on headless Linux
      GENOFFICE_NO_AUTO_OPEN: '1',
      ...(process.platform === 'linux'
        ? {
            ELECTRON_DISABLE_SANDBOX: '1',
            // CI runners have no session bus; Chromium's dbus retries wedge the
            // main loop at shutdown, so app.quit() never completes and
            // ElectronApplication.close() hangs. Point dbus at a black hole
            // (the standard headless-CI workaround) so quit proceeds.
            DBUS_SESSION_BUS_ADDRESS: '/dev/null',
          }
        : {}),
    },
    // Playwright's Electron screencast wedges the page CDP session on Linux
    // (page.url() stays empty, no lifecycle events, evaluate hangs) — record
    // only where it works
    recordVideo:
      process.platform === 'linux'
        ? undefined
        : {
            dir: join(ARTIFACTS_DIR, options.videoDir),
            size: { width: 1280, height: 800 },
          },
  })
  const page = await app.firstWindow()
  await waitForDocumentReady(app, page)
  return { app, page, userDataDir }
}

/**
 * Playwright can attach to the Electron window mid-navigation and miss the
 * load lifecycle events entirely (Linux timing) — waitForLoadState then hangs
 * on a page that is actually loaded. Polling through evaluate uses the live
 * CDP session instead of the missed events.
 */
async function waitForDocumentReady(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // the pre-navigation about:blank document also reports readyState complete
    const ready = await page
      .evaluate(() =>
        document.readyState !== 'loading' && window.location.href !== 'about:blank'
          ? document.readyState
          : null,
      )
      .catch(() => null)
    if (ready) return
    await new Promise((r) => setTimeout(r, 100))
  }
  // process list tells renderer-spawn failures apart from slow loads
  const diag = await app
    .evaluate(({ app: electronApp, BrowserWindow }) => ({
      processes: electronApp.getAppMetrics().map((m) => m.type),
      contents: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    }))
    .catch((e) => String(e))
  throw new Error(`Shell window never loaded (url: ${page.url()}, diag: ${JSON.stringify(diag)})`)
}

/**
 * Close the app and return the recorded video path for the given page.
 *
 * Open editor tabs trigger a native Save/Don't Save/Cancel dialog on close,
 * which would block app.close() forever — stub the dialog to answer
 * "Don't Save" (button index 1) so shutdown stays unattended. If close still
 * hangs, kill the process after 20s so the suite never wedges.
 */
export async function closeAndSaveVideo(
  launched: LaunchedApp,
  name: string,
): Promise<string | undefined> {
  const video = launched.page.video()
  // Dialog stub + handshake: stub "Don't Save" on dirty-editor close, and —
  // empirically load-bearing — give the app's main loop one bounded round-trip
  // before app.close(). Skipping the round-trip entirely leaves Playwright's
  // internal close state wedged and the WORKER teardown times out (90 s) even
  // when every test passed. A wedged main process must never hang this path,
  // so the round-trip is capped at 3 s; the SIGKILL fallback below still
  // guarantees termination when close() itself cannot proceed.
  await Promise.race([
    launched.app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({
          response: 1,
          checkboxChecked: false,
        })) as typeof dialog.showMessageBox
      })
      .catch(() => {}),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000)),
  ])
  // P1-7 teardown pattern: a Promise.race alone leaves the losing close()
  // promise pending forever, keeping the ElectronApplication undisposed —
  // the worker then re-closes it at teardown and blows the 90 s worker
  // teardown timeout ("1 error was not a part of any test" even when every
  // test passed). So RACE close() with a force kill, then await THE SAME
  // close() promise — it resolves once the process is gone, and Playwright's
  // internal close state settles with it.
  let killTimer: NodeJS.Timeout | undefined
  const gracefulClose = launched.app.close().catch(() => {})
  const forceKill = new Promise<void>((resolvePromise) => {
    killTimer = setTimeout(() => {
      console.log(`[teardown] force-killing electron pid=${launched.app.process()?.pid}`)
      try {
        launched.app.process().kill('SIGKILL')
      } catch {
        // already gone
      }
      resolvePromise()
    }, 20_000)
  })
  await Promise.race([gracefulClose, forceKill])
  if (killTimer) clearTimeout(killTimer)
  // Bounded second await on the SAME close promise: it resolves once the
  // process is gone (gracefully or via the SIGKILL above).
  await Promise.race([
    gracefulClose,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000)),
  ])
  if (!video) return undefined
  const target = join(ARTIFACTS_DIR, 'videos', `${name}.webm`)
  try {
    await video.saveAs(target)
    return target
  } catch {
    return undefined
  }
}

export function screenshotPath(name: string): string {
  return join(ARTIFACTS_DIR, 'screenshots', `${name}.png`)
}

/**
 * Wait for a page whose URL contains `urlPart` (e.g. an editor WebContentsView).
 * Checks windows that already exist before listening, so it never races the
 * view being created between launch and the first waitForEvent call.
 */
export async function waitForPageWithUrl(
  app: ElectronApplication,
  urlPart: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of app.windows()) {
      if (candidate.url().includes(urlPart)) return candidate
      // page.url() stays empty when attach raced navigation; ask the document
      const href = await candidate.evaluate(() => window.location.href).catch(() => '')
      if (href.includes(urlPart)) return candidate
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`No window with URL containing "${urlPart}"`)
    await app.waitForEvent('window', { timeout: Math.min(remaining, 1_000) }).catch(() => {})
  }
}

/** Activate the Shell Home tab; a normal launch initially opens a Slides tab. */
export async function activateHome(app: ElectronApplication): Promise<Page> {
  const page = await waitForPageWithUrl(app, 'shell/out')
  await page.waitForSelector('.app-frame', { timeout: 30_000 })
  await page.waitForSelector('.tab-bar .tab-item', { timeout: 30_000 })
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        aiOfficeTabs: { list(): Promise<unknown>; activate(id: string): Promise<void> }
      }
    ).aiOfficeTabs
    await api.list()
    await api.activate('home')
  })
  await page.locator('.tab-bar .tab-item.tab-home.active').waitFor({
    state: 'visible',
    timeout: 30_000,
  })
  return page
}
