/**
 * Measurement Engine (Phase 2). Deterministic natural-size computation for a
 * research node from its VISIBLE text — the composition stage must know real
 * size needs before any spatial decision. The text measurer is injectable so
 * tests stay dependency-free; production wires a calibrated estimator (and a
 * renderer-accurate measurer can replace it without touching callers).
 */
import type { RelationType } from '../semantic/schema.js'

/** px metrics at 96dpi. */
export interface NodeTextSpec {
  titleSizePt: number
  detailSizePt: number
  maxTitleLines: number
  maxDetailLines: number
  /** inner padding, px */
  padX: number
  padY: number
  /** gap between title and detail block, px */
  titleGapY: number
  lineHeight: number
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
}

export interface SizeBounds {
  minWidth: number
  preferredWidth: number
  maxWidth: number
  minHeight: number
  preferredHeight: number
  maxHeight: number
}

export interface VisibleText {
  title: string
  detail?: string
}

export interface MeasuredNode {
  /** semantic node id — the ONLY internal identity (COMP-P1-12) */
  id: string
  /** visible title text; display-only, never used as a graph key */
  title: string
  bounds: SizeBounds
  /** how many lines the title/detail need at preferredWidth */
  titleLines: number
  detailLines: number
}

/** Measures rendered text width in px for one line at the given pt size. */
export type TextMeasurer = (text: string, sizePt: number) => number

const PT_TO_PX = 96 / 72

/**
 * Calibrated estimator: full-width CJK ≈ 1em, Latin ≈ 0.52em, digits 0.56em,
 * space 0.30em, narrow punctuation 0.5em. Good to ~±8% for title-length
 * strings — enough to size composition candidates; the renderer's own text
 * pass remains the final authority.
 */
export function estimatorMeasurer(): TextMeasurer {
  return (text, sizePt) => {
    const em = sizePt * PT_TO_PX
    let units = 0
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0
      if (code >= 0x2e80) units += 1.0
      else if (ch === ' ') units += 0.3
      else if (/[0-9]/.test(ch)) units += 0.56
      else if (/[.,:;!|()[\]·—–\-"'`]/.test(ch)) units += 0.42
      else units += 0.52
    }
    return units * em
  }
}

function wrapLines(text: string, widthPx: number, sizePt: number, measure: TextMeasurer): number {
  if (!text) return 0
  let lines = 1
  let lineStart = 0
  let lastBreak = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\n') {
      lines++
      lineStart = i + 1
      lastBreak = -1
      continue
    }
    const width = measure(text.slice(lineStart, i + 1), sizePt)
    if (width > widthPx) {
      if (lastBreak > lineStart) {
        lineStart = lastBreak + 1
      } else {
        lineStart = i
      }
      lines++
      lastBreak = -1
    } else if (/\s/.test(ch)) {
      lastBreak = i
    }
  }
  return lines
}

/** Natural size for one node: preferred fits wrapped text, min/max clamp. */
export function measureNode(
  node: VisibleText & { id?: string },
  spec: NodeTextSpec,
  measure: TextMeasurer = estimatorMeasurer(),
): MeasuredNode {
  const titleWidth = node.title ? measure(node.title, spec.titleSizePt) : 0
  const detailWidth = node.detail ? measure(node.detail, spec.detailSizePt) : 0
  const preferredWidth = Math.ceil(
    Math.min(
      spec.maxWidth,
      Math.max(spec.minWidth, Math.max(titleWidth, detailWidth) + spec.padX * 2),
    ),
  )
  const titleLines = node.title
    ? wrapLines(node.title, preferredWidth - spec.padX * 2, spec.titleSizePt, measure)
    : 0
  const detailLines = node.detail
    ? wrapLines(node.detail, preferredWidth - spec.padX * 2, spec.detailSizePt, measure)
    : 0
  const titleBlock =
    Math.min(spec.maxTitleLines, titleLines) * spec.titleSizePt * PT_TO_PX * spec.lineHeight
  const detailBlock =
    Math.min(spec.maxDetailLines, detailLines) * spec.detailSizePt * PT_TO_PX * spec.lineHeight
  const textHeight = titleBlock + (detailLines > 0 ? spec.titleGapY + detailBlock : 0)
  const preferredHeight = Math.ceil(
    Math.min(spec.maxHeight, Math.max(spec.minHeight, textHeight + spec.padY * 2)),
  )
  const singleLineTitle = node.title
    ? measure(node.title, spec.titleSizePt) + spec.padX * 2
    : spec.minWidth
  return {
    id: node.id ?? node.title,
    title: node.title,
    titleLines,
    detailLines,
    bounds: {
      minWidth: Math.ceil(
        Math.min(
          preferredWidth,
          Math.max(spec.minWidth, Math.min(singleLineTitle, spec.minWidth * 1.35)),
        ),
      ),
      preferredWidth,
      maxWidth: spec.maxWidth,
      minHeight: Math.ceil(Math.min(preferredHeight, spec.minHeight)),
      preferredHeight,
      maxHeight: spec.maxHeight,
    },
  }
}

/** Nodes carry semantic + measured payload through the pipeline. */
export interface SemanticNodeInput {
  id: string
  title: string
  detail?: string
  importance?: number
  role?: string
  relationHints?: RelationType[]
}

export interface MeasuredFigure {
  nodes: MeasuredNode[]
}
