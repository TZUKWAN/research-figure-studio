/**
 * create_research_figure tool body (RENDER-P1-10: extracted from the
 * slides-skill god file; the skill keeps only tool registration + ONE
 * delegation — this module is the ONLY production implementation).
 *
 * Pipeline: structured semantic planner (machine protocol) → orchestrator →
 * PURE render plan → ONE atomic transaction → post-write verification against
 * the rebuilt slide. The renderer consumes solver geometry verbatim; a failed
 * plan or failed verification leaves the canvas exactly as it was.
 */
import {
  requestStructured,
  sanitizeAgentPayload,
  type StructuredTransport,
} from '@genoffice/agent-core'
import { calibrationFromProfile, type ModelCapabilityProfile } from '@genoffice/ai-provider'
import type { AgentToolCall } from '../../shared/ipc'
import {
  RESEARCH_COMPOSITION_DESIGNER_POLICY,
  RESEARCH_SEMANTIC_PLANNER_POLICY,
} from '../../shared/prompt-defaults'
import {
  composeCompositionDesignerPrompt,
  composeSemanticPlannerPrompt,
} from '../../shared/prompt-protocol'
import {
  beginAction,
  completeAction,
  figurePlanJsonSchema,
  orchestrateFigure,
  parseFigureContract,
  revertAction,
  spatialPlanJsonSchema,
  type CapabilityInput,
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
  onProgress?(event: {
    stage: 'figure'
    label: string
    status: 'running' | 'done' | 'error'
    summary: string
  }): void
  runLlm?: (
    system: string,
    user: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: boolean; text?: string; error?: string }>
  runStructured?(options: {
    system: string
    user: string
    jsonSchema?: { name: string; schema: Record<string, unknown> }
    signal?: AbortSignal
  }): Promise<{ ok: boolean; text?: string; error?: string }>
  getCapabilityProfile?(): Promise<ModelCapabilityProfile | null>
}

/** Structured facts kept out of conversational history (AI-P0-10). */
export interface DurableFigureState {
  thesis: string
  slideIndex: number
  contractCentralClaim?: string
  planSummary?: {
    figureType: string
    nodeCount: number
    edgeCount: number
    expressionMode: string
  }
  userConstraints: string[]
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
  applyTxn?: (req: {
    ops: Array<Record<string, unknown>>
    isolation?: 'atomic' | 'per_op'
  }) => Promise<{
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

const STAGE_BUDGET_MS = 180_000
const STAGE_LABELS: Record<string, string> = {
  'semantic.plan': '语义规划 / semantic planning',
  'text.optimized': '文字压缩 / text optimization',
  'measurement.completed': '尺寸测量 / measurement',
  'capability.selected': '能力分级 / capability selection',
  'composition.started': '构图候选 / composition candidates',
  'composition.completed': '构图完成 / composition completed',
  'layout.solved': '几何合法化 / layout solving',
  'route.repaired': '连线修复 / connector repair',
  'layout.repaired': '布局修复 / layout repair',
  'critic.completed': '质量审计 / quality audit',
  'recompose.started': '重新构图 / recomposition',
  'figure.completed': '完成 / completed',
}

export async function executeCreateResearchFigure(deps: {
  access: DeckAccessLike
  call: AgentToolCall
  /** durable figure state store (wired when the skill state is available) */
  setDurableFigureState?: (state: DurableFigureState) => void
  signal?: AbortSignal
  onProgress?: (progress: { stage: string; message: string }) => void
}): Promise<ToolSuccess | ToolFailure> {
  const { access, call, setDurableFigureState, signal, onProgress } = deps
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
  if (!slide) return fail(t('aiFailNewElement'), `slideIndex out of range (0-${slides.length - 1})`)
  if (!access.runLlm && !access.runStructured) {
    return fail(t('aiFailNewElement'), 'LLM transport unavailable')
  }
  if (!slidesApi?.applyTxn) {
    return fail(t('aiFailNewElement'), 'transaction API unavailable in this renderer session')
  }
  const thesis = String(call.input.thesis ?? '').trim()
  if (!thesis) return fail(t('aiFailNewElement'), 'thesis is required')
  const notes = String(call.input.notes ?? '').trim()
  // AI-P1-10: user/document material is untrusted DATA. It travels inside a
  // <source-material> boundary the immutable protocol declares as
  // never-instruction, and is sanitized so pasted credentials never reach the
  // model provider verbatim.
  const sourceMaterial = notes
    ? `<source-material>\n${sanitizeAgentPayload(notes)}\n</source-material>`
    : ''
  const plannerUser = [
    'Canvas: ' + slide.widthPx + 'x' + slide.heightPx + 'px (px, origin top-left)',
    'Request: ' + sanitizeAgentPayload(thesis),
    sourceMaterial,
  ]
    .filter(Boolean)
    .join('\n')

  // AI-P0-06: native JSON enforcement only when the probe proved it; weak
  // structured support degrades to plain requests + bounded client repair.
  const capabilityProfile = access.getCapabilityProfile
    ? await access.getCapabilityProfile().catch(() => null)
    : null
  const probedJson = capabilityProfile?.confidence === 'probed' && capabilityProfile.structuredJson
  const structuredTransport =
    (schemaName: string, schema: Record<string, unknown>): StructuredTransport =>
    async ({ system, user, signal: transportSignal, jsonSchema: schemaFromRequest }) => {
      const carrier = probedJson ? (schemaFromRequest ?? { name: schemaName, schema }) : undefined
      if (access.runStructured) {
        const r = await access.runStructured({
          system,
          user,
          ...(carrier ? { jsonSchema: carrier } : {}),
          ...(transportSignal ? { signal: transportSignal } : {}),
        })
        return {
          ok: r.ok,
          text: r.text,
          error: r.error,
          mode: carrier ? 'native-json' : 'plain',
        }
      }
      const r = (await access.runLlm!(system, user, transportSignal))!
      return {
        ok: r.ok,
        text: r.text,
        error: r.error,
        mode: carrier ? 'native-json' : 'plain',
      }
    }
  const plannerSystem = composeSemanticPlannerPrompt(
    effectivePrompt('research.semantic-planner', RESEARCH_SEMANTIC_PLANNER_POLICY),
  )
  const plannerSchema = figurePlanJsonSchema()
  const llm = {
    semanticPlan: async (_thesis: string, feedback?: string, planSignal?: AbortSignal) => {
      const result = await requestStructured(
        structuredTransport('research_figure_plan', plannerSchema),
        {
          schemaId: 'research.semantic-planner',
          jsonSchema: { name: 'research_figure_plan', schema: plannerSchema },
          system: plannerSystem,
          user: feedback
            ? plannerUser +
              '\n\nPrevious attempt rejected by schema validation: ' +
              feedback +
              '\nFix the issues and output the JSON object again.'
            : plannerUser,
          validate: (value) => (value !== null && typeof value === 'object' ? value : null),
        },
        {
          maxRepairs: 1,
          ...((planSignal ?? signal) ? { signal: (planSignal ?? signal)! } : {}),
        },
      )
      if (!result.ok) {
        const detail = result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')
        throw new Error(`planner structured output failed: ${detail}`)
      }
      return result.value
    },
    compose: async (ctx: {
      plan: unknown
      measured: Array<{ id: string; w: number; h: number }>
      canvas: { w: number; h: number }
      autonomy: string
      critique?: string[]
      signal?: AbortSignal
    }) => {
      const designerSystem = composeCompositionDesignerPrompt(
        effectivePrompt('research.composition-designer', RESEARCH_COMPOSITION_DESIGNER_POLICY),
      )
      const result = await requestStructured(
        structuredTransport('research_spatial_plan', spatialPlanJsonSchema()),
        {
          schemaId: 'research.composition-designer',
          jsonSchema: {
            name: 'research_spatial_plan',
            schema: spatialPlanJsonSchema(),
          },
          system: designerSystem,
          user: JSON.stringify(ctx),
          validate: (value) => (value !== null && typeof value === 'object' ? value : null),
        },
        {
          maxRepairs: 1,
          ...((ctx.signal ?? signal) ? { signal: (ctx.signal ?? signal)! } : {}),
        },
      )
      if (!result.ok) {
        const detail = result.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')
        // A provider/parse failure is diagnosed by the orchestrator — but it
        // must be VISIBLE, never a silent null fallback (AI-P0-08).
        throw new Error(`composition structured output failed: ${detail}`)
      }
      return result.value
    },
  }
  // P0.5 contract bridge: the structured contract field is authoritative;
  // legacy top-level fields (domain/figureFamily/venue/outputContext) are
  // normalized into the same FigureContract for backward compatibility.
  const contractInput =
    typeof call.input.contract === 'object' && call.input.contract !== null
      ? (call.input.contract as Record<string, unknown>)
      : {}
  const contract = parseFigureContract({
    ...contractInput,
    centralClaim: String(contractInput.centralClaim ?? '') || thesis,
    figureFamily: String(contractInput.figureFamily ?? call.input.figureFamily ?? ''),
    domain: String(contractInput.domain ?? call.input.domain ?? ''),
    venue: String(contractInput.venue ?? call.input.venue ?? ''),
    output: {
      ...((contractInput.output ?? {}) as Record<string, unknown>),
      context: String(
        (contractInput.output as Record<string, unknown> | undefined)?.context ??
          call.input.outputContext ??
          '',
      ),
    },
  })
  // AI-P1-14: autonomy calibration comes from the real capability profile;
  // the tool's explicit calibration argument stays authoritative.
  const profileCalibration = calibrationFromProfile(capabilityProfile)
  const capabilityArg = call.input.capability as CapabilityInput | undefined
  const capabilityInput: CapabilityInput = {
    ...(capabilityArg ?? {}),
    ...(capabilityArg?.calibration ? {} : { calibration: profileCalibration }),
  }
  const orchestration = await orchestrateFigure(
    {
      thesis,
      canvasW: slide.widthPx,
      canvasH: slide.heightPx,
      capability: capabilityInput,
      ...(contract ? { contract } : {}),
      ...(signal ? { signal } : {}),
      stageBudgets: { semanticMs: STAGE_BUDGET_MS, compositionMs: STAGE_BUDGET_MS },
      // Probed weak tool-calling → keep the model out of the composition loop.
      ...(capabilityProfile?.confidence === 'probed' && !capabilityProfile.toolCalling
        ? { allowModelComposition: false }
        : {}),
    },
    llm,
    (event) => {
      const label = STAGE_LABELS[event.stage] ?? event.stage
      onProgress?.({ stage: event.stage, message: label })
      access.onProgress?.({
        stage: 'figure',
        label,
        status: event.ok ? 'running' : 'error',
        summary: event.detail ?? '',
      } as const)
    },
  )
  if (
    !orchestration.ok ||
    !orchestration.plan ||
    !orchestration.best ||
    !orchestration.routes ||
    !orchestration.critic ||
    orchestration.critic.verdict === 'RECOMPOSE'
  ) {
    // Machine-readable failure: typed diagnostics + fallback reason travel
    // with the error (AI-P0-08/12).
    const diagnostics = orchestration.diagnostics
      ?.map((d) => `${d.code}(${d.message})`)
      .slice(0, 4)
      .join('; ')
    const reason =
      orchestration.error ??
      'composition ' +
        (orchestration.critic?.verdict ?? 'failed') +
        ': ' +
        (orchestration.critic?.gateIssues.join('; ') || 'critic below threshold')
    return fail(
      t('aiFailNewElement'),
      [
        reason,
        orchestration.fallbackUsed
          ? `fallbackUsed: ${orchestration.fallbackReason ?? 'unknown'}`
          : '',
        diagnostics ? `diagnostics: ${diagnostics}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    )
  }

  // ── PURE render plan: exact geometry, content policy, z-order, typography SSOT ──
  const renderPlan = buildFigureRenderPlan({
    plan: orchestration.plan,
    solve: orchestration.best.solve,
    routes: orchestration.routes,
    visualPlan: orchestration.visualPlan ?? { modules: [] },
    domain: orchestration.domain,
    canvasW: slide.widthPx,
    canvasH: slide.heightPx,
    theme: (
      getThemeById(String(call.input.themeId ?? 'academic-blue')) ?? getThemeById('academic-blue')!
    ).roles,
    typography: orchestration.typography,
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
    return fail(
      t('aiFailNewElement'),
      'figure transaction failed: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
  if (!result || !result.applied) {
    revertAction(actionId)
    const detail = (result?.failures ?? []).map((f) => `[${f.index}] ${f.error}`).join('; ')
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
    const walk = (
      nodes: Array<{
        sourceId: string
        semanticMetadata?: Record<string, unknown>
        children?: unknown[]
      }>,
    ) => {
      for (const node of nodes) {
        if (node.semanticMetadata) {
          const specId = specBySignature.get(signature(node.semanticMetadata))
          if (specId && !createdIdBySpecId.has(specId)) {
            createdIdBySpecId.set(specId, node.sourceId)
          }
        }
        if (Array.isArray(node.children)) walk(node.children as typeof nodes)
      }
    }
    walk(written.nodes as Parameters<typeof walk>[0])
  }
  let verification: { ok: boolean; issues: string[] }
  if (written) {
    verification = verifyFigureWrite(
      written,
      renderPlan,
      createdIdBySpecId,
      auditSlideLayout(written),
    )
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
      orchestration.plan.nodes.length +
      ' nodes, ' +
      boundCount +
      '/' +
      orchestration.routes.length +
      ' connectors bound, ' +
      renderPlan.groups.length +
      ' composite groups',
  )
  // Durable figure state (AI-P0-10): structured facts survive independent of
  // the conversational history, so context compaction can never rewrite the
  // thesis/plan the canvas was built from.
  setDurableFigureState?.({
    thesis,
    slideIndex: idx,
    ...(contract ? { contractCentralClaim: contract.centralClaim } : {}),
    planSummary: {
      figureType: orchestration.plan.figureType,
      nodeCount: orchestration.plan.nodes.length,
      edgeCount: orchestration.plan.edges.length,
      expressionMode: orchestration.plan.narrative?.expressionMode ?? 'freeform',
    },
    userConstraints: [],
  })
  const softDefects = renderPlan.defects.filter((defect) => defect.severity === 'soft')
  const moduleIds = [...createdIdBySpecId.entries()]
    .filter(([specId]) => specId.startsWith('module:'))
    .map(([, id]) => id)
  return {
    output:
      'Created an orchestrated research figure on page ' +
      (idx + 1) +
      ': ' +
      orchestration.plan.nodes.length +
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
      '/10, crossings ' +
      orchestration.best.crossings +
      ', intent drift ' +
      Math.round(orchestration.best.solve.intentDriftPx) +
      'px)' +
      // Fallback is allowed but must never be silent (AI-P0-08).
      (orchestration.fallbackUsed
        ? `. Model composition failed and the deterministic prior was used (fallbackReason: ${orchestration.fallbackReason ?? 'unknown'}); report this to the user.`
        : '') +
      '. Element ids: ' +
      moduleIds.join(', ') +
      '. Semantic graph + relation statuses saved to the slide metadata.' +
      (softDefects.length > 0
        ? ' Notes: ' + softDefects.map((defect) => defect.message).join('; ')
        : ''),
    mutated: true,
    summary: t('aiSumNewShape', { n: idx + 1 }),
  }
}
