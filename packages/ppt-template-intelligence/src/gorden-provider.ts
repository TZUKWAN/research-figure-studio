/**
 * GordenDirProvider (P0): loads the 21 Gorden template decks from a
 * user-supplied local directory (`metis-templates/gorden/`). Never bundled —
 * see THIRD_PARTY_NOTICES.md for the template license restriction. Templates
 * are analyzed on first use and cached by file hash.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeTemplateBytes,
  cachedAnalyze,
  MemoryAnalysisCache,
  type AnalysisCacheStore,
  type TemplateDefinition,
  type TemplateProvider,
  type TemplateSummary,
} from './index.js'

export class GordenDirProvider implements TemplateProvider {
  readonly id = 'gorden-local'
  readonly sourceType = 'gorden-local' as const
  private cache: AnalysisCacheStore = new MemoryAnalysisCache()
  private definitions = new Map<string, TemplateDefinition>()

  constructor(private dir: string) {}

  static isAvailable(dir: string): boolean {
    return existsSync(join(dir, 'INDEX.md'))
  }

  private deckDirs(): Array<{ slug: string; pptxPath: string; previewPath?: string }> {
    if (!existsSync(this.dir)) return []
    const out: Array<{ slug: string; pptxPath: string; previewPath?: string }> = []
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pptxPath = join(this.dir, entry.name, 'template.pptx')
      if (existsSync(pptxPath)) {
        out.push({
          slug: entry.name,
          pptxPath,
          previewPath: existsSync(join(this.dir, entry.name, 'preview.png'))
            ? join(this.dir, entry.name, 'preview.png')
            : undefined,
        })
      }
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug))
  }

  private slugId(slug: string): string {
    return `gorden-${slug}`
  }

  async list(): Promise<TemplateSummary[]> {
    return this.deckDirs().map(({ slug, pptxPath, previewPath }) => ({
      id: this.slugId(slug),
      name: slug,
      sourceType: this.sourceType,
      slideCount: 0, // unknown until analyzed; list stays cheap
      tags: ['gorden', 'cjk', 'non-commercial-templates'],
      origin: pptxPath,
      previewPath,
    }))
  }

  async load(id: string): Promise<TemplateDefinition> {
    const cachedDef = this.definitions.get(id)
    if (cachedDef) return cachedDef
    const slug = id.replace(/^gorden-/, '')
    const deck = this.deckDirs().find((d) => d.slug === slug)
    if (!deck) throw new Error(`template "${id}" not found in ${this.dir}`)
    const bytes = readFileSync(deck.pptxPath)
    const hash = sha256(bytes)
    const { definition } = await cachedAnalyze(this.cache, hash, async () =>
      analyzeTemplateBytes(bytes, { type: this.sourceType, sourceFile: deck.pptxPath }, slug),
    )
    this.definitions.set(id, definition)
    return definition
  }

  async getSource(id: string): Promise<{ filePath: string }> {
    const slug = id.replace(/^gorden-/, '')
    const deck = this.deckDirs().find((d) => d.slug === slug)
    if (!deck) throw new Error(`template "${id}" not found`)
    return { filePath: deck.pptxPath }
  }

  async getPreview(id: string): Promise<string | undefined> {
    const slug = id.replace(/^gorden-/, '')
    const deck = this.deckDirs().find((d) => d.slug === slug)
    return deck?.previewPath
  }
}

import { createHash } from 'node:crypto'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
