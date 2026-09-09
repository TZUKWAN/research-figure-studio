/**
 * P0-5 (production closure 2): connector ENDPOINT BINDING verification.
 *
 * A semantic edge's native connector must attach start→semantic `from` and
 * end→semantic `to` — an A→C wire cannot pass an A→B relation just because
 * the connector COUNT matches. Verified at the MODEL level (spid bindings),
 * and again after save→reopen so the bytes carry the bindings, not just the
 * in-memory map.
 *
 * Covers: plain arrow, dashed arrow, feedback loop (bottom lane), inhibition
 * (+ native bar), moderation, and multi-edge on the same source/target pair.
 */
import { describe, expect, it, vi } from 'vitest'
import { commitSaved, openPptx, savePptx, elementSpid } from '@genoffice/pptx-engine'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'
import { makeTxnAccess } from './research-txn-mock'

const figurePlan = {
  thesis: 'A促进B，B抑制C；M调节A对B；D独立促进B；B反馈抑制A。',
  figureType: 'mechanism',
  narrative: {
    expressionMode: 'mechanism',
    complexity: 'rich',
    centralMessage: 'regulation network',
    visualCenter: 'b',
    readingPath: ['a', 'b', 'c'],
    mustShow: ['a', 'b', 'c', 'm', 'd'],
    mayMerge: [],
    omitFromCanvas: [],
  },
  nodes: [
    {
      id: 'a',
      type: 'mechanism',
      semanticLabel: 'A',
      visible: { title: 'A' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'b',
      type: 'process',
      semanticLabel: 'B',
      visible: { title: 'B' },
      importance: 0.8,
      role: 'intermediate',
    },
    {
      id: 'c',
      type: 'outcome',
      semanticLabel: 'C',
      visible: { title: 'C' },
      importance: 0.7,
      role: 'output',
    },
    {
      id: 'm',
      type: 'variable',
      semanticLabel: 'M',
      visible: { title: 'M' },
      importance: 0.5,
      role: 'moderator',
    },
    {
      id: 'd',
      type: 'data-source',
      semanticLabel: 'D',
      visible: { title: 'D' },
      importance: 0.5,
      role: 'support',
    },
  ],
  edges: [
    { id: 'e-ab', from: 'a', to: 'b', role: 'main', relation: 'causal', presentation: 'arrow' },
    {
      id: 'e-bc',
      from: 'b',
      to: 'c',
      role: 'main',
      relation: 'inhibition',
      presentation: 'inhibition',
    },
    {
      id: 'e-mod',
      from: 'm',
      to: 'a',
      role: 'main',
      relation: 'moderation',
      presentation: 'dashed-arrow',
      targetEdge: 'e-ab',
    },
    { id: 'e-db', from: 'd', to: 'b', role: 'main', relation: 'data-flow', presentation: 'arrow' },
    {
      id: 'e-fb',
      from: 'b',
      to: 'a',
      role: 'feedback',
      relation: 'feedback',
      presentation: 'feedback-loop',
    },
  ],
  groups: [],
  globalIntent: { emphasis: ['b'], secondary: ['a'], optional: [] },
}

const spatialPlan = {
  composition: {
    readingFlow: 'LR',
    balance: 'loosely-balanced',
    density: 'medium',
    visualCenter: 'b',
    whitespaceStrategy: 'balanced',
  },
  placements: [
    { id: 'a', boxHint: { x: 0.18, y: 0.3, w: 0.2, h: 0.24 }, visualRole: 'dominant' },
    { id: 'b', boxHint: { x: 0.46, y: 0.3, w: 0.18, h: 0.22 }, visualRole: 'primary' },
    { id: 'c', boxHint: { x: 0.72, y: 0.32, w: 0.16, h: 0.2 }, visualRole: 'secondary' },
    { id: 'm', boxHint: { x: 0.18, y: 0.06, w: 0.14, h: 0.16 }, visualRole: 'supporting' },
    { id: 'd', boxHint: { x: 0.46, y: 0.62, w: 0.16, h: 0.16 }, visualRole: 'supporting' },
  ],
}

const runLlm = () =>
  vi.fn(async (system: string) => {
    if (system.includes('Semantic Planner')) return { ok: true, text: JSON.stringify(figurePlan) }
    if (system.includes('Composition Designer'))
      return { ok: true, text: JSON.stringify(spatialPlan) }
    return { ok: false, error: 'unexpected prompt' }
  })

interface ConnectorMeta {
  semanticEdgeId?: string
  componentType?: string
}

/** semantic edge id → { fromSpid, toSpid } from the rendered figure's model. */
function expectedEndpoints(slide: {
  elements: Array<{
    semanticMetadata?: { semanticEdgeId?: string; semanticNodeId?: string; componentType?: string }
  }>
}) {
  const spidByNode = new Map<string, number>()
  for (const element of slide.elements) {
    const nodeId = element.semanticMetadata?.semanticNodeId
    if (nodeId && !spidByNode.has(nodeId)) {
      const spid = elementSpid(element as never)
      if (spid != null) spidByNode.set(nodeId, spid)
    }
  }
  const map = new Map<string, { from: string; to: string; fromSpid: number; toSpid: number }>()
  for (const edge of figurePlan.edges) {
    const fromSpid = spidByNode.get(edge.from)
    const toSpid = spidByNode.get(edge.to)
    if (fromSpid != null && toSpid != null) {
      map.set(edge.id!, { from: edge.from, to: edge.to, fromSpid, toSpid })
    }
  }
  return map
}

function assertBindings(slide: {
  elements: Array<{
    semanticMetadata?: ConnectorMeta
    connection?: { start?: { id: number; idx: number }; end?: { id: number; idx: number } }
  }>
}) {
  const expected = expectedEndpoints(slide)
  const connectors = slide.elements.filter(
    (el) => el.semanticMetadata?.componentType === 'research-connector',
  )
  const byEdge = new Map<string, (typeof connectors)[number]>()
  for (const connector of connectors) {
    const edgeId = connector.semanticMetadata?.semanticEdgeId
    expect(edgeId, 'every connector carries a semanticEdgeId').toBeTruthy()
    expect(byEdge.has(edgeId!), `edge ${edgeId} duplicated`).toBe(false)
    byEdge.set(edgeId!, connector)
  }
  for (const edge of figurePlan.edges) {
    const connector = byEdge.get(edge.id!)
    expect(connector, `edge ${edge.id} has no native connector`).toBeTruthy()
    const want = expected.get(edge.id!)!
    const start = connector!.connection?.start
    const end = connector!.connection?.end
    expect(start, `edge ${edge.id}: unbound start`).toBeTruthy()
    expect(end, `edge ${edge.id}: unbound end`).toBeTruthy()
    // DIRECTION MATTERS: start spid == semantic from, end spid == semantic to
    expect(start!.id, `edge ${edge.id}: start bound to the wrong shape`).toBe(want.fromSpid)
    expect(end!.id, `edge ${edge.id}: end bound to the wrong shape`).toBe(want.toSpid)
  }
  // multi-edge sanity: every planned edge kept its own connector
  expect(connectors.length).toBe(figurePlan.edges.length)
  return { connectors, byEdge }
}

describe('connector endpoint binding verification (P0-5)', () => {
  it('every semantic edge binds start→from / end→to on the rebuilt model', async () => {
    const { access, opened } = await makeTxnAccess(runLlm())
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'p0-5',
        name: 'create_research_figure',
        input: { slideIndex: 0, thesis: figurePlan.thesis },
      },
    )
    expect(result.isError, result.output).toBeUndefined()
    assertBindings(opened.deck.slides[0]!)
  })

  it('bindings survive save → reopen (bytes, not just memory)', async () => {
    const { access, opened } = await makeTxnAccess(runLlm())
    const result = await createSlidesSkill(access as unknown as DeckAccess, 'research').executeTool(
      {
        id: 'p0-5b',
        name: 'create_research_figure',
        input: { slideIndex: 0, thesis: figurePlan.thesis },
      },
    )
    expect(result.isError, result.output).toBeUndefined()
    commitSaved(opened)
    const bytes = await savePptx(opened)
    const reopened = await openPptx(bytes)
    const { byEdge } = assertBindings(reopened.deck.slides[0]!)
    // the inhibition edge also carries its native bar
    const bars = reopened.deck.slides[0]!.elements.filter(
      (el) => el.semanticMetadata?.componentType === 'research-inhibition-bar',
    )
    expect(bars.some((bar) => bar.semanticMetadata?.semanticEdgeId === 'e-bc')).toBe(true)
    void byEdge
  })
})

import { verifyFigureWrite } from '../src/renderer/research/transaction'
import type { FigureRenderPlan } from '../src/renderer/research/native-figure-renderer'
import type { SemanticMetadata } from '@genoffice/pptx-engine'

const META = (edge: string): SemanticMetadata =>
  ({
    role: 'research-connector',
    themeFill: 'none',
    themeStroke: 'connector',
    themeText: 'none',
    componentType: 'research-connector',
    semanticEdgeId: edge,
  }) as unknown as SemanticMetadata

const MODULE_META = (nodeId: string): SemanticMetadata =>
  ({
    role: 'process-node',
    themeFill: 'surface',
    themeStroke: 'primary',
    themeText: 'textPrimary',
    componentType: 'research-module',
    semanticNodeId: nodeId,
  }) as unknown as SemanticMetadata

function fakePlan(): FigureRenderPlan {
  return {
    elements: [
      {
        specId: 'module:a',
        zTier: 0,
        kind: 'roundRect',
        x: 100,
        y: 200,
        w: 200,
        h: 100,
        paragraphs: [],
        fillColor: '#fff',
        stroke: { color: '#000', widthPt: 1 },
        insetsPx: { l: 0, t: 0, r: 0, b: 0 },
        semanticMetadata: MODULE_META('a'),
      },
      {
        specId: 'module:b',
        zTier: 0,
        kind: 'roundRect',
        x: 500,
        y: 200,
        w: 200,
        h: 100,
        paragraphs: [],
        fillColor: '#fff',
        stroke: { color: '#000', widthPt: 1 },
        insetsPx: { l: 0, t: 0, r: 0, b: 0 },
        semanticMetadata: MODULE_META('b'),
      },
      {
        specId: 'module:c',
        zTier: 0,
        kind: 'roundRect',
        x: 500,
        y: 500,
        w: 200,
        h: 100,
        paragraphs: [],
        fillColor: '#fff',
        stroke: { color: '#000', widthPt: 1 },
        insetsPx: { l: 0, t: 0, r: 0, b: 0 },
        semanticMetadata: MODULE_META('c'),
      },
      {
        specId: 'connector:e1',
        zTier: 1,
        kind: 'lineArrow',
        x: 300,
        y: 250,
        w: 200,
        h: 0,
        paragraphs: [],
        fillColor: 'none',
        stroke: { color: '#000', widthPt: 1.5 },
        insetsPx: { l: 0, t: 0, r: 0, b: 0 },
        semanticMetadata: META('e1'),
      },
    ],
    bindings: [
      {
        specId: 'connector:e1',
        semanticEdgeId: 'e1',
        start: { targetSpecId: 'module:a', idx: 3 },
        end: { targetSpecId: 'module:b', idx: 1 },
      },
    ],
    groups: [],
    slideMetadata: {
      schemaVersion: 1,
      figureRunId: 'fig-x',
      figureFamily: 'f',
      domain: 'd',
      thesis: 't',
      nodes: [],
      relations: [],
    },
    defects: [],
  }
}

function renderedSlide(connectorStartSpid: number, connectorEndSpid: number): { nodes: unknown[] } {
  // boxes mirror the plan's geometry so bounds checks stay quiet — only the
  // connector binding varies between the positive and negative cases
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {
    a: { x: 100, y: 200, w: 200, h: 100 },
    b: { x: 500, y: 200, w: 200, h: 100 },
    c: { x: 500, y: 500, w: 200, h: 100 },
  }
  const mod = (spid: number, nodeId: string) => ({
    sourceId: `sp_${spid}`,
    spid,
    box: boxes[nodeId]!,
    semanticMetadata: { componentType: 'research-module', semanticNodeId: nodeId },
  })
  return {
    nodes: [
      mod(2, 'a'),
      mod(3, 'b'),
      mod(4, 'c'),
      {
        sourceId: 'sp_9',
        spid: 9,
        box: { x: 300, y: 250, w: 200, h: 0 },
        semanticMetadata: { componentType: 'research-connector', semanticEdgeId: 'e1' },
        connection: {
          start: { id: connectorStartSpid, idx: 3 },
          end: { id: connectorEndSpid, idx: 1 },
        },
      },
    ],
  }
}

describe('verifyFigureWrite directional binding check (P0-5)', () => {
  it('correct direction A→B passes', () => {
    const v = verifyFigureWrite(renderedSlide(2, 3), fakePlan(), new Map(), [])
    expect(v.ok).toBe(true)
  })

  it('a connector wearing e1 metadata but bound to the WRONG END shape FAILS', () => {
    // start correctly at a (spid 2) but end bound to c (spid 4) — e1 said A→B
    const v = verifyFigureWrite(renderedSlide(2, 4), fakePlan(), new Map(), [])
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes('WRONG DIRECTION'))).toBe(true)
  })

  it('a fully swapped binding (end=a, start=b) FAILS', () => {
    const v = verifyFigureWrite(renderedSlide(3, 2), fakePlan(), new Map(), [])
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes('WRONG DIRECTION'))).toBe(true)
  })
})
