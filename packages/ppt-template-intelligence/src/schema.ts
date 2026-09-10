/**
 * Template Intelligence — typed contracts (P0).
 *
 * Two strict layers, per the production-closure principle that the model may
 * INFER semantics but never INVENT facts:
 *  - ObservedTemplateFacts: everything measured from the real pptx bytes
 *    (shape ids, text, geometry, font sizes, theme colors).
 *  - TemplateDefinition: the compiled, usable template model = observed facts
 *    + inferred semantics (roles, slot roles, editable flags) each carrying a
 *    confidence score.
 */

export const TEMPLATE_SCHEMA_VERSION = '1.0'

export type PageRole =
  | 'cover'
  | 'agenda'
  | 'section-divider'
  | 'content'
  | 'comparison'
  | 'process'
  | 'framework'
  | 'timeline'
  | 'data'
  | 'quote'
  | 'summary'
  | 'ending'
  | 'template-promo'
  | 'unknown'

export const PAGE_ROLES: readonly PageRole[] = [
  'cover',
  'agenda',
  'section-divider',
  'content',
  'comparison',
  'process',
  'framework',
  'timeline',
  'data',
  'quote',
  'summary',
  'ending',
  'template-promo',
  'unknown',
]

export type SlotRole =
  | 'title'
  | 'subtitle'
  | 'section-title'
  | 'body'
  | 'bullet'
  | 'metric'
  | 'caption'
  | 'label'
  | 'footer'
  | 'number'
  | 'figure'
  | 'custom'

/** Physical address of one editable text region inside the source slide. */
export interface SlotAddress {
  /** `<p:cNvPr id>` of the owning shape — identical to python-pptx shape_id */
  shapeId: number
  /** 0-based paragraph index within the shape's text body */
  paragraph: number
  /** optional 0-based run index; absent = whole paragraph, run-0 format kept */
  run?: number
}

/** One editable (or deliberately non-editable) text region of a template page. */
export interface TemplateSlot {
  id: string
  slideId: string
  role: SlotRole
  address: SlotAddress
  currentText: string
  editable: boolean
  guidance?: string
  language?: 'zh' | 'en' | 'mixed'
  capacity: {
    /** CJK-equivalent width units per line (CJK=1.0, latin≈0.5, space≈0.35) */
    charsPerLine?: number
    maxLines?: number
    /** charsPerLine × maxLines — soft reference, never a truncator */
    maxChars?: number
    boxWidthPx?: number
    boxHeightPx?: number
    confidence: number
  }
  typography: {
    fontFamily?: string
    fontSizePt?: number
    bold?: boolean
    /** 1 = largest tier of the template's type scale */
    level?: number
  }
}

export interface TypeScaleEntry {
  level: number
  sizePt: number
  slotCount: number
}

/** Facts measured directly from the pptx bytes — no inference. */
export interface ObservedTemplateFacts {
  slideCount: number
  slideSizeEmu: { cx: number; cy: number }
  themeColors: string[]
  fonts: { cn?: string; en?: string }
  pages: Array<{
    slideNumber: number
    shapes: Array<{
      shapeId: number
      name?: string
      kind: 'text' | 'picture' | 'table' | 'chart' | 'group' | 'other'
      hasChart: boolean
      text?: string
      paragraphs?: Array<{
        index: number
        runs: Array<{ index: number; text: string; fontSizePt?: number; bold?: boolean }>
        fontSizePt?: number
      }>
      boxEmu?: { x: number; y: number; cx: number; cy: number }
    }>
  }>
}

export interface TemplatePage {
  slideId: string
  originalSlideIndex: number
  role: PageRole
  roleConfidence: number
  layoutDescription: string
  useFor: string[]
  styleFeatures: string[]
  density: 'sparse' | 'medium' | 'dense'
  editableSlots: TemplateSlot[]
  nonEditableSlots: TemplateSlot[]
  chartShapeIds: number[]
  cautionNotes: string[]
}

export type TemplateSourceType =
  'user-upload' | 'builtin' | 'licensed' | 'gorden-local' | 'generated'

export interface TemplateDefinition {
  schemaVersion: string
  id: string
  name: string
  source: { type: TemplateSourceType; sourceFile?: string }
  slideSize: { widthPx: number; heightPx: number; aspectRatio: number }
  style: {
    tags: string[]
    colors: string[]
    fonts: { cn?: string; en?: string }
    typeScale: TypeScaleEntry[]
    density: 'sparse' | 'medium' | 'dense'
  }
  pageRoles: Partial<Record<PageRole, string[]>>
  pages: TemplatePage[]
  editingRules: string[]
  /** sha256 of the source pptx bytes — the analysis-cache key */
  sourceHash?: string
}

/** Content → template mapping contract (produced by the fill compiler's planner). */
export interface TemplateFillPlan {
  templateId: string
  slides: Array<{
    sourceSlideId: string
    outputOrder: number
    purpose: string
    slotValues: Array<{ slotId: string; text: string; source?: string }>
    chartUpdates?: Array<{
      shapeId: number
      categories: string[]
      series: Array<{ name: string; values: number[] }>
    }>
  }>
}

export interface PresentationIntent {
  purpose?: string
  audience?: string
  domain?: string
  language?: 'zh' | 'en' | 'mixed'
  targetLength?: number
  style?: string
  density?: 'sparse' | 'medium' | 'dense'
  templatePreference?: { templateId?: string; mode: 'AUTO' | 'TEMPLATE' | 'ORIGINAL' }
}

/** Rendering of one template page into a final deck. */
export interface TemplateRenderOutput {
  slideIds: string[]
}
