/**
 * Unknown Template Analyzer (P1): pptx bytes → ObservedTemplateFacts →
 * TemplateDefinition. Uses the GenOffice engine parser as the single source
 * of observed truth; heuristics only ever ADD inference (with confidence),
 * never alter facts.
 */
import { canonicalPptShapeId, openPptx } from '@genoffice/pptx-engine'
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
import type { SlotRole, TemplateFontProfile } from './schema.js'

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
    let zOrder = 0
    const walk = (elements: typeof slide.elements, groupPath: string[]) => {
      for (const el of elements) {
        if (el.type === 'group') {
          walk((el as unknown as { children: typeof slide.elements }).children, [
            ...groupPath,
            el.id,
          ])
          continue
        }
        const elObj = el as unknown as {
          name?: string
          transform: { offset: { x: number; y: number; cx: number; cy: number }; rot?: number }
          fill?: { type: string; color?: string }
          stroke?: { color?: string }
          opacity?: number
          mediaRef?: string
          text?: {
            paragraphs?: Array<{
              runs?: Array<{
                text: string
                fontSize?: number
                bold?: boolean
                fontFamily?: string
                italic?: boolean
                underline?: boolean
                color?: string
              }>
              fontSize?: number
              align?: string
              lineHeight?: number
              level?: number
              bullet?: { type: string }
            }>
            anchor?: 'top' | 'middle' | 'bottom'
            insets?: { l: number; t: number; r: number; b: number }
            autofit?: 'none' | 'shrink' | 'resize'
          }
        }
        const textObj = elObj.text
        const paragraphs = textObj?.paragraphs
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
        // GOAL section 8: the canonical cross-parse identity — the cNvPr id
        // (== python-pptx shape_id), never the element array index; slot
        // addresses and fill ops must agree on this one function
        const spid = canonicalPptShapeId(el)
        // placeholder type lives only in the raw bytes (p:ph type=...)
        const rawXml = (el as unknown as { anchor?: { originalXml?: string } }).anchor?.originalXml
        const phType = rawXml ? /<p:ph[^>]*?type="([a-zA-Z]+)"/.exec(rawXml)?.[1] : undefined
        shapes.push({
          shapeId: spid ?? -1,
          name: elObj.name,
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
              fontFamily: r.fontFamily,
              italic: r.italic,
              underline: r.underline,
              color: r.color,
            })),
            fontSizePt: p.fontSize ?? p.runs?.[0]?.fontSize,
            fontFamily: p.runs?.find((r) => r.fontFamily)?.fontFamily,
            align: p.align as 'left' | 'center' | 'right' | 'justify' | undefined,
            lineSpacingPct: p.lineHeight,
            bulletLevel: p.level,
            hasBullet: p.bullet != null && p.bullet.type !== 'none',
          })),
          boxEmu: {
            x: elObj.transform.offset.x,
            y: elObj.transform.offset.y,
            cx: elObj.transform.offset.cx,
            cy: elObj.transform.offset.cy,
          },
          rotationDeg: elObj.transform.rot != null ? elObj.transform.rot / 60000 : undefined,
          zOrder: zOrder++,
          verticalAnchor: textObj?.anchor,
          insetsEmu: textObj?.insets,
          autofit: textObj?.autofit,
          fillColor:
            elObj.fill?.type === 'solid' && typeof elObj.fill.color === 'string'
              ? elObj.fill.color
              : undefined,
          strokeColor: typeof elObj.stroke?.color === 'string' ? elObj.stroke.color : undefined,
          opacity: elObj.opacity,
          placeholderType: phType,
          ...(groupPath.length ? { groupPath: [...groupPath] } : {}),
        })
      }
    }
    walk(slide.elements, [])
    // GOAL section 12: the layout part this slide inherits chrome from
    const relsPath = slide.path.replace(/(slide\d+\.xml)$/, '_rels/$1.rels')
    const relsXml =
      opened.archive.readText?.(relsPath) ??
      (() => {
        try {
          return new TextDecoder().decode(opened.archive.entries.get(relsPath) as Uint8Array)
        } catch {
          return ''
        }
      })()
    const layoutPart =
      /Type="[^"]*slideLayout"[^>]*Target="([^"]*)"/.exec(relsXml ?? '')?.[1] ??
      /Target="([^"]*)"[^>]*Type="[^"]*slideLayout"/.exec(relsXml ?? '')?.[1]
    pages.push({ slideNumber: slideIndex + 1, shapes, layoutPart })
  })

  // theme colors from the theme part if present
  const themeColors: string[] = []
  const readArchiveText = (part: string): string => {
    try {
      return (
        opened.archive.readText?.(part) ??
        new TextDecoder().decode(opened.archive.entries.get(part) as Uint8Array)
      )
    } catch {
      return ''
    }
  }
  const themeXml = readArchiveText('ppt/theme/theme1.xml')
  for (const m of themeXml.matchAll(/<a:srgbClr val="([0-9A-Fa-f]{6})"\/>/g)) {
    if (themeColors.length < 12) themeColors.push(`#${m[1]!.toUpperCase()}`)
  }
  // GOAL section 13: theme font scheme (major = headings, minor = body; latin + ea)
  const themeFontOf = (scheme: 'major' | 'minor', script: 'latin' | 'ea'): string | undefined => {
    const block = new RegExp(
      `<a:${scheme}Font><a:latin typeface="([^"]*)"[^>]*/><a:ea typeface="([^"]*)"[^>]*/>`,
    ).exec(themeXml)
    if (block) return script === 'latin' ? block[1] || undefined : block[2] || undefined
    const single = new RegExp(`<a:${scheme}Font>[\\s\\S]*?<a:${script} typeface="([^"]*)"`).exec(
      themeXml,
    )
    return single?.[1] || undefined
  }
  const themeFonts = {
    majorLatin: themeFontOf('major', 'latin'),
    majorEa: themeFontOf('major', 'ea'),
    minorLatin: themeFontOf('minor', 'latin'),
    minorEa: themeFontOf('minor', 'ea'),
  }
  // observed background: first solid fill on the first slide's bg
  const bgXml = readArchiveText('ppt/slides/slide1.xml')
  const bgMatch = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(bgXml)

  return {
    facts: {
      slideCount: opened.deck.slides.length,
      slideSizeEmu: opened.deck.size,
      themeColors,
      themeFonts,
      fonts: {},
      ...(bgMatch ? { background: `#${bgMatch[1]!.toUpperCase()}` } : {}),
      pages,
    },
    hash,
  }
}

/** Build the type scale from observed font sizes (largest tier = level 1).
    GOAL section 17: sizes are normalized against a 16:9 reference slide height
    before clustering, so the SAME deck layout on a 4:3 canvas yields the
    same level assignment instead of a shifted scale. */
export function inferTypeScale(facts: ObservedTemplateFacts): TypeScaleEntry[] {
  const REFERENCE_HEIGHT_EMU = 6858000 // 16:9 12192000×6858000
  const k =
    facts.slideSizeEmu.cy > 0 && facts.slideSizeEmu.cy !== REFERENCE_HEIGHT_EMU
      ? REFERENCE_HEIGHT_EMU / facts.slideSizeEmu.cy
      : 1
  const sizeCounts = new Map<number, number>()
  for (const page of facts.pages) {
    for (const shape of page.shapes) {
      for (const para of shape.paragraphs ?? []) {
        for (const run of para.runs) {
          if (run.fontSizePt && run.text.trim()) {
            const normalized = run.fontSizePt * k
            const key = Math.round(normalized * 2) / 2
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

/** GOAL section 13: observed font usage profile from run-level families. */
export function observeFontProfile(facts: ObservedTemplateFacts): TemplateFontProfile {
  const counts = new Map<string, number>()
  let ea = 0
  let latin = 0
  for (const page of facts.pages) {
    for (const shape of page.shapes) {
      for (const para of shape.paragraphs ?? []) {
        for (const run of para.runs) {
          if (!run.fontFamily || !run.text.trim()) continue
          counts.set(run.fontFamily, (counts.get(run.fontFamily) ?? 0) + 1)
          if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(run.text)) ea++
          else latin++
        }
      }
    }
  }
  const observed = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([family, usageCount]) => ({
      family,
      usageCount,
      script: (ea >= latin ? 'ea' : 'latin') as 'latin' | 'ea' | 'mixed',
    }))
  return { theme: facts.themeFonts, observed }
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
      // GOAL section 19: picture/chart shapes become figure slots so plans can
      // address them (image replacement / chart data updates) by slotId
      if (shape.kind === 'picture' || shape.kind === 'chart') {
        const figureSlot: TemplateSlot = {
          id: `s${page.slideNumber}_sh${shape.shapeId}_fig`,
          slideId: `slide-${page.slideNumber}`,
          role: 'figure',
          address: { shapeId: shape.shapeId, paragraph: 0 },
          currentText: shape.kind === 'chart' ? '[chart]' : '[image]',
          editable: true,
          guidance:
            shape.kind === 'chart'
              ? 'Embedded chart: replace its data, never redraw it as text.'
              : 'Image slot: replace the picture, keep the frame geometry.',
          capacity: {
            ...(shape.boxEmu
              ? {
                  boxWidthPx: Math.round(shape.boxEmu.cx / 9525),
                  boxHeightPx: Math.round(shape.boxEmu.cy / 9525),
                  boxEmu: { cx: shape.boxEmu.cx, cy: shape.boxEmu.cy },
                }
              : {}),
            tier: 'fast-estimate',
            confidence: 0.9,
          },
          typography: {},
        }
        nonEditableSlots.push(figureSlot)
        continue
      }
      const paragraphs = shape.paragraphs ?? []
      for (const para of paragraphs) {
        const text = para.runs.map((r) => r.text).join('')
        if (!text.trim()) continue
        const level = levelForSize(para.fontSizePt ?? para.runs[0]?.fontSizePt, typeScale)
        const { role } = inferSlotRole(text, para.fontSizePt, level, page.slideNumber)
        const decorative = /^[0-9]{1,2}$/.test(text.trim()) && (para.fontSizePt ?? 0) >= 40
        // GOAL section 14: geometry-accurate capacity from the box + insets
        const fontPt = para.fontSizePt ?? para.runs[0]?.fontSizePt ?? 18
        const insets = shape.insetsEmu ?? { l: 91440, t: 45720, r: 91440, b: 45720 }
        const usableWEmu = Math.max(0, (shape.boxEmu?.cx ?? 0) - insets.l - insets.r)
        const usableHEmu = Math.max(0, (shape.boxEmu?.cy ?? 0) - insets.t - insets.b)
        const usableWPt = usableWEmu / 12700
        const usableHPt = usableHEmu / 12700
        const charsPerLine = usableWPt > 0 ? usableWPt / fontPt : undefined
        const maxLines =
          usableHPt > 0 ? Math.max(1, Math.floor(usableHPt / (fontPt * 1.2))) : undefined
        const slot: TemplateSlot = {
          id: `s${page.slideNumber}_sh${shape.shapeId}_p${para.index}`,
          slideId: `slide-${page.slideNumber}`,
          role,
          address: { shapeId: shape.shapeId, paragraph: para.index },
          currentText: text,
          editable: !decorative,
          language: inferLanguage(text),
          capacity: {
            ...(charsPerLine != null
              ? {
                  charsPerLine: Math.round(charsPerLine * 10) / 10,
                  maxLines,
                  maxChars:
                    charsPerLine != null && maxLines != null
                      ? Math.round(charsPerLine * maxLines)
                      : undefined,
                  boxWidthPx: Math.round((shape.boxEmu?.cx ?? 0) / 9525),
                  boxHeightPx: Math.round((shape.boxEmu?.cy ?? 0) / 9525),
                  boxEmu:
                    shape.boxEmu != null ? { cx: shape.boxEmu.cx, cy: shape.boxEmu.cy } : undefined,
                  textInsetsEmu: insets,
                }
              : {}),
            tier: 'fast-estimate',
            confidence: charsPerLine != null ? 0.7 : 0.35,
          },
          typography: {
            fontFamily: para.fontFamily ?? para.runs[0]?.fontFamily,
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
      fontProfile: observeFontProfile(facts),
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
