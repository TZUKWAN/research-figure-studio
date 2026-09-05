/**
 * RENDER-P0-04 registry coverage + render spec compilation.
 * The Component Registry must be a REAL renderer source of truth: every
 * runtime field is consumed by the compiled spec or honestly declared
 * documentation-only — a "fake config" table fails this test.
 */
import { describe, expect, it } from 'vitest'
import { RESEARCH_COMPONENT_REGISTRY } from '@genoffice/research-harness'
import { getThemeById, resolveComponentColors } from '@genoffice/theme-engine'
import {
  compileComponentRenderSpec,
  connectorStyleFor,
  resolveDetailDisposition,
  roundRectAdjust,
  validateAnchorSide,
  CONSUMED_REGISTRY_FIELDS,
  DOCUMENTATION_ONLY_REGISTRY_FIELDS,
} from '../src/renderer/research/render-spec'

const theme = getThemeById('academic-blue')!

describe('component registry coverage (P0-04)', () => {
  it('every ComponentSpec field is consumed XOR documentation-only, never both', () => {
    const consumed = new Set<string>(CONSUMED_REGISTRY_FIELDS)
    const documented = new Set<string>(Object.keys(DOCUMENTATION_ONLY_REGISTRY_FIELDS))
    const specFields = new Set([
      'kind',
      'preset',
      'wFrac',
      'hFrac',
      'minWpx',
      'minHpx',
      'paddingXFrac',
      'paddingYFrac',
      'titleFontPt',
      'bodyFontPt',
      'radiusPx',
      'strokeWidthPt',
      'allowedTokens',
      'anchors',
      'textCapacity',
    ])
    for (const field of specFields) {
      expect(
        consumed.has(field) || documented.has(field),
        `field "${field}" is neither consumed nor documented`,
      ).toBe(true)
      expect(
        consumed.has(field) && documented.has(field),
        `field "${field}" is claimed by both lists`,
      ).toBe(false)
    }
    // documented entries point at a real authority
    for (const field of documented) {
      expect(DOCUMENTATION_ONLY_REGISTRY_FIELDS[field]?.length ?? 0).toBeGreaterThan(10)
    }
  })

  it('every registered kind compiles with registry-driven stroke/radius/anchors/capacity', () => {
    for (const [kind, spec] of RESEARCH_COMPONENT_REGISTRY) {
      const compiled = compileComponentRenderSpec({
        kind,
        style: { titleSizePt: 13, detailSizePt: 10.5, padX: 10, padY: 8 },
        placement: { x: 10, y: 20, w: 200, h: 100 },
        colors: resolveComponentColors(kind, theme.roles),
      })
      expect(compiled.preset).toBe(spec.preset)
      expect(compiled.strokeWidthPt).toBe(spec.strokeWidthPt)
      expect(compiled.radiusPx).toBe(spec.radiusPx)
      expect(compiled.anchors).toEqual(spec.anchors)
      expect(compiled.textCapacity).toBe(spec.textCapacity)
      // exact geometry passes through verbatim (P0-01)
      expect([compiled.x, compiled.y, compiled.w, compiled.h]).toEqual([10, 20, 200, 100])
      if (spec.preset === 'roundRect' && spec.radiusPx > 0) {
        expect(compiled.radiusPx).toBeGreaterThan(0)
      }
    }
  })

  it('scientific primitives keep their meaning-bearing presets', () => {
    const expected: Record<string, string> = {
      'data-store': 'can',
      'process-stage': 'chevron',
      'reaction-stage': 'homePlate',
      'material-layer': 'rect',
      tensor: 'parallelogram',
      condition: 'diamond',
      metric: 'pentagon',
      'model-layer': 'rect',
      device: 'flowChartPredefinedProcess',
      'timeline-marker': 'ellipse',
    }
    for (const [kind, preset] of Object.entries(expected)) {
      expect(getSpecPreset(kind)).toBe(preset)
    }
  })

  function getSpecPreset(kind: string): string {
    return RESEARCH_COMPONENT_REGISTRY.get(kind)!.preset
  }
})

describe('render spec helpers', () => {
  it('roundRectAdjust converts px radius to the OOXML adj value', () => {
    expect(roundRectAdjust(10, 200, 100)).toEqual({ adj: 10000 })
    expect(roundRectAdjust(0, 200, 100)).toBeUndefined()
    expect(roundRectAdjust(500, 100, 100)!.adj).toBeLessThanOrEqual(50000)
  })

  it('connector presentation styles come from one table (no inline branches)', () => {
    expect(connectorStyleFor('inhibition')).toEqual({ widthPt: 2, dash: 'dash' })
    expect(connectorStyleFor('dashed-arrow')).toEqual({ widthPt: 1.5, dash: 'sysDash' })
    expect(connectorStyleFor('arrow')).toEqual({ widthPt: 1.5 })
    expect(connectorStyleFor(undefined)).toEqual(connectorStyleFor('arrow'))
  })

  it('detail disposition is explicit for every content case (P0-05)', () => {
    expect(resolveDetailDisposition(undefined, true)).toBe('omitted-by-plan')
    expect(resolveDetailDisposition('  ', true)).toBe('omitted-by-plan')
    expect(resolveDetailDisposition('key detail', true)).toBe('promoted-to-units')
    expect(resolveDetailDisposition('key detail', false)).toBe('render-in-parent')
    expect(resolveDetailDisposition(undefined, false)).toBe('omitted-by-plan')
  })

  it('anchor sides validate against registry anchors (chevron is LR-only)', () => {
    const lrOnly = { top: false, bottom: false, left: true, right: true }
    expect(validateAnchorSide('left', lrOnly)).toEqual({ side: 'left', remapped: false })
    expect(validateAnchorSide('top', lrOnly)).toEqual({ side: 'left', remapped: true })
    const allSides = { top: true, bottom: true, left: true, right: true }
    expect(validateAnchorSide('bottom', allSides)).toEqual({ side: 'bottom', remapped: false })
  })
})
