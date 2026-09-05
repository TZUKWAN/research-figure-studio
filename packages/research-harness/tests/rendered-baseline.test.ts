import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'

/**
 * Rendered Visual Benchmark — deterministic pre-render baseline (QA-P1-09).
 *
 * Each fixture runs the FULL deterministic pipeline and freezes a geometry
 * fingerprint (normalized placements, normalized route polylines, verdict,
 * crossings) into a committed JSON baseline. A diff means layout, clipping
 * risk, positions, or routes drifted — the exact gross properties a rendered
 * screenshot would surface, minus antialiasing noise.
 *
 * PNG pixel baselines remain a separate, app-level lane (P0.5 screenshot
 * Vision Critic); this suite is the fast deterministic layer above the
 * geometry regression and below human/screenshot review.
 *
 * Regenerate the baseline deliberately after a REVIEWED behavior change:
 *   UPDATE_BASELINE=1 npx vitest run tests/rendered-baseline.test.ts
 */

const CANVAS = { w: 1280, h: 720 }

const node = (
  id: string,
  type: FigurePlanV2['nodes'][number]['type'],
  semanticLabel: string,
  importance: number,
  role: FigurePlanV2['nodes'][number]['role'],
  detail?: string,
): FigurePlanV2['nodes'][number] => ({
  id,
  type,
  semanticLabel,
  visible: { title: semanticLabel, ...(detail ? { detail } : {}) },
  importance,
  role,
})

const FIXTURES: Array<{ id: string; category: string; build: () => FigurePlanV2 }> = [
  {
    id: 'linear-lr',
    category: 'linear',
    build: () => ({
      thesis: '线性流程',
      figureType: 'horizontal-pipeline',
      nodes: [
        node('a', 'data-source', '原始数据', 0.4, 'input'),
        node('b', 'process', '预处理', 0.7, 'core'),
        node('c', 'process', '建模', 0.9, 'core'),
        node('d', 'outcome', '结论', 0.6, 'output'),
      ],
      edges: [
        { from: 'a', to: 'b', role: 'main', relation: 'data-flow' },
        { from: 'b', to: 'c', role: 'main', relation: 'data-flow' },
        { from: 'c', to: 'd', role: 'main', relation: 'transformation' },
      ],
      groups: [],
      globalIntent: { emphasis: ['c'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
  {
    id: 'radial-core',
    category: 'radial',
    build: () => ({
      thesis: '核心向外辐射',
      figureType: 'core-periphery',
      nodes: [
        node('core', 'mechanism', '核心机制', 0.95, 'core'),
        node('s1', 'variable', '因素一', 0.4, 'context'),
        node('s2', 'variable', '因素二', 0.4, 'context'),
        node('s3', 'variable', '因素三', 0.4, 'context'),
        node('s4', 'outcome', '效果', 0.5, 'output'),
      ],
      edges: [
        { from: 'core', to: 's1', role: 'main', relation: 'association' },
        { from: 'core', to: 's2', role: 'main', relation: 'association' },
        { from: 'core', to: 's3', role: 'main', relation: 'association' },
        { from: 'core', to: 's4', role: 'main', relation: 'causal' },
      ],
      groups: [],
      globalIntent: { emphasis: ['core'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'radial' },
    }),
  },
  {
    id: 'feedback-loop',
    category: 'feedback',
    build: () => ({
      thesis: '负反馈调节',
      figureType: 'feedback-loop',
      nodes: [
        node('in', 'variable', '输入', 0.4, 'input'),
        node('proc', 'mechanism', '过程', 0.9, 'core'),
        node('out', 'outcome', '输出', 0.6, 'output'),
      ],
      edges: [
        { from: 'in', to: 'proc', role: 'main', relation: 'causal' },
        { from: 'proc', to: 'out', role: 'main', relation: 'causal' },
        { from: 'out', to: 'proc', role: 'feedback', relation: 'inhibition' },
      ],
      groups: [],
      globalIntent: { emphasis: ['proc'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
  {
    id: 'hierarchy-tree',
    category: 'hierarchy',
    build: () => ({
      thesis: '分类层级',
      figureType: 'hierarchy',
      nodes: [
        node('root', 'model', '总类', 0.9, 'core'),
        node('k1', 'variable', '亚类一', 0.5, 'core'),
        node('k2', 'variable', '亚类二', 0.5, 'core'),
        node('l1', 'variable', '条目甲', 0.3, 'context'),
        node('l2', 'variable', '条目乙', 0.3, 'context'),
      ],
      edges: [
        { from: 'root', to: 'k1', role: 'main', relation: 'hierarchy' },
        { from: 'root', to: 'k2', role: 'main', relation: 'hierarchy' },
        { from: 'k1', to: 'l1', role: 'main', relation: 'hierarchy' },
        { from: 'k1', to: 'l2', role: 'main', relation: 'hierarchy' },
      ],
      groups: [],
      globalIntent: { emphasis: ['root'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'TB' },
    }),
  },
  {
    id: 'social-moderation',
    category: 'social-science moderation',
    build: () => ({
      thesis: '社会支持调节压力与心理健康的关系',
      figureType: 'input-core-output',
      nodes: [
        node('x', 'variable', '压力', 0.8, 'input'),
        node('y', 'outcome', '心理健康', 0.8, 'output'),
        node('m', 'variable', '社会支持', 0.6, 'moderator'),
      ],
      edges: [
        { from: 'x', to: 'y', role: 'main', relation: 'causal' },
        { from: 'm', to: 'y', role: 'main', relation: 'moderation' },
      ],
      groups: [],
      globalIntent: { emphasis: ['x'], secondary: ['m'], optional: [] },
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
  {
    id: 'materials-synthesis',
    category: 'materials',
    build: () => ({
      thesis: '三步材料合成路线',
      figureType: 'horizontal-pipeline',
      nodes: [
        node('p0', 'data-source', '前驱体', 0.4, 'input'),
        node('p1', 'process', '溶剂热', 0.8, 'core', '180°C 24h'),
        node('p2', 'process', '退火', 0.8, 'core', '350°C 2h'),
        node('p3', 'outcome', '目标相', 0.7, 'output'),
      ],
      edges: [
        { from: 'p0', to: 'p1', role: 'main', relation: 'transformation' },
        { from: 'p1', to: 'p2', role: 'main', relation: 'transformation' },
        { from: 'p2', to: 'p3', role: 'main', relation: 'transformation' },
        { from: 'p2', to: 'p1', role: 'main', relation: 'inhibition', label: '杂质抑制' },
      ],
      groups: [],
      globalIntent: { emphasis: ['p2'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
  {
    id: 'cs-ml-pipeline',
    category: 'cs-ml',
    build: () => ({
      thesis: '训练与推理数据流',
      figureType: 'architecture',
      nodes: [
        node('data', 'data-source', '训练集', 0.5, 'input'),
        node('enc', 'model', '编码器', 0.9, 'core'),
        node('dec', 'model', '解码器', 0.9, 'core'),
        node('loss', 'evidence', '损失', 0.6, 'output'),
        node('pred', 'outcome', '预测', 0.7, 'output'),
      ],
      edges: [
        { from: 'data', to: 'enc', role: 'main', relation: 'data-flow' },
        { from: 'enc', to: 'dec', role: 'main', relation: 'data-flow' },
        { from: 'dec', to: 'loss', role: 'main', relation: 'data-flow' },
        { from: 'dec', to: 'pred', role: 'main', relation: 'data-flow' },
      ],
      groups: [],
      globalIntent: { emphasis: ['enc'], secondary: [], optional: [] },
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
  {
    id: 'cjk-dense',
    category: 'cjk',
    build: () => ({
      thesis: '长江文化国际传播的四方法链：注意、理解、冲突、情绪、记忆与态度的递进机制',
      figureType: 'input-core-output',
      nodes: [
        node('src', 'data-source', '文化符号资源', 0.5, 'input', '考古、非遗与典籍数字化'),
        node('att', 'mechanism', '注意捕获', 0.9, 'core', '视觉显著性驱动第一印象'),
        node('cog', 'mechanism', '理解建构', 0.8, 'core', '图式与叙事双通道编码'),
        node('emo', 'mechanism', '情绪唤起', 0.7, 'core', '共情叙事提升卷入度'),
        node('mem', 'mechanism', '记忆固化', 0.7, 'core', '重复曝光与意义整合'),
        node('att2', 'outcome', '态度形成', 0.6, 'output', '传播效果的行为意向指标'),
      ],
      edges: [
        { from: 'src', to: 'att', role: 'main', relation: 'process' },
        { from: 'att', to: 'cog', role: 'main', relation: 'process' },
        { from: 'cog', to: 'emo', role: 'main', relation: 'process' },
        { from: 'emo', to: 'mem', role: 'main', relation: 'process' },
        { from: 'mem', to: 'att2', role: 'main', relation: 'process' },
        { from: 'att2', to: 'att', role: 'feedback', relation: 'feedback', label: '传播反馈' },
      ],
      groups: [],
      globalIntent: { emphasis: ['att'], secondary: [], optional: [] },
      primarySpine: ['src', 'att', 'cog', 'emo', 'mem', 'att2'],
      readingIntent: { preferredDirection: 'LR' },
    }),
  },
]

interface BaselineEntry {
  verdict: string
  crossings: number
  nodeIntersections: number
  /** placement centroids normalized to canvas, 3 decimals */
  centroids: Record<string, [number, number]>
  /** route polylines normalized to canvas, keyed by edge key */
  routes: Record<string, Array<[number, number]>>
}

const BASELINE_PATH = join(__dirname, '..', 'benchmarks', 'rendered-baseline.json')

async function fingerprint(id: string, build: () => FigurePlanV2): Promise<BaselineEntry> {
  const plan = build()
  const result = await orchestrateFigure(
    { thesis: plan.thesis, canvasW: CANVAS.w, canvasH: CANVAS.h },
    { semanticPlan: async () => plan },
  )
  const centroids: Record<string, [number, number]> = {}
  for (const p of result.best?.solve.placements ?? []) {
    centroids[p.id] = [
      Math.round(((p.x + p.w / 2) / CANVAS.w) * 1000) / 1000,
      Math.round(((p.y + p.h / 2) / CANVAS.h) * 1000) / 1000,
    ]
  }
  const rects = new Map((result.best?.solve.placements ?? []).map((p) => [p.id, p]))
  const routes: Record<string, Array<[number, number]>> = {}
  for (const route of result.routes ?? []) {
    if (route.status !== 'routed') continue
    const a = rects.get(route.fromId)
    const b = rects.get(route.toId)
    if (!a || !b || !route.start || !route.end) continue
    const anchor = (r: { x: number; y: number; w: number; h: number }, side: string) => {
      switch (side) {
        case 'top':
          return [r.x + r.w / 2, r.y]
        case 'bottom':
          return [r.x + r.w / 2, r.y + r.h]
        case 'left':
          return [r.x, r.y + r.h / 2]
        default:
          return [r.x + r.w, r.y + r.h / 2]
      }
    }
    const pts: Array<[number, number]> = [
      anchor(a, route.start.side) as [number, number],
      anchor(b, route.end.side) as [number, number],
    ]
    routes[route.key] = pts.map(([x, y]) => [
      Math.round((x / CANVAS.w) * 1000) / 1000,
      Math.round((y / CANVAS.h) * 1000) / 1000,
    ])
  }
  return {
    verdict: result.critic?.verdict ?? 'NO_VERDICT',
    crossings:
      result.critic?.hardGates.find((gate) => gate.gate === 'connector_not_through_node')?.pass ===
      false
        ? 1
        : 0,
    nodeIntersections: (result.critic?.edgeIds ?? []).length,
    centroids,
    routes,
  }
}

const TOL = 0.02 // 2% of canvas — solver granularity, not pixel-exact

describe('rendered baseline (deterministic pre-render fingerprints)', () => {
  it('every fixture matches the committed baseline', async () => {
    const update = process.env.UPDATE_BASELINE === '1'
    const baseline: Record<string, BaselineEntry> = existsSync(BASELINE_PATH)
      ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
      : {}

    if (update) {
      for (const fixture of FIXTURES) {
        baseline[fixture.id] = await fingerprint(fixture.id, fixture.build)
      }
      writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
      return
    }

    expect(existsSync(BASELINE_PATH), 'baseline JSON missing — run with UPDATE_BASELINE=1').toBe(
      true,
    )
    for (const fixture of FIXTURES) {
      const recorded = baseline[fixture.id]
      expect(recorded, `fixture ${fixture.id} missing from baseline`).toBeDefined()
      const current = await fingerprint(fixture.id, fixture.build)
      expect(current.verdict, `${fixture.id}: verdict drifted`).toBe(recorded.verdict)
      expect(current.crossings, `${fixture.id}: crossing state drifted`).toBe(recorded.crossings)
      for (const [nodeId, [cx, cy]] of Object.entries(current.centroids)) {
        const was = recorded.centroids[nodeId]
        expect(was, `${fixture.id}: node ${nodeId} appeared`).toBeDefined()
        expect(Math.abs(cx - was![0]), `${fixture.id}: ${nodeId} x drifted`).toBeLessThanOrEqual(
          TOL,
        )
        expect(Math.abs(cy - was![1]), `${fixture.id}: ${nodeId} y drifted`).toBeLessThanOrEqual(
          TOL,
        )
      }
      for (const [key, pts] of Object.entries(current.routes)) {
        const was = recorded.routes[key]
        expect(was, `${fixture.id}: route ${key} appeared`).toBeDefined()
        for (const [i, pt] of pts.entries()) {
          expect(
            Math.abs(pt[0] - was![i]![0]),
            `${fixture.id}: route ${key} x drifted`,
          ).toBeLessThanOrEqual(TOL)
          expect(
            Math.abs(pt[1] - was![i]![1]),
            `${fixture.id}: route ${key} y drifted`,
          ).toBeLessThanOrEqual(TOL)
        }
      }
    }
  })

  it('covers the eight required baseline categories', () => {
    expect(FIXTURES.map((fixture) => fixture.category).sort()).toEqual(
      [
        'cjk',
        'cs-ml',
        'feedback',
        'hierarchy',
        'linear',
        'materials',
        'radial',
        'social-science moderation',
      ].sort(),
    )
  })
})
