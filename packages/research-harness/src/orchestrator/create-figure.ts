/**
 * Creation Orchestrator (Phase 3, GOAL §23/§65) with the Visual Quality
 * Stabilization repair hierarchy: ROUTE_FIX re-runs the orthogonal router,
 * LOCAL_LAYOUT_FIX promotes the next-ranked candidate, RECOMPOSE (≤2) redraws
 * composition intent, and SEMANTIC_REPLAN (bounded) replaces the FigurePlan
 * itself and REBUILDS every derived state object (audit ORCH-P0-01..05).
 * Creation NEVER depends on tool calling; Editing keeps the existing ReAct +
 * execute_slide_script path untouched.
 */
import type { RelationPresentation } from '../semantic/schema.js'
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import { normalizeSpatialPlan, type SpatialPlan } from '../composition/spatial-plan.js'
import { measureNode, type MeasuredNode, type NodeTextSpec } from '../measurement/measure.js'
import { SEMANTIC_NODE_STYLES } from '../components/semantic-styles.js'
import {
  capabilityProfile,
  selectAutonomy,
  type AutonomyLevel,
  type CapabilityInput,
} from '../models/autonomy.js'
import { generateCandidates, type CompositionCandidate } from '../composition/candidate.js'
import type { CriticVerdict } from '../critic/metric-critic.js'
import { criticVerdict } from '../critic/metric-critic.js'
import { routeEdgesWithObstacles, type RoutedEdge } from '../routing/router.js'
import { normalizeVisualPlan } from '../visual/visualPlan.js'

import { minimumHeightForUnits, minimumWidthForUnits } from '../visual/microLayout.js'
import { auditScientific, type ScientificIssue } from '../critic/scientific-critic.js'
import { reviewCandidates } from './candidate-review.js'
import {
  OUTPUT_CONTEXT_DEFAULT_WIDTH_MM,
  OUTPUT_CONTEXT_MIN_TEXT_PT,
  publicationAudit,
  qualityThresholdFor,
} from '../contract/figure-contract.js'
import { resolveDomain } from '../contract/domain-profile.js'
import {
  compileSemanticAttempt,
  compileSemanticReplanFeedback,
  isSemanticFailure,
  planSemanticFigure,
  type SemanticAttemptState,
} from './semantic-attempt.js'
import { familyStrategyFor, UnsupportedFigureFamilyError } from '../composition/family-strategy.js'
import { downgradePresentation } from '../protocol/runtime-capabilities.js'
import { auditFigureContract, type RenderedText } from '../contract/contract-audit.js'
import { evaluateDeliveryGate } from '../delivery/delivery-gate.js'
import { resolveFigureTypography } from '../render/typography.js'
import {
  validateDomain,
  validateFamily,
  familyFromFigureType,
} from '../critic/family-validators.js'
import type { TypographySignal } from '../critic/metric-critic.js'
import { resolveReadingFlow, type ReadingFlow } from '../critic/reading-flow.js'

export interface OrchestratorLlm {
  /** semantic planner: research meaning ONLY (no coordinates/colors) */
  semanticPlan: (thesis: string, feedback?: string, signal?: AbortSignal) => Promise<unknown>
  /** composition designer: intent-level layout plus optional visual decomposition */
  compose?: (ctx: {
    plan: FigurePlanV2
    measured: Array<{ id: string; w: number; h: number }>
    canvas: { w: number; h: number }
    autonomy: AutonomyLevel
    critique?: string[]
    signal?: AbortSignal
  }) => Promise<unknown>
}

export interface FigureNodeSpec {
  /** per-semantic-type typography/padding; defaults keep nodes restrained */
  titleSizePt?: number
  detailSizePt?: number
  padX?: number
  padY?: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
}

/** Typed machine diagnostics for LLM-stage failures (AI-P0-08/09). */
export type OrchestrationDiagnosticCode =
  | 'QUALITY_REVIEW_UNAVAILABLE'
  | 'MODEL_SEMANTIC_PROVIDER_FAILED'
  | 'MODEL_SEMANTIC_PARSE_FAILED'
  | 'MODEL_SEMANTIC_SCHEMA_FAILED'
  | 'MODEL_SEMANTIC_TIMEOUT'
  | 'MODEL_SEMANTIC_CANCELLED'
  | 'MODEL_COMPOSITION_PROVIDER_FAILED'
  | 'MODEL_COMPOSITION_PARSE_FAILED'
  | 'MODEL_COMPOSITION_SCHEMA_FAILED'
  | 'MODEL_COMPOSITION_TIMEOUT'
  | 'MODEL_COMPOSITION_CANCELLED'
  | 'MODEL_PRESENTATION_DOWNGRADED'

export interface OrchestrationDiagnostic {
  code: OrchestrationDiagnosticCode
  message: string
  /** attempt index the diagnostic belongs to (0 = first semantic/compose call) */
  attempt: number
}

/** Per-stage wall-clock budgets (AI-P0-11). Undefined stage = no stage cap. */
export interface StageBudgets {
  /** semantic planner call, ms */
  semanticMs?: number
  /** each composition designer call, ms */
  compositionMs?: number
}

/** Char/latency accounting for one structured planning call (AI-P1-08). */
export interface PlanningMetric {
  stage: 'semantic' | 'composition'
  inputChars: number
  outputChars: number
  latencyMs: number
  retries: number
  providerMode?: string
}

export class StageTimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`${stage} timed out after ${ms}ms`)
    this.name = 'StageTimeoutError'
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('cancelled')
}

/** Run one stage against its budget and the run signal; rejects with StageTimeoutError on overrun. */
export async function withStageBudget<T>(
  stage: string,
  run: (signal: AbortSignal | undefined) => Promise<T>,
  options: { signal?: AbortSignal; budgetMs?: number },
): Promise<T> {
  if (options.budgetMs === undefined) return run(options.signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StageTimeoutError(stage, options.budgetMs!)),
      options.budgetMs,
    )
  })
  try {
    return await Promise.race([run(options.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export interface OrchestrationInput {
  thesis: string
  canvasW: number
  canvasH: number
  capability?: CapabilityInput
  autonomyOverride?: AutonomyLevel
  /** run cancellation (AI-P1-05): checked between stages and inside LLM calls */
  signal?: AbortSignal
  /** per-stage LLM budgets (AI-P0-11); stage-specific policy lives with the caller */
  stageBudgets?: StageBudgets
  nodeSpec?: FigureNodeSpec
  measure?: typeof measureNode
  maxRecompose?: number
  /** bounded semantic replans (real FigurePlan replacement); default 1 */
  maxSemanticReplans?: number
  /** publication contract (P1): venue, final size, forbidden claims, provenance */
  contract?: import('../contract/figure-contract.js').FigureContract
  /**
   * P1-1: production vision review. When provided, surviving candidates are
   * rendered off-screen, reviewed by a screenshot critic, and the blended
   * winner is selected — vision PARTICIPATES in candidate selection. When
   * absent, publication-grade contracts fail the delivery gate honestly
   * (VISION_REVIEW_UNAVAILABLE) instead of claiming submission quality.
   */
  vision?: {
    renderPreview: import('./candidate-review.js').PreviewRenderer
    visionReview: import('./candidate-review.js').VisionReviewer
  }
  /** domain hint when no contract is supplied */
  domainHint?: string
}

export type OrchestrationStage =
  | 'vision.review.adopted'
  | 'semantic.plan'
  | 'semantic.plan.started'
  | 'semantic.plan.completed'
  | 'semantic.plan.failed'
  | 'semantic.replan.started'
  | 'semantic.replan.completed'
  | 'semantic.replan.failed'
  | 'text.optimized'
  | 'measurement.completed'
  | 'capability.selected'
  | 'composition.started'
  | 'composition.completed'
  | 'layout.solved'
  | 'route.repaired'
  | 'layout.repaired'
  | 'critic.started'
  | 'critic.completed'
  | 'recompose.started'
  | 'figure.completed'
  | 'figure.failed'

export interface OrchestrationEvent {
  stage: OrchestrationStage
  ok: boolean
  detail?: string
  /** wall-clock ms — events are real happenings, never pre-emptive oks */
  timestamp: number
  /** semantic attempt index (0 = initial plan) */
  attemptId?: number
  /** candidate identifier when one is in scope */
  candidateId?: string
}

/** Repair hierarchy actually applied (extended P0 ladder + real L6). */
export type AppliedRepair =
  | 'L2 ROUTE_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX (budget exhausted)'
  | 'L4 COMPOSITION_REDESIGN'
  | 'L5 RECOMPOSE (semantic replan budget exhausted)'
  | 'L5 RECOMPOSE (composition redesign)'
  | 'L6 SEMANTIC_REPLAN'
  | 'L6 SEMANTIC_REPLAN (replan failed)'
  | 'CONTENT_REDUCE'
  | 'TYPOGRAPHY_FIX'

export interface OrchestrationResult {
  ok: boolean
  trace: OrchestrationEvent[]
  plan?: FigurePlanV2
  autonomy?: AutonomyLevel
  measured?: MeasuredNode[]
  best?: CompositionCandidate
  /** the WINNER's decomposition only — never a previous attempt's (ORCH-P0-04) */
  visualPlan?: import('../visual/visualPlan.js').VisualPlan
  /** resolved scientific domain (P1): drives renderer primitives + connector language */
  domain?: import('../contract/domain-profile.js').ScientificDomain
  /** forward typography scale applied for the publication contract (1 = none) */
  contractFontScale?: number
  /** relations deliberately expressed through position/grouping rather than a connector */
  unrenderedRelations?: RoutedEdge[]
  /** ranked candidate summary (P2 art direction): the set the winner was chosen from */
  candidates?: Array<{ source: string; priorId: string | null; score: number; crossings: number }>
  /** true when a model composition failed/timed out and a deterministic prior was used */
  fallbackUsed?: boolean
  /** machine reason for the deterministic fallback (see diagnostics) */
  fallbackReason?: string
  /** typed LLM-stage diagnostics (AI-P0-08/09) */
  diagnostics?: OrchestrationDiagnostic[]
  /** per-call planning accounting (AI-P1-08) */
  planningMetrics?: PlanningMetric[]
  /** P0.5 delivery gate verdict — ok === delivery.pass, always */
  delivery?: import('../delivery/delivery-gate.js').DeliveryGateResult
  /** resolved render typography (P0.5 SSOT): what the renderer must draw */
  typography?: import('../render/typography.js').ResolvedFigureTypography
  routes?: RoutedEdge[]
  critic?: CriticVerdict
  repairs?: AppliedRepair[]
  /** how many REAL semantic replans replaced the FigurePlan */
  semanticReplans?: number
  /** per-attempt semantic diagnostics (ORCH-P0-02): parse vs schema errors */
  semanticDiagnostics?: import('./semantic-attempt.js').SemanticPlanAttemptResult['diagnostics']
  error?: string
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** per-candidate retry budget (ORCH-P0-05) — never a run-global boolean */
interface CandidateAttemptBudget {
  routeFixes: number
}

const MAX_ROUTE_FIXES_PER_CANDIDATE = 1

// RENDER-P0-01: per-module hard fit constraints derived from the model's
// visual decomposition. The solver reserves the composite size; the renderer
// must never re-derive or inflate geometry after the solve.
function unitFitConstraints(
  visualPlan: import('../visual/visualPlan.js').VisualPlan,
  measured: MeasuredNode[],
): Map<string, { minHeightForWidth: (w: number) => number; minWidth: number }> | undefined {
  if (visualPlan.modules.length === 0) return undefined
  const widthById = new Map(measured.map((node) => [node.id, node.bounds.minWidth]))
  const fit = new Map<string, { minHeightForWidth: (w: number) => number; minWidth: number }>()
  for (const module of visualPlan.modules) {
    const innerWidth = Math.max(60, (widthById.get(module.moduleId) ?? 96) - 8)
    fit.set(module.moduleId, {
      minHeightForWidth: (w: number) => minimumHeightForUnits(module, Math.max(60, w - 8)),
      minWidth: minimumWidthForUnits(module) || innerWidth,
    })
  }
  return fit.size > 0 ? fit : undefined
}
export async function orchestrateFigure(
  input: OrchestrationInput,
  llm: OrchestratorLlm,
  onEvent?: (event: OrchestrationEvent) => void,
): Promise<OrchestrationResult> {
  const trace: OrchestrationEvent[] = []
  const emit = (
    stage: OrchestrationStage,
    ok: boolean,
    detail?: string,
    extra?: { attemptId?: number; candidateId?: string },
  ) => {
    const event: OrchestrationEvent = {
      stage,
      ok,
      timestamp: Date.now(),
      ...(detail ? { detail } : {}),
      ...(extra ?? {}),
    }
    trace.push(event)
    onEvent?.(event)
  }
  // P1: domain resolution + final-size-aware typography scale. The contract's
  // physical floor is solved FORWARD — canvas fonts scale up so the printed
  // figure clears the floor — rather than gated after the fact.
  const domain = resolveDomain(input.contract?.domain ?? input.domainHint)
  let contractFontScale = 1
  if (input.contract) {
    const finalWidthMm =
      input.contract.output.finalWidthMm ??
      OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context]
    const floorPt =
      input.contract.minTextPtAtFinalSize ??
      OUTPUT_CONTEXT_MIN_TEXT_PT[input.contract.output.context]
    const canvasMm = (input.canvasW * 25.4) / 96
    const smallestDefault = Math.min(
      ...Object.values(SEMANTIC_NODE_STYLES).map((style) => style.detailSizePt),
    )
    contractFontScale = Math.max(1, (floorPt * canvasMm) / finalWidthMm / smallestDefault)
  }
  const specFor = (type: keyof typeof SEMANTIC_NODE_STYLES): NodeTextSpec => {
    const style = SEMANTIC_NODE_STYLES[type]
    const round1 = (v: number) => Math.round(v * 10) / 10
    return {
      titleSizePt: round1((input.nodeSpec?.titleSizePt ?? style.titleSizePt) * contractFontScale),
      detailSizePt: round1(
        (input.nodeSpec?.detailSizePt ?? style.detailSizePt) * contractFontScale,
      ),
      maxTitleLines: style.maxTitleLines,
      maxDetailLines: style.maxDetailLines,
      padX: input.nodeSpec?.padX ?? style.padX,
      padY: input.nodeSpec?.padY ?? style.padY,
      titleGapY: style.titleGapY,
      lineHeight: style.lineHeight,
      minWidth: input.nodeSpec?.minWidth ?? style.minWidth,
      maxWidth: input.nodeSpec?.maxWidth ?? style.maxWidth,
      minHeight: input.nodeSpec?.minHeight ?? style.minHeight,
      maxHeight: input.nodeSpec?.maxHeight ?? style.maxHeight,
    }
  }

  // QA-P0-02: the critic scores composition against the figure FAMILY even
  // without a contract — legacy figureType strings map onto families.
  let familyFallback: import('../contract/figure-contract.js').FigureFamily | undefined
  // FigureFamily strategy (COMP-P1-02): a DECLARED unsupported family fails
  // loudly here — it never silently degrades to freeform.
  let family: import('../contract/figure-contract.js').FigureFamily | undefined
  if (input.contract) {
    try {
      const strategy = familyStrategyFor(input.contract.figureFamily)
      if (strategy) family = strategy.family
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      emit('figure.failed', false, error)
      return { ok: false, trace, error }
    }
  }

  const forbiddenClaims = [
    ...(input.contract?.forbiddenClaims ?? []),
    ...(input.contract?.visibleTextPolicy?.forbidden ?? []),
  ]
  // QA-P0-01: critic typography signals derived from the SAME measured data
  // and the SAME SSOT pt the renderer draws — never re-derived or drifted.
  const buildTypographySignals = (
    attemptState: SemanticAttemptState,
  ): Map<string, TypographySignal> => {
    const PT_TO_PX = 96 / 72
    const signals = new Map<string, TypographySignal>()
    for (const [index, node] of attemptState.plan.nodes.entries()) {
      const m = attemptState.measured[index]
      if (!m || m.id !== node.id) continue
      const spec = specFor(node.type)
      const pt = typography?.node[node.id]
      const titlePt = pt?.titlePt ?? spec.titleSizePt
      const detailPt = pt?.detailPt ?? spec.detailSizePt
      const textBlockH =
        m.titleLines * titlePt * PT_TO_PX * spec.lineHeight +
        (m.detailLines > 0
          ? spec.titleGapY + m.detailLines * detailPt * PT_TO_PX * spec.lineHeight
          : 0)
      signals.set(node.id, {
        titlePt,
        detailPt,
        titleLines: m.titleLines,
        detailLines: m.detailLines,
        maxTitleLines: spec.maxTitleLines,
        maxDetailLines: spec.maxDetailLines,
        textBlockH,
        padY: spec.padY,
      })
    }
    return signals
  }

  // P0.5: full Figure Contract audit over the FINAL render intent (macro
  // titles/details, micro-unit labels, edge labels). Runs each critic round;
  // results feed the delivery gate.
  const auditContract = (
    attemptPlan: FigurePlanV2,
    attemptVisualPlan: import('../visual/visualPlan.js').VisualPlan | undefined,
    placements: Array<{ id: string }>,
  ): { violations: number; missingEvidence: number; messages: string[] } => {
    if (!input.contract) return { violations: 0, missingEvidence: 0, messages: [] }
    const rendered: RenderedText[] = []
    for (const node of attemptPlan.nodes) {
      rendered.push({ id: node.id, kind: 'title', text: node.visible.title })
      if (node.visible.detail)
        rendered.push({ id: node.id, kind: 'detail', text: node.visible.detail })
    }
    for (const module of attemptVisualPlan?.modules ?? []) {
      for (const unit of module.units) {
        rendered.push({ id: unit.id, kind: 'micro', text: unit.label })
        if (unit.detail) rendered.push({ id: unit.id, kind: 'micro', text: unit.detail })
      }
    }
    for (const edge of attemptPlan.edges) {
      if (edge.label)
        rendered.push({
          id: edge.id ?? `${edge.from}->${edge.to}`,
          kind: 'label',
          text: edge.label,
        })
    }
    // P0-7: evidence and provenance travel in SEPARATE channels — merging
    // them let an evidence citation whitewash an unsourced number.
    const evidenceRefs = new Map<string, string[]>()
    const provenanceRefs = new Map<string, string[]>()
    const quantitativeNodeIds = new Set<string>()
    for (const node of attemptPlan.nodes) {
      if ((node.evidenceRefs?.length ?? 0) > 0) evidenceRefs.set(node.id, node.evidenceRefs!)
      if ((node.provenanceRefs?.length ?? 0) > 0) {
        provenanceRefs.set(node.id, node.provenanceRefs!)
      }
      if (node.claimType === 'quantitative') quantitativeNodeIds.add(node.id)
    }
    const issues = auditFigureContract({
      contract: input.contract,
      placedNodeIds: placements.map((placement) => placement.id),
      renderedTexts: rendered,
      evidenceRefs,
      provenanceRefs,
      quantitativeNodeIds,
    })
    const violations = issues.filter((issue) => issue.kind !== 'EVIDENCE_MISSING').length
    const missingEvidence = issues.filter((issue) => issue.kind === 'EVIDENCE_MISSING').length
    return {
      violations,
      missingEvidence,
      messages: issues.map((issue) => `${issue.kind}: ${issue.message}`),
    }
  }

  const compileAttempt = (plan: FigurePlanV2, attempt: number): SemanticAttemptState | string => {
    try {
      return compileSemanticAttempt({
        plan,
        attempt,
        specFor,
        ...(input.measure ? { measure: input.measure } : {}),
        domain,
        // ONLY a DECLARED (contract) family may gate grammar composition; the
        // legacy figureType fallback is a critic-scoring hint, never a gate
        ...(family ? { family } : {}),
        ...(forbiddenClaims.length > 0 ? { forbiddenClaims } : {}),
        ...(typography ? { typographyPt: typography.node } : {}),
      })
    } catch (err) {
      // consistency assertion violation: fail loudly with the assertion text
      return err instanceof Error ? err.message : String(err)
    }
  }

  // SEMANTIC_PLAN — real parse/repair loop with SPECIFIC diagnostics
  // (ORCH-P0-02). started/completed/failed are separate events; preparing a
  // call is never recorded as a success.
  emit('semantic.plan.started', true, undefined, { attemptId: 0 })
  // coarse-stage alias for consumers of the original OrchestrationStage enum
  emit('semantic.plan', true)
  // AI-P0-08/09/11: typed diagnostics + budgets around every LLM call
  const diagnostics: OrchestrationDiagnostic[] = []
  const planningMetrics: PlanningMetric[] = []
  let semanticAttempts = 0
  const diagnose = (code: OrchestrationDiagnosticCode, message: string, attempt = 0) => {
    diagnostics.push({ code, message, attempt })
  }
  let planResult: Awaited<ReturnType<typeof planSemanticFigure>>
  try {
    planResult = await planSemanticFigure({
      thesis: input.thesis,
      semanticPlan: (thesis, feedback) => {
        const attempt = ++semanticAttempts
        const started = Date.now()
        return withStageBudget(
          'semantic planner',
          (signal) => llm.semanticPlan(thesis, feedback, signal),
          { signal: input.signal, budgetMs: input.stageBudgets?.semanticMs },
        ).then(
          (raw) => {
            planningMetrics.push({
              stage: 'semantic',
              inputChars: thesis.length,
              outputChars: raw === null || raw === undefined ? 0 : JSON.stringify(raw).length,
              latencyMs: Date.now() - started,
              retries: attempt - 1,
            })
            return raw
          },
          (err: unknown) => {
            if (err instanceof StageTimeoutError) {
              diagnose('MODEL_SEMANTIC_TIMEOUT', err.message, attempt)
            } else if (input.signal?.aborted) {
              diagnose(
                'MODEL_SEMANTIC_CANCELLED',
                'run cancelled during semantic planning',
                attempt,
              )
              throw new Error('cancelled', { cause: err })
            } else {
              diagnose(
                'MODEL_SEMANTIC_PROVIDER_FAILED',
                err instanceof Error ? err.message : String(err),
                attempt,
              )
            }
            throw err
          },
        )
      },
      onAttempt: (info) => {
        emit(
          'semantic.plan.failed',
          false,
          `attempt ${info.attempt} ${info.failureKind}: ${info.errors.join('; ')}`.slice(0, 500),
          { attemptId: info.attempt - 1 },
        )
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'cancelled') {
      emit('figure.failed', false, 'cancelled')
      return { ok: false, trace, error: 'cancelled', diagnostics, planningMetrics }
    }
    emit('figure.failed', false, `semantic planner failed: ${message}`)
    return {
      ok: false,
      trace,
      error: `semantic planner failed: ${message}`,
      diagnostics,
      planningMetrics,
    }
  }
  if (!planResult.plan) {
    diagnose(
      planResult.failureKind === 'MODEL_OUTPUT_PARSE_ERROR'
        ? 'MODEL_SEMANTIC_PARSE_FAILED'
        : planResult.failureKind === 'PLANNER_TRANSPORT_ERROR'
          ? 'MODEL_SEMANTIC_PROVIDER_FAILED'
          : 'MODEL_SEMANTIC_SCHEMA_FAILED',
      planResult.errors.join('; ') || 'FigurePlan v2 failed schema validation',
      planResult.attemptsUsed,
    )
    const error = `${planResult.failureKind ?? 'FIGURE_PLAN_SCHEMA_ERROR'}: ${planResult.errors.join('; ') || 'FigurePlan v2 failed schema validation'}`
    emit('figure.failed', false, error)
    return {
      ok: false,
      trace,
      ...(planResult.diagnostics.length > 0 ? { semanticDiagnostics: planResult.diagnostics } : {}),
      diagnostics,
      planningMetrics,
      error,
    }
  }
  emit('semantic.plan.completed', true, `attempt ${planResult.attemptsUsed}`, { attemptId: 0 })

  // P0.5: resolve the contract-scaled typography NOW (after parse, before any
  // measurement). The renderer and publication audit consume this same object.
  const typography = resolveFigureTypography({
    plan: planResult.plan,
    ...(input.contract ? { contract: input.contract } : {}),
    canvasW: input.canvasW,
    ...(input.nodeSpec ? { nodeSpecOverrides: input.nodeSpec } : {}),
  })
  // Capability contract (AI-P0-05): a stale prompt may have let the model
  // declare a presentation this renderer does not realize (e.g. `junction`);
  // such edges are downgraded to the renderer-realizable default here.
  const downgradedPresentations: string[] = []
  for (const [index, edge] of planResult.plan.edges.entries()) {
    if (!edge.presentation) continue
    const downgrade = downgradePresentation(edge.presentation)
    if (downgrade) {
      downgradedPresentations.push(`edge ${edge.id ?? index}: ${downgrade.reason}`)
      edge.presentation = downgrade.fallback
    }
  }
  for (const reason of downgradedPresentations) diagnose('MODEL_PRESENTATION_DOWNGRADED', reason, 0)
  // QA-P0-02 family fallback: map the legacy figureType when no contract named one
  if (!family) {
    familyFallback = familyFromFigureType(planResult.plan.figureType) as
      import('../contract/figure-contract.js').FigureFamily | undefined
  }

  const compiled = compileAttempt(planResult.plan, 0)
  if (typeof compiled === 'string') {
    const error = `semantic attempt compilation failed: ${compiled}`
    emit('figure.failed', false, error)
    return { ok: false, trace, error }
  }
  let state: SemanticAttemptState = compiled
  emit('text.optimized', true)
  emit('measurement.completed', true, `${state.measured.length} nodes`)

  // CAPABILITY_SELECT
  const capability = capabilityProfile(input.capability ?? {})
  const complexity = {
    nodeCount: state.plan.nodes.length,
    edgeCount: state.plan.edges.length,
    hasFeedback: state.plan.edges.some((edge) => edge.relation === 'feedback'),
    hasModeration: state.plan.edges.some((edge) => edge.relation === 'moderation'),
  }
  const autonomy = input.autonomyOverride ?? selectAutonomy(capability, complexity)
  emit('capability.selected', true, autonomy)

  const maxRecompose = input.maxRecompose ?? 2
  const maxSemanticReplans = input.maxSemanticReplans ?? 1
  let critique: string[] | undefined
  let best: CompositionCandidate | null = null
  let critic: CriticVerdict | undefined = undefined
  let candidates: CompositionCandidate[] = []
  let candidateIdx = 0
  let composeAttempt = 0
  let semanticReplansUsed = 0
  let scientificIssues: ScientificIssue[]
  // AI-P0-08/09: deterministic-fallback bookkeeping
  let fallbackUsed = false
  let fallbackReason: string | undefined
  let lastSemanticDiagnostics = planResult.diagnostics
  // P0.5 delivery-gate counters, recomputed each critic round
  let lastScientificHard = 0
  let lastPublicationHard = 0
  let lastContractViolations = 0
  let lastMissingEvidence = 0
  // P0-5: true only when a repair budget actually ran out while not yet PASS
  let ladderExhausted = false
  const repairs: AppliedRepair[] = []
  let routes: RoutedEdge[] = []
  let unrenderedRelations: RoutedEdge[] = []
  /** inputs of the CURRENT candidate's routing (for vision re-route adoption) */
  let lastRouteableInputs: import('../routing/router.js').RoutedEdgeInput[] = []
  // hard bound: the ladder always terminates (fuzz invariant). Sized so the
  // full ladder can reach its honest exhaustion marker: per recompose round
  // up to 2 L3 candidate steps, plus route-fix replays and the final round.
  const maxRounds = 2 * (maxRecompose + maxSemanticReplans) + 6

  // ── P0-4 (production closure): ONE candidate-state evaluation ──
  // Metric critic + scientific audit + contract audit + publication audit are
  // computed TOGETHER from the CURRENT candidate/routes. Every state change —
  // initial solve, ROUTE_FIX, candidate swap, composition redesign, semantic
  // replan — re-runs this whole function; stale hard-issue counters can never
  // reach the delivery gate.
  interface CandidateEvaluation {
    critic: CriticVerdict
    scientificIssues: ScientificIssue[]
    scientificHard: number
    contractViolations: number
    missingEvidence: number
    publicationHard: number
  }
  const evaluateCandidateState = (args: {
    best: CompositionCandidate
    routes: RoutedEdge[]
    candidateId: string
  }): CandidateEvaluation => {
    const { best: candidate, routes: candidateRoutes, candidateId: cid } = args
    emit('critic.started', true, undefined, { candidateId: cid })
    const metricCritic = criticVerdict({
      solve: candidate.solve,
      edges: state.edges,
      canvasW: input.canvasW,
      canvasH: input.canvasH,
      importance: state.importance,
      groupIds: state.groupIds,
      intent: { plan: state.plan, spatial: candidate.plan },
      routed: candidateRoutes,
      passThreshold: qualityThresholdFor(input.contract),
      family: (family ?? familyFallback ?? undefined) as
        import('../contract/figure-contract.js').FigureFamily | undefined,
      typography: buildTypographySignals(state),
      ...(input.contract
        ? {
            finalWidthMm:
              input.contract.output.finalWidthMm ??
              OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context],
          }
        : {}),
    })
    // Scientific audit (17.3): evidence coverage, connector realization, causal
    // direction, dominance — against the DECLARED reading flow (all six), the
    // solved spatial plan and family; domain/family validators append checks.
    const declaredFlow: ReadingFlow = resolveReadingFlow(candidate.plan, state.plan)
    const issues: ScientificIssue[] = [
      ...auditScientific({
        plan: state.plan,
        placements: candidate.solve.placements,
        routes: candidateRoutes,
        importance: state.importance,
        spatial: candidate.plan,
        ...((family ?? familyFallback) ? { family: (family ?? familyFallback)! } : {}),
        domain,
        direction: declaredFlow,
      }),
      ...validateDomain(state.plan, domain),
      ...validateFamily(state.plan, (family ?? familyFallback ?? undefined) as string | undefined),
    ]
    const hardIssues = issues.filter((issue) => issue.severity === 'hard')
    let verdict = metricCritic
    if (hardIssues.length > 0 && verdict.verdict === 'PASS') {
      const needsRoute = hardIssues.some((issue) => issue.repairClass === 'ROUTE_FIX')
      verdict = {
        ...verdict,
        verdict: needsRoute ? 'ROUTE_FIX' : 'RECOMPOSE',
        reason: hardIssues.map((issue) => issue.message).join('; '),
        gateIssues: [...verdict.gateIssues, ...issues.map((issue) => issue.message)],
      }
    } else if (issues.length > 0) {
      verdict = {
        ...verdict,
        gateIssues: [...verdict.gateIssues, ...issues.map((issue) => issue.message)],
      }
    }
    // P1: forbidden claims / visible-text violations block delivery outright.
    // P0.5: full contract audit over the final render intent feeds the same
    // gate; EVIDENCE_MISSING escalates to semantic replan like forbidden hits.
    const contractAudit = auditContract(
      state.plan,
      candidate.plan.visualPlan,
      candidate.solve.placements,
    )
    const contractViolations = contractAudit.violations + state.forbiddenHits.length
    if (contractViolations > 0 || contractAudit.missingEvidence > 0) {
      const message = [
        ...state.forbiddenHits.map((claim) => `forbidden claim: ${claim}`),
        ...contractAudit.messages,
      ].join('; ')
      if (verdict.verdict === 'PASS' || verdict.verdict === 'LOCAL_LAYOUT_FIX') {
        verdict = {
          ...verdict,
          verdict: 'RECOMPOSE',
          reason: message,
          gateIssues: [...verdict.gateIssues, ...message.split('; ')],
        }
      } else {
        verdict = { ...verdict, gateIssues: [...verdict.gateIssues, ...message.split('; ')] }
      }
    }
    // P3: publication QA at final physical size.
    let publicationHard = 0
    if (input.contract) {
      const pubIssues = publicationAudit({
        contract: input.contract,
        canvasW: input.canvasW,
        canvasH: input.canvasH,
        minFontPt: typography!.minEffectiveTextPt,
      })
      const hardPub = pubIssues.filter((issue) => issue.severity === 'hard')
      publicationHard = hardPub.length
      if (hardPub.length > 0) {
        repairs.push('TYPOGRAPHY_FIX')
        const message = hardPub.map((issue) => issue.detail).join('; ')
        verdict = {
          ...verdict,
          verdict: 'RECOMPOSE',
          reason: message,
          gateIssues: [...verdict.gateIssues, message],
        }
      }
    }
    return {
      critic: verdict,
      scientificIssues: issues,
      scientificHard: hardIssues.length,
      contractViolations,
      missingEvidence: contractAudit.missingEvidence,
      publicationHard,
    }
  }
  const failResult = (error: string): OrchestrationResult => {
    return {
      ok: false,
      trace,
      plan: state.plan,
      autonomy,
      measured: state.measured,
      ...(best
        ? {
            best,
            visualPlan: best.plan.visualPlan ?? { modules: [] },
            domain,
            unrenderedRelations,
            routes,
            critic,
            ...(repairs.length > 0 ? { repairs: repairs as AppliedRepair[] } : {}),
          }
        : {}),
      ...(lastSemanticDiagnostics.length > 0
        ? { semanticDiagnostics: lastSemanticDiagnostics }
        : {}),
      ...(fallbackUsed ? { fallbackUsed, fallbackReason } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      ...(planningMetrics.length > 0 ? { planningMetrics } : {}),
      semanticReplans: semanticReplansUsed,
      error,
    }
  }

  // AI-P1-05: cancellation between deterministic stages surfaces a typed result
  try {
    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(input.signal)
      if (candidates.length === 0) {
        emit(
          'composition.started',
          true,
          composeAttempt === 0 ? autonomy : `compose#${composeAttempt}`,
          { attemptId: state.attempt },
        )
        // model-authored decomposition is OWNED by this attempt (ORCH-P0-04)
        let modelPlan: SpatialPlan | null = null
        if (autonomy !== 'A0' && llm.compose) {
          const composeStarted = Date.now()
          let raw: unknown
          let composeSettled = false
          try {
            raw = await withStageBudget(
              'composition designer',
              (signal) =>
                llm.compose!({
                  plan: state.plan,
                  measured: state.measured.map((node) => ({
                    id: node.id,
                    w: node.bounds.preferredWidth,
                    h: node.bounds.preferredHeight,
                  })),
                  canvas: { w: input.canvasW, h: input.canvasH },
                  autonomy,
                  ...(critique ? { critique } : {}),
                  signal,
                }),
              { signal: input.signal, budgetMs: input.stageBudgets?.compositionMs },
            )
            composeSettled = true
          } catch (err) {
            modelPlan = null
            fallbackUsed = true
            if (err instanceof StageTimeoutError) {
              fallbackReason = err.message
              diagnose('MODEL_COMPOSITION_TIMEOUT', err.message, state.attempt)
            } else if (input.signal?.aborted) {
              diagnose(
                'MODEL_COMPOSITION_CANCELLED',
                'run cancelled during composition',
                state.attempt,
              )
              throw new Error('cancelled', { cause: err })
            } else {
              fallbackReason = err instanceof Error ? err.message : String(err)
              diagnose('MODEL_COMPOSITION_PROVIDER_FAILED', fallbackReason, state.attempt)
            }
          }
          if (composeSettled) {
            // parse vs schema classification (AI-P0-09): a string payload must
            // parse as JSON before schema validation can even run
            let parsed: unknown = raw
            let parseFailed = false
            if (typeof raw === 'string') {
              try {
                const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
                const rawText = (fenced ? fenced[1]! : raw).trim()
                const start = rawText.indexOf('{')
                const end = rawText.lastIndexOf('}')
                parsed = JSON.parse(
                  start >= 0 && end > start ? rawText.slice(start, end + 1) : rawText,
                )
              } catch {
                parseFailed = true
              }
            }
            if (raw === null || raw === undefined) {
              // designer declined to answer: silent deterministic fallback, no diagnostic
            } else if (parseFailed) {
              fallbackUsed = true
              fallbackReason = 'composition designer returned unparseable output'
              diagnose('MODEL_COMPOSITION_PARSE_FAILED', fallbackReason, state.attempt)
            } else {
              const normalized = normalizeSpatialPlan(
                parsed,
                state.plan.nodes.map((node) => node.id),
                { readingFlow: 'LR', visualRole: 'primary' },
              )
              const normalizedVisualPlan = normalizeVisualPlan(
                (parsed as Record<string, unknown> | null)?.visualPlan,
                state.plan,
              )
              modelPlan = normalized
                ? {
                    ...normalized,
                    visualPlan: normalizedVisualPlan,
                  }
                : null
              if (!normalized) {
                fallbackUsed = true
                fallbackReason = 'composition designer failed schema validation'
                diagnose('MODEL_COMPOSITION_SCHEMA_FAILED', fallbackReason, state.attempt)
              }
            }
            planningMetrics.push({
              stage: 'composition',
              inputChars: JSON.stringify(state.plan).length,
              outputChars: raw === null || raw === undefined ? 0 : JSON.stringify(raw).length,
              latencyMs: Date.now() - composeStarted,
              retries: 0,
            })
          }
        }
        try {
          candidates = generateCandidates(
            autonomy,
            state.measured,
            state.edges,
            state.signals,
            input.canvasW,
            input.canvasH,
            modelPlan,
            state.meta,
            state.candidateContext,
            // RENDER-P0-01: composite modules reserve their real unit-fit size at
            // solve time, so the renderer can consume placements verbatim.
            unitFitConstraints(modelPlan?.visualPlan ?? { modules: [] }, state.measured),
          )
        } catch (err) {
          if (err instanceof UnsupportedFigureFamilyError) {
            emit('figure.failed', false, err.message)
            return failResult(err.message)
          }
          throw err
        }
        if (candidates.length === 0) {
          const error = 'no composition candidates generated'
          emit('figure.failed', false, error)
          return failResult(error)
        }
        candidateIdx = 0
      }
      best = candidates[Math.min(candidateIdx, candidates.length - 1)]!
      const candidateId = best.priorId ?? 'model'
      emit('composition.completed', true, best.source, { candidateId })

      // Geometry legalizes the designer's composition but never repositions
      // boxes merely to make a primary connector straighter.
      emit('layout.solved', true, `${best.solve.issues.length} issues`, { candidateId })
      // every candidate owns a FRESH retry budget (ORCH-P0-05)
      const budget: CandidateAttemptBudget = { routeFixes: 0 }

      const rectMap = new Map(best.solve.placements.map((placement) => [placement.id, placement]))
      const connectorPresentations = new Set([
        'arrow',
        'line',
        'dashed-arrow',
        'inhibition',
        'feedback-loop',
        'junction',
      ])
      const routeInputs = state.edges.map((edge) => {
        const pair = `${edge.from}\u0000${edge.to}`
        const priority =
          state.edgePriorityById.get(edge.id ?? '') ??
          state.edgePriorityByPair.get(pair)?.[0] ??
          'secondary'
        return {
          key: edge.id ?? `${edge.from}->${edge.to}`,
          semanticEdgeId: edge.id ?? `${edge.from}->${edge.to}`,
          fromId: edge.from,
          toId: edge.to,
          role: edge.role,
          relation: edge.relation,
          presentation: (edge.presentation ?? 'arrow') as RelationPresentation,
          priority,
        }
      })
      // Relationship presentation is model-authored: connectors are routed only
      // when the declared representation is a connector, regardless of whether
      // the semantic relationship happened to be classified as primary.
      const connectorInputs = routeInputs.filter((edge) =>
        connectorPresentations.has(edge.presentation),
      )
      unrenderedRelations = routeInputs
        .filter((edge) => !connectorPresentations.has(edge.presentation))
        .map((edge) => ({ ...edge, status: 'suppressed' as const, laneOffsetPx: 0 }))
      // Density guard (acceptance finding RF-BUG-1): a planner flood of
      // connectors turns the canvas into a hairball where no single relation
      // reads. Every drawn line must be irreplaceable, so above the density cap
      // only the highest-priority relations keep their line and the rest are
      // demoted to recorded spatial presentation — never silently dropped.
      const densityCap = Math.max(3, Math.ceil(state.plan.nodes.length * 1.8))
      let routeableInputs = connectorInputs
      if (connectorInputs.length > densityCap) {
        const rank: Record<string, number> = { primary: 0, feedback: 1, secondary: 2 }
        const sorted = [...connectorInputs].sort(
          (a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) || a.key.localeCompare(b.key),
        )
        // P0.5: directional relations (causal/inhibition/feedback/moderation
        // primaries) are NEVER density-suppressed — without the explicit symbol
        // the science is lost. Only secondaries may be demoted; if directional
        // edges alone exceed the cap the delivery gate forces a replan instead.
        const directional = sorted.filter((edge) => (rank[edge.priority] ?? 2) < 2)
        const secondary = sorted.filter((edge) => (rank[edge.priority] ?? 2) >= 2)
        const secondaryKeep = Math.max(0, densityCap - directional.length)
        const kept = [...directional, ...secondary.slice(0, secondaryKeep)]
        const demoted = secondary.slice(secondaryKeep)
        unrenderedRelations.push(
          ...demoted.map((edge) => ({
            ...edge,
            status: 'suppressed' as const,
            laneOffsetPx: 0,
            diagnostic: 'connector density cap: expressed spatially',
          })),
        )
        routeableInputs = kept
      }
      routes = routeEdgesWithObstacles(
        routeableInputs,
        rectMap,
        { w: input.canvasW, h: input.canvasH },
        state.direction,
      )
      lastRouteableInputs = routeableInputs
      const evaluation = evaluateCandidateState({ best, routes, candidateId })
      critic = evaluation.critic
      scientificIssues = evaluation.scientificIssues
      lastScientificHard = evaluation.scientificHard
      lastPublicationHard = evaluation.publicationHard
      lastContractViolations = evaluation.contractViolations
      lastMissingEvidence = evaluation.missingEvidence
      emit('critic.completed', true, critic.verdict, { candidateId })

      if (critic.verdict === 'ROUTE_FIX' && budget.routeFixes < MAX_ROUTE_FIXES_PER_CANDIDATE) {
        // Geometry fix for connector geometry only: admit one extra corridor,
        // never touch the composition or suppress a declared relation.
        budget.routeFixes++
        repairs.push('L2 ROUTE_FIX')
        const extraLanes = [median(best.solve.placements.map((p) => p.y + p.h / 2))]
        routes = routeEdgesWithObstacles(
          routeableInputs,
          rectMap,
          { w: input.canvasW, h: input.canvasH },
          state.direction,
          extraLanes,
        )
        // P0-4/P0-5: the repair CHANGED candidate state — the FULL QA suite
        // (metric + scientific + contract + publication) re-runs; a stale
        // hard-issue counter must never reach the delivery gate.
        const afterRouteFix = evaluateCandidateState({ best, routes, candidateId })
        critic = afterRouteFix.critic
        scientificIssues = afterRouteFix.scientificIssues
        lastScientificHard = afterRouteFix.scientificHard
        lastPublicationHard = afterRouteFix.publicationHard
        lastContractViolations = afterRouteFix.contractViolations
        lastMissingEvidence = afterRouteFix.missingEvidence
        emit('route.repaired', true, critic.verdict, { candidateId })
        emit('critic.completed', true, `${critic.verdict} (after L2)`, { candidateId })
      }

      if (
        (critic.verdict === 'LOCAL_LAYOUT_FIX' || critic.verdict === 'ROUTE_FIX') &&
        candidateIdx + 1 < candidates.length &&
        candidateIdx < 2 // bound L3 to one next-candidate step; further issues escalate
      ) {
        // L3: geometry is not salvageable at this rank — the next candidate is
        // still cheaper than a whole recompose
        repairs.push('L3 LOCAL_GEOMETRY_FIX')
        candidateIdx++
        emit('layout.repaired', true, `candidate rank ${candidateIdx + 1}`)
        continue
      }
      // P0-5: L3 budget exhaustion means LOCAL repair failed — it escalates to
      // L4 COMPOSITION_REDESIGN while recompose budget remains, and only an
      // exhausted LADDER breaks (to an honest delivery failure, never accept).
      if (
        (critic.verdict === 'LOCAL_LAYOUT_FIX' || critic.verdict === 'ROUTE_FIX') &&
        candidateIdx >= 2
      ) {
        if (composeAttempt < maxRecompose) {
          repairs.push('L4 COMPOSITION_REDESIGN')
          composeAttempt++
          emit('recompose.started', true, `attempt ${composeAttempt} (L4 escalation)`)
          critique = critic.decisions?.length
            ? critic.decisions.map((d) => `${d.action}: ${d.message}`)
            : critic.gateIssues.length
              ? critic.gateIssues
              : [`overall ${critic.scores.overall}/10`]
          candidates = []
          continue
        }
        repairs.push('L3 LOCAL_GEOMETRY_FIX (budget exhausted)')
        ladderExhausted = true
        break
      }

      if (critic.verdict === 'RECOMPOSE') {
        // forbidden claims are semantic failures of the PLAN: recomposing the
        // same violating content cannot help — only a new plan (or an honest
        // failure) can
        const semantic = isSemanticFailure(critic) || state.forbiddenHits.length > 0
        // L6 SEMANTIC_REPLAN (ORCH-P0-01): the FigurePlan itself is regenerated
        // by the model and EVERY derived state object is rebuilt. A bounded
        // budget keeps the ladder finite; when the budget is spent the ladder
        // degrades to an honest composition redesign.
        if (semantic && semanticReplansUsed < maxSemanticReplans) {
          semanticReplansUsed++
          emit('semantic.replan.started', true, `replan #${semanticReplansUsed}`, {
            attemptId: semanticReplansUsed,
          })
          const feedback = compileSemanticReplanFeedback({
            critic,
            scientificIssues,
            forbiddenHits: state.forbiddenHits,
          })
          const replan = await planSemanticFigure({
            thesis: input.thesis,
            semanticPlan: llm.semanticPlan,
            critiqueFeedback: feedback,
            onAttempt: (info) => {
              lastSemanticDiagnostics = [
                ...lastSemanticDiagnostics,
                {
                  attempt: info.attempt,
                  kind: info.failureKind ?? 'FIGURE_PLAN_SCHEMA_ERROR',
                  errors: info.errors,
                },
              ]
              emit(
                'semantic.replan.failed',
                false,
                `attempt ${info.attempt} ${info.failureKind}: ${info.errors.join('; ')}`.slice(
                  0,
                  500,
                ),
                { attemptId: semanticReplansUsed },
              )
            },
          })
          if (replan.plan) {
            const next = compileAttempt(replan.plan, semanticReplansUsed)
            if (typeof next === 'string') {
              emit('semantic.replan.failed', false, `compile: ${next}`, {
                attemptId: semanticReplansUsed,
              })
            } else {
              state = next
              lastSemanticDiagnostics = [...lastSemanticDiagnostics, ...replan.diagnostics]
              repairs.push('L6 SEMANTIC_REPLAN')
              emit('semantic.replan.completed', true, `attempt ${semanticReplansUsed}`, {
                attemptId: semanticReplansUsed,
              })
              // plan replaced → the candidate set, critique and budgets die with
              // the old plan; the next round composes from the NEW state
              candidates = []
              candidateIdx = 0
              critique = undefined
              best = null
              composeAttempt++
              continue
            }
          } else {
            lastSemanticDiagnostics = [...lastSemanticDiagnostics, ...replan.diagnostics]
            repairs.push('L6 SEMANTIC_REPLAN (replan failed)')
          }
        } else if (semantic) {
          repairs.push('L5 RECOMPOSE (semantic replan budget exhausted)')
          if (composeAttempt >= maxRecompose) ladderExhausted = true
        } else {
          repairs.push('L5 RECOMPOSE (composition redesign)')
        }
        if (critic.scores.compositionQuality <= 3) repairs.push('CONTENT_REDUCE')
        composeAttempt++
        emit('recompose.started', true, `attempt ${composeAttempt}`)
        critique = critic.decisions?.length
          ? critic.decisions.map((d) => `${d.action}: ${d.message}`)
          : critic.gateIssues.length
            ? critic.gateIssues
            : [`overall ${critic.scores.overall}/10`]
        candidates = []
        continue
      }

      break
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'cancelled') {
      emit('figure.failed', false, 'cancelled')
      return {
        ok: false,
        trace,
        plan: state.plan,
        autonomy,
        measured: state.measured,
        error: 'cancelled',
        diagnostics,
        planningMetrics,
      }
    }
    throw err
  }

  if (!best || !critic) {
    const error = 'composition pipeline ended without a candidate'
    emit('figure.failed', false, error)
    return failResult(error)
  }

  // P0.5 Delivery Gate — the ONLY source of orchestration.ok. Repair budget
  // exhaustion is never acceptance: a non-PASS verdict after the full ladder
  // fails delivery with every diagnostic preserved.
  // ── P1-1: production vision review participates in candidate selection ──
  // With the reviewer wired (renderer off-screen preview + screenshot rubric),
  // surviving candidates are rendered and reviewed; the blended winner is
  // ADOPTED with a full QA re-run (evaluateCandidateState) so beauty never
  // outvotes science. Vision review also feeds the venue policy below.
  let visionReviewed = false
  if (input.vision && best && critic && candidates.length >= 2) {
    try {
      const review = await reviewCandidates({
        candidates,
        renderPreview: input.vision.renderPreview,
        visionReview: input.vision.visionReview,
        context: {
          plan: state.plan,
          planNodes: state.plan.nodes.map((node) => ({
            id: node.id,
            visible: { title: node.visible.title },
          })),
          visualPlan: best.plan.visualPlan ?? { modules: [] },
          ...(domain ? { domain } : {}),
        },
      })
      const winner = review.ranked.find(
        (entry) =>
          !entry.vision?.blockingProblems?.length || entry.vision.blockingProblems.length === 0,
      )
      const adopted = winner?.candidate ?? best
      if (adopted !== best) {
        const rectMap = new Map<string, import('../routing/geometry.js').Rect>(
          adopted.solve.placements.map((placement) => [placement.id, placement]),
        )
        const adoptedRoutes = routeEdgesWithObstacles(
          lastRouteableInputs,
          rectMap,
          { w: input.canvasW, h: input.canvasH },
          state.direction,
        )
        const evaluation = evaluateCandidateState({
          best: adopted,
          routes: adoptedRoutes,
          candidateId: adopted.priorId ?? 'model',
        })
        if (evaluation.critic.verdict !== 'RECOMPOSE') {
          best = adopted
          routes = adoptedRoutes
          critic = evaluation.critic
          scientificIssues = evaluation.scientificIssues
          lastScientificHard = evaluation.scientificHard
          lastPublicationHard = evaluation.publicationHard
          lastContractViolations = evaluation.contractViolations
          lastMissingEvidence = evaluation.missingEvidence
          repairs.push('L4 COMPOSITION_REDESIGN' as AppliedRepair)
          emit('vision.review.adopted', true, `winner ${adopted.priorId ?? 'model'}`)
        }
      }
      visionReviewed = true
    } catch {
      visionReviewed = false
    }
  }
  // ── P1-2 venue policy: publication-grade contracts REQUIRE vision review ──
  const venue = (input.contract?.venue ?? '').toLowerCase()
  const publicationGrade =
    input.contract?.visionReview === 'required' ||
    (!input.contract?.visionReview &&
      (venue.includes('nature') ||
        venue.includes('science') ||
        venue.includes('journal') ||
        venue.includes('thesis') ||
        input.contract?.output.context === 'paper-single-column' ||
        input.contract?.output.context === 'paper-double-column' ||
        input.contract?.output.context === 'full-page-paper'))
  const visionReviewMissing = publicationGrade && !visionReviewed
  if (publicationGrade && !visionReviewed) {
    diagnose(
      'QUALITY_REVIEW_UNAVAILABLE',
      'publication-grade contract without a screenshot vision review; submission-grade delivery is blocked',
    )
  }
  const delivery = evaluateDeliveryGate({
    critic,
    scientificHardIssues: lastScientificHard,
    publicationHardIssues: lastPublicationHard,
    contentContractViolations: lastContractViolations + state.forbiddenHits.length,
    requiredEvidenceMissing: lastMissingEvidence,
    // truthfully computed from the ladder: a PASS verdict never sets this
    repairBudgetExhausted: ladderExhausted || critic.verdict !== 'PASS',
    visionReviewRequiredMissing: visionReviewMissing,
  })
  if (!delivery.pass) {
    const error = `delivery gate failed: ${delivery.detail} — ${critic.reason ?? critic.gateIssues.join('; ') ?? 'quality below threshold'}`
    emit('figure.failed', false, error)
    return {
      ...failResult(error),
      delivery,
      typography,
    }
  }

  emit('figure.completed', true, critic.verdict, { candidateId: best.priorId ?? 'model' })
  return {
    ok: delivery.pass,
    trace,
    plan: state.plan,
    autonomy,
    measured: state.measured,
    best,
    // the WINNER's decomposition only; an attempt without one ships empty
    visualPlan: best.plan.visualPlan ?? { modules: [] },
    domain,
    contractFontScale,
    unrenderedRelations,
    candidates: candidates.map((candidate) => ({
      source: candidate.source,
      priorId: candidate.priorId,
      score: Math.round(candidate.score * 10) / 10,
      crossings: candidate.crossings,
    })),
    routes,
    critic,
    ...(repairs.length > 0 ? { repairs: repairs as AppliedRepair[] } : {}),
    semanticReplans: semanticReplansUsed,
    ...(lastSemanticDiagnostics.length > 0 ? { semanticDiagnostics: lastSemanticDiagnostics } : {}),
    ...(fallbackUsed ? { fallbackUsed, fallbackReason } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(planningMetrics.length > 0 ? { planningMetrics } : {}),
    delivery,
    typography,
  }
}
