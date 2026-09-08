/**
 * Slide-level research figure metadata (RENDER-P0-10).
 *
 * Per-shape cNvPr payloads carry element identity, but the FIGURE as a whole —
 * semantic graph, suppressed/spatially-encoded relations, domain, family —
 * needs a document-level home so a reopened deck can reconstruct the real
 * FigureGraph instead of guessing from visuals. The payload rides the slide's
 * `<p:cSld name>` attribute: kept verbatim by the save path (bodyPrefix
 * passthrough), visible as the slide name in PowerPoint, and cheap to parse.
 * A user renaming the slide inside PowerPoint replaces the payload — the
 * per-shape refs then remain as the degraded fallback.
 *
 * Schema is versioned (`schemaVersion`); parsers accept unknown versions and
 * surface them instead of discarding data.
 */
import type { Slide } from './types'

/** Relation record preserved for AI re-editing after reopen. */
export interface ResearchRelationRecord {
  id: string
  from: string
  to: string
  relation: string
  presentation: string
  /** rendered connector | expressed through position/grouping | dropped by density cap */
  status: 'rendered' | 'spatial' | 'suppressed'
  /** native connector element id when status === 'rendered' */
  connectorId?: string
  /** why the relation has no line (suppression reason) */
  reason?: string
}

/** Node record: identity + display text so the graph survives reopen. */
export interface ResearchNodeRecord {
  id: string
  title: string
  type: string
  /** registry primitive the module was rendered as */
  primitiveKind: string
  /** semantic detail disposition (RENDER-P0-05) */
  detailDisposition: 'render-in-parent' | 'promoted-to-units' | 'omitted-by-plan'
  /** composite module group (native p:grpSp) when the module has micro units */
  groupElementId?: string
}

export interface ResearchFigureSlidePayload {
  schemaVersion: number
  /** id of the creation run that produced this figure */
  figureRunId: string
  figureFamily: string
  domain: string
  /** thesis / central claim the figure expresses */
  thesis: string
  nodes: ResearchNodeRecord[]
  relations: ResearchRelationRecord[]
  /** typographic resolution actually used (RENDER-P1-08 fallback traceability) */
  typography?: { fontScale: number; measurer: string }
  /** P1-3: intent trail of structured edits applied to this figure */
  editTrail?: string[]
}

const NAME_PREFIX = 'rfs1:'

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Read the slide's research payload; null when absent or foreign. */
export function getSlideResearchMetadata(slide: Slide): ResearchFigureSlidePayload | null {
  const m =
    /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(slide.bodyPrefix) ??
    /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(slide.originalXml)
  if (!m) return null
  const raw = unescapeXmlAttr(m[1]!)
  if (!raw.startsWith(NAME_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(NAME_PREFIX.length)) as ResearchFigureSlidePayload
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.nodes)) return null
    return parsed
  } catch {
    return null
  }
}

/** Write (or overwrite) the slide's research payload. Returns true on success. */
export function setSlideResearchMetadata(
  slide: Slide,
  payload: ResearchFigureSlidePayload,
): boolean {
  const name = escapeXmlAttr(NAME_PREFIX + JSON.stringify(payload))
  const open = /<p:cSld\b[^>]*?\/?>/.exec(slide.bodyPrefix)
  if (!open) return false
  let tag = open[0]
  if (/\bname="/.test(tag)) {
    tag = tag.replace(/\bname="[^"]*"/, `name="${name}"`)
  } else if (tag.endsWith('/>')) {
    tag = `${tag.slice(0, -2)} name="${name}">`
  } else {
    tag = `${tag.slice(0, -1)} name="${name}">`
  }
  slide.bodyPrefix =
    slide.bodyPrefix.slice(0, open.index) +
    tag +
    slide.bodyPrefix.slice(open.index + open[0].length)
  // Keep originalXml coherent: it is the save base for non-dirty paths.
  const openFull = /<p:cSld\b[^>]*?\/?>/.exec(slide.originalXml)
  if (openFull) {
    let tagFull = openFull[0]
    if (/\bname="/.test(tagFull)) tagFull = tagFull.replace(/\bname="[^"]*"/, `name="${name}"`)
    else if (tagFull.endsWith('/>')) tagFull = `${tagFull.slice(0, -2)} name="${name}">`
    else tagFull = `${tagFull.slice(0, -1)} name="${name}">`
    slide.originalXml =
      slide.originalXml.slice(0, openFull.index) +
      tagFull +
      slide.originalXml.slice(openFull.index + openFull[0].length)
  }
  return true
}
