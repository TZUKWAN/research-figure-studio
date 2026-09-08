/**
 * Figure Contract (P1, GOAL §5/§8/§21/§22/§24).
 *
 * The pipeline's first layer is no longer User → FigurePlan; it is
 * User/Document → FigureContract → FigurePlan. The contract pins WHAT the
 * figure must claim, for WHOM, at WHAT final physical size — so QA can gate
 * on publication reality (effective text size at 85mm print width) instead
 * of 1280×720 vanity metrics.
 */

export const FIGURE_FAMILIES = [
  'framework',
  'architecture',
  'pipeline',
  'mechanism',
  'causal-model',
  'hierarchy',
  'network',
  'timeline',
  'matrix',
  'multi-panel-data',
  'graphical-abstract',
  'experimental-setup',
  'comparison',
  'outreach',
  'freeform',
] as const

export type FigureFamily = (typeof FIGURE_FAMILIES)[number]

export const OUTPUT_CONTEXTS = [
  'presentation',
  'paper-single-column',
  'paper-double-column',
  'full-page-paper',
  'thesis',
  'poster',
  'web',
] as const

export type OutputContext = (typeof OUTPUT_CONTEXTS)[number]

/** Standard final widths (mm) when the user does not pin explicit sizes. */
export const OUTPUT_CONTEXT_DEFAULT_WIDTH_MM: Record<OutputContext, number> = {
  presentation: 338.7,
  'paper-single-column': 85,
  'paper-double-column': 180,
  'full-page-paper': 190,
  thesis: 150,
  poster: 900,
  web: 338.7,
}

/** Minimum readable font size (pt) AT FINAL PHYSICAL SIZE, per context. */
export const OUTPUT_CONTEXT_MIN_TEXT_PT: Record<OutputContext, number> = {
  presentation: 9,
  'paper-single-column': 5.5,
  'paper-double-column': 5.5,
  'full-page-paper': 5.5,
  thesis: 6.5,
  poster: 10,
  web: 9,
}

export type ProvenanceSource = 'user' | 'document' | 'search' | 'dataset' | 'sample' | 'derived'

export interface ProvenanceSpec {
  /** the claim/value the provenance covers (e.g. "accuracy 92%") */
  claim: string
  source: ProvenanceSource
  /** locator within the source (file, url, dataset column…) */
  locator?: string
}

export interface EvidenceRequirement {
  id: string
  description: string
  required: boolean
  source: ProvenanceSource
}

export interface VisibleTextContract {
  allowed: string[]
  required?: string[]
  forbidden?: string[]
  language: 'zh' | 'en' | 'mixed'
}

export interface FigureContract {
  centralClaim: string
  figureFamily: FigureFamily
  domain: string
  audience?: string
  venue?: string
  output: {
    context: OutputContext
    finalWidthMm?: number
    finalHeightMm?: number
    aspectRatio: number
  }
  evidenceMustShow: EvidenceRequirement[]
  evidenceOptional: EvidenceRequirement[]
  forbiddenClaims: string[]
  visibleTextPolicy: VisibleTextContract
  provenance: ProvenanceSpec[]
  /** explicit override of the per-context floor */
  minTextPtAtFinalSize?: number
  editability: 'fully-native' | 'hybrid-vector'
}

const FAMILY_SET = new Set<string>(FIGURE_FAMILIES)
const CONTEXT_SET = new Set<string>(OUTPUT_CONTEXTS)
const SOURCE_SET = new Set<string>(['user', 'document', 'search', 'dataset', 'sample', 'derived'])

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(text).filter(Boolean) : []
}

/**
 * R0/R1 repair: accept a raw model/user contract, clamp enums, fill safe
 * defaults. Returns null only when even the central claim is missing.
 */
export function parseFigureContract(raw: unknown): FigureContract | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const centralClaim = text(r.centralClaim)
  if (!centralClaim) return null
  const family = text(r.figureFamily)
  const domain = text(r.domain) || 'general'
  const venue = text(r.venue)
  const audience = text(r.audience)
  const output = (r.output ?? {}) as Record<string, unknown>
  const context = text(output.context)
  const aspectRatio =
    typeof output.aspectRatio === 'number' && output.aspectRatio > 0 ? output.aspectRatio : 16 / 9
  const finalWidthMm =
    typeof output.finalWidthMm === 'number' && output.finalWidthMm > 0
      ? output.finalWidthMm
      : undefined
  const finalHeightMm =
    typeof output.finalHeightMm === 'number' && output.finalHeightMm > 0
      ? output.finalHeightMm
      : undefined
  // P0-7: the SECTION the caller placed the entry in decides the default —
  // evidenceMustShow entries default required, evidenceOptional entries default
  // optional; a caller never has to repeat `required: false` in the optional
  // list (an explicit `required` flag still wins).
  let invalidRequiredEvidence = false
  const evidence = (value: unknown, defaultRequired: boolean): EvidenceRequirement[] =>
    Array.isArray(value)
      ? (value as unknown[]).flatMap((item) => {
          const e = (item ?? {}) as Record<string, unknown>
          const id = text(e.id)
          if (!id) return []
          const source = text(e.source)
          // P0-4: provenance source is NEVER guessed. A missing or unknown
          // source makes the entry invalid — the contract author must state
          // where it comes from. An invalid REQUIRED evidence entry poisons
          // the whole contract (fail-closed: gating must never silently
          // weaken); invalid optional entries are dropped as items.
          if (!SOURCE_SET.has(source)) {
            if (defaultRequired) invalidRequiredEvidence = true
            return []
          }
          return [
            {
              id,
              description: text(e.description) || id,
              required: typeof e.required === 'boolean' ? e.required : defaultRequired,
              source: source as ProvenanceSource,
            },
          ]
        })
      : []
  const provenance = Array.isArray(r.provenance)
    ? (r.provenance as unknown[]).flatMap((item) => {
        const p = (item ?? {}) as Record<string, unknown>
        const claim = text(p.claim)
        if (!claim) return []
        const source = text(p.source)
        // P0-4: same no-guessing rule for quantitative provenance — an
        // explicit source is part of the contract, not a default.
        if (!SOURCE_SET.has(source)) return []
        return [
          {
            claim,
            source: source as ProvenanceSource,
            ...(text(p.locator) ? { locator: text(p.locator) } : {}),
          },
        ]
      })
    : []
  // P0-4 fail-closed: a required evidence entry with a missing/unknown
  // source invalidates the WHOLE contract — never ship with weakened gates.
  if (invalidRequiredEvidence) return null
  const policy = (r.visibleTextPolicy ?? {}) as Record<string, unknown>
  const language = text(policy.language)
  const parsedContract: FigureContract = {
    centralClaim,
    figureFamily: (FAMILY_SET.has(family.toLowerCase())
      ? (family.toLowerCase() as FigureFamily)
      : 'freeform') as FigureFamily,
    domain,
    ...(audience ? { audience } : {}),
    ...(venue ? { venue } : {}),
    output: {
      context: (CONTEXT_SET.has(context.toLowerCase())
        ? (context.toLowerCase() as OutputContext)
        : 'presentation') as OutputContext,
      ...(finalWidthMm !== undefined ? { finalWidthMm } : {}),
      ...(finalHeightMm !== undefined ? { finalHeightMm } : {}),
      aspectRatio,
    },
    evidenceMustShow: evidence(r.evidenceMustShow, true).filter((e) => e.required),
    evidenceOptional: evidence(r.evidenceOptional, false).filter((e) => !e.required),
    forbiddenClaims: strings(r.forbiddenClaims),
    visibleTextPolicy: {
      allowed: strings(policy.allowed),
      ...(strings(policy.required).length ? { required: strings(policy.required) } : {}),
      ...(strings(policy.forbidden).length ? { forbidden: strings(policy.forbidden) } : {}),
      language: (['zh', 'en', 'mixed'].includes(language) ? language : 'mixed') as
        'zh' | 'en' | 'mixed',
    },
    provenance,
    ...(typeof r.minTextPtAtFinalSize === 'number' && r.minTextPtAtFinalSize > 0
      ? { minTextPtAtFinalSize: r.minTextPtAtFinalSize }
      : {}),
    editability: text(r.editability) === 'hybrid-vector' ? 'hybrid-vector' : 'fully-native',
  }
  // P0-4 fail-closed: a required evidence entry with a missing/unknown
  // source invalidates the WHOLE contract — never ship with weakened gates.
  if (invalidRequiredEvidence) return null
  return parsedContract
}

/**
 * Venue-aware soft quality threshold (GOAL §18). Hard gates always apply
 * regardless of this number.
 */
export function qualityThresholdFor(contract?: Pick<FigureContract, 'venue' | 'output'>): number {
  const venue = (contract?.venue ?? '').toLowerCase()
  if (venue.includes('nature') || venue.includes('science') || venue.includes('journal')) return 8.5
  if (venue.includes('conference')) return 8.0
  if (venue.includes('thesis')) return 8.0
  if (contract?.output.context === 'poster') return 7.5
  if (contract?.output.context === 'presentation') return 7.0
  return 7.5
}

/**
 * Effective pt of an on-canvas font size when the canvas is printed/exported
 * at the contract's final width. Canvas mm is derived from px at 96dpi
 * (1px = 25.4/96 mm) — the same convention the renderer already uses.
 */
export function effectiveFontPt(
  fontPt: number,
  canvasWidthPx: number,
  finalWidthMm: number,
): number {
  const canvasWidthMm = (canvasWidthPx * 25.4) / 96
  if (canvasWidthMm <= 0 || finalWidthMm <= 0) return fontPt
  return (fontPt * finalWidthMm) / canvasWidthMm
}

export interface PublicationIssue {
  gate: string
  severity: 'hard' | 'soft'
  detail: string
  affectedIds?: string[]
}

/**
 * Publication QA (P3 core, deterministic): gate the figure against its final
 * physical size — text floor, stroke floor, canvas margin — before delivery.
 */
export function publicationAudit(input: {
  contract: FigureContract
  canvasW: number
  canvasH: number
  /** smallest title/body font actually used on canvas (pt) */
  minFontPt: number
  /** smallest stroke width used (pt) */
  minStrokePt?: number
  /** placement id owning the smallest font, for evidence */
  smallestTextId?: string
}): PublicationIssue[] {
  const issues: PublicationIssue[] = []
  const finalWidthMm =
    input.contract.output.finalWidthMm ??
    OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context]
  const minPt =
    input.contract.minTextPtAtFinalSize ?? OUTPUT_CONTEXT_MIN_TEXT_PT[input.contract.output.context]
  const effective = effectiveFontPt(input.minFontPt, input.canvasW, finalWidthMm)
  // 1e-3pt absolute tolerance: float noise from the forward scale must not
  // re-introduce a false floor violation at exactly-floor configurations.
  if (effective < minPt - 1e-3) {
    issues.push({
      gate: 'final-size-text-minimum',
      severity: 'hard',
      detail: `smallest text ${input.minFontPt}pt shrinks to ${effective.toFixed(1)}pt at ${Math.round(finalWidthMm)}mm width (floor ${minPt}pt)`,
      ...(input.smallestTextId ? { affectedIds: [input.smallestTextId] } : {}),
    })
  }
  if (input.minStrokePt !== undefined && input.minStrokePt < 0.5) {
    issues.push({
      gate: 'final-size-stroke-minimum',
      severity: 'hard',
      detail: `stroke ${input.minStrokePt}pt vanishes at final size (floor 0.5pt)`,
    })
  }
  return issues
}
