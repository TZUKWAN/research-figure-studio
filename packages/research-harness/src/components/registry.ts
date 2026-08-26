/**
 * ResearchComponentRegistry — code-level spec of every research figure component.
 *
 * Layer contract (see docs/2026-08-26-genoffice-slides-refactor-map.md §3):
 *   HARNESS decides  "this slot needs a mechanism-module"
 *   THIS registry decides  "what a mechanism-module looks like and how it behaves"
 *
 * All sizes are fractions (0..1) of the slide canvas so a figure re-flows when
 * the canvas size changes (set_slide_size). Font sizes are absolute points.
 */

export interface ConnectorAnchors {
  top: boolean
  bottom: boolean
  left: boolean
  right: boolean
}

export interface ComponentSpec {
  /** registry key, e.g. 'process-node' */
  kind: string
  /** OOXML preset geometry for the body shape */
  preset: string
  /** default size as fractions of canvas width/height */
  wFrac: number
  hFrac: number
  /** minimum absolute size in px (never render smaller) */
  minWpx: number
  minHpx: number
  /** inner padding as fractions of the element's own box */
  paddingXFrac: number
  paddingYFrac: number
  titleFontPt: number
  bodyFontPt: number
  /** corner radius in px at a 1280px reference width */
  radiusPx: number
  /** stroke width in points; 0 = borderless */
  strokeWidthPt: number
  /** theme tokens this component may bind to (role names resolved by Theme Engine) */
  allowedTokens: readonly string[]
  /** which sides accept connector endpoints */
  anchors: ConnectorAnchors
  /** rough text capacity: max characters before the spec must grow or shrink font */
  textCapacity: number
}

const ALL_SIDES: ConnectorAnchors = { top: true, bottom: true, left: true, right: true }
const LR_ONLY: ConnectorAnchors = { top: false, bottom: false, left: true, right: true }

function spec(partial: Partial<ComponentSpec> & { kind: string }): ComponentSpec {
  return {
    preset: 'roundRect',
    wFrac: 0.16,
    hFrac: 0.12,
    minWpx: 96,
    minHpx: 56,
    paddingXFrac: 0.08,
    paddingYFrac: 0.1,
    titleFontPt: 13,
    bodyFontPt: 10.5,
    radiusPx: 10,
    strokeWidthPt: 1.25,
    allowedTokens: ['primary', 'secondary', 'accent', 'surface', 'border'],
    anchors: ALL_SIDES,
    textCapacity: 40,
    ...partial,
  }
}

export const RESEARCH_COMPONENT_REGISTRY: ReadonlyMap<string, ComponentSpec> = new Map(
  (
    [
      { kind: 'data-source', preset: 'roundRect', anchors: LR_ONLY },
      { kind: 'input-node', preset: 'roundRect' },
      {
        kind: 'process-node',
        preset: 'roundRect',
        wFrac: 0.15,
        hFrac: 0.11,
      },
      {
        kind: 'model-module',
        preset: 'roundRect',
        wFrac: 0.2,
        hFrac: 0.16,
        titleFontPt: 14,
        textCapacity: 60,
      },
      {
        kind: 'mechanism-module',
        preset: 'roundRect',
        wFrac: 0.22,
        hFrac: 0.18,
        titleFontPt: 14,
        textCapacity: 80,
      },
      { kind: 'output-node', preset: 'roundRect', anchors: LR_ONLY },
      { kind: 'evidence-node', preset: 'roundRect', hFrac: 0.1, textCapacity: 30 },
      {
        kind: 'annotation',
        preset: 'rect',
        wFrac: 0.12,
        hFrac: 0.06,
        titleFontPt: 10,
        bodyFontPt: 9,
        strokeWidthPt: 0,
        anchors: { top: false, bottom: false, left: false, right: false },
        textCapacity: 60,
      },
      {
        kind: 'section-container',
        preset: 'roundRect',
        wFrac: 0.46,
        hFrac: 0.62,
        titleFontPt: 12,
        strokeWidthPt: 1,
        anchors: { top: true, bottom: true, left: true, right: true },
        textCapacity: 24,
      },
    ] as Array<Partial<ComponentSpec> & { kind: string }>
  ).map((s) => [s.kind, spec(s)]),
)

export function getComponentSpec(kind: string): ComponentSpec {
  const found = RESEARCH_COMPONENT_REGISTRY.get(kind)
  if (!found) throw new Error(`Unknown research component kind: ${kind}`)
  return found
}

/** Resolve a spec against an actual canvas, honoring minimum sizes. */
export function resolveSize(
  specKind: string,
  canvasW: number,
  canvasH: number,
): { w: number; h: number } {
  const s = getComponentSpec(specKind)
  return {
    w: Math.max(s.minWpx, Math.round(s.wFrac * canvasW)),
    h: Math.max(s.minHpx, Math.round(s.hFrac * canvasH)),
  }
}
