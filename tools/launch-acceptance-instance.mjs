/**
 * Real-UI acceptance launcher (production closure 2).
 *
 * Boots the REAL Electron shell from this worktree's build with an ISOLATED
 * userData dir pre-seeded to point BYOK at a local deterministic stub provider
 * (the same one the E2E suite uses — bundled from e2e/helpers/stub-provider.ts).
 * The app stays running so a human / Computer-Use session can drive real UI
 * acceptance scenarios; the stub server stays alive in this process.
 *
 * Usage:  node tools/launch-acceptance-instance.mjs
 * Output: docs/acceptance/ui-evidence/acceptance-instance.json + console info.
 * Stop the stub server with Ctrl+C here (the app itself keeps running).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHELL_DIR = join(ROOT, 'apps', 'shell')
const SHELL_MAIN = join(SHELL_DIR, 'out', 'main', 'index.js')
const EVIDENCE = join(ROOT, 'docs', 'acceptance', 'ui-evidence')
mkdirSync(EVIDENCE, { recursive: true })

if (!existsSync(SHELL_MAIN)) {
  console.error(`Missing build output at ${SHELL_MAIN} — run "npm run build:all" first`)
  process.exit(1)
}

const { startStubProvider, aiSettingsJson } = await import(
  'file:///' + join(HERE, '.acceptance-stub.mjs').replace(/\\/g, '/')
)

const userDataDir = mkdtempSync(join(process.env.TEMP ?? '/tmp', 'metis-acceptance-'))
const stub = await startStubProvider()
writeFileSync(join(userDataDir, 'ai-settings.json'), aiSettingsJson(stub.baseUrl))
writeFileSync(join(userDataDir, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }))

const require2 = createRequire(join(SHELL_DIR, 'package.json'))
const electronPath = require2('electron')
const env = { ...process.env, GENOFFICE_USER_DATA: userDataDir, GENOFFICE_LANG: 'en' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [SHELL_DIR], {
  detached: true,
  stdio: 'ignore',
  env,
})
child.unref()

const info = {
  appPid: child.pid,
  userDataDir,
  stubUrl: stub.baseUrl,
  shellMain: SHELL_MAIN,
  evidenceDir: EVIDENCE,
  startedAt: new Date().toISOString(),
}
writeFileSync(join(EVIDENCE, 'acceptance-instance.json'), JSON.stringify(info, null, 2))
console.log(JSON.stringify(info, null, 2))
console.log('\nApp is launching DETACHED. Drive the real UI now; save screenshots into')
console.log('docs/acceptance/ui-evidence/. Keep this process alive (stub server). Ctrl+C stops the stub only.')
process.on('SIGINT', () => stub.close())
setInterval(() => {}, 1 << 30)
