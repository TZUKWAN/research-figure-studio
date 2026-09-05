/**
 * Micro Layout engine. For each MajorModuleVisual it lays out its visualUnits
 * into a list of sub-rects INSIDE the module's outer box. Outer page
 * composition never sees these sub-units; the Router treats the parent box
 * as a single terminal for the macro edge network.
 *
 * Each unit's inner box contains its own title/detail. The page-level
 * connector engine routes only between macro boxes.
 */
import type { MajorModuleVisual, MicroLayout, VisualUnit } from './visualPlan.js'

export interface MicroRect {
  /** semantic id; matches VisualUnit.id or a derived micro-node id */
  id: string
  /** owning major-module semantic node id */
  moduleId: string
  /** label that will be drawn */
  label: string
  detail?: string
  role: VisualUnit['role']
  x: number
  y: number
  w: number
  h: number
  /** semantic link back to the parent graph (when this unit IS a child node) */
  semanticNodeId?: string
  /** semantic relationship represented by this unit, if it is relation-bound */
  semanticEdgeId?: string
  /** which side of a junction this unit sits on, if any */
  junctionSide?: 'left' | 'right' | 'top' | 'bottom' | 'center'
}

export interface MicroLayoutResult {
  /** map from moduleId → list of sub-rects inside it */
  units: MicroRect[]
  /** bounding box each module needs beyond its title row (px) */
  moduleExtraHeight: Map<string, number>
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Measure {
  /** visual measure for label height (px) — uses a conservative estimator */
  labelHeight: (label: string, maxW: number) => number
  unitHeight: (label: string, hasDetail: boolean, maxW: number) => number
  unitWidth: (label: string) => number
  /** padding around each unit cell */
  padX: number
  padY: number
  /** header reserved for the module's own title */
  headerHeight: number
}

const defaultMeasure: Measure = {
  labelHeight: (_label, _w) => 16,
  unitHeight: (label, hasDetail, _w) => (hasDetail ? 36 : 22),
  unitWidth: (label) => 18 + label.length * 7.2,
  padX: 6,
  padY: 4,
  headerHeight: 24,
}

const minimumVisualUnitHeight = 42

/**
 * Minimum parent module height required to fit the model-authored sub-units
 * when the module box is `innerWidth` px wide. This is the MEASUREMENT-side
 * authority: the solver must reserve at least this height for a module with
 * visual units, so the renderer can consume solver geometry verbatim instead
 * of inflating boxes after the fact.
 */
export function minimumHeightForUnits(
  module: Pick<MajorModuleVisual, 'units' | 'microLayout'>,
  innerWidth: number,
  measure: Measure = defaultMeasure,
): number {
  const nominal =
    measure.headerHeight + 2 + Math.max(0, innerHeightForUnits(module, measure, innerWidth))
  return nominal
}

/** Smallest box width that keeps the module's units one-per-row at worst. */
export function minimumWidthForUnits(
  module: Pick<MajorModuleVisual, 'units' | 'microLayout'>,
  measure: Measure = defaultMeasure,
): number {
  if (module.units.length === 0) return 0
  const widest = Math.max(...module.units.map((u) => measure.unitWidth(u.label) + measure.padX * 2))
  const gap = module.microLayout === 'flow' ? 8 : 4
  return Math.ceil(Math.min(widest + gap * (module.units.length - 1) + 8, widest * 2))
}

function innerHeightForUnits(
  module: Pick<MajorModuleVisual, 'units' | 'microLayout'>,
  measure: Measure,
  innerWidth = 800,
): number {
  const inner: Box = { x: 0, y: measure.headerHeight + 2, w: innerWidth, h: 10_000 }
  const rects = arrange(module.units, module.microLayout, inner, measure)
  return rects.reduce((acc, rect) => Math.max(acc, rect.y + rect.h), 0)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function arrange(
  units: VisualUnit[],
  layout: MicroLayout,
  container: Box,
  measure: Measure,
): MicroRect[] {
  if (units.length === 0) return []
  const innerW = Math.max(60, container.w)
  const x0 = container.x
  const y0 = container.y
  switch (layout) {
    case 'chips': {
      // free-flow wrapping, like a tag cloud
      const out: MicroRect[] = []
      let cursorX = x0
      let cursorY = y0
      let lineH = 0
      const padX = measure.padX
      const padY = measure.padY
      for (const u of units) {
        const w = clamp(measure.unitWidth(u.label) + padX * 2, 36, innerW * 0.6)
        const h = Math.max(
          minimumVisualUnitHeight,
          measure.unitHeight(u.label, false, w) + padY * 2,
        )
        if (cursorX + w > x0 + innerW) {
          cursorX = x0
          cursorY += lineH + 4
          lineH = 0
        }
        out.push({
          id: u.id,
          moduleId: '',
          label: u.label,
          role: u.role,
          x: cursorX,
          y: cursorY,
          w,
          h,
          ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
          ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
          ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
        })
        cursorX += w + 4
        lineH = Math.max(lineH, h)
      }
      return out
    }
    case 'rows': {
      // vertical stack; full width
      const rowH = Math.max(
        minimumVisualUnitHeight,
        measure.unitHeight('', true, innerW) + measure.padY * 2,
      )
      return units.map((u, i) => ({
        id: u.id,
        moduleId: '',
        label: u.label,
        ...(u.detail ? { detail: u.detail } : {}),
        role: u.role,
        x: x0,
        y: y0 + i * (rowH + 2),
        w: innerW,
        h: rowH,
        ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
        ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
      }))
    }
    case 'flow': {
      // horizontal sequence of compact boxes
      const gap = 8
      const cellW = clamp((innerW - gap * (units.length - 1)) / units.length, 60, innerW)
      const cellH = Math.max(
        minimumVisualUnitHeight,
        measure.unitHeight('', true, cellW) + measure.padY * 2,
      )
      return units.map((u, i) => ({
        id: u.id,
        moduleId: '',
        label: u.label,
        ...(u.detail ? { detail: u.detail } : {}),
        role: u.role,
        x: x0 + i * (cellW + gap),
        y: y0,
        w: cellW,
        h: cellH,
        ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
        ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
      }))
    }
    case 'parallel': {
      // vertical parallel lanes (equal width)
      const cellH = Math.max(
        minimumVisualUnitHeight,
        measure.unitHeight('', false, innerW) + measure.padY * 2,
      )
      return units.map((u, i) => ({
        id: u.id,
        moduleId: '',
        label: u.label,
        ...(u.detail ? { detail: u.detail } : {}),
        role: u.role,
        x: x0,
        y: y0 + i * (cellH + 4),
        w: innerW,
        h: cellH,
        ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
        ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
      }))
    }
    case 'grid': {
      // square-ish grid; auto columns
      const cols = Math.max(1, Math.ceil(Math.sqrt(units.length)))
      const rows = Math.ceil(units.length / cols)
      const cellW = clamp((innerW - 4 * (cols - 1)) / cols, 50, innerW)
      const cellH = Math.max(
        minimumVisualUnitHeight,
        measure.unitHeight('', true, cellW) + measure.padY * 2,
      )
      return units.map((u, i) => {
        const r = Math.floor(i / cols)
        const c = i % cols
        return {
          id: u.id,
          moduleId: '',
          label: u.label,
          ...(u.detail ? { detail: u.detail } : {}),
          role: u.role,
          x: x0 + c * (cellW + 4),
          y: y0 + r * (cellH + 4),
          w: cellW,
          h: cellH,
          ...(u.semanticNodeId ? { semanticNodeId: u.semanticNodeId } : {}),
          ...(u.semanticEdgeId ? { semanticEdgeId: u.semanticEdgeId } : {}),
        }
      })
    }
    case 'subnodes':
    case 'free':
    default: {
      // subnodes / free: treat as chips (so each becomes a visible element)
      return arrange(units, 'chips', container, measure)
    }
  }
}

/**
 * Lay out the visual units of every module into the space the macro solver
 * reserved for each module. Returns the full list of micro rects (one entry
 * per visualUnit) plus per-module "extra height above the title row".
 */
export function layoutMicro(
  modules: MajorModuleVisual[],
  moduleRects: Map<string, Box>,
  measure: Measure = defaultMeasure,
): MicroLayoutResult {
  const out: MicroRect[] = []
  const extraHeight = new Map<string, number>()
  for (const m of modules) {
    const outer = moduleRects.get(m.moduleId)
    if (!outer) continue
    const inner: Box = {
      x: outer.x + 4,
      y: outer.y + measure.headerHeight + 2,
      w: outer.w - 8,
      h: Math.max(0, outer.h - measure.headerHeight - 6),
    }
    const unclamped = arrange(m.units, m.microLayout, inner, measure)
    const maxY = unclamped.reduce((acc, rect) => Math.max(acc, rect.y + rect.h), 0)
    const availableBottom = inner.y + inner.h
    const lift = Math.max(0, maxY - availableBottom)
    const rects = unclamped.map((rect) => ({ ...rect, y: rect.y - lift }))
    for (const r of rects) {
      r.moduleId = m.moduleId
      out.push(r)
    }
    const used = rects.reduce((acc, r) => Math.max(acc, r.y + r.h), 0)
    const required = rects.length === 0 ? 0 : Math.max(0, used - inner.y)
    extraHeight.set(m.moduleId, required)
  }
  return { units: out, moduleExtraHeight: extraHeight }
}
