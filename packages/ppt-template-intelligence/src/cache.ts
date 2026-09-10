/**
 * Template analysis cache (GOAL section 28): keyed by source-file sha256 +
 * parser version. A re-analysis only happens when the file changes, the
 * parser is upgraded, or the user explicitly requests a refresh.
 */
import type { TemplateDefinition } from './schema.js'

export const PARSER_VERSION = 1

export interface CacheEntry {
  parserVersion: number
  sourceHash: string
  analyzedAt: string
  definition: TemplateDefinition
}

export interface AnalysisCacheStore {
  get(key: string): Promise<CacheEntry | undefined>
  set(key: string, entry: CacheEntry): Promise<void>
}

export class MemoryAnalysisCache implements AnalysisCacheStore {
  private map = new Map<string, CacheEntry>()
  async get(key: string): Promise<CacheEntry | undefined> {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.parserVersion !== PARSER_VERSION) return undefined
    return entry
  }
  async set(key: string, entry: CacheEntry): Promise<void> {
    this.map.set(key, entry)
  }
}

export function cacheKey(sourceHash: string): string {
  return `ppt-tpl:${PARSER_VERSION}:${sourceHash}`
}

/**
 * Cached analysis wrapper: given a loader (that reads bytes) and an analyzer,
 * return the cached TemplateDefinition when present, else analyze-and-store.
 */
export async function cachedAnalyze(
  cache: AnalysisCacheStore,
  sourceHash: string,
  analyze: () => Promise<TemplateDefinition>,
): Promise<{ definition: TemplateDefinition; fromCache: boolean }> {
  const key = cacheKey(sourceHash)
  const hit = await cache.get(key)
  if (hit && hit.sourceHash === sourceHash) {
    return { definition: hit.definition, fromCache: true }
  }
  const definition = await analyze()
  await cache.set(key, {
    parserVersion: PARSER_VERSION,
    sourceHash,
    analyzedAt: new Date().toISOString(),
    definition,
  })
  return { definition, fromCache: false }
}
