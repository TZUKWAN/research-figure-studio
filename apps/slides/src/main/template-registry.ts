/**
 * User template registry (GOAL §8/§9/§14): persistent, crash-safe storage for
 * user-imported templates under `userData/templates/`.
 *
 * Layout:
 *   templates/registry.json          — index; ATOMIC writes (tmp + rename, the
 *                                      VS Code FileService pattern) so a crash
 *                                      never leaves a half-written registry
 *   templates/sources/<hash>.pptx    — managed immutable copy of the user file
 *                                      (the user's ORIGINAL is never touched)
 *   templates/previews/<hash>.png    — first-slide preview bitmap, provided by
 *                                      the renderer after first paint
 *   templates/analysis/<hash>.json   — cached TemplateDefinition
 *
 * Cache keys are `sourceHash + version` (GOAL §14): the deck changing is the
 * only thing that invalidates a preview/analysis.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const TEMPLATES_DIRNAME = 'templates'
/** bump when the preview render pipeline meaningfully changes (GOAL §14) */
export const PREVIEW_RENDERER_VERSION = 1
/** bump when the persisted TemplateDefinition shape changes (mirrors the package schema) */
export const REGISTRY_VERSION = 1
/** import safety caps (GOAL §41) */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export interface TemplateRegistryEntry {
  id: string
  name: string
  /** the user's original file — read-only, never modified or deleted by us */
  sourcePath: string
  /** our managed immutable copy under templates/sources/ */
  managedSourcePath: string
  sourceHash: string
  schemaVersion: string
  parserVersion: number
  importedAt: string
  lastUsedAt: string
  analysisStatus: 'not-analyzed' | 'analyzing' | 'ready' | 'error'
  pageCount?: number
  previewPath?: string
}

export interface TemplateRegistry {
  version: number
  templates: TemplateRegistryEntry[]
}

export function templatesRoot(userDataDir: string): string {
  return join(userDataDir, TEMPLATES_DIRNAME)
}

export function registryPath(userDataDir: string): string {
  return join(templatesRoot(userDataDir), 'registry.json')
}

export function loadRegistry(userDataDir: string): TemplateRegistry {
  const file = registryPath(userDataDir)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TemplateRegistry
    if (!Array.isArray(parsed.templates)) throw new Error('bad shape')
    return parsed
  } catch (err) {
    // corrupt/missing registry never crashes the app — start fresh (GOAL §41)
    console.warn(
      '[template-registry] registry unreadable, starting fresh:',
      err instanceof Error ? err.message : err,
    )
    return { version: REGISTRY_VERSION, templates: [] }
  }
}

/** ATOMIC registry write: serialize to a temp file in the SAME directory then
    rename over the target — fs.rename is atomic within one filesystem, so a
    crash can never leave a truncated registry. */
export function saveRegistry(userDataDir: string, registry: TemplateRegistry): void {
  const root = templatesRoot(userDataDir)
  mkdirSync(root, { recursive: true })
  const target = registryPath(userDataDir)
  const tmp = join(root, `.registry-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8')
  renameSync(tmp, target)
}

export function sourceHashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface ImportResult {
  entry: TemplateRegistryEntry
  duplicate: boolean
}

/** Import a user template: validate → hash → dedupe → managed copy → register. */
export function importUserTemplate(
  userDataDir: string,
  sourcePath: string,
  bytes: Uint8Array,
): ImportResult {
  // GOAL §41 import caps: type + magic + size before anything touches the disk
  if (!sourcePath.toLowerCase().endsWith('.pptx')) {
    throw new Error('only .pptx templates can be imported')
  }
  if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
    throw new Error(`template file must be between 1 byte and ${MAX_IMPORT_BYTES} bytes`)
  }
  if (!Buffer.from(bytes.subarray(0, 4)).equals(ZIP_MAGIC)) {
    throw new Error('not a valid PowerPoint file (missing ZIP signature)')
  }

  const hash = sourceHashOf(bytes)
  const registry = loadRegistry(userDataDir)
  const existing = registry.templates.find((t) => t.sourceHash === hash)
  if (existing) {
    // GOAL §8.8: the same template imports as a dedupe — touch lastUsedAt only
    existing.lastUsedAt = new Date().toISOString()
    saveRegistry(userDataDir, registry)
    return { entry: existing, duplicate: true }
  }

  const root = templatesRoot(userDataDir)
  const sourcesDir = join(root, 'sources')
  mkdirSync(sourcesDir, { recursive: true })
  const managedSourcePath = join(sourcesDir, `${hash}.pptx`)
  if (!existsSync(managedSourcePath)) copyFileSync(sourcePath, managedSourcePath)

  const now = new Date().toISOString()
  const entry: TemplateRegistryEntry = {
    id: `user-${hash.slice(0, 12)}`,
    name: sourcePath.split(/[\\/]/).pop() ?? sourcePath,
    sourcePath,
    managedSourcePath,
    sourceHash: hash,
    schemaVersion: '1.1',
    parserVersion: 1,
    importedAt: now,
    lastUsedAt: now,
    analysisStatus: 'not-analyzed',
  }
  registry.templates.push(entry)
  saveRegistry(userDataDir, registry)
  return { entry, duplicate: false }
}

export function updateRegistryEntry(
  userDataDir: string,
  id: string,
  patch: Partial<TemplateRegistryEntry>,
): TemplateRegistryEntry | null {
  const registry = loadRegistry(userDataDir)
  const entry = registry.templates.find((t) => t.id === id)
  if (!entry) return null
  Object.assign(entry, patch)
  saveRegistry(userDataDir, registry)
  return entry
}

/** Remove a registry entry AND our managed copies. The user's ORIGINAL file is
    never deleted (GOAL §36). */
export function removeRegistryEntry(userDataDir: string, id: string): boolean {
  const registry = loadRegistry(userDataDir)
  const at = registry.templates.findIndex((t) => t.id === id)
  if (at < 0) return false
  const [entry] = registry.templates.splice(at, 1)
  saveRegistry(userDataDir, registry)
  for (const p of [entry.managedSourcePath, entry.previewPath]) {
    try {
      if (p && existsSync(p)) rmSync(p)
    } catch {
      // best effort cleanup; the registry removal already succeeded
    }
  }
  try {
    const analysis = join(templatesRoot(userDataDir), 'analysis', `${entry.sourceHash}.json`)
    if (existsSync(analysis)) rmSync(analysis)
  } catch {
    // best effort
  }
  return true
}

/** Persist a cached TemplateDefinition for a hash (GOAL §9 analysis cache). */
export function saveAnalysisCache(userDataDir: string, hash: string, definition: unknown): string {
  const dir = join(templatesRoot(userDataDir), 'analysis')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${hash}.json`)
  const tmp = join(dir, `.${hash}.tmp`)
  writeFileSync(tmp, JSON.stringify(definition), 'utf8')
  renameSync(tmp, file)
  return file
}

export function loadAnalysisCache<T>(userDataDir: string, hash: string): T | null {
  try {
    return JSON.parse(
      readFileSync(join(templatesRoot(userDataDir), 'analysis', `${hash}.json`), 'utf8'),
    ) as T
  } catch {
    return null
  }
}
