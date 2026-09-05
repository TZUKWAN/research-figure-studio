/**
 * Home preferences IPC surface (language / update channel / theme / default
 * save directory) — extracted from index.ts alongside home-file-ipc and
 * project-ipc (audit DESKTOP-P0-01/02). The settings STATE stays in index.ts
 * (it is entangled with menu rebuilds and nativeTheme); this module owns the
 * channel wiring, argument validation, and sender checks.
 */
import { BrowserWindow, ipcMain, nativeTheme, webContents } from 'electron'
import { assertTrustedIpcSender, type SenderTrustOptions } from '@genoffice/electron-utils'
import { isLang, type Lang } from '@genoffice/i18n'
import { HOME_CHANNELS, type UiTheme } from '../../shared/home-api'
import { isUpdateChannel, type UpdateChannel } from '../../shared/update-api'

export interface PreferencesIpcDeps {
  senderTrust: SenderTrustOptions
  getShellWindow(): BrowserWindow | null
  /** Persist + broadcast a language switch (menus, dock, back-to-home items). */
  onLanguageSwitched(lang: Lang): void
  currentLanguage(): Lang
  currentUpdateChannel(): UpdateChannel
  /** Persist + reconfigure the auto-updater feed. */
  onUpdateChannelSwitched(channel: UpdateChannel): void
  currentTheme(): UiTheme
  /** Persist the theme; nativeTheme + renderer broadcast are handled here. */
  onThemeSwitched(theme: UiTheme): void
  defaultSaveDir(): string
  /** Opens the directory picker and persists the choice; null = canceled/invalid. */
  pickDefaultSaveDir(): Promise<string | null>
}

export function registerPreferencesIpc(deps: PreferencesIpcDeps): void {
  const assertSender = (event: unknown, label: string): void => {
    assertTrustedIpcSender(
      event as Parameters<typeof assertTrustedIpcSender>[0],
      deps.senderTrust,
      label,
    )
  }

  ipcMain.handle(HOME_CHANNELS.getLanguage, (): Lang => deps.currentLanguage())

  ipcMain.handle(HOME_CHANNELS.setLanguage, (event, lang: unknown) => {
    assertSender(event, 'home:set-language')
    if (!isLang(lang) || lang === deps.currentLanguage()) return
    deps.onLanguageSwitched(lang)
  })

  ipcMain.handle(HOME_CHANNELS.getUpdateChannel, (): UpdateChannel => deps.currentUpdateChannel())

  ipcMain.handle(HOME_CHANNELS.setUpdateChannel, (event, channel: unknown) => {
    assertSender(event, 'home:set-update-channel')
    if (!isUpdateChannel(channel) || channel === deps.currentUpdateChannel()) return
    deps.onUpdateChannelSwitched(channel)
  })

  ipcMain.handle(HOME_CHANNELS.getTheme, (): UiTheme => deps.currentTheme())
  // editor tabs ask via the app-wide channel (symmetric with app:get-language)
  ipcMain.handle('app:get-theme', (): UiTheme => deps.currentTheme())

  ipcMain.handle(HOME_CHANNELS.setTheme, (event, theme: unknown) => {
    assertSender(event, 'home:set-theme')
    // unchanged behavior: unknown values are ignored, not rejected
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
    if (theme === deps.currentTheme()) return
    deps.onThemeSwitched(theme)
    nativeTheme.themeSource = theme
    for (const wc of webContents.getAllWebContents()) wc.send('app:theme-changed', theme)
  })

  ipcMain.handle(HOME_CHANNELS.getDefaultSaveDir, () => deps.defaultSaveDir())

  ipcMain.handle(HOME_CHANNELS.pickDefaultSaveDir, (event) => {
    assertSender(event, 'home:pick-default-save-dir')
    return deps.pickDefaultSaveDir()
  })
}
