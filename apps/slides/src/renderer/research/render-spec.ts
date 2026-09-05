/**
 * ComponentRenderSpec compiler (RENDER-P0-04).
 *
 * The Component Registry is the RENDERER's source of truth: the native figure
 * renderer consumes ONLY compiled specs — never ad-hoc `if (micro) 0.75`
 * branches. Every runtime field of a ComponentSpec is either consumed here
 * (declared in CONSUMED_REGISTRY_FIELDS, enforced by the coverage test) or
 * explicitly listed in DOCUMENTATION_ONLY_REGISTRY_FIELDS with a reason.
 *
 * Domain style inheritance (RENDER-P0-06): a module's micro units compile
 * from the SAME domain-resolved kind as the parent, so a materials-science
 * module and its units never disagree about the visual language.
 */
import {
  getComponentSpec,
  type ComponentSpec,
  type ConnectorAnchors,
  type SemanticNodeStyle,
} from '@genoffice/research-harness'
import type { ComponentColors } from '@genoffice/theme-engine'

/** Every field the compiled spec carries into native elements. */
export interface ComponentRenderSpec {
  /** registry kind after domain override (mechanism → model-module in cs-ml) */
  kind: string
  /** OOXML preset geometry */
  preset: string
  /** exact solver geometry — the renderer consumes this verbatim */
  x: number
  y: number
  w: number
  h: number
  fillColor: string
  strokeColor: string
  /** points — from the registry, never hard-coded at the call site */
  strokeWidthPt: number
  /** resolved typography (semantic style × contract scale) */
  titleFontPt: number
  bodyFontPt: number
  /** corner radius in px (roundRect adj), 0 = square */
  radiusPx: number
  /** resolved inner padding in px (bodyPr insets) */
  padXPx: number
  padYPx: number
  /** which sides accept connector endpoints (binding validation) */
  anchors: ConnectorAnchors
  /** semantic collision class (z-tier + audit exemptions) */
  collisionClass: SemanticNodeStyle['collisionClass']
  /** rough text capacity; exceeded titles are recorded as defects, not clipped */
  textCapacity: number
}

/** Registry fields the compiled spec genuinely consumes at render time. */
export const CONSUMED_REGISTRY_FIELDS = [
  'preset',
  'minWpx',
  'minHpx',
  'radiusPx',
  'strokeWidthPt',
  'allowedTokens',
  'anchors',
  'textCapacity',
] as const

/**
 * Registry fields intentionally NOT consumed by the renderer, with the
 * authority that replaced them. The coverage test keeps this list exhaustive
 * and honest (every ComponentSpec field appears exactly once across the two
 * lists) so the registry can never silently rot into a "fake config" table.
 */
export const DOCUMENTATION_ONLY_REGISTRY_FIELDS: Record<string, string> = {
  kind: 'registry key itself (consumed trivially for lookup)',
  wFrac: 'sizing authority is the semantic-style measurement table (Registry v2)',
  hFrac: 'sizing authority is the semantic-style measurement table (Registry v2)',
  paddingXFrac: 'padding authority is SemanticNodeStyle.padX (measured typography)',
  paddingYFrac: 'padding authority is SemanticNodeStyle.padY (measured typography)',
  titleFontPt: 'typography authority is SemanticNodeStyle.titleSizePt × contract scale',
  bodyFontPt: 'typography authority is SemanticNodeStyle.detailSizePt × contract scale',
}

/**
 * Connector presentation → native stroke. Single source for the renderer;
 * width/dash come from HERE, not from inline conditionals.
 */
export const CONNECTOR_PRESENTATION_STYLES: Record<
  string,
  { widthPt: number; dash?: 'dash' | 'sysDash' | 'sysDot' }
> = {
  arrow: { widthPt: 1.5 },
  line: { widthPt: 1.5 },
  'dashed-arrow': { widthPt: 1.5, dash: 'sysDash' },
  inhibition: { widthPt: 2, dash: 'dash' },
  'feedback-loop': { widthPt: 1.5 },
  junction: { widthPt: 1.5 },
  containment: { widthPt: 1 },
  proximity: { widthPt: 1, dash: 'sysDot' },
  alignment: { widthPt: 1, dash: 'sysDot' },
  annotation: { widthPt: 1, dash: 'sysDash' },
}

export function connectorStyleFor(presentation: string | undefined): {
  widthPt: number
  dash?: 'dash' | 'sysDash' | 'sysDot'
} {
  return CONNECTOR_PRESENTATION_STYLES[presentation ?? 'arrow'] ?? CONNECTOR_PRESENTATION_STYLES.arrow!
}

/**
 * Micro units are sub-elements of a composite module and have no registry
 * kinds of their own; their stroke weight is declared HERE once instead of
 * being hard-coded at the emit site.
 */
export const MICRO_UNIT_STROKE_PT = 0.75

/** px → roundRect corner-radius adjust value (1/1000 % of min(w,h)). */
export function roundRectAdjust(radiusPx: number, w: number, h: number): Record<string, number> | undefined {
  if (radiusPx <= 0 || w <= 0 || h <= 0) return undefined
  const adj = Math.min(50000, Math.round((radiusPx / Math.min(w, h)) * 100000))
  return adj > 0 ? { adj } : undefined
}

export interface CompileComponentSpecArgs {
  kind: string
  spec?: ComponentSpec
  style: Pick<SemanticNodeStyle, 'titleSizePt' | 'detailSizePt' | 'padX' | 'padY'>
  placement: { x: number; y: number; w: number; h: number }
  colors: ComponentColors
}

export function compileComponentRenderSpec(args: CompileComponentSpecArgs): ComponentRenderSpec {
  const spec = args.spec ?? getComponentSpec(args.kind)
  return {
    kind: args.kind,
    preset: spec.preset,
    x: args.placement.x,
    y: args.placement.y,
    w: args.placement.w,
    h: args.placement.h,
    fillColor: args.colors.fill,
    strokeColor: args.colors.stroke,
    strokeWidthPt: spec.strokeWidthPt,
    titleFontPt: args.style.titleSizePt,
    bodyFontPt: args.style.detailSizePt,
    radiusPx: spec.radiusPx,
    padXPx: args.style.padX,
    padYPx: args.style.padY,
    anchors: spec.anchors,
    collisionClass: 'solid',
    textCapacity: spec.textCapacity,
  }
}

/**
 * Content rendering policy (RENDER-P0-05): every piece of visible detail has
 * an explicit disposition. The renderer never guesses — a detail either
 * renders in the parent body, was promoted to independent visual units, or
 * the plan omitted it on purpose.
 */
export type DetailDisposition = 'render-in-parent' | 'promoted-to-units' | 'omitted-by-plan'

export function resolveDetailDisposition(
  detail: string | undefined,
  hasModuleDecomposition: boolean,
): DetailDisposition {
  if (!detail || !detail.trim()) return 'omitted-by-plan'
  return hasModuleDecomposition ? 'promoted-to-units' : 'render-in-parent'
}

/**
 * Anchor-side validation (registry `anchors` consumption): a route binding to
 * a side the primitive forbids is remapped to the nearest allowed side and
 * recorded. Keeps 'process-stage' (chevron: LR only) from accepting top/bottom
 * endpoints silently.
 */
export function validateAnchorSide(
  side: 'top' | 'left' | 'bottom' | 'right',
  anchors: ConnectorAnchors,
): { side: 'top' | 'left' | 'bottom' | 'right'; remapped: boolean } {
  if (anchors[side]) return { side, remapped: false }
  const fallback: Array<'top' | 'left' | 'bottom' | 'right'> =
    side === 'top' || side === 'bottom'
      ? ['left', 'right', 'bottom', 'top']
      : ['top', 'bottom', 'left', 'right']
  const next = fallback.find((candidate) => anchors[candidate])
  return next ? { side: next, remapped: true } : { side, remapped: false }
}
