import { describe, expect, it } from 'vitest'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'

/**
 * Performance benchmark harness (§32). Records per-stage wall time of the
 * deterministic pipeline at 5 / 15 / 30 nodes and 60 edges. Thresholds are
 * deliberately GENEROUS ABSOLUTE ceilings — this guards against order-of-
 * magnitude regressions (e.g. an accidental O(n²) critic loop), not against
 * small fluctuations. Actual timings are printed for trend tracking.
 */

function buildPlan(nodeCount: number, edgeCount: number): FigurePlanV2 {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    type: i === nodeCount - 1 ? ('outcome' as const) : ('mechanism' as const),
    semanticLabel: `机制单元${i}`,
    visible: { title: `机制单元${i}`, detail: i % 3 === 0 ? '包含实验条件与参数说明' : undefined },
    importance: i === 0 ? 0.95 : 0.3 + (i / nodeCount) * 0.5,
    role:
      i === 0 ? ('input' as const) : i === nodeCount - 1 ? ('output' as const) : ('core' as const),
  })).filter((node) => node.visible.detail !== undefined || true) as FigurePlanV2['nodes']
  const edges: FigurePlanV2['edges'] = []
  // chain + random-ish deterministic extras up to edgeCount
  for (let i = 0; i + 1 < nodeCount; i++) {
    edges.push({ from: `n${i}`, to: `n${i + 1}`, role: 'main', relation: 'process' })
  }
  let i = 0
  while (edges.length < edgeCount && i + 2 < nodeCount) {
    const from = i % (nodeCount - 2)
    const to = nodeCount - 1
    if (!edges.some((e) => e.from === `n${from}` && e.to === `n${to}`)) {
      edges.push({ from: `n${from}`, to: `n${to}`, role: 'main', relation: 'association' })
    }
    i++
  }
  return {
    thesis: `性能基准 ${nodeCount} 节点`,
    figureType: 'input-core-output',
    nodes,
    edges,
    groups: [],
    globalIntent: { emphasis: [], secondary: [], optional: [] },
    readingIntent: { preferredDirection: 'LR' },
  }
}

async function timedRun(plan: FigurePlanV2): Promise<{ ms: number; verdict: string }> {
  const start = performance.now()
  const result = await orchestrateFigure(
    { thesis: plan.thesis, canvasW: 1280, canvasH: 720 },
    { semanticPlan: async () => plan },
  )
  return { ms: performance.now() - start, verdict: result.critic?.verdict ?? 'NONE' }
}

const CASES: Array<{ label: string; nodes: number; edges: number; ceilingMs: number }> = [
  { label: '5 nodes / 4 edges', nodes: 5, edges: 4, ceilingMs: 5_000 },
  { label: '15 nodes / 20 edges', nodes: 15, edges: 20, ceilingMs: 15_000 },
  { label: '30 nodes / 40 edges', nodes: 30, edges: 40, ceilingMs: 30_000 },
  { label: '30 nodes / 60 edges', nodes: 30, edges: 60, ceilingMs: 45_000 },
]

describe('performance benchmark (generous regression ceilings)', () => {
  for (const testCase of CASES) {
    it(`${testCase.label} completes under ${testCase.ceilingMs / 1000}s`, async () => {
      const plan = buildPlan(testCase.nodes, testCase.edges)
      const { ms, verdict } = await timedRun(plan)
      // warm state matters little; one honest timed run per case
      // eslint-disable-next-line no-console
      console.log(`[perf] ${testCase.label}: ${Math.round(ms)}ms → ${verdict}`)
      expect(ms, `${testCase.label} took ${Math.round(ms)}ms`).toBeLessThan(testCase.ceilingMs)
      expect(verdict).not.toBe('RECOMPOSE')
    })
  }
})
