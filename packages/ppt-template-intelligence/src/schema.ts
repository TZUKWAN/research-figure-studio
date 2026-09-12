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

export const TEMPLATE_SCHEMA_VERSION = '1.1'

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
    /** GOAL §十四: raw geometry the estimates derive from */
    boxEmu?: { cx: number; cy: number }
    textInsetsEmu?: { l: number; t: number; r: number; b: number }
    /** GOAL §十五: how the numbers were derived */
    tier: CapacityTier
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

/** GOAL §十三: template font profile — theme scheme + observed usage. */
export interface TemplateFontProfile {
  theme: {
    /** major = heading scheme, minor = body scheme; latin + ea (CJK) */
    majorLatin?: string
    majorEa?: string
    minorLatin?: string
    minorEa?: string
  }
  /** families actually observed on shapes, by usage (descending) */
  observed: Array<{ family: string; usageCount: number; script: 'latin' | 'ea' | 'mixed' }>
}

/** GOAL §十五: how capacity numbers were derived. */
export type CapacityTier = 'fast-estimate' | 'real-layout-measure'

/** Facts measured directly from the pptx bytes — no inference. */
export interface ObservedTemplateFacts {
  slideCount: number
  slideSizeEmu: { cx: number; cy: number }
  themeColors: string[]
  /** GOAL §十三: theme font scheme (major = headings, minor = body) */
  themeFonts: {
    majorLatin?: string
    majorEa?: string
    minorLatin?: string
    minorEa?: string
  }
  fonts: { cn?: string; en?: string }
  /** first solid slide background color, observed (absent = derived/none) */
  background?: string
  pages: Array<{
    slideNumber: number
    /** layout part this slide inherits its chrome from (GOAL §十二) */
    layoutPart?: string
    shapes: Array<{
      shapeId: number
      name?: string
      kind: 'text' | 'picture' | 'table' | 'chart' | 'group' | 'other'
      hasChart: boolean
      text?: string
      paragraphs?: Array<{
        index: number
        runs: Array<{
          index: number
          text: string
          fontSizePt?: number
          bold?: boolean
          fontFamily?: string
          italic?: boolean
          underline?: boolean
          color?: string
        }>
        fontSizePt?: number
        fontFamily?: string
        align?: 'left' | 'center' | 'right' | 'justify'
        lineSpacingPct?: number
        bulletLevel?: number
        hasBullet?: boolean
      }>
      boxEmu?: { x: number; y: number; cx: number; cy: number }
      /** GOAL §十二: observed layout facts beyond geometry */
      rotationDeg?: number
      zOrder?: number
      verticalAnchor?: 'top' | 'middle' | 'bottom'
      insetsEmu?: { l: number; t: number; r: number; b: number }
      autofit?: 'none' | 'shrink' | 'resize'
      fillColor?: string
      strokeColor?: string
      opacity?: number
      placeholderType?: string
      /** owning group chain (outermost → immediate parent element ids) */
      groupPath?: string[]
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
    /** GOAL §十三: full font profile (theme scheme + observed usage) */
    fontProfile?: TemplateFontProfile
    typeScale: TypeScaleEntry[]
    density: 'sparse' | 'medium' | 'dense'
  }
  pageRoles: Partial<Record<PageRole, string[]>>
  pages: TemplatePage[]
  editingRules: string[]
  /** sha256 of the source pptx bytes — the analysis-cache key */
  sourceHash?: string
}

/** Content → template mapping contract (produced by the fill compiler's planner).
    GOAL §十: the production SSOT for filling — consumers name TEMPLATE SLOTS
    (slotId), never physical addresses; slotId → shape/paragraph resolution
    happens inside compileFillPlan against the analyzed TemplateDefinition. */
export interface TemplateFillPlan {
  templateId: string
  /** GOAL §24: runtime fidelity policy. 'preserve-template' (default) fails
      compilation when a slot's current text drifted from the analysis
      (state drift = hard stop); 'adaptive' tolerates drift in user-modified
      decks and relies on post-fill QA instead. */
  fidelity?: 'preserve-template' | 'adaptive'
  slides: Array<{
    sourceSlideId: string
    /** position of this entry in the final deck (0-based) */
    outputOrder: number
    purpose: string
    slotValues: Array<{ slotId: string; text: string; source?: string }>
    /** 0-based occurrence among entries sharing sourceSlideId (clones) */
    instance?: number
    /** GOAL §21: replace embedded chart data (categories + series values) */
    chartUpdates?: Array<{
      shapeId: number
      categories: string[]
      series: Array<{ name: string; values: number[] }>
    }>
    /** GOAL §23: replace picture-slot media (base64 payload) */
    imageSlots?: Array<{
      shapeId: number
      imageBase64: string
      ext: string
      keepSrcRect?: boolean
    }>
    /** GOAL §22: rewrite table cell text (paragraph runs per cell) */
    tableUpdates?: Array<{
      shapeId: number
      cells: Array<{ row: number; col: number; paragraphs: string[] }>
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
