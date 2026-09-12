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
  parseFigurePlanV2WithDiagnostics,
  parseSpatialPlanWithDiagnostics,
  revertAction,
  spatialPlanJsonSchema,
  type CapabilityInput,
  type FigurePlanV2,
} from '@genoffice/research-harness'
import { getThemeById } from '@genoffice/theme-engine'
import type { BridgedTheme } from '@genoffice/ppt-template-intelligence'
import type { RenderSlide } from '@genoffice/pptx-render'
import { effectivePrompt } from '../ai/prompt-overrides'
import { auditSlideLayout } from '../ai/layout-audit'
import { t } from '../i18n/locale'
import { buildFigureRenderPlan } from './native-figure-renderer'
import { figurePlanToTxnOps, verifyFigureWrite } from './transaction'
import { renderCandidatePreview, toAgentImage } from './candidate-preview'
import type { VisionReview } from '@genoffice/research-harness'

/**
 * P1-1 vision rubric: the reviewer scores ONLY visual qualities. Scientific
 * truth stays with the Scientific Critic — vision can never outvote it.
 */
const VISION_RUBRIC_PROMPT = `You are a Vision Critic for research figures. You see ONE screenshot.
Score each dimension 0-10 (integers): scientificReadability, fiveSecondClarity, visualHierarchy, composition, relationClarity, typography, visualRestraint, domainAppropriateness, professionalAppearance.
Also list blockingProblems (empty array if none) and optional repairSuggestions.
You judge APPEARANCE only; you cannot judge factual truth or evidence validity.
Reply with ONLY one JSON object: {"scientificReadability":n,...,"blockingProblems":[...],"repairSuggestions":[{"repairClass":"...","targetIds":["..."],"instruction":"..."}]}`

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
    images?: Array<{ base64: string; mime: string }>,
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
  /** true when a rollback itself failed — canvas state is UNCERTAIN */
  mutated: boolean
  summary: string
  /** P0-1: critical marker, see output text for manual-recovery guidance */
  critical?: true
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

/** Count rendered nodes still carrying the figure run's identity (rollback leak check). */
function figureRunLeak(slide: { nodes: unknown[] }, runId: string): number {
  let leaks = 0
  const walk = (
    nodes: Array<{ semanticMetadata?: Record<string, unknown>; children?: unknown[] }>,
  ) => {
    for (const node of nodes) {
      if (node.semanticMetadata?.figureRunId === runId) leaks++
      if (Array.isArray(node.children)) walk(node.children as typeof nodes)
    }
  }
  walk(slide.nodes as Parameters<typeof walk>[0])
  return leaks
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
  // Retry-budget layering (P0-2): Protocol Repair (JSON shape, schema,
  // references) lives HERE with maxRepairs=1 per request. Scientific Replan
  // (evidence, causality, abstraction) lives in the orchestrator's
  // planSemanticFigure with its own budget. The two never multiply.
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
          // P0-2: REAL runtime validation — the machine schema is enforced by
          // executing the production parser; its exact diagnostics become the
          // repair feedback instead of a structural typeof check.
          validate: (value) => {
            const parsed = parseFigurePlanV2WithDiagnostics(value)
            if (!parsed.plan) {
              throw new Error(parsed.errors.join('; ') || 'FigurePlan failed schema validation')
            }
            return parsed.plan as unknown as Record<string, unknown>
          },
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
          // P0-2: strict runtime validation against the CURRENT plan —
          // placement ids must resolve to real nodes, boxHints must be 0..1
          // fractions, visualPlan refs must resolve; exact diagnostics feed
          // the single protocol repair turn.
          validate: (value) => {
            const plan = ctx.plan as FigurePlanV2
            const nodeIds = plan.nodes.map((node) => node.id)
            const edgeIds = plan.edges.map((edge) => edge.id ?? `${edge.from}->${edge.to}`)
            const parsed = parseSpatialPlanWithDiagnostics(value, nodeIds, {
              edgeIds,
              planNodes: plan.nodes.map((node) => ({
                id: node.id,
                semanticLabel: node.semanticLabel,
                visible: { title: node.visible.title },
              })),
            })
            if (!parsed.plan) {
              throw new Error(parsed.errors.join('; ') || 'SpatialPlan failed schema validation')
            }
            // the decomposition travels WITH the spatial plan, exactly like the
            // orchestrator's own modelPlan composition
            return {
              ...parsed.plan,
              ...(parsed.visualPlan && parsed.visualPlan.modules.length > 0
                ? { visualPlan: parsed.visualPlan }
                : {}),
            } as unknown as Record<string, unknown>
          },
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
  const contractProvided =
    typeof call.input.contract === 'object' && call.input.contract !== null
      ? Object.keys(call.input.contract as Record<string, unknown>).length > 0
      : Boolean(
          call.input.figureFamily ||
          call.input.domain ||
          call.input.venue ||
          call.input.outputContext,
        )
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
  // P0-4 fail-closed: a DECLARED but unparseable contract is a hard error —
  // silently proceeding without gates would ship ungated scientific claims.
  if (contractProvided && !contract) {
    return fail(
      t('aiFailNewElement'),
      'the declared FigureContract is invalid (check provenance/evidence entries: every item needs an explicit source: user|document|search|dataset|sample|derived)',
    )
  }
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
      // P1-1: the screenshot vision reviewer participates in candidate
      // selection whenever this session can render previews AND the model
      // accepts image input (probe-gated; unprobed gateways stay text-only).
      ...(access.runLlm &&
      access.getCapabilityProfile &&
      capabilityProfile?.confidence === 'probed' &&
      capabilityProfile.vision
        ? {
            vision: {
              renderPreview: (
                candidate: import('@genoffice/research-harness').CompositionCandidate,
                context: import('@genoffice/research-harness').PreviewRenderContext,
              ) =>
                renderCandidatePreview({
                  candidate,
                  plan: context.plan,
                  planNodes: context.planNodes,
                  visualPlan: context.visualPlan,
                  domain: context.domain,
                  canvasW: slide.widthPx,
                  canvasH: slide.heightPx,
                  theme: figureThemeRoles,
                }),
              visionReview: async (
                _candidate: import('@genoffice/research-harness').CompositionCandidate,
                screenshotPngBase64: string,
              ): Promise<VisionReview | null> => {
                const r = await access.runLlm!(
                  VISION_RUBRIC_PROMPT,
                  'Review this research figure screenshot. Reply with ONLY the rubric JSON.',
                  signal,
                  [toAgentImage(screenshotPngBase64)],
                )
                if (!r.ok || !r.text) return null
                try {
                  const start = r.text.indexOf('{')
                  const end = r.text.lastIndexOf('}')
                  const parsed = JSON.parse(r.text.slice(start, end + 1)) as VisionReview
                  return typeof parsed.scientificReadability === 'number' ? parsed : null
                } catch {
                  return null
                }
              },
            },
          }
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
  // GOAL section 20 theme bridge: when the caller supplies a template's analyzed
  // theme (template-fill flow), it wins over the preset themeId — figures
  // rendered INTO a template deck inherit the template palette/fonts.
  const bridged = (call.input as { templateTheme?: BridgedTheme }).templateTheme
  const figureThemeRoles = bridged
    ? bridged.roles
    : (
        getThemeById(String(call.input.themeId ?? 'academic-blue')) ??
        getThemeById('academic-blue')!
      ).roles
  const renderPlan = buildFigureRenderPlan({
    plan: orchestration.plan,
    solve: orchestration.best.solve,
    routes: orchestration.routes,
    visualPlan: orchestration.visualPlan ?? { modules: [] },
    domain: orchestration.domain,
    canvasW: slide.widthPx,
    canvasH: slide.heightPx,
    theme: figureThemeRoles,
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

  // ── ONE atomic transaction (P0-1 fail-closed) ──
  // Rule B: rollback capability is a MUTATION PRECONDITION. Post-write
  // verification that cannot roll back must never run against a mutated
  // canvas, so a session without undo refuses the write up front.
  if (typeof slidesApi.undo !== 'function') {
    return fail(
      t('aiFailNewElement'),
      'this renderer session has no undo/rollback capability; refusing to create the figure (post-write verification must be able to restore the canvas)',
    )
  }
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

  // Rollback helper: undo MUST restore a slide with zero elements of THIS
  // figure run — a restoration that leaks figure shapes is a failed rollback.
  const runId = renderPlan.slideMetadata.figureRunId
  const undoFn = slidesApi.undo
  const rollbackFigure = async (): Promise<{ ok: boolean; detail: string }> => {
    try {
      const restored = (await undoFn?.()) ?? null
      const restoredSlide = restored?.[idx]
      if (!restoredSlide) {
        return { ok: false, detail: 'undo returned no restored slide' }
      }
      const leak = figureRunLeak(restoredSlide, runId)
      if (leak > 0) {
        return { ok: false, detail: `undo left ${leak} figure element(s) on the canvas` }
      }
      access.applyDeck(restored)
      return { ok: true, detail: 'canvas restored' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }
  const criticalFail = (issues: string): ToolFailure => {
    // Rollback itself failed: the canvas state is UNCERTAIN. Never pretend the
    // canvas is unchanged — report a critical, mutated failure.
    revertAction(actionId, 'CRITICAL: rollback failed — ' + issues)
    return {
      output:
        'CRITICAL_TRANSACTION_ROLLBACK_FAILED: ' +
        issues +
        ' The figure write could not be rolled back; the canvas is in an uncertain state. Ask the user to check/undo manually before any further edit.',
      isError: true,
      mutated: true,
      critical: true,
      summary: t('aiFailNewElement'),
    }
  }

  // ── post-write verification against the REBUILT slide (P0-1 Rule A) ──
  const written = result.slides?.[idx]
  if (!written) {
    // applied=true without a rebuilt slide cannot be verified → roll back,
    // never return success.
    const rollback = await rollbackFigure()
    if (!rollback.ok) {
      return criticalFail(`rebuilt slide missing; rollback failed (${rollback.detail})`)
    }
    revertAction(actionId, 'rebuilt slide missing after apply')
    return fail(
      t('aiFailNewElement'),
      'the transaction applied but no rebuilt slide was returned; the canvas was rolled back and nothing was created',
    )
  }

  // Elements are re-materialized after the transaction (parse-time ids are
  // reborn), so element identity is read back from the rebuilt slide via the
  // semantic signature each spec stamped, not from the txn record mints.
  const createdIdBySpecId = new Map<string, string>()
  {
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
  const verification = verifyFigureWrite(
    written,
    renderPlan,
    createdIdBySpecId,
    auditSlideLayout(written),
  )
  if (!verification.ok) {
    // P0-1 Rule B: verification failure ALWAYS rolls back — a session without
    // undo was rejected before the mutation, so this branch can restore.
    const rollback = await rollbackFigure()
    if (!rollback.ok) {
      return criticalFail(
        `post-write verification failed (${verification.issues.join('; ')}); rollback failed (${rollback.detail})`,
      )
    }
    revertAction(actionId, 'post-write verification failed: ' + verification.issues.join('; '))
    return fail(
      t('aiFailNewElement'),
      'figure reverted after post-write verification: ' + verification.issues.join('; '),
    )
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
