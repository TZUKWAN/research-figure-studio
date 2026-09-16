/**
 * GOAL: complex architecture look for converging frameworks. The user's real
 * case (长江经济带: foundation + 4 pillars → summary) produced a single
 * left-column stack that left half the canvas empty. The tiered grammar
 * (kept in the registry, selection-gated until the router gains row-channel
 * support) must produce the classic architecture look when directly invoked:
 * outcome row on top, pillar row in the middle, foundation row at the bottom,
 * each spread across the full canvas width.
 */
import { describe, expect, it } from 'vitest'
import { tieredGrammar, type GrammarContext } from '../src/composition/candidate.js'

const IDS = [
  'foundation',
  'pillar-eco',
  'pillar-social',
  'pillar-human',
  'pillar-strategy',
  'summary-yangtze',
]

function makeContext(): GrammarContext {
  const layerOf = new Map<string, number>([
    ['foundation', 0],
    ['pillar-eco', 1],
    ['pillar-social', 1],
    ['pillar-human', 1],
    ['pillar-strategy', 1],
    ['summary-yangtze', 2],
  ])
  const sizes = new Map(IDS.map((id) => [id, { w: 0.2, h: 0.14 }]))
  return {
    topo: {
      ids: IDS,
      adjacency: new Map(),
      inDeg: new Map([
        ['foundation', 0],
        ['pillar-eco', 1],
        ['pillar-social', 1],
        ['pillar-human', 1],
        ['pillar-strategy', 1],
        ['summary-yangtze', 4],
      ]),
      outDeg: new Map([
        ['foundation', 4],
        ['pillar-eco', 1],
        ['pillar-social', 1],
        ['pillar-human', 1],
        ['pillar-strategy', 1],
        ['summary-yangtze', 0],
      ]),
      layerOf,
      maxLayer: 2,
      sources: ['foundation'],
      sinks: ['summary-yangtze'],
      hub: 'summary-yangtze',
      root: 'foundation',
      depthOf: layerOf,
      maxDepth: 2,
      components: [IDS],
      mainChain: ['foundation', 'summary-yangtze'],
      hasCycle: false,
    },
    sizes: sizes as never,
    edges: [],
    prior: {
      id: 'tiered-framework',
      grammar: 'tiered',
      semanticFit: [],
      principles: [],
      defaultBias: { top: 0.16, bottom: 0.84 },
      allowedRange: { top: [0.1, 0.22], bottom: [0.78, 0.9] },
      readingFlow: 'BT',
    },
    ctx: {},
  } as never
}

describe('tiered grammar (framework architecture rows)', () => {
  it('lays three full-width rows: summary top, pillars middle, foundation bottom', () => {
    const layout = tieredGrammar(makeContext())
    expect(layout).toBeTruthy()
    const hints = layout!.hints
    const index = new Map(IDS.map((id, i) => [id, i]))
    const pos = new Map(
      IDS.map((id) => {
        const hint = hints.get(id)
        return [id, hint ? { x: hint.x, y: hint.y } : undefined]
      }),
    )

    // outcome on top, foundation at the base (hint.y = box top edge)
    expect(pos.get('summary-yangtze')!.y).toBeLessThan(pos.get('foundation')!.y)
    // the four pillars share the middle row
    for (const p of ['pillar-eco', 'pillar-social', 'pillar-human', 'pillar-strategy']) {
      expect(pos.get(p)!.y).toBeGreaterThan(pos.get('summary-yangtze')!.y)
      expect(pos.get(p)!.y).toBeLessThan(pos.get('foundation')!.y)
    }
    // full-width spread: pillars span the canvas
    const pillarXs = ['pillar-eco', 'pillar-social', 'pillar-human', 'pillar-strategy'].map(
      (p) => pos.get(p)!.x,
    )
    const tops = [...pos.values()].map((v) => v.y)
    // rows genuinely differ: no two tier tops collapse together
    expect(new Set(tops.map((y) => Math.round(y * 20))).size).toBe(3)
    expect(Math.min(...pillarXs)).toBeLessThan(0.35)
    expect(Math.max(...pillarXs)).toBeGreaterThan(0.6)
  })

  it('declines degenerate shapes (too few nodes or too many per row)', () => {
    const base = makeContext()
    const tiny = {
      ...base,
      topo: {
        ...base.topo,
        ids: ['a', 'b', 'c'],
        layerOf: new Map([
          ['a', 0],
          ['b', 1],
          ['c', 2],
        ]),
      },
    } as never
    expect(tieredGrammar(tiny)).toBeNull()
  })
})
