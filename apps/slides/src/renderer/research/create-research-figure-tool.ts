/**
 * create_research_figure tool body (RENDER-P1-10: extracted from the
 * slides-skill god file; the skill keeps only tool registration + delegation).
 *
 * Pipeline: orchestrator → PURE render plan → ONE atomic transaction →
 * post-write verification against the rebuilt slide. The renderer consumes
 * solver geometry verbatim; a failed plan or failed verification leaves the
 * canvas exactly as it was.
 */
import type { AgentToolCall } from '../../shared/ipc'
import {
  RESEARCH_COMPOSITION_DESIGNER_POLICY,
  RESEARCH_SEMANTIC_PLANNER_POLICY,
} from '../../shared/prompt-defaults'
import {
  beginAction,
  completeAction,
  orchestrateFigure,
  parseFigureContract,
  revertAction,
  type CapabilityInput,
  type FigurePlanV2,
} from '@genoffice/research-harness'
import { getThemeById } from '@genoffice/theme-engine'
import type { RenderSlide } from '@genoffice/pptx-render'
import { effectivePrompt } from '../ai/prompt-overrides'
import { auditSlideLayout } from '../ai/layout-audit'
import { t } from '../i18n/locale'
import { buildFigureRenderPlan } from './native-figure-renderer'
import { figurePlanToTxnOps, verifyFigureWrite } from './transaction'

export interface DeckAccessLike {
  getSlides: () => RenderSlide[]
  getCurrent: () => number
  getSelectedIds: () => string[]
  applySlide: (index: number, slide: RenderSlide) => void
  applyDeck: (slides: RenderSlide[]) => void
  fitWidthPx: number
  runLlm?: (system: string, user: string) => Promise<{ ok: boolean; text?: string; error?: string }>
}

export interface ToolFailure {
  output: string
  isError: true
  mutated: false
  summary: string
}

export interface ToolSuccess {
  output: string
  isError?: undefined
  mutated: boolean
  summary: string
}

interface SlidesApiForFigure {
  applyTxn?: (req: { ops: Array<Record<string, unknown>>; isolation?: 'atomic' | 'per_op' }) => Promise<{
    applied: boolean
    records?: Array<{ op: string; created?: string[] }>
    slides?: RenderSlide[]
    failures?: Array<{ index: number; error: string }>
  } | null>
  undo?: () => Promise<RenderSlide[] | null>
}

function fail(summary: string, output: string): ToolFailure {
  return { output, isError: true, mutated: false, summary }
}

export async function executeCreateResearchFigure(deps: {
  access: DeckAccessLike
  mode: string
  call: AgentToolCall
  signal?: AbortSignal
}): Promise<ToolSuccess | ToolFailure> {
  const { access, mode, call, signal } = deps
  const slides = access.getSlides()
  const slidesApi = (window as unknown as { slidesApi?: SlidesApiForFigure }).slidesApi
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('aborted')
  }
  // Graceful degradation: agents (especially weak models) frequently pass a
  // stale slideIndex after deleting/creating canvases. Fall back to the
  // current slide instead of failing the whole creation.
  let idx = Number(call.input.slideIndex)
  if (!slides[idx]) idx = access.getCurrent()
  const slide = slides[idx]
  if (!slide)
    return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
  if (mode !== 'research') {
    return fail(t('aiFailNewElement'), 'create_research_figure runs in Research Figure Mode only')
  }
  if (!access.runLlm) return fail(t('aiFailNewElement'), 'LLM transport unavailable')
  if (!slidesApi?.applyTxn) {
    return fail(t('aiFailNewElement'), 'transaction API unavailable in this renderer session')
  }
  const thesis = String(call.input.thesis ?? '').trim()
  if (!thesis) return fail(t('aiFailNewElement'), 'thesis is required')
  const notes = String(call.input.notes ?? '').trim()
  const parseJson = (text: string): unknown => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
    const raw = (fenced ? fenced[1]! : text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw)
  }
  const plannerUser = [
    'Canvas: ' + slide.widthPx + 'x' + slide.heightPx + 'px (px, origin top-left)',
    'Request: ' + thesis,
    notes ? 'Material notes:\n' + notes : '',
  ]
    .filter(Boolean)
    .join('\n')
  const llm = {
    semanticPlan: async (_thesis: string, feedback?: string) => {
      const r = await access.runLlm!(
        effectivePrompt('research.semantic-planner', RESEARCH_SEMANTIC_PLANNER_POLICY),
        feedback
          ? plannerUser +
              '\n\nPrevious attempt rejected by schema validation: ' +
              feedback +
              '\nFix the issues and output the JSON object again.'
          : plannerUser,
      )
      if (!r.ok) throw new Error(r.error ?? 'planner call failed')
      return parseJson(r.text ?? '')
    },
    compose: async (ctx: unknown) => {
      const r = await access.runLlm!(
        effectivePrompt('research.composition-designer', RESEARCH_COMPOSITION_DESIGNER_POLICY),
        JSON.stringify(ctx),
      )
      if (!r.ok) return null
      try {
        return parseJson(r.text ?? '')
      } catch {
        return null
      }
    },
  }
  const contract = parseFigureContract({
    centralClaim: thesis,
    figureFamily: String(call.input.figureFamily ?? ''),
    domain: String(call.input.domain ?? ''),
    venue: String(call.input.venue ?? ''),
    output: { context: String(call.input.outputContext ?? '') },
  })
  const orchestration = await orchestrateFigure(
    {
      thesis,
      canvasW: slide.widthPx,
      canvasH: slide.heightPx,
      capability: call.input.capability as CapabilityInput | undefined,
      ...(contract ? { contract } : {}),
    },
    llm,
  )
  if (
    !orchestration.ok ||
    !orchestration.plan ||
    !orchestration.best ||
    !orchestration.routes ||
    !orchestration.critic ||
    orchestration.critic.verdict === 'RECOMPOSE'
  ) {
    const reason =
      orchestration.error ??
      'composition ' +
        (orchestration.critic?.verdict ?? 'failed') +
        ': ' +
        (orchestration.critic?.gateIssues.join('; ') || 'critic below threshold')
    return fail(t('aiFailNewElement'), reason)
  }
  const plan: FigurePlanV2 = orchestration.plan
  const theme = getThemeById(String(call.input.themeId ?? 'academic-blue')) ?? getThemeById('academic-blue')!
  const fontScale = orchestration.contractFontScale ?? 1

  // ── PURE render plan: exact geometry, content policy, z-order ──
  const renderPlan = buildFigureRenderPlan({
    plan: orchestration.plan,
    solve: orchestration.best.solve,
    routes: orchestration.routes,
    visualPlan: orchestration.visualPlan ?? { modules: [] },
    domain: orchestration.domain,
    canvasW: slide.widthPx,
    canvasH: slide.heightPx,
    theme: theme.roles,
    ...(Number.isFinite(fontScale) && fontScale !== 1 ? { fontScale } : {}),
    thesis,
  })
  const hardDefects = renderPlan.defects.filter((defect) => defect.severity === 'hard')
  if (hardDefects.length > 0) {
    return fail(
      t('aiFailNewElement'),
      'render plan rejected (exact-geometry contract): ' +
        hardDefects.map((defect) => defect.message).join('; '),
    )
  }

  // ── ONE atomic transaction ──
  const scale = slide.scale > 0 ? slide.scale : 1
  const txn = figurePlanToTxnOps(renderPlan, { slideIndex: idx, scale })
  const actionId = beginAction('Create research figure (orchestrated)')
  throwIfAborted()
  let result: Awaited<ReturnType<NonNullable<SlidesApiForFigure['applyTxn']>>>
  try {
    result = await slidesApi.applyTxn({ ops: txn.ops, isolation: 'atomic' })
  } catch (err) {
    revertAction(actionId, err instanceof Error ? err.message : String(err))
    return fail(t('aiFailNewElement'), 'figure transaction failed: ' + (err instanceof Error ? err.message : String(err)))
  }
  if (!result || !result.applied) {
    revertAction(actionId)
    const detail = (result?.failures ?? [])
      .map((f) => `[${f.index}] ${f.error}`)
      .join('; ')
    return fail(
      t('aiFailNewElement'),
      'figure transaction rolled back (canvas unchanged)' + (detail ? `: ${detail}` : ''),
    )
  }

  // ── post-write verification against the REBUILT slide (P1-09) ──
  // Elements are re-materialized after the transaction (parse-time ids are
  // reborn), so element identity is read back from the rebuilt slide via the
  // semantic signature each spec stamped, not from the txn record mints.
  const written = result.slides?.[idx]
  const createdIdBySpecId = new Map<string, string>()
  if (written) {
    const sigKeys = ['componentType', 'semanticNodeId', 'visualUnitId', 'semanticEdgeId'] as const
    const signature = (meta: Record<string, unknown>): string =>
      sigKeys.map((key) => `${meta[key] ?? ''}`).join('|')
    const specBySignature = new Map<string, string>()
    for (const element of renderPlan.elements) {
      specBySignature.set(
        signature(element.semanticMetadata as unknown as Record<string, unknown>),
        element.specId,
      )
    }
    const walk = (nodes: Array<{ sourceId: string; semanticMetadata?: Record<string, unknown>; children?: unknown[] }>) => {
      for (const node of nodes) {
        if (node.semanticMetadata) {
          const specId = specBySignature.get(signature(node.semanticMetadata))
          if (specId && !createdIdBySpecId.has(specId)) createdIdBySpecId.set(specId, node.sourceId)
        }
        if (Array.isArray(node.children)) walk(node.children as typeof nodes)
      }
    }
    walk(written.nodes as Parameters<typeof walk>[0])
  }
  let verification: { ok: boolean; issues: string[] }
  if (written) {
    verification = verifyFigureWrite(written, renderPlan, createdIdBySpecId, auditSlideLayout(written))
    if (!verification.ok && slidesApi.undo) {
      // Audit failed post-commit: undo restores the exact pre-transaction
      // snapshot — the canvas never keeps an unvouched figure.
      const restored = await slidesApi.undo()
      if (restored) access.applyDeck(restored)
      revertAction(actionId, 'post-write verification failed: ' + verification.issues.join('; '))
      return fail(
        t('aiFailNewElement'),
        'figure reverted after post-write verification: ' + verification.issues.join('; '),
      )
    }
  }
  if (written) access.applySlide(idx, written)

  const boundCount = txn.bindings.length
  completeAction(
    actionId,
    'orchestrated figure: ' +
      plan.nodes.length +
      ' nodes, ' +
      boundCount +
      '/' +
      orchestration.routes.length +
      ' connectors bound, ' +
      renderPlan.groups.length +
      ' composite groups',
  )
  const softDefects = renderPlan.defects.filter((defect) => defect.severity === 'soft')
  return {
    output:
      'Created an orchestrated research figure on page ' +
      (idx + 1) +
      ': ' +
      plan.nodes.length +
      ' nodes, ' +
      boundCount +
      ' native-bound connectors. Composition: ' +
      orchestration.best.source +
      (orchestration.best.priorId ? '/' + orchestration.best.priorId : '') +
      ' at autonomy ' +
      orchestration.autonomy +
      '. Critic: ' +
      orchestration.critic.verdict +
      ' (overall ' +
      orchestration.critic.scores.overall +
      '/10). Element ids: ' +
      [...createdIdBySpecId.values()].join(', ') +
      '. Semantic graph + relation statuses saved to the slide metadata.' +
      (softDefects.length > 0
        ? ' Notes: ' + softDefects.map((defect) => defect.message).join('; ')
        : ''),
    mutated: true,
    summary: t('aiSumNewShape', { n: idx + 1 }),
  }
}
