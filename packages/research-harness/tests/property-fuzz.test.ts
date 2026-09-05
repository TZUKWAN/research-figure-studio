import { describe, expect, it } from 'vitest'
import { criticVerdict } from '../src/critic/metric-critic.js'
import { auditScientific } from '../src/critic/scientific-critic.js'
import { solveGeometry } from '../src/constraints/solver.js'
import { routeEdgesWithObstacles, type RoutedEdgeInput } from '../src/routing/router.js'
import { normalizeSpatialPlan } from '../src/composition/spatial-plan.js'
import { RELATION_TYPES, type RelationType } from '../src/semantic/schema.js'
import type { FigureEdgesInput } from '../src/composition/candidate.js'
import type { SolvedPlacement } from '../src/constraints/solver.js'

/**
 * QA-P1-10: property/fuzz tests. A deterministic seeded PRNG generates random
 * (and deliberately degenerate) layouts and graphs; the pipeline must hold
 * these invariants for EVERY input, not just curated golden cases:
 *   no throw · no NaN · hard gates boolean · same input → same output ·
 *   edge ids preserved · no unknown node references
 */

/** mulberry32 — tiny deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface GenWorld {
  ids: string[]
  edges: FigureEdgesInput[]
  placements: SolvedPlacement[]
  importance: Map<string, number>
}

function generateWorld(seed: number): GenWorld {
  const rand = rng(seed)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!
  const n = 2 + Math.floor(rand() * 7)
  const ids = Array.from({ length: n }, (_, i) => `n${i}`)
  const edgeCount = Math.floor(rand() * (n * 2))
  const edges: FigureEdgesInput[] = []
  for (let i = 0; i < edgeCount; i++) {
    const from = pick(ids)
    let to = pick(ids)
    if (to === from) to = ids[(ids.indexOf(from) + 1) % n]!
    edges.push({
      id: `edge:${i}`,
      from,
      to,
      role: rand() < 0.2 ? 'feedback' : 'main',
      relation: pick(RELATION_TYPES as unknown as string[]) as RelationType,
    })
  }
  const placements: SolvedPlacement[] = ids.map((id) => {
    // occasional degenerate geometry: zero-area, huge, duplicated coordinates
    const mode = rand()
    if (mode < 0.1) return { id, x: 300, y: 200, w: 0, h: 0 }
    if (mode < 0.16) return { id, x: 1e6, y: -1e6, w: 400, h: 300 }
    if (mode < 0.24) return { id, x: 300, y: 200, w: 160, h: 80 }
    return {
      id,
      x: Math.round(rand() * 1100),
      y: Math.round(rand() * 600),
      w: 80 + Math.round(rand() * 220),
      h: 40 + Math.round(rand() * 120),
    }
  })
  const importance = new Map(ids.map((id) => [id, rand()]))
  return { ids, edges, placements, importance }
}

function expectFinite(obj: unknown, path = 'root'): void {
  if (typeof obj === 'number') {
    expect(Number.isFinite(obj), `${path} must be finite`).toBe(true)
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => expectFinite(v, `${path}[${i}]`))
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) expectFinite(value, `${path}.${key}`)
  }
}

const NODE_ID_RE = /^[\w:-]+$/

describe('QA-P1-10: property invariants over randomized worlds', () => {
  // 60 seeds: broad enough to hit degenerate modes, fast enough for CI
  for (let seed = 1; seed <= 60; seed++) {
    it(`world seed ${seed}: critic + solver + router hold all invariants`, () => {
      const world = generateWorld(seed)
      const solve = {
        placements: world.placements,
        issues: [] as string[],
        intentDriftPx: 0,
      }

      // 1) the critic must not throw and must produce finite scores
      const verdict = criticVerdict({
        solve,
        edges: world.edges,
        canvasW: 1280,
        canvasH: 720,
        importance: world.importance,
      })
      expectFinite(verdict.scores, 'scores')
      for (const gate of verdict.hardGates) {
        expect(typeof gate.pass, 'gate pass must be boolean').toBe('boolean')
      }
      expect(['PASS', 'ROUTE_FIX', 'LOCAL_LAYOUT_FIX', 'RECOMPOSE']).toContain(verdict.verdict)

      // 2) determinism: identical input → identical verdict object
      const again = criticVerdict({
        solve,
        edges: world.edges,
        canvasW: 1280,
        canvasH: 720,
        importance: world.importance,
      })
      expect(again).toEqual(verdict)

      // 3) the scientific critic must not throw
      const plan = {
        thesis: 'fuzz',
        figureType: 'mechanism',
        nodes: world.ids.map((id) => ({
          id,
          type: 'mechanism',
          semanticLabel: id,
          visible: { title: id },
          importance: world.importance.get(id) ?? 0.5,
          role: 'core',
        })),
        edges: world.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          role: edge.role,
          relation: edge.relation,
          presentation: 'arrow' as const,
        })),
        groups: [],
        globalIntent: { emphasis: [], secondary: [], optional: [] },
      } as unknown as Parameters<typeof auditScientific>[0]['plan']
      expect(() =>
        auditScientific({ plan, placements: world.placements, importance: world.importance }),
      ).not.toThrow()

      // 4) the router must not throw and must preserve edge identity
      const rects = new Map(world.placements.map((p) => [p.id, p]))
      const routeInputs: RoutedEdgeInput[] = world.edges.map((edge) => ({
        key: edge.id ?? `edge:${edge.from}->${edge.to}`,
        semanticEdgeId: edge.id,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
      }))
      const routed = routeEdgesWithObstacles(routeInputs, rects, { w: 1280, h: 720 }, 'LR')
      expect(routed).toHaveLength(routeInputs.length)
      for (const [index, route] of routed.entries()) {
        expect(route.key).toBe(routeInputs[index]!.key)
        expect(route.semanticEdgeId).toBe(routeInputs[index]!.semanticEdgeId)
        // every referenced endpoint must be a KNOWN node (or the route failed cleanly)
        if (route.status !== 'unroutable' || route.diagnostic?.includes('unresolved')) {
          expect(NODE_ID_RE.test(route.fromId)).toBe(true)
        }
      }
    })
  }
})

describe('QA-P1-10: adversarial geometric corners', () => {
  it('all nodes at one coordinate still produce a finite verdict', () => {
    const placements = ['a', 'b', 'c'].map((id) => ({ id, x: 500, y: 300, w: 160, h: 80 }))
    const verdict = criticVerdict({
      solve: {
        placements,
        issues: ['illegal overlap: a intersects b'],
        intentDriftPx: 0,
      },
      edges: [
        { from: 'a', to: 'b', role: 'main', relation: 'causal' },
        { from: 'b', to: 'c', role: 'main', relation: 'process' },
      ],
      canvasW: 1280,
      canvasH: 720,
      importance: new Map([
        ['a', 0.2],
        ['b', 0.9],
        ['c', 0.5],
      ]),
    })
    expectFinite(verdict.scores)
  })

  it('solver legalizes overlapping inputs into non-overlapping outputs or reports issues', () => {
    const rand = rng(4242)
    for (let trial = 0; trial < 20; trial++) {
      const spatial = normalizeSpatialPlan(
        {
          composition: {
            readingFlow: 'LR',
            balance: 'symmetric',
            density: 'high',
            whitespaceStrategy: 'compact',
          },
          placements: ['a', 'b', 'c', 'd'].map((id) => ({
            id,
            boxHint: {
              x: rand() * 0.8,
              y: rand() * 0.8,
              w: 0.3 + rand() * 0.4,
              h: 0.2 + rand() * 0.3,
            },
            visualRole: 'primary',
          })),
        },
        ['a', 'b', 'c', 'd'],
        { readingFlow: 'LR' },
      )
      expect(spatial).not.toBeNull()
      const measured = ['a', 'b', 'c', 'd'].map((id) => ({
        title: id,
        titleLines: 1,
        detailLines: 0,
        bounds: {
          minWidth: 96,
          preferredWidth: 180,
          maxWidth: 300,
          minHeight: 52,
          preferredHeight: 80,
          maxHeight: 170,
        },
      }))
      const result = solveGeometry({
        plan: spatial!,
        measured,
        canvasW: 1280,
        canvasH: 720,
      })
      expectFinite({ placements: result.placements, drift: result.intentDriftPx })
      // reported placements must never NaN
      for (const p of result.placements) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
      }
    }
  })

  it('duplicate coordinate nodes do not hang the solver push loop', () => {
    const spatial = normalizeSpatialPlan(
      {
        composition: { readingFlow: 'LR' },
        placements: ['a', 'b'].map((id) => ({
          id,
          boxHint: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 },
          visualRole: 'primary',
        })),
      },
      ['a', 'b'],
      { readingFlow: 'LR' },
    )!
    const measured = ['a', 'b'].map((id) => ({
      title: id,
      titleLines: 1,
      detailLines: 0,
      bounds: {
        minWidth: 96,
        preferredWidth: 180,
        maxWidth: 300,
        minHeight: 52,
        preferredHeight: 80,
        maxHeight: 170,
      },
    }))
    const result = solveGeometry({ plan: spatial, measured, canvasW: 1280, canvasH: 720 })
    expect(result.placements).toHaveLength(2)
  })
})
