/**
 * Runtime Capability Contract (AI-P0-05).
 *
 * The prompts and machine schemas may only declare what the native renderer
 * actually realizes. This module is the single source of that truth: the
 * capability set is declared HERE, the prompt/schema generators read it, and
 * the orchestrator downgrades stale model output that names an unrealized
 * presentation. A capability the renderer does not draw can therefore never
 * reach the model through the protocol layer.
 */
import type { RelationPresentation } from '../semantic/schema.js'
import { FAMILY_STRATEGIES } from '../composition/family-strategy.js'
import type { MicroLayout, ShapeKind } from '../visual/visualPlan.js'

/** What the native writer can draw today, and how each presentation is realized. */
export interface ResearchRuntimeCapabilities {
  /** presentations realized as a routed connector with a distinct visual */
  connectorPresentations: readonly RelationPresentation[]
  /** presentations realized through placement/grouping (no line is drawn) */
  spatialPresentations: readonly RelationPresentation[]
  /** presentations the model may declare = connector ∪ spatial */
  declarablePresentations: readonly RelationPresentation[]
  microLayouts: readonly MicroLayout[]
  visualUnitShapes: readonly ShapeKind[]
  figureFamilies: readonly string[]
  /** declared families this runtime can NOT compose (typed error if forced) */
  unsupportedFigureFamilies: readonly string[]
  domains: readonly string[]
  outputContexts: readonly string[]
  /** vision critic availability (model-dependent; flipped off per capability profile) */
  supportsVisionCritic: boolean
  supportsHybridVector: boolean
}

/**
 * Presentations the renderer draws with a distinct visual TODAY
 * (slides-skill create_research_figure connector writer):
 * - inhibition → 2pt dashed line; dashed-arrow → sysDash; feedback-loop →
 *   bottom-lane routed connector; arrow/line → plain connectors.
 * `junction` has a routing data structure (routing/junction.ts) but NO
 * production dot renderer, so it stays out of the declarable set until the
 * writer draws the dot.
 * containment/proximity/alignment/annotation are realized spatially
 * (placement/grouping), which the orchestrator records as suppressed lines.
 */
export const RENDERER_CONNECTOR_PRESENTATIONS: readonly RelationPresentation[] = [
  'arrow',
  'line',
  'dashed-arrow',
  'inhibition',
  'feedback-loop',
]

export const RENDERER_SPATIAL_PRESENTATIONS: readonly RelationPresentation[] = [
  'containment',
  'proximity',
  'alignment',
  'annotation',
]

export const RENDERER_MICRO_LAYOUTS: readonly MicroLayout[] = [
  'flow',
  'chips',
  'grid',
  'rows',
  'parallel',
  'subnodes',
  'free',
]

export const RENDERER_VISUAL_UNIT_SHAPES: readonly ShapeKind[] = [
  'roundedRect',
  'rect',
  'parallelogram',
  'circle',
  'ellipse',
  'pentagon',
  'hexagon',
  'diamond',
]

// ── P0-3: family support is DERIVED from the strategy implementation ──

function supportedFigureFamilies(): readonly string[] {
  return Object.values(FAMILY_STRATEGIES)
    .filter(
      (strategy) =>
        !(strategy.eligibleGrammars.length === 0 && strategy.fallbackPolicy === 'strict'),
    )
    .map((strategy) => strategy.family)
}

function unsupportedFigureFamilies(): readonly string[] {
  const supported = new Set(supportedFigureFamilies())
  return Object.keys(FAMILY_STRATEGIES).filter((family) => !supported.has(family))
}

export function runtimeCapabilities(
  overrides: Partial<ResearchRuntimeCapabilities> = {},
): ResearchRuntimeCapabilities {
  const connectorPresentations =
    overrides.connectorPresentations ?? RENDERER_CONNECTOR_PRESENTATIONS
  const spatialPresentations = overrides.spatialPresentations ?? RENDERER_SPATIAL_PRESENTATIONS
  return {
    connectorPresentations,
    spatialPresentations,
    declarablePresentations: [...connectorPresentations, ...spatialPresentations],
    microLayouts: overrides.microLayouts ?? RENDERER_MICRO_LAYOUTS,
    visualUnitShapes: overrides.visualUnitShapes ?? RENDERER_VISUAL_UNIT_SHAPES,
    // P0-3: derived from the IMPLEMENTATION (family-strategy table) — a family
    // is "supported" iff its strategy can compose at least one grammar; an
    // empty eligible set with a strict fallback means a forced run throws
    // UnsupportedFigureFamilyError, so it is reported as unsupported instead
    // of being promised to the model.
    figureFamilies: overrides.figureFamilies ?? supportedFigureFamilies(),
    unsupportedFigureFamilies: overrides.unsupportedFigureFamilies ?? unsupportedFigureFamilies(),
    domains: overrides.domains ?? [
      'general',
      'cs-ml',
      'materials-chemistry',
      'biomed',
      'engineering',
      'social-science',
    ],
    outputContexts: overrides.outputContexts ?? [
      'presentation',
      'paper-single-column',
      'paper-double-column',
      'full-page-paper',
      'thesis',
      'poster',
      'web',
    ],
    supportsVisionCritic: overrides.supportsVisionCritic ?? false,
    supportsHybridVector: overrides.supportsHybridVector ?? false,
  }
}

/** Default contract: what this build of the native renderer realizes. */
export const RUNTIME_CAPABILITIES: ResearchRuntimeCapabilities = runtimeCapabilities()

/** True when the model may declare this presentation. */
export function isDeclarablePresentation(
  presentation: string,
  capabilities: ResearchRuntimeCapabilities = RUNTIME_CAPABILITIES,
): boolean {
  return (capabilities.declarablePresentations as readonly string[]).includes(presentation)
}

/**
 * Downgrade decision for a stale/unsupported model-declared presentation
 * (e.g. `junction` from a model that saw an older prompt): return the fallback
 * presentation the renderer CAN realize, or null when the input was already fine.
 */
export function downgradePresentation(
  presentation: string,
  capabilities: ResearchRuntimeCapabilities = RUNTIME_CAPABILITIES,
): { fallback: RelationPresentation; reason: string } | null {
  if (isDeclarablePresentation(presentation, capabilities)) return null
  return {
    fallback: 'arrow',
    reason: `presentation "${presentation}" is not realized by this renderer; downgraded to arrow`,
  }
}
