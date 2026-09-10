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
  }>
}

/** Every editable slot must be FILLED or EXPLICITLY_UNUSED — no silent placeholders. */
export function auditPlaceholders(
  slides: AuditableSlide[],
  opts?: { allowlist?: RegExp[] },
): PlaceholderAuditResult {
  const issues: PlaceholderIssue[] = []
  let explicitlyUnused = 0
  const patterns = [...PLACEHOLDER_PATTERNS, ...(opts?.allowlist ?? [])]
  for (const slide of slides) {
    for (const el of slide.elements) {
      const text = el.text.trim()
      if (!text) continue
      if (el.editable === false) continue
      if (el.explicitUnused) {
        explicitlyUnused++
        continue
      }
      const hit = patterns.find((p) => p.test(text))
      if (hit) {
        issues.push({
          slideIndex: slide.slideIndex,
          elementId: el.elementId,
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
