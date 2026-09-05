/**
 * RENDER-P0-01/02: composite-module fit enters the SOLVER, not the renderer.
 * A module the composer decomposed into visual units must receive a solved
 * box tall enough for those units — the renderer consumes placements
 * verbatim and hard-fails on shortfall instead of inflating geometry.
 */
import { describe, expect, it } from 'vitest'
import { solveGeometry, type SolveInput } from '../src/constraints/solver.js'
import type { SpatialPlan } from '../src/composition/spatial-plan.js'
import {
  minimumHeightForUnits,
  minimumWidthForUnits,
  layoutMicro,
} from '../src/visual/microLayout.js'
import type { MajorModuleVisual } from '../src/visual/visualPlan.js'
import type { MeasuredNode } from '../src/measurement/measure.js'

function planWith(id: string, box: { x: number; y: number; w: number; h: number }): SpatialPlan {
  return {
    composition: {
      readingFlow: 'LR',
      balance: 'loosely-balanced',
      density: 'medium',
      whitespaceStrategy: 'balanced',
    },
    placements: [{ id, boxHint: box, visualRole: 'dominant' }],
  }
}

const module: MajorModuleVisual = {
  moduleId: 'core',
  microLayout: 'rows',
  units: [
    { id: 'u1', label: '注意', role: 'substep' },
    { id: 'u2', label: '理解', role: 'substep' },
    { id: 'u3', label: '冲突', role: 'substep' },
  ],
}

function measuredNode(id: string): MeasuredNode {
  return {
    id,
    title: id,
    titleLines: 1,
    detailLines: 0,
    bounds: {
      minWidth: 120,
      preferredWidth: 200,
      maxWidth: 320,
      minHeight: 52,
      preferredHeight: 70,
      maxHeight: 150,
    },
  }
}

describe('composite fit constraints in the solver', () => {
  it('reserves the unit-fit height even when the boxHint is small', () => {
    const fit = new Map([
      [
        'core',
        {
          minHeightForWidth: (w: number) => minimumHeightForUnits(module, Math.max(60, w - 8)),
          minWidth: minimumWidthForUnits(module),
        },
      ],
    ])
    const input: SolveInput = {
      plan: planWith('core', { x: 0.1, y: 0.1, w: 0.2, h: 0.15 }),
      measured: [measuredNode('core')],
      canvasW: 1280,
      canvasH: 720,
      unitFitConstraints: fit,
    }
    const result = solveGeometry(input)
    const placement = result.placements[0]!
    const needed = minimumHeightForUnits(module, Math.max(60, placement.w - 8))
    // rows layout with 3 units at min unit height 42 + header
    expect(needed).toBeGreaterThanOrEqual(42 * 3 + 24)
    expect(placement.h).toBeGreaterThanOrEqual(needed)
    // micro layout of the FINAL box fits inside it — no renderer inflation needed
    const micro = layoutMicro(
      [module],
      new Map([['core', { x: placement.x, y: placement.y, w: placement.w, h: placement.h }]]),
    )
    for (const unit of micro.units) {
      expect(unit.y + unit.h).toBeLessThanOrEqual(placement.y + placement.h + 0.5)
    }
  })

  it('without constraints the short box stays short (documents the old failure mode)', () => {
    const input: SolveInput = {
      plan: planWith('core', { x: 0.1, y: 0.1, w: 0.2, h: 0.15 }),
      measured: [measuredNode('core')],
      canvasW: 1280,
      canvasH: 720,
    }
    const result = solveGeometry(input)
    const placement = result.placements[0]!
    expect(placement.h).toBeLessThan(minimumHeightForUnits(module, Math.max(60, placement.w - 8)))
  })
})
