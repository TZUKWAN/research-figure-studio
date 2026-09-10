/**
 * Template providers (P0): a registry of template sources. The Gorden deck
 * directory is loaded from a user-supplied local path (never bundled — see
 * THIRD_PARTY_NOTICES.md); user-uploaded templates register through the
 * UserTemplateProvider.
 */
import type { TemplateDefinition, TemplateSourceType } from './schema.js'

export interface TemplateSummary {
  id: string
  name: string
  sourceType: TemplateSourceType
  slideCount: number
  tags: string[]
  /** directory or file path the template was loaded from */
  origin?: string
  /** preview image path when available (Gorden decks ship preview.png) */
  previewPath?: string
}

export interface PptxSource {
  /** absolute path to the template pptx */
  filePath: string
}

export interface TemplateProvider {
  readonly id: string
  readonly sourceType: TemplateSourceType
  list(): Promise<TemplateSummary[]>
  load(id: string): Promise<TemplateDefinition>
  getSource(id: string): Promise<PptxSource>
  getPreview?(id: string): Promise<string | undefined>
}
