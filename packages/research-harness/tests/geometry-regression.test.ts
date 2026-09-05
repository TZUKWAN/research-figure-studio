import { describe, expect, it } from 'vitest'
import { orchestrateFigure, type FigurePlanV2, type SemanticNodeType } from '../src/index.js'

/**
 * Geometry & Semantic Regression Suite (QA-P1-08, renamed from the misleading
 * "golden benchmark"). 52 cases asserting that the deterministic pipeline
 * (measure → candidates → solve → route → critic) stays gate-clean and
 * solver-legal on a fixed corpus of semantic graphs.
 *
 * THIS IS NOT A VISUAL-QUALITY BENCHMARK. Passing these cases proves the
 * backend does not crash, mis-route, or produce illegal geometry — it does
 * NOT prove the rendered figures are publication-quality. Visual quality is
 * judged by the rendered benchmark + Vision Critic (see
 * tests/rendered-baseline.test.ts and docs/acceptance/).
 */

type Role = 'input' | 'core' | 'output' | 'moderator' | 'context'
interface CaseSpec {
  id: string
  roles: Role[]
  edges: Array<[number, number, 'main' | 'feedback', string]>
}

const E = (
  a: number,
  b: number,
  role: 'main' | 'feedback' = 'main',
  relation = 'process',
): [number, number, 'main' | 'feedback', string] => [a, b, role, relation]

const CASES: CaseSpec[] = [
  { id: 'simple-flow-1', roles: ['input', 'output'], edges: [E(0, 1)] },
  { id: 'simple-flow-2', roles: ['input', 'core', 'output'], edges: [E(0, 1), E(1, 2)] },
  {
    id: 'simple-flow-3',
    roles: ['input', 'core', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3)],
  },
  {
    id: 'complex-flow-1',
    roles: ['input', 'core', 'core', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3), E(3, 4)],
  },
  {
    id: 'complex-flow-2',
    roles: ['input', 'input', 'core', 'core', 'output', 'output'],
    edges: [E(0, 2), E(1, 3), E(2, 4), E(3, 5)],
  },
  {
    id: 'fan-in-1',
    roles: ['input', 'input', 'input', 'core'],
    edges: [
      E(0, 3, 'main', 'data-flow'),
      E(1, 3, 'main', 'data-flow'),
      E(2, 3, 'main', 'data-flow'),
    ],
  },
  { id: 'fan-in-2', roles: ['input', 'input', 'core', 'core'], edges: [E(0, 2), E(1, 3)] },
  {
    id: 'fan-in-3',
    roles: ['input', 'input', 'input', 'input', 'core'],
    edges: [E(0, 4), E(1, 4), E(2, 4), E(3, 4, 'main', 'causal')],
  },
  {
    id: 'fan-out-1',
    roles: ['core', 'output', 'output', 'output'],
    edges: [E(0, 1), E(0, 2), E(0, 3)],
  },
  {
    id: 'fan-out-2',
    roles: ['core', 'core', 'output', 'output'],
    edges: [E(0, 2), E(0, 3), E(1, 2), E(1, 3, 'main', 'data-flow')],
  },
  {
    id: 'fan-out-3',
    roles: ['core', 'output', 'output', 'output', 'output'],
    edges: [E(0, 1), E(0, 2), E(0, 3), E(0, 4)],
  },
  {
    id: 'ico-1',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1, 'main', 'causal'), E(1, 2, 'main', 'transformation')],
  },
  {
    id: 'ico-2',
    roles: ['input', 'input', 'core', 'output', 'output'],
    edges: [E(0, 2), E(1, 2), E(2, 3), E(2, 4)],
  },
  {
    id: 'ico-3',
    roles: ['input', 'input', 'input', 'core', 'output', 'output'],
    edges: [E(0, 3), E(1, 3), E(2, 3), E(3, 4), E(3, 5)],
  },
  {
    id: 'parallel-1',
    roles: ['input', 'core', 'core', 'output'],
    edges: [E(0, 1), E(0, 2), E(1, 3), E(2, 3, 'main', 'association')],
  },
  {
    id: 'parallel-2',
    roles: ['input', 'input', 'core', 'core', 'output', 'output'],
    edges: [E(0, 2), E(1, 3), E(2, 4), E(3, 5)],
  },
  {
    id: 'parallel-3',
    roles: ['input', 'core', 'core', 'core', 'output'],
    edges: [E(0, 1), E(0, 2), E(0, 3), E(1, 4), E(2, 4), E(3, 4)],
  },
  {
    id: 'layered-1',
    roles: ['context', 'core', 'core', 'output'],
    edges: [E(0, 1), E(0, 2), E(1, 3), E(2, 3, 'main', 'hierarchy')],
  },
  {
    id: 'layered-2',
    roles: ['context', 'context', 'core', 'output'],
    edges: [E(0, 2), E(1, 2), E(2, 3)],
  },
  {
    id: 'core-periphery-1',
    roles: ['core', 'context', 'context', 'output'],
    edges: [E(0, 1, 'main', 'association'), E(0, 2, 'main', 'mapping'), E(0, 3)],
  },
  {
    id: 'feedback-1',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 1, 'feedback', 'feedback')],
  },
  {
    id: 'feedback-2',
    roles: ['input', 'core', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3), E(3, 1, 'feedback', 'feedback')],
  },
  {
    id: 'feedback-3',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 0, 'feedback', 'feedback')],
  },
  {
    id: 'causal-1',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1, 'main', 'causal'), E(1, 2, 'main', 'causal')],
  },
  {
    id: 'causal-2',
    roles: ['input', 'input', 'core', 'output'],
    edges: [E(0, 2, 'main', 'causal'), E(1, 2, 'main', 'inhibition'), E(2, 3, 'main', 'causal')],
  },
  {
    id: 'moderation-1',
    roles: ['input', 'core', 'output', 'moderator'],
    edges: [E(0, 1), E(1, 2), E(3, 1, 'main', 'moderation')],
  },
  {
    id: 'moderation-2',
    roles: ['input', 'core', 'output', 'moderator', 'moderator'],
    edges: [E(0, 1), E(1, 2), E(3, 1, 'main', 'moderation'), E(4, 2, 'main', 'moderation')],
  },
  {
    id: 'mediation-1',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1, 'main', 'mediation'), E(1, 2, 'main', 'mediation')],
  },
  {
    id: 'mediation-2',
    roles: ['input', 'input', 'core', 'output'],
    edges: [E(0, 2, 'main', 'mediation'), E(1, 2, 'main', 'causal'), E(2, 3, 'main', 'mediation')],
  },
  {
    id: 'hierarchy-1',
    roles: ['context', 'core', 'core', 'core'],
    edges: [
      E(0, 1, 'main', 'hierarchy'),
      E(0, 2, 'main', 'hierarchy'),
      E(0, 3, 'main', 'hierarchy'),
    ],
  },
  {
    id: 'hierarchy-2',
    roles: ['context', 'core', 'core', 'core', 'core'],
    edges: [
      E(0, 1, 'main', 'hierarchy'),
      E(0, 2, 'main', 'hierarchy'),
      E(1, 3, 'main', 'hierarchy'),
      E(2, 4, 'main', 'hierarchy'),
    ],
  },
  {
    id: 'layered-arch-1',
    roles: ['context', 'core', 'core', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3), E(3, 4)],
  },
  {
    id: 'system-arch-1',
    roles: ['input', 'core', 'core', 'core', 'output', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3), E(3, 4), E(3, 5), E(1, 3, 'main', 'data-flow')],
  },
  {
    id: 'experiment-flow-1',
    roles: ['input', 'core', 'core', 'output'],
    edges: [
      E(0, 1, 'main', 'process'),
      E(1, 2, 'main', 'process'),
      E(2, 3, 'main', 'transformation'),
    ],
  },
  {
    id: 'algorithm-pipeline-1',
    roles: ['input', 'core', 'core', 'core', 'output'],
    edges: [
      E(0, 1, 'main', 'data-flow'),
      E(1, 2, 'main', 'data-flow'),
      E(2, 3, 'main', 'data-flow'),
      E(3, 4, 'main', 'transformation'),
    ],
  },
  {
    id: 'graphical-abstract-1',
    roles: ['input', 'core', 'output', 'context'],
    edges: [
      E(0, 1, 'main', 'causal'),
      E(1, 2, 'main', 'transformation'),
      E(3, 1, 'main', 'association'),
    ],
  },
  {
    id: 'overlap-venn-1',
    roles: ['core', 'core', 'output'],
    edges: [E(0, 2), E(1, 2, 'main', 'mapping')],
  },
  {
    id: 'nested-region-1',
    roles: ['context', 'core', 'core', 'output'],
    edges: [E(1, 3), E(2, 3, 'main', 'process')],
  },
  {
    id: 'boundary-overlay-1',
    roles: ['core', 'context', 'output'],
    edges: [E(0, 2), E(1, 0, 'main', 'association')],
  },
  {
    id: 'mixed-1',
    roles: ['input', 'input', 'core', 'core', 'output', 'moderator'],
    edges: [E(0, 2), E(1, 2), E(2, 3), E(3, 4), E(5, 3, 'main', 'moderation')],
  },
  {
    id: 'mixed-2',
    roles: ['input', 'core', 'core', 'output', 'output', 'moderator'],
    edges: [
      E(0, 1),
      E(1, 2),
      E(2, 3),
      E(2, 4),
      E(5, 2, 'main', 'moderation'),
      E(4, 1, 'feedback', 'feedback'),
    ],
  },
  {
    id: 'mixed-3',
    roles: ['input', 'input', 'input', 'core', 'core', 'output', 'output'],
    edges: [E(0, 3), E(1, 3), E(2, 4), E(3, 5), E(4, 6), E(5, 3, 'feedback', 'feedback')],
  },
  {
    id: 'bidirectional-1',
    roles: ['core', 'core', 'output'],
    edges: [E(0, 1, 'main', 'bidirectional'), E(1, 2)],
  },
  {
    id: 'inhibition-1',
    roles: ['input', 'core', 'output'],
    edges: [E(0, 1, 'main', 'inhibition'), E(1, 2)],
  },
  {
    id: 'stage-pipeline-1',
    roles: ['input', 'core', 'core', 'core', 'output'],
    edges: [E(0, 1), E(1, 2), E(2, 3), E(3, 4, 'main', 'process')],
  },
  {
    id: 'stage-pipeline-2',
    roles: ['input', 'input', 'core', 'output'],
    edges: [E(0, 2), E(1, 2), E(2, 3, 'main', 'transformation')],
  },
  { id: 'hub-1', roles: ['core', 'input', 'input', 'output'], edges: [E(1, 0), E(2, 0), E(0, 3)] },
  {
    id: 'cascade-1',
    roles: ['input', 'core', 'core', 'core', 'output'],
    edges: [
      E(0, 1),
      E(1, 2, 'main', 'causal'),
      E(2, 3, 'main', 'causal'),
      E(3, 4, 'main', 'causal'),
    ],
  },
  {
    id: 'feedback-moderation-1',
    roles: ['input', 'core', 'output', 'moderator'],
    edges: [E(0, 1), E(1, 2), E(2, 1, 'feedback', 'feedback'), E(3, 1, 'main', 'moderation')],
  },
  {
    id: 'large-fan-1',
    roles: ['input', 'input', 'core', 'output', 'output', 'output'],
    edges: [E(0, 2), E(1, 2), E(2, 3), E(2, 4), E(2, 5), E(5, 0, 'feedback', 'feedback')],
  },
  {
    id: 'diamond-1',
    roles: ['input', 'core', 'core', 'output'],
    edges: [E(0, 1), E(0, 2), E(1, 3), E(2, 3, 'main', 'hierarchy')],
  },
  {
    id: 'diamond-2',
    roles: ['input', 'core', 'core', 'output', 'output'],
    edges: [E(0, 1), E(0, 2), E(1, 3), E(2, 4), E(3, 4, 'main', 'association')],
  },
]

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

describe('geometry & semantic regression suite (52 cases, full orchestrator)', () => {
  it('covers the required 50+-case pack', () => {
    expect(CASES.length).toBe(52)
  })

  const TYPE_BY_ROLE: Record<string, SemanticNodeType> = {
    input: 'data-source',
    core: 'mechanism',
    output: 'outcome',
    moderator: 'variable',
    context: 'context',
  }

  for (const spec of CASES) {
    it(`benchmark case ${spec.id}: one run, not RECOMPOSE`, async () => {
      const nodes = spec.roles.map((role, index) => ({
        id: `n${index}`,
        type: TYPE_BY_ROLE[role] ?? 'process',
        semanticLabel: `${role}-${index}`,
        visible: { title: `${role}-${index}` },
        importance: role === 'core' ? 0.9 : 0.5,
        role: role === 'moderator' ? 'moderator' : role === 'context' ? 'context' : role,
      }))
      const plan: FigurePlanV2 = {
        thesis: spec.id,
        figureType: 'input-core-output',
        nodes: nodes as FigurePlanV2['nodes'],
        edges: spec.edges.map(([from, to, role, relation]) => ({
          from: `n${from}`,
          to: `n${to}`,
          role,
          relation: relation as FigurePlanV2['edges'][number]['relation'],
        })),
        groups: [],
        globalIntent: { emphasis: [], secondary: [], optional: [] },
        readingIntent: { preferredDirection: 'LR' },
      }
      const result = await orchestrateFigure(
        { thesis: spec.id, canvasW: 1280, canvasH: 720 },
        { semanticPlan: async () => plan },
      )
      // First-generation correctness: router resolves lines, solver resolves
      // geometry, the ladder absorbs LOCAL defects — a RECOMPOSE verdict means
      // the deterministic backend failed this golden case.
      expect(result.critic?.verdict).not.toBe('RECOMPOSE')
      expect(result.ok).toBe(true)
      expect(result.best?.solve.issues).toEqual([])
    })
  }
})
