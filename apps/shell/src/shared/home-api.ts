import type { AiChatResponse, AiProviderMeta, AiSettings } from '@genoffice/ai-provider'
import type { UpdateChannel } from './update-api'

/** UI language; kept self-contained here (mirrors Lang in @genoffice/i18n) */
export type UiLanguage =
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'th'
  | 'id'
  | 'ru'
  | 'ar'
  | 'pt'
  | 'it'
  | 'pl'
  | 'nl'
  | 'ms'
  | 'he'
  | 'hi'
  | 'zh-TW'

/** UI theme preference */
export type UiTheme = 'light' | 'dark' | 'system'

/** a recent file entry shown on the home screen; type derives from the extension */
export interface RecentEntry {
  path: string
  name: string
  /** lowercased extension without the dot ('pptx') */
  ext: string
  /** last-modified time, ms since epoch */
  mtimeMs: number
  /** file size in bytes */
  sizeBytes: number
  /** whether the user starred this file */
  starred: boolean
}

/** paged query for the home file lists */
export interface RecentQuery {
  /** number of entries to skip (default 0) */
  offset?: number
  /** page size; 0 returns no entries but still reports totals (default 50) */
  limit?: number
  /** restrict to the Slides extension ('pptx'); omit for all */
  ext?: string
}

export interface RecentPage {
  entries: RecentEntry[]
  /** total matching the query's ext filter */
  total: number
  /** total ignoring the ext filter (for the sidebar counters) */
  totalAll: number
}

export interface HomeApi {
  /** recent Slides files, newest first (paged) */
  recents(query?: RecentQuery): Promise<RecentPage>
  /** starred files (independent of the recent list), newest first (paged) */
  starred(query?: RecentQuery): Promise<RecentPage>
  /** stat a specific set of paths (project view); missing files are skipped */
  statPaths(paths: string[]): Promise<RecentEntry[]>
  /** star / unstar a file */
  toggleStar(path: string): Promise<void>
  /** open an existing Slides file */
  openPath(path: string): Promise<void>
  /** file picker accepting Slides files */
  browse(): Promise<void>
  /** open a slides tab at its start screen (open-a-pptx) */
  newSlide(opts?: { projectId?: string }): Promise<void>
  /** drop entries from the recent list (does not touch the files) */
  removeRecent(paths: string[]): Promise<void>
  /** reveal the file in Finder / Explorer */
  revealPath(path: string): Promise<void>
  /** rename the file on disk (same directory) and update the recent list */
  renameFile(path: string, newName: string): Promise<RenameResult>
  /** copy the file next to itself (localized "copy" suffix before .ext) and record it as recent */
  duplicateFile(path: string): Promise<void>
  /** move files to the trash and drop them from the recent list */
  deleteFiles(paths: string[]): Promise<void>
  /** open the OS trash, where deleted files can be restored */
  openTrash(): Promise<void>
  /** current UI language (persisted in userData/app-settings.json) */
  getLanguage(): Promise<UiLanguage>
  /** switch + persist the UI language; main rebuilds its menus to match */
  setLanguage(lang: UiLanguage): Promise<void>
  /** current update channel (persisted in userData/app-settings.json; default 'stable') */
  getUpdateChannel(): Promise<UpdateChannel>
  /** switch + persist the update channel; triggers an immediate update check */
  setUpdateChannel(channel: UpdateChannel): Promise<void>
  /** app version (from package.json / electron app.getVersion) */
  getAppVersion(): Promise<string>
  /** current UI theme preference (persisted in userData/app-settings.json) */
  getTheme(): Promise<UiTheme>
  /** switch + persist the UI theme; broadcasts 'app:theme-changed' to all web contents */
  setTheme(theme: UiTheme): Promise<void>
  /** effective default save folder for new/untitled files (configured in userData/app-settings.json, falls back to <Documents>/Metis SD) */
  getDefaultSaveDir(): Promise<string>
  /** directory picker to change the default save folder; resolves to the new folder, or null when canceled or the pick was unusable */
  pickDefaultSaveDir(): Promise<string | null>
  /** theme switched anywhere (broadcast from the main process) */
  onThemeChanged(handler: (theme: UiTheme) => void): () => void
  /** AI settings (userData/ai-settings.json, shared by every editor); the genspark key never appears here */
  getAiSettings(): Promise<AiSettings>
  /** persist AI settings; open editors pick the change up on their next settings read */
  setAiSettings(settings: AiSettings): Promise<void>
  /** provider catalog with each fixed endpoint's default base URL (empty for genspark/custom) */
  getAiProviders(): AiCatalogEntry[]
  /** built-in AI drawing prompts + registry metadata (Settings → Standards) */
  getPromptDefaults(): Promise<{
    agent: Record<string, string>
    defs: { id: string; titleZh: string; titleEn: string; descZh: string; descEn: string }[]
  }>
  /** user's saved prompt overrides keyed by prompt id */
  getPromptOverrides(): Promise<Record<string, string>>
  setPromptOverride(id: string, text: string): Promise<boolean>
  clearPromptOverride(id: string): Promise<boolean>
  /** list model ids (+ optional context/output metadata) from a custom OpenAI-compatible endpoint */
  probeModels(query: { baseUrl: string; apiKey: string }): Promise<{
    ok: boolean
    models?: { id: string; contextLength?: number; maxOutputTokens?: number }[]
    error?: string
  }>
  /** one-shot round trip against the given (possibly unsaved) settings — the settings-UI connection test */
  testAiSettings(settings: AiSettings): Promise<AiChatResponse>
}

export interface AiCatalogEntry extends AiProviderMeta {
  /** default endpoint for fixed-endpoint providers ('' = model-dependent or user-supplied) */
  defaultBaseUrl: string
}

export interface RenameResult {
  ok: boolean
  /** the new absolute path when ok */
  path?: string
  error?: string
}

// ── Project-related APIs (P1) ────────────────────────────────

export interface ProjectSummaryEntry {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  fileCount: number
  lastActiveAt: string
  isDefault: boolean
}

export interface TimelineEntryItem {
  filePath: string
  fileName: string
  chatId: string
  ts: string
  role: 'user' | 'assistant'
  preview: string
  seq: number
}

export interface ProjectHomeApi {
  /** list all projects (with file count + last-active time) */
  listProjects(): Promise<ProjectSummaryEntry[]>
  /** list existing files currently belonging to a project */
  listFiles(projectId: string): Promise<string[]>
  /** create a project */
  createProject(name: string): Promise<ProjectSummaryEntry>
  /** rename a project */
  renameProject(id: string, name: string): Promise<void>
  /** soft-delete a project */
  deleteProject(id: string): Promise<void>
  /** move a file into the given project */
  moveFile(filePath: string, projectId: string): Promise<void>
  /** open a file picker and attach the chosen pptx files to the project (paths registered, files untouched) */
  importFiles(projectId: string): Promise<string[]>
  /** fetch the project timeline */
  getTimeline(projectId: string, limit?: number): Promise<TimelineEntryItem[]>
}

export const HOME_CHANNELS = {
  recents: 'home:recents',
  starred: 'home:starred',
  statPaths: 'home:stat-paths',
  toggleStar: 'home:toggle-star',
  openPath: 'home:open-path',
  browse: 'home:browse',
  newSlide: 'home:new-slide',
  removeRecent: 'home:remove-recent',
  revealPath: 'home:reveal-path',
  renameFile: 'home:rename-file',
  duplicateFile: 'home:duplicate-file',
  deleteFiles: 'home:delete-files',
  openTrash: 'home:open-trash',
  getLanguage: 'home:get-language',
  setLanguage: 'home:set-language',
  getUpdateChannel: 'home:get-update-channel',
  setUpdateChannel: 'home:set-update-channel',
  getAppVersion: 'home:get-app-version',
  getTheme: 'home:get-theme',
  setTheme: 'home:set-theme',
  getDefaultSaveDir: 'home:get-default-save-dir',
  pickDefaultSaveDir: 'home:pick-default-save-dir',
} as const

export const PROJECT_CHANNELS = {
  list: 'project:list',
  files: 'project:files',
  create: 'project:create',
  rename: 'project:rename',
  delete: 'project:delete',
  moveFile: 'project:moveFile',
  importFiles: 'project:importFiles',
  timeline: 'project:timeline',
} as const
