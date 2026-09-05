import { describe, expect, it } from 'vitest'
import {
  segmentContact,
  segmentsProperlyIntersect,
  segmentIntersectsRect,
  type Rect,
  type Segment,
} from '../src/routing/geometry.js'
import { directionalProgressById, isReadingFlow } from '../src/critic/reading-flow.js'
import { RELATION_SEMANTICS } from '../src/semantic/relation-semantics.js'
import { RELATION_TYPES } from '../src/semantic/schema.js'
import { relationDefault } from './helpers/relation-defaults.js'
import { familyProfileFor, fillScore } from '../src/critic/family-quality.js'
import { routeNaturalness } from '../src/critic/route-naturalness.js'
import type { RoutedEdge, AnchorSide } from '../src/routing/router.js'

describe('QA-P0-08: segment contact classification', () => {
  it('an elbow joint of one route is a legal endpoint touch, not a crossing', () => {
    const s1: Segment = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
    const s2: Segment = { a: { x: 100, y: 0 }, b: { x: 100, y: 80 } }
    expect(segmentContact(s1, s2)).toBe('endpoint-touch')
    expect(segmentsProperlyIntersect(s1, s2)).toBe(false)
  })

  it('a proper interior crossing is classified as cross', () => {
    const s1: Segment = { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }
    const s2: Segment = { a: { x: 0, y: 100 }, b: { x: 100, y: 0 } }
    expect(segmentContact(s1, s2)).toBe('cross')
  })

  it('collinear overlap is distinct from crossing (lane sharing)', () => {
    const s1: Segment = { a: { x: 0, y: 50 }, b: { x: 100, y: 50 } }
    const s2: Segment = { a: { x: 50, y: 50 }, b: { x: 150, y: 50 } }
    expect(segmentContact(s1, s2)).toBe('collinear-overlap')
  })

  it('parallel disjoint segments do not touch', () => {
    const s1: Segment = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }
    const s2: Segment = { a: { x: 0, y: 12 }, b: { x: 100, y: 12 } }
    expect(segmentContact(s1, s2)).toBe('none')
  })
})

describe('QA-P0-09: robust segment-vs-rectangle (Liang-Barsky)', () => {
  const rect: Rect = { x: 100, y: 100, w: 100, h: 50 }

  it('counts a segment crossing the rect interior', () => {
    expect(segmentIntersectsRect({ a: { x: 50, y: 125 }, b: { x: 250, y: 125 } }, rect)).toBe(true)
  })

  it('counts a segment fully inside the rect (diagonal proxy missed this)', () => {
    expect(segmentIntersectsRect({ a: { x: 110, y: 110 }, b: { x: 190, y: 140 } }, rect)).toBe(true)
  })

  it('a segment passing at a corner misses only when truly outside', () => {
    expect(segmentIntersectsRect({ a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, rect, 0)).toBe(true)
  })

  it('tangent contact within tolerance is NOT an intersection', () => {
    const touching: Segment = { a: { x: 50, y: 100 }, b: { x: 250, y: 100 } } // lies on the top edge
    expect(segmentIntersectsRect(touching, rect, 1)).toBe(false)
    expect(segmentIntersectsRect(touching, rect, 0)).toBe(true)
  })

  it('a segment above the rect never intersects regardless of tolerance', () => {
    expect(segmentIntersectsRect({ a: { x: 0, y: 50 }, b: { x: 250, y: 50 } }, rect, 1)).toBe(false)
  })

  it('vertical segments are judged exactly like horizontal ones', () => {
    expect(segmentIntersectsRect({ a: { x: 150, y: 20 }, b: { x: 150, y: 200 } }, rect)).toBe(true)
    expect(segmentIntersectsRect({ a: { x: 150, y: 0 }, b: { x: 150, y: 99 } }, rect, 1)).toBe(
      false,
    )
  })
})

describe('QA-P0-04/05: directional progress across reading flows', () => {
  const canvas = { w: 1000, h: 800 }
  const rect = (x: number, y: number): Rect => ({ x, y, w: 100, h: 60 })
  const rects = new Map<string, Rect>([
    ['a', rect(100, 300)],
    ['b', rect(600, 300)],
    ['c', rect(300, 100)],
    ['d', rect(300, 600)],
  ])

  it('LR rewards rightward progress', () => {
    expect(directionalProgressById('LR', 'a', 'b', rects, canvas)).toBeGreaterThan(0)
    expect(directionalProgressById('LR', 'b', 'a', rects, canvas)).toBeLessThan(0)
  })

  it('RL rewards leftward progress', () => {
    expect(directionalProgressById('RL', 'b', 'a', rects, canvas)).toBeGreaterThan(0)
    expect(directionalProgressById('RL', 'a', 'b', rects, canvas)).toBeLessThan(0)
  })

  it('TB rewards downward progress', () => {
    expect(directionalProgressById('TB', 'c', 'd', rects, canvas)).toBeGreaterThan(0)
    expect(directionalProgressById('TB', 'd', 'c', rects, canvas)).toBeLessThan(0)
  })

  it('BT rewards upward progress', () => {
    expect(directionalProgressById('BT', 'd', 'c', rects, canvas)).toBeGreaterThan(0)
  })

  it('radial rewards outward movement from the declared visual center', () => {
    const inner: Rect = { x: 440, y: 340, w: 120, h: 80 }
    const outer: Rect = { x: 800, y: 340, w: 120, h: 80 }
    const withCenter = new Map([...rects, ['core', inner], ['out', outer]])
    expect(
      directionalProgressById('radial', 'core', 'out', withCenter, canvas, {
        visualCenterId: 'core',
      }),
    ).toBeGreaterThan(0)
    expect(
      directionalProgressById('radial', 'out', 'core', withCenter, canvas, {
        visualCenterId: 'core',
      }),
    ).toBeLessThan(0)
  })

  it('mixed uses the declared readingPath order', () => {
    const path = new Map([
      ['c', 1],
      ['a', 2],
      ['d', 3],
    ])
    expect(directionalProgressById('mixed', 'c', 'a', rects, canvas, { pathPositions: path })).toBe(
      100,
    )
    expect(directionalProgressById('mixed', 'a', 'c', rects, canvas, { pathPositions: path })).toBe(
      -100,
    )
  })

  it('flow validation rejects unknown flows', () => {
    expect(isReadingFlow('TB')).toBe(true)
    expect(isReadingFlow('diagonal')).toBe(false)
  })
})

describe('QA-P0-06: RELATION_SEMANTICS single source of truth', () => {
  it('covers the entire relation vocabulary', () => {
    for (const relation of RELATION_TYPES) {
      expect(RELATION_SEMANTICS[relation]).toBeDefined()
    }
  })

  it('feedback/inhibition carry negative/regulatory polarity, causal positive', () => {
    expect(RELATION_SEMANTICS.inhibition.polarity).toBe('negative')
    expect(RELATION_SEMANTICS.feedback.polarity).toBe('regulatory')
    expect(RELATION_SEMANTICS.causal.polarity).toBe('positive')
  })

  it('association-like relations never demand flow monotonicity', () => {
    for (const relation of ['association', 'mapping', 'bidirectional'] as const) {
      expect(RELATION_SEMANTICS[relation].monotonicAlongFlow).toBe(false)
      expect(RELATION_SEMANTICS[relation].directional).toBe(false)
    }
  })

  it('default presentations agree with the schema fallback table', () => {
    for (const relation of RELATION_TYPES) {
      expect(RELATION_SEMANTICS[relation].defaultPresentation).toBe(relationDefault(relation))
    }
  })
})

describe('QA-P0-02: FamilyQualityProfile replaces the universal 0.15 fill', () => {
  it('families declare materially different fill bands', () => {
    const ga = familyProfileFor('graphical-abstract')
    const statement = familyProfileFor('freeform')
    expect(ga.targetFillRange[0]).toBeGreaterThan(statement.targetFillRange[0])
    expect(ga.idealFill).toBeGreaterThan(statement.idealFill)
  })

  it('the same fill scores differently per family', () => {
    const fill = 0.5
    const ga = fillScore(fill, familyProfileFor('graphical-abstract'))
    const timeline = fillScore(fill, familyProfileFor('timeline'))
    expect(ga).toBeGreaterThan(timeline)
  })

  it('unknown families fall back to the freeform profile instead of throwing', () => {
    expect(familyProfileFor('nonexistent').idealFill).toBe(familyProfileFor('freeform').idealFill)
  })
})

describe('QA-P0-10: orientation-free route naturalness', () => {
  const route = (
    start: AnchorSide,
    end: AnchorSide,
    kind: 'straight' | 'elbow' = 'elbow',
  ): RoutedEdge => ({
    key: 'e1',
    fromId: 'a',
    toId: 'b',
    role: 'main',
    relation: 'process',
    status: 'routed',
    kind,
    start: { side: start, idx: 0 },
    end: { side: end, idx: 0 },
    laneOffsetPx: 0,
  })

  it('a TB route entering from the top is natural without any LR assumption', () => {
    const from = { x: 400, y: 100, w: 120, h: 60 }
    const to = { x: 400, y: 400, w: 120, h: 60 }
    const segments = [{ a: { x: 460, y: 160 }, b: { x: 460, y: 400 } }]
    const verdict = routeNaturalness(route('bottom', 'top', 'straight'), segments, from, to)
    expect(verdict.score).toBeGreaterThanOrEqual(8.5)
  })

  it('the mirrored RL case scores the same as the LR case (symmetry)', () => {
    const lrFrom = { x: 100, y: 300, w: 120, h: 60 }
    const lrTo = { x: 700, y: 300, w: 120, h: 60 }
    const lrSegs = [{ a: { x: 220, y: 330 }, b: { x: 700, y: 330 } }]
    const rlFrom = { x: 1180, y: 300, w: 120, h: 60 }
    const rlTo = { x: 180, y: 300, w: 120, h: 60 }
    const rlSegs = [{ a: { x: 1180, y: 330 }, b: { x: 180, y: 330 } }]
    const lr = routeNaturalness(route('right', 'left', 'straight'), lrSegs, lrFrom, lrTo)
    const rl = routeNaturalness(route('left', 'right', 'straight'), rlSegs, rlFrom, rlTo)
    expect(lr.score).toBe(rl.score)
  })

  it('a route leaving against the flow direction is penalized', () => {
    const from = { x: 100, y: 300, w: 120, h: 60 }
    const to = { x: 700, y: 300, w: 120, h: 60 }
    const segments = [
      { a: { x: 220, y: 330 }, b: { x: 50, y: 330 } },
      { a: { x: 50, y: 330 }, b: { x: 50, y: 500 } },
      { a: { x: 50, y: 500 }, b: { x: 700, y: 500 } },
    ]
    const verdict = routeNaturalness(route('right', 'left'), segments, from, to)
    expect(verdict.issues).toContain('exit-side')
    expect(verdict.issues).toContain('entry-side')
    expect(verdict.score).toBeLessThan(9)
  })

  it('a long detour is penalized', () => {
    const from = { x: 100, y: 300, w: 120, h: 60 }
    const to = { x: 400, y: 300, w: 120, h: 60 }
    const segments = [
      { a: { x: 220, y: 330 }, b: { x: 220, y: 700 } },
      { a: { x: 220, y: 700 }, b: { x: 460, y: 700 } },
      { a: { x: 460, y: 700 }, b: { x: 460, y: 360 } },
    ]
    const verdict = routeNaturalness(route('bottom', 'top'), segments, from, to)
    expect(verdict.issues).toContain('detour')
  })
})
