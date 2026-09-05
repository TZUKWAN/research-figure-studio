/**
 * COMP-P0-01..08 / COMP-P1-07..09 — grammar-level edge cases:
 * mediation adjacency, parallel path decomposition, diverging terminals,
 * feedback corridor, role-driven moderators, tree cycle/forest guards,
 * prior-bias wiring, spine-driven main chain, radial core selection.
 */
import { describe, expect, it } from 'vitest'
import {
  candidateFromPrior,
  type FigureEdgesInput,
  type NodeMeta,
} from '../src/composition/candidate.js'
import { priorById } from '../src/composition/priors.js'
import { estimatorMeasurer, measureNode, type MeasuredNode } from '../src/measurement/measure.js'

const measurer = estimatorMeasurer()
const SPEC = {
  titleSizePt: 13,
  detailSizePt: 10.5,
  maxTitleLines: 2,
  maxDetailLines: 2,
  padX: 10,
  padY: 8,
  titleGapY: 4,
  lineHeight: 1.25,
  minWidth: 96,
  maxWidth: 300,
  minHeight: 52,
  maxHeight: 170,
}

function measure(ids: string[], importance: Record<string, number> = {}): MeasuredNode[] {
  return ids.map((id) => ({
    ...measureNode({ id, title: id }, SPEC, measurer),
  }))
}

function metaOf(
  ids: string[],
  importance: Record<string, number>,
  role: Record<string, string> = {},
): Map<string, NodeMeta> {
  return new Map(
    ids.map((id) => [
      id,
      { importance: importance[id] ?? 0.5, ...(role[id] ? { role: role[id] } : {}) },
    ]),
  )
}

const center = (placement: { boxHint: { x: number; y: number; w: number; h: number } }) => ({
  x: placement.boxHint.x + placement.boxHint.w / 2,
  y: placement.boxHint.y + placement.boxHint.h / 2,
})

describe('COMP-P0-01: mediation resolves X→M→Y from REAL adjacency', () => {
  const ids = ['x', 'm', 'a1', 'a2', 'y']
  // M has TWO successors: the true outcome y (a sink) and a1 (which flows on
  // to a2). y is deliberately NOT the lexicographically first candidate.
  const edges: FigureEdgesInput[] = [
    { id: 'e1', from: 'x', to: 'm', role: 'main', relation: 'mediation' },
    { id: 'e2', from: 'm', to: 'a1', role: 'main', relation: 'causal' },
    { id: 'e3', from: 'a1', to: 'a2', role: 'main', relation: 'process' },
    { id: 'e4', from: 'm', to: 'y', role: 'main', relation: 'causal' },
  ]

  it('picks the true sink outcome Y, not the first node that is not X/M', () => {
    const prior = priorById('mediation')!
    const candidate = candidateFromPrior(
      prior,
      measure(ids),
      edges,
      1280,
      720,
      metaOf(ids, { y: 0.8 }),
    )
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const y = center(placements.get('y')!)
    const a1 = center(placements.get('a1')!)
    expect(y.x).toBeGreaterThan(0.7) // true outcome on the right pole
    expect(a1.x).toBeLessThan(y.x) // the decoy path never takes Y's slot
  })

  it('declines the grammar when no genuine mediation triple exists', () => {
    const prior = priorById('mediation')!
    // M has no successor → no Y → the grammar must DECLINE, not fake
    const deadEnd: FigureEdgesInput[] = [
      { id: 'e1', from: 'x', to: 'm', role: 'main', relation: 'mediation' },
    ]
    const candidate = candidateFromPrior(prior, measure(['x', 'm']), deadEnd, 1280, 720)
    expect(candidate).toBeNull()
  })
})

describe('COMP-P0-03: parallel tracks come from real paths, never round-robin', () => {
  const ids = ['input', 'a1', 'a2', 'b1', 'b2', 'c1', 'output']
  const edges: FigureEdgesInput[] = [
    { id: 'e0', from: 'input', to: 'a1', role: 'main', relation: 'process' },
    { id: 'e1', from: 'a1', to: 'a2', role: 'main', relation: 'process' },
    { id: 'e2', from: 'a2', to: 'output', role: 'main', relation: 'process' },
    { id: 'e3', from: 'input', to: 'b1', role: 'main', relation: 'process' },
    { id: 'e4', from: 'b1', to: 'b2', role: 'main', relation: 'process' },
    { id: 'e5', from: 'b2', to: 'output', role: 'main', relation: 'process' },
    { id: 'e6', from: 'input', to: 'c1', role: 'main', relation: 'process' },
    { id: 'e7', from: 'c1', to: 'output', role: 'main', relation: 'process' },
  ]

  it('keeps each path in ONE lane with shared anchors at the ends', () => {
    const prior = priorById('parallel-mechanisms')!
    const candidate = candidateFromPrior(prior, measure(ids), edges, 1280, 720)
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const laneOf = (id: string) => center(placements.get(id)!).y
    const xOf = (id: string) => center(placements.get(id)!).x
    const aLane = laneOf('a1')
    const bLane = laneOf('b1')
    const cLane = laneOf('c1')
    // path A stays in lane A — a2 is NOT thrown into another band
    expect(Math.abs(laneOf('a2') - aLane)).toBeLessThan(0.12)
    expect(Math.abs(laneOf('b2') - bLane)).toBeLessThan(0.12)
    // the three tracks are genuinely distinct bands
    expect(new Set([aLane, bLane, cLane]).size).toBe(3)
    // shared input/output anchors live OUTSIDE the track columns (anchored ends)
    const trackNodeXs = ['a1', 'a2', 'b1', 'b2', 'c1'].map(xOf)
    expect(xOf('input')).toBeLessThan(Math.min(...trackNodeXs))
    expect(xOf('output')).toBeGreaterThan(Math.max(...trackNodeXs))
  })

  it('declines when the graph has NO parallel structure (a chain is not tracks)', () => {
    const prior = priorById('parallel-mechanisms')!
    const chain: FigureEdgesInput[] = [
      { id: 'e0', from: 'a', to: 'b', role: 'main', relation: 'process' },
      { id: 'e1', from: 'b', to: 'c', role: 'main', relation: 'process' },
    ]
    const candidate = candidateFromPrior(prior, measure(['a', 'b', 'c']), chain, 1280, 720)
    expect(candidate).toBeNull()
  })
})

describe('COMP-P0-04: diverging distinguishes intermediates from terminal outputs', () => {
  const ids = ['source', 'i1', 'i2', 't1', 't2', 't3']
  const edges: FigureEdgesInput[] = [
    { id: 'e0', from: 'source', to: 'i1', role: 'main', relation: 'process' },
    { id: 'e1', from: 'source', to: 'i2', role: 'main', relation: 'process' },
    { id: 'e2', from: 'i1', to: 't1', role: 'main', relation: 'process' },
    { id: 'e3', from: 'i1', to: 't2', role: 'main', relation: 'process' },
    { id: 'e4', from: 'i2', to: 't3', role: 'main', relation: 'process' },
  ]

  it('only terminal sinks reach the right output column', () => {
    const prior = priorById('diverging-flow')!
    const candidate = candidateFromPrior(prior, measure(ids), edges, 1280, 720)
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const xOf = (id: string) => center(placements.get(id)!).x
    for (const terminal of ['t1', 't2', 't3']) {
      expect(xOf(terminal)).toBeGreaterThan(0.75)
    }
    // intermediates keep their layer columns — never pushed to the output edge
    for (const intermediate of ['i1', 'i2']) {
      expect(xOf(intermediate)).toBeLessThan(0.75)
    }
  })
})

describe('COMP-P0-05: feedback grammar reserves the corridor geometry', () => {
  const ids = ['a', 'b', 'c', 'd']
  const edges: FigureEdgesInput[] = [
    { id: 'e0', from: 'a', to: 'b', role: 'main', relation: 'process' },
    { id: 'e1', from: 'b', to: 'c', role: 'main', relation: 'process' },
    { id: 'e2', from: 'c', to: 'd', role: 'main', relation: 'process' },
    { id: 'f0', from: 'd', to: 'a', role: 'feedback', relation: 'feedback' },
  ]

  it('keeps the bottom band free for the feedback lane from the FIRST solve', () => {
    const prior = priorById('feedback-system')!
    const candidate = candidateFromPrior(prior, measure(ids), edges, 1280, 720)
    expect(candidate).not.toBeNull()
    for (const placement of candidate!.plan.placements) {
      const bottom = placement.boxHint.y + placement.boxHint.h
      // the peripheral corridor (bottom ~30% of the canvas) holds NO node
      expect(bottom).toBeLessThanOrEqual(0.75)
    }
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    // feedback endpoints sit at the chain extremities for clean lane entry
    const aX = center(placements.get('a')!).x
    const dX = center(placements.get('d')!).x
    expect(dX).toBeGreaterThan(aX)
  })
})

describe('COMP-P0-06: causal moderators are promoted by ROLE, not coordinates', () => {
  const ids = ['cause', 'effect', 'mod1', 'mod2', 'ctx']
  const edges: FigureEdgesInput[] = [
    { id: 'e0', from: 'cause', to: 'effect', role: 'main', relation: 'causal' },
    { id: 'e1', from: 'mod1', to: 'effect', role: 'main', relation: 'moderation' },
    { id: 'e2', from: 'mod2', to: 'effect', role: 'main', relation: 'moderation' },
  ]

  it('moderators float above the main band; context sinks below', () => {
    const prior = priorById('causal-framework')!
    const candidate = candidateFromPrior(
      prior,
      measure(ids),
      edges,
      1280,
      720,
      metaOf(ids, {}, { mod1: 'moderator', mod2: 'moderator', ctx: 'context' }),
    )
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const yOf = (id: string) => center(placements.get(id)!).y
    // moderators in the top band regardless of graph layer or id order
    expect(yOf('mod1')).toBeLessThan(0.25)
    expect(yOf('mod2')).toBeLessThan(0.25)
    // the main cause→effect pair runs in the main band
    expect(Math.abs(yOf('cause') - 0.45)).toBeLessThan(0.15)
    expect(Math.abs(yOf('effect') - 0.45)).toBeLessThan(0.15)
    // context below the band
    expect(yOf('ctx')).toBeGreaterThan(0.6)
  })
})

describe('COMP-P0-07/08: tree grammar cycle guard and forest support', () => {
  it('declines on a non-feedback cycle instead of recursing forever', () => {
    const prior = priorById('hierarchical-system')!
    const cyclic: FigureEdgesInput[] = [
      { id: 'e0', from: 'a', to: 'b', role: 'main', relation: 'hierarchy' },
      { id: 'e1', from: 'b', to: 'c', role: 'main', relation: 'hierarchy' },
      { id: 'e2', from: 'c', to: 'a', role: 'main', relation: 'hierarchy' },
      { id: 'e3', from: 'a', to: 'd', role: 'main', relation: 'hierarchy' },
    ]
    const candidate = candidateFromPrior(prior, measure(['a', 'b', 'c', 'd']), cyclic, 1280, 720)
    expect(candidate).toBeNull()
  })

  it('distributes a FOREST across the leaf span; islands get their own band', () => {
    const prior = priorById('hierarchical-system')!
    const ids = ['r1', 'r1a', 'r1b', 'r2', 'r2a', 'island']
    const forest: FigureEdgesInput[] = [
      { id: 'e0', from: 'r1', to: 'r1a', role: 'main', relation: 'hierarchy' },
      { id: 'e1', from: 'r1', to: 'r1b', role: 'main', relation: 'hierarchy' },
      { id: 'e2', from: 'r2', to: 'r2a', role: 'main', relation: 'hierarchy' },
    ]
    const candidate = candidateFromPrior(prior, measure(ids), forest, 1280, 720)
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const xOf = (id: string) => center(placements.get(id)!).x
    const yOf = (id: string) => center(placements.get(id)!).y
    // the two roots occupy different horizontal slots
    expect(Math.abs(xOf('r1') - xOf('r2'))).toBeGreaterThan(0.15)
    // leaves are not stacked on one default x
    expect(new Set([xOf('r1a'), xOf('r1b'), xOf('r2a')]).size).toBe(3)
    // the disconnected island lands in its own bottom band, not in the tree
    expect(yOf('island')).toBeGreaterThan(yOf('r1'))
  })
})

describe('COMP-P1-07: mutating prior config actually moves the layout', () => {
  it('mediation Y position follows defaultBias.y (clamped by allowedRange)', () => {
    const prior = priorById('mediation')!
    const ids = ['x', 'm', 'y']
    const edges: FigureEdgesInput[] = [
      { id: 'e1', from: 'x', to: 'm', role: 'main', relation: 'mediation' },
      { id: 'e2', from: 'm', to: 'y', role: 'main', relation: 'causal' },
    ]
    const base = candidateFromPrior(prior, measure(ids), edges, 1280, 720)
    const mutatedPrior = {
      ...prior,
      defaultBias: { ...prior.defaultBias, y: 0.84 },
    }
    const mutated = candidateFromPrior(mutatedPrior, measure(ids), edges, 1280, 720)
    expect(base).not.toBeNull()
    expect(mutated).not.toBeNull()
    const baseY = center(base!.plan.placements.find((p) => p.id === 'y')!).x
    const mutatedY = center(mutated!.plan.placements.find((p) => p.id === 'y')!).x
    expect(mutatedY).toBeLessThan(baseY)
  })
})

describe('COMP-P1-08: the declared spine wins the main chain, not lexicographic ids', () => {
  it('primary role follows narrative spine [c, d], not the a→b chain', () => {
    const prior = priorById('linear-process')!
    const ids = ['a', 'b', 'c', 'd']
    const edges: FigureEdgesInput[] = [
      { id: 'e0', from: 'a', to: 'b', role: 'main', relation: 'process' },
      { id: 'e1', from: 'c', to: 'd', role: 'main', relation: 'process' },
    ]
    const candidate = candidateFromPrior(prior, measure(ids), edges, 1280, 720, undefined, 0, {
      spine: ['c', 'd'],
    })
    expect(candidate).not.toBeNull()
    const roleOf = new Map(candidate!.plan.placements.map((p) => [p.id, p.visualRole]))
    expect(roleOf.get('c')).toBe('primary')
    expect(roleOf.get('d')).toBe('primary')
    expect(roleOf.get('a')).not.toBe('primary')
    expect(roleOf.get('b')).not.toBe('primary')
  })
})

describe('COMP-P1-09: radial core combines structure AND semantics', () => {
  it('a high-importance leaf does not steal the center from a structural hub', () => {
    const prior = priorById('core-periphery')!
    const ids = ['hub', 's1', 's2', 's3', 'star']
    const edges: FigureEdgesInput[] = [
      { id: 'e0', from: 's1', to: 'hub', role: 'main', relation: 'association' },
      { id: 'e1', from: 's2', to: 'hub', role: 'main', relation: 'association' },
      { id: 'e2', from: 'hub', to: 's3', role: 'main', relation: 'association' },
      { id: 'e3', from: 'hub', to: 'star', role: 'main', relation: 'association' },
    ]
    // 'star' has the HIGHEST importance but degree 1; hub has degree 4
    const candidate = candidateFromPrior(
      prior,
      measure(ids),
      edges,
      1280,
      720,
      metaOf(ids, { star: 0.95, hub: 0.5 }),
    )
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const hub = center(placements.get('hub')!)
    const star = center(placements.get('star')!)
    const radialDist = (p: { x: number; y: number }) => Math.hypot(p.x - 0.5, p.y - 0.45)
    expect(radialDist(hub)).toBeLessThan(radialDist(star))
  })

  it('the declared visualCenter wins the center outright', () => {
    const prior = priorById('core-periphery')!
    const ids = ['hub', 's1', 's2', 's3', 'star']
    const edges: FigureEdgesInput[] = [
      { id: 'e0', from: 's1', to: 'hub', role: 'main', relation: 'association' },
      { id: 'e1', from: 's2', to: 'hub', role: 'main', relation: 'association' },
      { id: 'e2', from: 'hub', to: 's3', role: 'main', relation: 'association' },
      { id: 'e3', from: 'hub', to: 'star', role: 'main', relation: 'association' },
    ]
    const candidate = candidateFromPrior(
      prior,
      measure(ids),
      edges,
      1280,
      720,
      metaOf(ids, { star: 0.95 }),
      0,
      { visualCenter: 'star' },
    )
    expect(candidate).not.toBeNull()
    const placements = new Map(candidate!.plan.placements.map((p) => [p.id, p]))
    const radialDist = (p: { x: number; y: number }) => Math.hypot(p.x - 0.5, p.y - 0.45)
    const star = radialDist(center(placements.get('star')!))
    const hub = radialDist(center(placements.get('hub')!))
    expect(star).toBeLessThan(hub)
  })
})
