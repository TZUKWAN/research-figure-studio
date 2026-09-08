/**
 * Weak-model Structured EditPlan (P1-3, production closure 2).
 *
 * Editing an existing research figure must not depend on a strong ReAct tool
 * loop. The model declares INTENT over SEMANTIC ids (never native element
 * ids) as one EditPlan; a deterministic executor validates it against the
 * recovered semantic graph, compiles ONE atomic transaction, verifies the
 * write, and rolls back on any failure — the same fail-closed contract as
 * creation.
 *
 * The semantic graph is recovered from the slide's research payload + per-
 * shape metadata (P0-10/P0-11), never guessed from a screenshot.
 */
import type { RenderSlide } from '@genoffice/pptx-render'
import { t } from '../i18n/locale'
import { pxToEmu } from './transaction'

export type EditPlanOperation =
  | { type: 'move'; targetSemanticId: string; dxPx: number; dyPx: number }
  | { type: 'resize'; targetSemanticId: string; wPx: number; hPx: number }
  | {
      type: 'edit-text'
      targetSemanticId: string
      title?: string
      detail?: string
    }
  | {
      type: 'add-relation'
      semanticEdgeId: string
      from: string
      to: string
      presentation?: string
    }
  | { type: 'remove-relation'; semanticEdgeId: string }

export interface EditPlan {
  intent: string
  operations: EditPlanOperation[]
}

export interface EditPlanParseResult {
  plan: EditPlan | null
  errors: string[]
}

const OPERATION_TYPES = new Set(['move', 'resize', 'edit-text', 'add-relation', 'remove-relation'])

/** Validate a raw model EditPlan against the CURRENT semantic graph. */
export function parseEditPlan(
  raw: unknown,
  graph: { nodeIds: Set<string>; edgeIds: Set<string> },
): EditPlanParseResult {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { plan: null, errors: ['EditPlan must be a JSON object'] }
  }
  const plan = raw as Record<string, unknown>
  const intent = typeof plan.intent === 'string' ? plan.intent : ''
  if (!Array.isArray(plan.operations)) {
    return { plan: null, errors: ['"operations" must be an array'] }
  }
  const operations: EditPlanOperation[] = []
  plan.operations.forEach((rawOp, index) => {
    const op = (rawOp ?? {}) as Record<string, unknown>
    const type = typeof op.type === 'string' ? op.type : ''
    if (!OPERATION_TYPES.has(type)) {
      errors.push(
        `operation ${index}: type "${type}" unsupported (allowed: ${[...OPERATION_TYPES].join(', ')})`,
      )
      return
    }
    const target = typeof op.targetSemanticId === 'string' ? op.targetSemanticId : ''
    switch (type) {
      case 'move': {
        if (!graph.nodeIds.has(target)) {
          errors.push(`operation ${index}: targetSemanticId "${target}" references missing node`)
          return
        }
        const dx = typeof op.dxPx === 'number' ? op.dxPx : Number.NaN
        const dy = typeof op.dyPx === 'number' ? op.dyPx : Number.NaN
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
          errors.push(`operation ${index}: move needs finite dxPx/dyPx numbers`)
          return
        }
        operations.push({ type: 'move', targetSemanticId: target, dxPx: dx, dyPx: dy })
        return
      }
      case 'resize': {
        if (!graph.nodeIds.has(target)) {
          errors.push(`operation ${index}: targetSemanticId "${target}" references missing node`)
          return
        }
        const w = typeof op.wPx === 'number' ? op.wPx : Number.NaN
        const h = typeof op.hPx === 'number' ? op.hPx : Number.NaN
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 24 || h < 24) {
          errors.push(`operation ${index}: resize needs finite wPx/hPx ≥ 24`)
          return
        }
        operations.push({ type: 'resize', targetSemanticId: target, wPx: w, hPx: h })
        return
      }
      case 'edit-text': {
        if (!graph.nodeIds.has(target)) {
          errors.push(`operation ${index}: targetSemanticId "${target}" references missing node`)
          return
        }
        const title = typeof op.title === 'string' ? op.title.trim() : ''
        const detail = typeof op.detail === 'string' ? op.detail.trim() : ''
        if (!title && !detail) {
          errors.push(`operation ${index}: edit-text needs title and/or detail`)
          return
        }
        operations.push({
          type: 'edit-text',
          targetSemanticId: target,
          ...(title ? { title } : {}),
          ...(detail ? { detail } : {}),
        })
        return
      }
      case 'add-relation': {
        const edgeId = typeof op.semanticEdgeId === 'string' ? op.semanticEdgeId : ''
        const from = typeof op.from === 'string' ? op.from : ''
        const to = typeof op.to === 'string' ? op.to : ''
        if (!edgeId) {
          errors.push(`operation ${index}: add-relation needs a semanticEdgeId`)
          return
        }
        if (graph.edgeIds.has(edgeId)) {
          errors.push(`operation ${index}: relation id "${edgeId}" already exists`)
          return
        }
        if (!graph.nodeIds.has(from) || !graph.nodeIds.has(to)) {
          errors.push(
            `operation ${index}: add-relation references missing node ("${from}" / "${to}")`,
          )
          return
        }
        if (from === to) {
          errors.push(`operation ${index}: add-relation from === to (self relation)`)
          return
        }
        const presentation =
          typeof op.presentation === 'string' && op.presentation ? op.presentation : 'arrow'
        operations.push({
          type: 'add-relation',
          semanticEdgeId: edgeId,
          from,
          to,
          presentation,
        })
        return
      }
      case 'remove-relation': {
        const edgeId = typeof op.semanticEdgeId === 'string' ? op.semanticEdgeId : ''
        if (!graph.edgeIds.has(edgeId)) {
          errors.push(`operation ${index}: remove-relation references missing relation "${edgeId}"`)
          return
        }
        operations.push({ type: 'remove-relation', semanticEdgeId: edgeId })
        return
      }
    }
  })
  if (errors.length > 0) return { plan: null, errors }
  if (operations.length === 0) {
    return { plan: null, errors: ['"operations" must contain at least one operation'] }
  }
  return { plan: { intent, operations }, errors: [] }
}

/** Recovered semantic identity of one canvas element (render space, px). */
export interface SemanticElementView {
  sourceId: string
  componentType: string
  semanticNodeId?: string
  visualUnitId?: string
  semanticEdgeId?: string
  box: { x: number; y: number; w: number; h: number }
}

/** Walk the whole render tree (groups included) and collect research elements. */
export function collectSemanticElements(slide: RenderSlide): SemanticElementView[] {
  const out: SemanticElementView[] = []
  const walk = (nodes: unknown[]) => {
    for (const raw of nodes) {
      const node = raw as {
        sourceId?: string
        box?: { x: number; y: number; w: number; h: number }
        semanticMetadata?: Record<string, unknown>
        children?: unknown[]
      }
      if (node.semanticMetadata && node.box && node.sourceId) {
        out.push({
          sourceId: node.sourceId,
          componentType: String(node.semanticMetadata.componentType ?? ''),
          semanticNodeId:
            typeof node.semanticMetadata.semanticNodeId === 'string'
              ? node.semanticMetadata.semanticNodeId
              : undefined,
          visualUnitId:
            typeof node.semanticMetadata.visualUnitId === 'string'
              ? node.semanticMetadata.visualUnitId
              : undefined,
          semanticEdgeId:
            typeof node.semanticMetadata.semanticEdgeId === 'string'
              ? node.semanticMetadata.semanticEdgeId
              : undefined,
          box: { ...node.box },
        })
      }
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(slide.nodes)
  return out
}

/**
 * Compile a validated EditPlan into ONE atomic transaction's ops against the
 * CURRENT render tree. Ops are semantic-id addressed; the executor resolves
 * them to live element ids via the stamped metadata.
 */
export function editPlanToTxnOps(
  plan: EditPlan,
  slide: RenderSlide,
  args: { slideIndex: number; scale: number },
): { ops: Array<Record<string, unknown>>; appliedDescriptions: string[] } {
  const toEmu = (px: number) => pxToEmu(px, args.scale)
  const elements = collectSemanticElements(slide)
  const moduleById = new Map(
    elements
      .filter((el) => el.componentType === 'research-module' && el.semanticNodeId)
      .map((el) => [el.semanticNodeId!, el]),
  )
  const connectorByEdge = new Map(
    elements
      .filter((el) => el.componentType === 'research-connector' && el.semanticEdgeId)
      .map((el) => [el.semanticEdgeId!, el]),
  )
  const ops: Array<Record<string, unknown>> = []
  const appliedDescriptions: string[] = []
  const slideTarget = { slide: args.slideIndex }

  for (const op of plan.operations) {
    if (op.type === 'move' || op.type === 'resize') {
      const el = moduleById.get(op.targetSemanticId)
      if (!el) throw new Error(`element for "${op.targetSemanticId}" not found on the canvas`)
      const next =
        op.type === 'move'
          ? {
              x: el.box.x + op.dxPx,
              y: el.box.y + op.dyPx,
              w: el.box.w,
              h: el.box.h,
            }
          : { x: el.box.x, y: el.box.y, w: op.wPx, h: op.hPx }
      ops.push({
        op: 'setTransform',
        target: { slide: args.slideIndex, el: el.sourceId },
        box: {
          x: toEmu(Math.round(next.x)),
          y: toEmu(Math.round(next.y)),
          cx: toEmu(Math.round(next.w)),
          cy: toEmu(Math.round(next.h)),
        },
      })
      appliedDescriptions.push(
        op.type === 'move'
          ? `moved ${op.targetSemanticId} by (${Math.round(op.dxPx)}, ${Math.round(op.dyPx)})px`
          : `resized ${op.targetSemanticId} to ${Math.round(op.wPx)}×${Math.round(op.hPx)}px`,
      )
    } else if (op.type === 'edit-text') {
      const el = moduleById.get(op.targetSemanticId)
      if (!el) throw new Error(`element for "${op.targetSemanticId}" not found on the canvas`)
      const paragraphs: Array<Record<string, unknown>> = []
      if (op.title) {
        paragraphs.push({ runs: [{ text: op.title, bold: true }] })
      }
      if (op.detail) {
        paragraphs.push({ runs: [{ text: op.detail }] })
      }
      ops.push({
        op: 'setText',
        target: { slide: args.slideIndex, el: el.sourceId },
        paragraphs,
      })
      appliedDescriptions.push(
        `edited text of ${op.targetSemanticId}${op.title ? ` title="${op.title}"` : ''}${op.detail ? ` detail="${op.detail}"` : ''}`,
      )
    } else if (op.type === 'add-relation') {
      const from = moduleById.get(op.from)
      const to = moduleById.get(op.to)
      if (!from || !to) {
        throw new Error(`add-relation endpoints not found (${op.from} / ${op.to})`)
      }
      // straight connector between facing midpoints (right→left is the LR default)
      const createOpIndex = ops.length
      ops.push({
        op: 'addElement',
        target: slideTarget,
        kind:
          op.presentation === 'inhibition'
            ? 'lineArrow'
            : op.presentation === 'line'
              ? 'line'
              : 'lineArrow',
        offset: {
          x: toEmu(Math.min(from.box.x + from.box.w, to.box.x)),
          y: toEmu(from.box.y + from.box.h / 2),
          cx: toEmu(Math.max(1, Math.abs(to.box.x - (from.box.x + from.box.w)))),
          cy: 0,
        },
        stroke: { color: '#263746', widthEmu: Math.round(1.5 * 12700) },
        semanticMetadata: {
          role: 'research-connector',
          themeFill: 'none',
          themeStroke: 'connector',
          themeText: 'none',
          componentType: 'research-connector',
          semanticEdgeId: op.semanticEdgeId,
          relationPresentation: op.presentation ?? 'arrow',
        },
      })
      ops.push({
        op: 'setConnectorEndpoints',
        target: { slide: args.slideIndex, el: `$txn:${createOpIndex}` },
        p1: { x: toEmu(from.box.x + from.box.w), y: toEmu(from.box.y + from.box.h / 2) },
        p2: { x: toEmu(to.box.x), y: toEmu(to.box.y + to.box.h / 2) },
        start: { targetId: from.sourceId, idx: 3 },
        end: { targetId: to.sourceId, idx: 1 },
      })
      appliedDescriptions.push(`added relation ${op.from}→${op.to} (${op.semanticEdgeId})`)
    } else if (op.type === 'remove-relation') {
      const el = connectorByEdge.get(op.semanticEdgeId)
      if (!el) throw new Error(`connector for "${op.semanticEdgeId}" not found on the canvas`)
      ops.push({
        op: 'deleteElement',
        target: { slide: args.slideIndex, el: el.sourceId },
      })
      appliedDescriptions.push(`removed relation ${op.semanticEdgeId}`)
    }
  }
  return { ops, appliedDescriptions }
}

/** Build the structured edit prompt: recovered graph + instruction. */
export function composeEditPlanPrompt(graphSummary: string, instruction: string): string {
  return [
    'You are editing an EXISTING research figure. The figure was recovered from slide metadata — trust it over any screenshot.',
    'Current figure state:',
    graphSummary,
    'User instruction:',
    instruction,
    'Reply with ONLY one JSON EditPlan object:',
    '{"intent":"...","operations":[{"type":"move|resize|edit-text|add-relation|remove-relation", ...}]}',
    'Operation fields: move{targetSemanticId,dxPx,dyPx} resize{targetSemanticId,wPx,hPx} edit-text{targetSemanticId,title?,detail?} add-relation{semanticEdgeId,from,to,presentation} remove-relation{semanticEdgeId}.',
    'targetSemanticId/from/to MUST be existing node ids from the figure state above. Coordinates are canvas pixels.',
  ].join('\n')
}

/** Shared fail helper shape (mirrors the tool). */
export const editPlanFail = (output: string) => ({
  output,
  isError: true as const,
  mutated: false,
  summary: t('aiFailNewElement'),
})

export interface EditExecutorAccess {
  getSlides: () => RenderSlide[]
  applyDeck: (slides: RenderSlide[]) => void
  runLlm?: (
    system: string,
    user: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; text?: string; error?: string }>
}

interface SlidesApiForEdit {
  applyTxn?: (req: {
    ops: Array<Record<string, unknown>>
    isolation?: 'atomic' | 'per_op'
  }) => Promise<{
    applied: boolean
    slides?: RenderSlide[]
    failures?: Array<{ index: number; error: string }>
  } | null>
  undo?: () => Promise<RenderSlide[] | null>
}

export interface EditExecutionResult {
  ok: boolean
  output: string
  /** rollback failed — canvas state UNCERTAIN */
  critical?: boolean
}

/**
 * Full weak-model edit path: recover graph → strict parse → ONE atomic txn →
 * layout audit → rollback on any failure (fail-closed, same as creation).
 */
export async function executeStructuredEdit(
  access: EditExecutorAccess,
  instruction: string,
  args: {
    slideIndex?: number
    signal?: AbortSignal
    runStructured?: (o: {
      system: string
      user: string
      signal?: AbortSignal
    }) => Promise<{ ok: boolean; text?: string; error?: string }>
  },
): Promise<EditExecutionResult> {
  const slides = access.getSlides()
  let idx = args.slideIndex ?? 0
  if (!slides[idx]) idx = 0
  const slide = slides[idx]
  if (!slide) return { ok: false, output: 'no canvas to edit' }
  const slidesApi = (window as unknown as { slidesApi?: SlidesApiForEdit }).slidesApi
  if (!slidesApi?.applyTxn) return { ok: false, output: 'transaction API unavailable' }
  if (typeof slidesApi.undo !== 'function') {
    return { ok: false, output: 'no rollback capability; refusing to edit' }
  }
  const payload = slide.researchMetadata
  if (!payload) {
    return {
      ok: false,
      output:
        'this page is not a generated research figure (no slide metadata to recover the semantic graph from)',
    }
  }
  const elements = collectSemanticElements(slide)
  const nodeIds = new Set(
    elements.filter((el) => el.semanticNodeId).map((el) => el.semanticNodeId!),
  )
  const edgeIds = new Set(
    elements.filter((el) => el.semanticEdgeId).map((el) => el.semanticEdgeId!),
  )
  const graphSummary = [
    `figure ${payload.figureRunId} | domain ${payload.domain} | family ${payload.figureFamily}`,
    `nodes: ${payload.nodes.map((n) => `${n.id}(${n.title})`).join(', ')}`,
    `relations: ${payload.relations.map((r) => `${r.id}:${r.from}->${r.to} ${r.presentation} [${r.status}]`).join('; ')}`,
    `editable semantic node ids: [${[...nodeIds].join(', ')}]`,
  ].join('\n')
  const system = composeEditPlanPrompt(graphSummary, instruction)
  const user = instruction
  let raw: unknown
  try {
    if (args.runStructured) {
      const r = await args.runStructured({
        system,
        user,
        ...(args.signal ? { signal: args.signal } : {}),
      })
      if (!r.ok || !r.text)
        return { ok: false, output: `edit plan request failed: ${r.error ?? 'empty'}` }
      const start = r.text.indexOf('{')
      const end = r.text.lastIndexOf('}')
      raw = JSON.parse(r.text.slice(start, end + 1))
    } else if (access.runLlm) {
      const r = await access.runLlm(system, user, args.signal)
      if (!r.ok || !r.text)
        return { ok: false, output: `edit plan request failed: ${r.error ?? 'empty'}` }
      const start = r.text.indexOf('{')
      const end = r.text.lastIndexOf('}')
      raw = JSON.parse(r.text.slice(start, end + 1))
    } else {
      return { ok: false, output: 'no LLM transport' }
    }
  } catch (err) {
    return {
      ok: false,
      output: 'edit plan not parseable: ' + (err instanceof Error ? err.message : String(err)),
    }
  }
  const parsed = parseEditPlan(raw, { nodeIds, edgeIds })
  if (!parsed.plan) {
    return { ok: false, output: 'EditPlan rejected: ' + parsed.errors.join('; ') }
  }
  let compiled: { ops: Array<Record<string, unknown>>; appliedDescriptions: string[] }
  try {
    compiled = editPlanToTxnOps(parsed.plan, slide, {
      slideIndex: idx,
      scale: slide.scale > 0 ? slide.scale : 1,
    })
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  }
  compiled.ops.push({
    op: 'setSlideResearchMetadata',
    target: { slide: idx },
    payload: {
      ...payload,
      // intent trail keeps the edit history on the figure itself
      editTrail: [...(payload.editTrail ?? []), parsed.plan.intent],
    },
  })
  const result = await slidesApi.applyTxn({ ops: compiled.ops, isolation: 'atomic' })
  if (!result || !result.applied) {
    const detail = (result?.failures ?? []).map((f) => `[${f.index}] ${f.error}`).join('; ')
    return {
      ok: false,
      output: 'edit transaction rolled back (canvas unchanged)' + (detail ? `: ${detail}` : ''),
    }
  }
  const written = result.slides?.[idx]
  if (!written) {
    const restored = await slidesApi.undo()
    if (!restored)
      return {
        ok: false,
        critical: true,
        output: 'CRITICAL_TRANSACTION_ROLLBACK_FAILED: rebuilt slide missing and undo failed',
      }
    access.applyDeck(restored)
    return { ok: false, output: 'rebuilt slide missing after edit; canvas rolled back' }
  }
  return {
    ok: true,
    output:
      'Applied ' +
      compiled.appliedDescriptions.length +
      ' edit(s): ' +
      compiled.appliedDescriptions.join('; '),
  }
}
