/**
 * Capacity (P3) — geometry-accurate text fit estimation for template slots.
 *
 * Port of Gorden's compute_capacity vw-unit concept, re-expressed on the
 * GenOffice engine: box geometry comes from the parsed slide, font size from
 * resolved paragraph runs, and the visual-width unit formula is identical
 * (CJK/fullwidth = 1.0 em, latin ≈ 0.5, space ≈ 0.35).
 *
 * Capacity is a SOFT constraint for content planning — never a string
 * truncator (see the content-fit ladder in fill.ts).
 */
import type { TemplateSlot } from './schema.js'

export const EMU_PER_CM = 360000
export const PT_PER_CM = 28.3465
/** px at 96dpi per pt (Engine UI px convention) */
export const PX_PER_PT = 96 / 72

/** Visual width in em units: CJK/fullwidth = 1.0, space = 0.35, latin ≈ 0.5. */
export function visualWidthEm(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      w += 1.0
    } else if (ch === ' ') {
      w += 0.35
    } else if (code < 0x80) {
      w += 0.5
    } else {
      w += 0.8
    }
  }
  return w
}

export interface TextFitResult {
  fits: boolean
  overflowX: number
  overflowY: number
  estimatedLines: number
  maxLines: number
  /** 0..1+ — estimated capacity pressure, usable for content compression */
  pressure: number
  confidence: number
}

/**
 * Estimate whether `text` fits a slot at its resolved font size, using the
 * slot's box geometry (EMU) instead of char counts.
 */
export function estimateTextFit(
  text: string,
  slot: Pick<TemplateSlot, 'capacity' | 'typography'>,
  opts?: { boxEmu?: { cx: number; cy: number }; fontPt?: number },
): TextFitResult {
  const fontPt = opts?.fontPt ?? slot.typography.fontSizePt ?? 18
  const boxCm = opts?.boxEmu
    ? { w: opts.boxEmu.cx / EMU_PER_CM, h: opts.boxEmu.cy / EMU_PER_CM }
    : slot.capacity.boxWidthPx && slot.capacity.boxHeightPx
      ? {
          w: slot.capacity.boxWidthPx / PX_PER_PT / PT_PER_CM,
          h: slot.capacity.boxHeightPx / PX_PER_PT / PT_PER_CM,
        }
      : undefined
  if (!boxCm) {
    return {
      fits: true,
      overflowX: 0,
      overflowY: 0,
      estimatedLines: 1,
      maxLines: 1,
      pressure: 0,
      confidence: 0.2,
    }
  }
  const textWidthCm = (visualWidthEm(text) * fontPt) / PT_PER_CM
  const fontSizeCm = fontPt / PT_PER_CM
  const lineHeightCm = fontSizeCm * 1.2
  const wrap = slot.capacity.charsPerLine === undefined ? true : true
  const estimatedLines = wrap ? Math.max(1, Math.ceil(textWidthCm / Math.max(0.1, boxCm.w))) : 1
  const maxLines = Math.max(1, Math.floor(boxCm.h / Math.max(0.1, lineHeightCm)))
  const overflowY = Math.max(0, (estimatedLines - maxLines) * lineHeightCm)
  const overflowX = wrap ? 0 : Math.max(0, textWidthCm - boxCm.w)
  const capacityLines = slot.capacity.maxLines ?? maxLines
  const pressure =
    capacityLines > 0 ? Math.min(2, estimatedLines / capacityLines) : estimatedLines > 1 ? 1.2 : 0.8
  return {
    fits: overflowY <= 0.05 && overflowX <= 0.05,
    overflowX: Math.round(overflowX * 100) / 100,
    overflowY: Math.round(overflowY * 100) / 100,
    estimatedLines,
    maxLines,
    pressure: Math.round(pressure * 100) / 100,
    confidence: slot.capacity.confidence,
  }
}

/**
 * GOAL section 15: REAL_LAYOUT_MEASURE tier — wrap computed from ACTUAL glyph
 * advances of the named installed family (@genoffice/font-metrics hmtx/cmap),
 * not the 0.5/1.0 em approximations. Returns null (caller keeps the fast
 * estimate) when the family is unknown to the OS or no box geometry exists;
 * the tier field in the slot's capacity records which path produced the
 * numbers — never claim measured precision for an estimate.
 *
 * font-metrics is loaded lazily: it reads system font files (node:fs), so it
 * must never enter a renderer bundle.
 */
export async function measureTextFitReal(
  text: string,
  slot: Pick<TemplateSlot, 'capacity' | 'typography'>,
  opts?: {
    boxEmu?: { cx: number; cy: number }
    insetsEmu?: { l: number; t: number; r: number; b: number }
    fontPt?: number
    family?: string
    lineHeightPct?: number
  },
): Promise<TextFitResult | null> {
  const family = opts?.family ?? slot.typography.fontFamily
  if (!family) return null
  const fontPt = opts?.fontPt ?? slot.typography.fontSizePt ?? 18
  const insets = opts?.insetsEmu ?? { l: 91440, t: 45720, r: 91440, b: 45720 }
  const box = opts?.boxEmu
    ? {
        w: (opts.boxEmu.cx - insets.l - insets.r) / 12700,
        h: (opts.boxEmu.cy - insets.t - insets.b) / 12700,
      }
    : slot.capacity.boxEmu
      ? {
          w: (slot.capacity.boxEmu.cx - insets.l - insets.r) / 12700,
          h: (slot.capacity.boxEmu.cy - insets.t - insets.b) / 12700,
        }
      : undefined
  if (!box || box.w <= 0 || box.h <= 0) return null

  let widths: number[] | null
  try {
    // lazy: keeps node:fs out of renderer bundles
    const { advanceWidths } = await import('@genoffice/font-metrics')
    widths = advanceWidths(family, text, fontPt, { bold: slot.typography.bold })
  } catch {
    return null
  }
  if (!widths) return null

  // greedy wrap on measured advances (twips → pt at /20)
  const lines: number[] = [0]
  for (const tw of widths) {
    const w = tw / 20
    const current = lines[lines.length - 1]!
    if (current + w > box.w && current > 0) lines.push(w)
    else lines[lines.length - 1] = current + w
  }
  const estimatedLines = lines.length
  const lineHeightPt = fontPt * 1.2 * ((opts?.lineHeightPct ?? 100) / 100)
  const maxLines = Math.max(1, Math.floor(box.h / lineHeightPt))
  const overflowY = Math.max(0, (estimatedLines - maxLines) * lineHeightPt)
  const pressure =
    maxLines > 0 ? Math.min(2, estimatedLines / maxLines) : estimatedLines > 1 ? 1.2 : 0.8
  return {
    fits: overflowY <= 0.05,
    overflowX: 0,
    overflowY: Math.round(overflowY * 100) / 100,
    estimatedLines,
    maxLines,
    pressure: Math.round(pressure * 100) / 100,
    confidence: 0.95,
  }
}
