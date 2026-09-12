/**
 * Template QA (P3): placeholder audit, type-scale consistency audit, content
 * fit audit. Hard failures block delivery; soft issues feed repair.
 */

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /lorem ipsum/i,
  /\bQuestion\s*\d+/i,
  /\bClick to add/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /^XXX+$/i,
  /标题文字/,
  /正文文字/,
  /项目名称/,
  /示例文本/,
  /Key Words Here/i,
  /Vivamus/i,
  /点击此处/,
]

export interface PlaceholderIssue {
  slideIndex: number
  elementId: string
  kind: 'PLACEHOLDER_TEXT' | 'EMPTY_EDITABLE' | 'UNCHANGED_TEMPLATE_TEXT'
  text: string
  matchedPattern: string
}

export interface PlaceholderAuditResult {
  issues: PlaceholderIssue[]
  /** editable slots intentionally left without content */
  explicitlyUnused: number
  pass: boolean
}

export interface AuditableSlide {
  slideIndex: number
  elements: Array<{
    elementId: string
    text: string
    editable?: boolean
    explicitUnused?: boolean
    slotRole?: string
    /** GOAL section 16: the template's original text — equality means "never filled" */
    currentText?: string
  }>
}

/**
 * GOAL section 16, three gates, no silent placeholders:
 *  1. PLACEHOLDER_TEXT — the text matches a known placeholder pattern;
 *  2. EMPTY_EDITABLE   — an editable slot left empty (unless explicitly unused);
 *  3. UNCHANGED        — the text still EQUALS the slot's template currentText,
 *     i.e. the plan targeted this slot but never wrote to it.
 * `opts.allowlist` marks text that is INTENTIONALLY kept (page numbers,
 * copyright lines, brand footers) — matching elements are suppressed.
 * `opts.extraForbidden` extends the placeholder patterns.
 */
export function auditPlaceholders(
  slides: AuditableSlide[],
  opts?: { allowlist?: RegExp[]; extraForbidden?: RegExp[] },
): PlaceholderAuditResult {
  const issues: PlaceholderIssue[] = []
  let explicitlyUnused = 0
  const patterns = [...PLACEHOLDER_PATTERNS, ...(opts?.extraForbidden ?? [])]
  const allow = opts?.allowlist ?? []
  for (const slide of slides) {
    for (const el of slide.elements) {
      const text = el.text.trim()
      if (el.editable === false) continue
      if (el.explicitUnused) {
        explicitlyUnused++
        continue
      }
      if (allow.some((p) => p.test(text))) continue
      if (!text) {
        issues.push({
          slideIndex: slide.slideIndex,
          elementId: el.elementId,
          kind: 'EMPTY_EDITABLE',
          text: '',
          matchedPattern: '(empty editable slot)',
        })
        continue
      }
      if (el.currentText !== undefined && el.currentText.trim() === text) {
        issues.push({
          slideIndex: slide.slideIndex,
          elementId: el.elementId,
          kind: 'UNCHANGED_TEMPLATE_TEXT',
          text: text.slice(0, 60),
          matchedPattern: '(equals template currentText)',
        })
        continue
      }
      const hit = patterns.find((p) => p.test(text))
      if (hit) {
        issues.push({
          slideIndex: slide.slideIndex,
          elementId: el.elementId,
          kind: 'PLACEHOLDER_TEXT',
          text: text.slice(0, 60),
          matchedPattern: String(hit),
        })
      }
    }
  }
  return { issues, explicitlyUnused, pass: issues.length === 0 }
}

export interface TypeScaleIssue {
  slideIndex: number
  elementId: string
  level: number
  fontSizePt: number
  expectedPt: number
}

export interface TypeScaleAuditResult {
  issues: TypeScaleIssue[]
  pass: boolean
}

/** Same semantic level ⇒ same font size (within rounding). */
export function auditTypeScaleConsistency(
  entries: Array<{
    slideIndex: number
    elementId: string
    level: number
    fontSizePt: number
  }>,
  tolerancePt = 0.6,
): TypeScaleAuditResult {
  const byLevel = new Map<number, number[]>()

  const issues: TypeScaleIssue[] = []
  for (const entry of entries) {
    const list = byLevel.get(entry.level) ?? []
    list.push(entry.fontSizePt)
    byLevel.set(entry.level, list)
  }
  for (const [level, sizes] of byLevel) {
    const dominant = modeSize(sizes)
    for (const size of sizes) {
      if (Math.abs(size - dominant) > tolerancePt) {
        // find the element
        const offender = entries.find(
          (e) => e.level === level && Math.abs(e.fontSizePt - dominant) > tolerancePt,
        )
        if (offender) {
          issues.push({
            slideIndex: offender.slideIndex,
            elementId: offender.elementId,
            level,
            fontSizePt: offender.fontSizePt,
            expectedPt: dominant,
          })
        }
        break
      }
    }
  }
  return { issues, pass: issues.length === 0 }
}

function modeSize(sizes: number[]): number {
  const counts = new Map<number, number>()
  for (const s of sizes) counts.set(s, (counts.get(s) ?? 0) + 1)
  let best = sizes[0]!
  let bestCount = 0
  for (const [s, c] of counts) {
    if (c > bestCount || (c === bestCount && s > best)) {
      best = s
      bestCount = c
    }
  }
  return best
}

export interface ContentFitIssue {
  slideIndex: number
  elementId: string
  overflowY: number
  estimatedLines: number
  maxLines: number
}

export interface ContentFitAuditResult {
  issues: ContentFitIssue[]
  pass: boolean
}

/** Hard gate: overflow beyond tolerance fails delivery (GOAL section 48). */
export function auditContentFit(
  fits: Array<{
    slideIndex: number
    elementId: string
    fit: { fits: boolean; overflowY: number; estimatedLines: number; maxLines: number }
  }>,
  toleranceCm = 0.15,
): ContentFitAuditResult {
  const issues: ContentFitIssue[] = fits
    .filter((f) => f.fit.overflowY > toleranceCm)
    .map((f) => ({
      slideIndex: f.slideIndex,
      elementId: f.elementId,
      overflowY: f.fit.overflowY,
      estimatedLines: f.fit.estimatedLines,
      maxLines: f.fit.maxLines,
    }))
  return { issues, pass: issues.length === 0 }
}
