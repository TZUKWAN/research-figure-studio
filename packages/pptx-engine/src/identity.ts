/**
 * Durable identity (design step 0): ids resolved from the element's own bytes,
 * so they survive save→reopen, reparse, and group/ungroup.
 *
 * - element: the a16:creationId GUID (newborn elements mint one — see
 *   creationIdXml — and PowerPoint writes them too) → "e_<guid8>"; otherwise
 *   the <p:cNvPr id>, also persisted in the XML, unique per slide and stable
 *   across reparses → "e_<n>".
 * - slide: the part path (slide7.xml → "s_7"; save never renames parts).
 *
 * The element search is scoped to the element's OWN <p:cNvPr> (always the
 * first in the fragment): group/SmartArt fragments embed their children's
 * bytes, and a wrapper without a creationId must not inherit a child's GUID —
 * after ungroup that same id would suddenly mean the child.
 */
import type { SemanticMetadata, Slide, SlideElement } from './types'
import { creationIdExtXml, creationIdXml } from './xml-utils'

const CREATION_ID_RE = /<a16:creationId[^>]*\bid="\{?([0-9A-Fa-f-]{36})\}?"/
const SEMANTIC_PREFIX = 'rfs:v1'
const SEMANTIC_FIELDS = ['role', 'themeFill', 'themeStroke', 'themeText', 'componentType'] as const
const OPTIONAL_SEMANTIC_FIELDS = [
  'semanticNodeId',
  'semanticEdgeId',
  'relationPresentation',
] as const
/** Extended refs (schema v2). All optional; old parsers ignore them safely. */
const EXTENDED_SEMANTIC_FIELDS = [
  'researchMetadataVersion',
  'parentModuleId',
  'groupId',
  'figureRunId',
  'figureFamily',
  'domain',
  'primitiveKind',
  'relationType',
  'visualUnitId',
  'evidenceRefs',
  'provenanceRefs',
  'derivedFrom',
] as const

/** Current per-shape semantic metadata schema version. */
export const RESEARCH_METADATA_VERSION = 2

type AllSemanticFields =
  | (typeof SEMANTIC_FIELDS)[number]
  | (typeof OPTIONAL_SEMANTIC_FIELDS)[number]
  | (typeof EXTENDED_SEMANTIC_FIELDS)[number]

/** Encode the route-B payload as a compact, PowerPoint-safe cNvPr string. */
export function serializeSemanticMetadata(metadata: SemanticMetadata): string {
  const extended: Record<string, unknown> = {
    ...(metadata.researchMetadataVersion === undefined
      ? { researchMetadataVersion: RESEARCH_METADATA_VERSION }
      : {}),
    ...metadata,
  }
  return [
    SEMANTIC_PREFIX,
    ...SEMANTIC_FIELDS.map((field) => `${field}=${encodeURIComponent(metadata[field])}`),
    ...OPTIONAL_SEMANTIC_FIELDS.flatMap((field) =>
      metadata[field] === undefined ? [] : [`${field}=${encodeURIComponent(metadata[field]!)}`],
    ),
    ...EXTENDED_SEMANTIC_FIELDS.flatMap((field) =>
      extended[field] === undefined
        ? []
        : [`${field}=${encodeURIComponent(String(extended[field]))}`],
    ),
  ].join('|')
}

/** Decode a route-B cNvPr value; unrelated user descriptions return null. */
export function parseSemanticMetadata(value: unknown): SemanticMetadata | null {
  if (typeof value !== 'string') return null
  const parts = value.split('|')
  const prefix = parts.shift()
  // Accept the current prefix and future `rfs:vN` ones: unknown versions parse
  // their readable fields and are never silently dropped (graceful downgrade).
  if (!prefix || !prefix.startsWith('rfs:v')) return null
  const values: Partial<Record<AllSemanticFields, string>> = {}
  const allowed = new Set<string>([
    ...SEMANTIC_FIELDS,
    ...OPTIONAL_SEMANTIC_FIELDS,
    ...EXTENDED_SEMANTIC_FIELDS,
  ])
  for (const part of parts) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    const key = part.slice(0, at)
    if (!allowed.has(key)) continue
    try {
      values[key as AllSemanticFields] = decodeURIComponent(part.slice(at + 1))
    } catch {
      return null
    }
  }
  if (SEMANTIC_FIELDS.some((field) => !values[field])) return null
  const parsed: SemanticMetadata = {
    role: values.role!,
    themeFill: values.themeFill!,
    themeStroke: values.themeStroke!,
    themeText: values.themeText!,
    componentType: values.componentType!,
  }
  if (values.semanticNodeId !== undefined) parsed.semanticNodeId = values.semanticNodeId
  if (values.semanticEdgeId !== undefined) parsed.semanticEdgeId = values.semanticEdgeId
  if (values.relationPresentation !== undefined) {
    parsed.relationPresentation = values.relationPresentation
  }
  for (const field of EXTENDED_SEMANTIC_FIELDS) {
    const raw = values[field]
    if (raw === undefined) continue
    if (field === 'researchMetadataVersion') {
      const n = Number(raw)
      if (Number.isFinite(n)) parsed.researchMetadataVersion = n
      continue
    }
    ;(parsed as unknown as Record<string, unknown>)[field] = raw
  }
  return parsed
}

/** Prefer descr, then title, so foreign decks can be read without rewriting them. */
export function semanticMetadataFromCnvPr(descr: unknown, title: unknown): SemanticMetadata | null {
  return parseSemanticMetadata(descr) ?? parseSemanticMetadata(title)
}

export function elementDurableId(el: SlideElement): string | null {
  const xml = el.anchor?.originalXml
  if (!xml) {
    // Group children carry no byte slice of their own (it lives inside the parent
    // group's XML); their persisted <p:cNvPr id> — parsed as nvId, unique within
    // the slide part — still identifies them durably. (creationId continuity
    // while grouped is a known follow-up: the GUID sits in the parent's bytes.)
    const nvId = (el as { nvId?: number | string }).nvId
    return nvId != null ? `e_${nvId}` : null
  }
  const open = /<p:cNvPr\b[^>]*?(\/?)>/.exec(xml)
  if (!open) return null
  const own =
    open[1] === '/'
      ? open[0]
      : xml.slice(open.index, xml.indexOf('</p:cNvPr>', open.index) + '</p:cNvPr>'.length)
  const creation = CREATION_ID_RE.exec(own)
  if (creation) return `e_${creation[1]!.slice(0, 8).toLowerCase()}`
  const cnvpr = /\bid="(\d+)"/.exec(open[0])
  return cnvpr ? `e_${cnvpr[1]!}` : null
}

export function slideDurableId(slide: Slide): string {
  const m = /slide(\d+)\.xml$/.exec(slide.path)
  return m ? `s_${m[1]}` : `s_${slide.path.replace(/[^a-zA-Z0-9]/g, '_')}`
}

/**
 * The pre-upgrade fallback form ("e_<cNvPr id>"), independent of whether a
 * creationId exists. Kept resolvable as an ALIAS after ensureCreationId mints
 * a GUID, so refs held across the upgrade keep working.
 */
export function elementCNvPrId(el: SlideElement): string | null {
  const xml = el.anchor?.originalXml
  if (!xml) {
    const nvId = (el as { nvId?: number | string }).nvId
    return nvId != null ? `e_${nvId}` : null
  }
  const open = /<p:cNvPr\b[^>]*?(\/?)>/.exec(xml)
  if (!open) return null
  const id = /\bid="(\d+)"/.exec(open[0])
  return id ? `e_${id[1]!}` : null
}

/** Ref match across all forms: parse-time id, durable GUID, and the cNvPr
    form — the latter stays an alias after ensureCreationId upgrades an
    element to a GUID mid-session, so refs held across the upgrade resolve. */
export function matchesElementRef(el: SlideElement, id: string): boolean {
  return el.id === id || elementDurableId(el) === id || elementCNvPrId(el) === id
}

/**
 * Progressive identity hardening for foreign decks: mint an a16:creationId
 * into the element's OWN <p:cNvPr> when it lacks one. Mutates the anchor and
 * is idempotent — callers invoke it only for elements whose bytes are being
 * rewritten anyway (the patch-save path), so untouched content stays
 * byte-identical on save. extLst is cNvPr's last child, so appending before
 * the close tag keeps schema order (after any hlinkClick).
 */
export function ensureCreationId(el: SlideElement): void {
  const xml = el.anchor?.originalXml
  if (!xml) return
  const open = /<p:cNvPr\b[^>]*?(\/?)>/.exec(xml)
  if (!open) return
  if (open[1] === '/') {
    // Self-closing: expand into a tag pair carrying the extLst
    el.anchor.originalXml =
      xml.slice(0, open.index + open[0].length - 2) +
      `>${creationIdXml()}</p:cNvPr>` +
      xml.slice(open.index + open[0].length)
    return
  }
  const close = xml.indexOf('</p:cNvPr>', open.index)
  if (close < 0) return
  const own = xml.slice(open.index, close)
  if (CREATION_ID_RE.test(own)) return
  // extLst has maxOccurs=1: merge into an existing one (decorative/compat
  // extensions) rather than appending a second, invalid, extLst. cNvPr's own
  // extLst is its LAST child — an earlier </a:extLst> belongs to a nested
  // hlinkClick/hlinkHover extension list and must not receive the GUID.
  const extLstClose = own.lastIndexOf('</a:extLst>')
  if (extLstClose >= 0 && own.slice(extLstClose + '</a:extLst>'.length).trim() === '') {
    const at = open.index + extLstClose
    el.anchor.originalXml = xml.slice(0, at) + creationIdExtXml() + xml.slice(at)
    return
  }
  el.anchor.originalXml = xml.slice(0, close) + creationIdXml() + xml.slice(close)
}

/**
 * Durable id for a group child. Children carry no byte slice of their own —
 * their bytes (including any a16:creationId) live inside the parent group's
 * XML — so locate the child's <p:cNvPr> there by its parsed nvId (unique per
 * slide part) and scope the creationId search to that block. Falls back to
 * elementDurableId's nvId form, so the id is at worst the same as before.
 */
export function groupChildDurableId(grp: SlideElement, child: SlideElement): string | null {
  const nvId = (child as { nvId?: number | string }).nvId
  const xml = grp.anchor?.originalXml
  if (xml && nvId != null) {
    const open = new RegExp(`<p:cNvPr\\b[^>]*\\bid="${nvId}"[^>]*?(\\/?)>`).exec(xml)
    if (open) {
      const own =
        open[1] === '/'
          ? open[0]
          : xml.slice(open.index, xml.indexOf('</p:cNvPr>', open.index) + '</p:cNvPr>'.length)
      const creation = CREATION_ID_RE.exec(own)
      if (creation) return `e_${creation[1]!.slice(0, 8).toLowerCase()}`
    }
  }
  return elementDurableId(child)
}
