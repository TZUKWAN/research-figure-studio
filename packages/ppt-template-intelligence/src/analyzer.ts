/**
 * Unknown Template Analyzer (P1): pptx bytes → ObservedTemplateFacts →
 * TemplateDefinition. Uses the GenOffice engine parser as the single source
 * of observed truth; heuristics only ever ADD inference (with confidence),
 * never alter facts.
 */
import { elementSpid, openPptx } from '@genoffice/pptx-engine'
import { createHash } from 'node:crypto'
import {
  PAGE_ROLES,
  type ObservedTemplateFacts,
  type TemplateDefinition,
  type TemplatePage,
  type TemplateSlot,
  type TypeScaleEntry,
} from './schema.js'
import { classifyPageRole } from './role-classifier.js'
import type { SlotRole } from './schema.js'

const EMU_PER_PX = 9525

function inferSlotRole(
  text: string,
  fontSizePt?: number,
  level?: number,
  slideNumber = 0,
): { role: SlotRole; confidence: number } {
  const t = text.trim().toLowerCase()
  if (slideNumber === 1 && (fontSizePt ?? 0) >= 24) return { role: 'title', confidence: 0.8 }
  if (/标题|title/.test(t)) return { role: 'title', confidence: 0.6 }
  if (/副.?标题|subtitle/.test(t)) return { role: 'subtitle', confidence: 0.6 }
  if (/^\d{1,3}%$/.test(t) || /[0-9]+\s*(万|亿|%)/.test(text))
    return { role: 'metric', confidence: 0.7 }
  if (/^0?\d$/.test(t)) return { role: 'number', confidence: 0.8 }
  if ((level ?? 9) >= 9 || (fontSizePt ?? 18) <= 14) return { role: 'body', confidence: 0.6 }
  return { role: 'body', confidence: 0.4 }
}

function inferLanguage(text: string): 'zh' | 'en' | 'mixed' {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.match(/[a-zA-Z]/g) ?? []).length
  if (cjk === 0 && latin === 0) return 'mixed'
  if (cjk === 0) return 'en'
  if (latin === 0) return 'zh'
  return 'mixed'
}

/** Parse pptx bytes into raw observed facts (no inference). */
export async function observeTemplateFacts(
  bytes: Uint8Array,
): Promise<{ facts: ObservedTemplateFacts; hash: string }> {
  const opened = await openPptx(bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const pages: ObservedTemplateFacts['pages'] = []

  opened.deck.slides.forEach((slide, slideIndex) => {
    const shapes: ObservedTemplateFacts['pages'][number]['shapes'] = []
    const walk = (elements: typeof slide.elements) => {
      for (const el of elements) {
        if (el.type === 'group') {
          walk((el as unknown as { children: typeof slide.elements }).children)
          continue
        }
        const textObj = (el as { text?: { paragraphs?: unknown[] } }).text
        const paragraphs = (
          textObj as
            | {
                paragraphs?: Array<{
                  runs?: Array<{ text: string; fontSize?: number; bold?: boolean }>
                  fontSize?: number
                }>
              }
            | undefined
        )?.paragraphs
        const kind: 'text' | 'picture' | 'table' | 'chart' | 'group' | 'other' =
          el.type === 'text' || (el.type === 'shape' && textObj)
            ? 'text'
            : el.type === 'picture'
              ? 'picture'
              : el.type === 'table'
                ? 'table'
                : el.type === 'chart'
                  ? 'chart'
                  : 'other'
        // P0-4/GOAL section 32: shape_id must be the cNvPr id (== python-pptx
        // shape_id), NOT the element array index — slot addresses depend on it
        const spid = elementSpid(el) ?? (el as unknown as { nvId?: number }).nvId
        shapes.push({
          shapeId: spid ?? -1,
          name: el.name,
          kind,
          hasChart: kind === 'chart',
          text: paragraphs?.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('\n'),
          paragraphs: paragraphs?.map((p, pi) => ({
            index: pi,
            runs: (p.runs ?? []).map((r, ri) => ({
              index: ri,
              text: r.text,
              fontSizePt: r.fontSize,
              bold: r.bold,
            })),
            fontSizePt: p.fontSize,
          })),
          boxEmu: {
            x: el.transform.offset.x,
            y: el.transform.offset.y,
            cx: el.transform.offset.cx,
            cy: el.transform.offset.cy,
          },
        })
      }
    }
    walk(slide.elements)
    pages.push({ slideNumber: slideIndex + 1, shapes })
  })

  // theme colors from the theme part if present
  const themeColors: string[] = []
  const themeXml =
    opened.archive.readText?.('ppt/theme/theme1.xml') ??
    (() => {
      try {
        return new TextDecoder().decode(
          opened.archive.entries.get('ppt/theme/theme1.xml') as Uint8Array,
        )
      } catch {
        return ''
      }
    })()
  for (const m of themeXml.matchAll(/<a:srgbClr val="([0-9A-Fa-f]{6})"\/>/g)) {
    if (themeColors.length < 12) themeColors.push(`#${m[1]!.toUpperCase()}`)
  }

  return {
    facts: {
      slideCount: opened.deck.slides.length,
      slideSizeEmu: opened.deck.size,
      themeColors,
      fonts: {},
      pages,
    },
    hash,
  }
}

/** Build the type scale from observed font sizes (largest tier = level 1). */
export function inferTypeScale(facts: ObservedTemplateFacts): TypeScaleEntry[] {
  const sizeCounts = new Map<number, number>()
  for (const page of facts.pages) {
    for (const shape of page.shapes) {
      for (const para of shape.paragraphs ?? []) {
        for (const run of para.runs) {
          if (run.fontSizePt && run.text.trim()) {
            const key = Math.round(run.fontSizePt * 2) / 2
            sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1)
          }
        }
      }
    }
  }
  const sorted = [...sizeCounts.entries()].sort((a, b) => b[0] - a[0])
  return sorted.map(([sizePt, slotCount], index) => ({
    level: index + 1,
    sizePt,
    slotCount,
  }))
}

function levelForSize(sizePt: number | undefined, scale: TypeScaleEntry[]): number | undefined {
  if (!sizePt) return undefined
  const entry = scale.find((e) => Math.abs(e.sizePt - sizePt) < 0.6)
  return entry?.level
}

/** Compile observed facts into a usable TemplateDefinition (inference included). */
export function analyzeTemplate(
  facts: ObservedTemplateFacts,
  hash: string,
  source: { type: TemplateDefinition['source']['type']; sourceFile?: string },
  nameHint?: string,
): TemplateDefinition {
  const typeScale = inferTypeScale(facts)
  const widthPx = Math.round(facts.slideSizeEmu.cx / 9525)
  const heightPx = Math.round(facts.slideSizeEmu.cy / 9525)
  const pages: TemplatePage[] = []
  const pageRoles: TemplateDefinition['pageRoles'] = {}

  facts.pages.forEach((page) => {
    const inference = classifyPageRole(page, facts.slideCount)
    const editableSlots: TemplateSlot[] = []
    const nonEditableSlots: TemplateSlot[] = []
    const chartShapeIds: number[] = []

    for (const shape of page.shapes) {
      if (shape.hasChart) chartShapeIds.push(shape.shapeId)
      const paragraphs = shape.paragraphs ?? []
      for (const para of paragraphs) {
        const text = para.runs.map((r) => r.text).join('')
        if (!text.trim()) continue
        const level = levelForSize(para.fontSizePt ?? para.runs[0]?.fontSizePt, typeScale)
        const { role, confidence } = inferSlotRole(text, para.fontSizePt, level, page.slideNumber)
        const decorative = /^[0-9]{1,2}$/.test(text.trim()) && (para.fontSizePt ?? 0) >= 40
        const slot: TemplateSlot = {
          id: `s${page.slideNumber}_sh${shape.shapeId}_p${para.index}`,
          slideId: `slide-${page.slideNumber}`,
          role,
          address: { shapeId: shape.shapeId, paragraph: para.index },
          currentText: text,
          editable: !decorative,
          language: inferLanguage(text),
          capacity: {
            confidence: 0.7,
          },
          typography: {
            fontFamily: undefined,
            fontSizePt: para.fontSizePt ?? para.runs[0]?.fontSizePt,
            bold: para.runs[0]?.bold,
            level,
          },
        }
        ;(decorative ? nonEditableSlots : editableSlots).push(slot)
      }
    }

    const slideId = `slide-${page.slideNumber}`
    pages.push({
      slideId,
      originalSlideIndex: page.slideNumber,
      role: inference.role,
      roleConfidence: inference.confidence,
      layoutDescription: `${page.shapes.length} shapes, ${editableSlots.length} editable slots`,
      useFor: inference.useFor,
      styleFeatures: [],
      density:
        editableSlots.length >= 8 ? 'dense' : editableSlots.length >= 3 ? 'medium' : 'sparse',
      editableSlots,
      nonEditableSlots,
      chartShapeIds,
      cautionNotes: inference.warnings,
    })
    if (inference.role !== 'unknown') {
      pageRoles[inference.role] = [...(pageRoles[inference.role] ?? []), slideId]
    }
  })

  void PAGE_ROLES

  return {
    schemaVersion: '1.0',
    id: `tpl-${hash.slice(0, 12)}`,
    name: nameHint ?? `Template ${hash.slice(0, 6)}`,
    source,
    slideSize: {
      widthPx,
      heightPx,
      aspectRatio: Math.round((widthPx / heightPx) * 100) / 100,
    },
    style: {
      tags: [],
      colors: facts.themeColors,
      fonts: facts.fonts,
      typeScale,
      density:
        pages.filter((p) => p.density === 'dense').length > pages.length / 2 ? 'dense' : 'medium',
    },
    pageRoles,
    pages,
    editingRules: [
      'Template fidelity: replace slot text only; never move/resize/recolor non-content shapes.',
      'Never truncate with ellipsis; rewrite instead.',
      'Same type-scale level keeps the same font size.',
      'Sync agenda/section-divider/breadcrumb text when chapter names change.',
      'Missing page role = fewer pages; never fake a cover/ending from a content page.',
    ],
    sourceHash: hash,
  }
}

/** One-call analyzer: bytes → TemplateDefinition. */
export async function analyzeTemplateBytes(
  bytes: Uint8Array,
  source: { type: TemplateDefinition['source']['type']; sourceFile?: string },
  nameHint?: string,
): Promise<TemplateDefinition> {
  const { facts, hash } = await observeTemplateFacts(bytes)
  return analyzeTemplate(facts, hash, source, nameHint)
}
