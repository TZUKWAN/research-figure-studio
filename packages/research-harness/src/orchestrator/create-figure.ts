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
import { auditScientific, type ScientificIssue } from '../critic/scientific-critic.js'
import {
  OUTPUT_CONTEXT_DEFAULT_WIDTH_MM,
  OUTPUT_CONTEXT_MIN_TEXT_PT,
  publicationAudit,
  qualityThresholdFor,
} from '../contract/figure-contract.js'
import { domainPresentationDefault, resolveDomain } from '../contract/domain-profile.js'
import {
  compileSemanticAttempt,
  compileSemanticReplanFeedback,
  isSemanticFailure,
  planSemanticFigure,
  type SemanticAttemptState,
} from './semantic-attempt.js'
import { familyStrategyFor, UnsupportedFigureFamilyError } from '../composition/family-strategy.js'
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
  semanticPlan: (thesis: string, feedback?: string) => Promise<unknown>
  /** composition designer: intent-level layout plus optional visual decomposition */
  compose?: (ctx: {
    plan: FigurePlanV2
    measured: Array<{ id: string; w: number; h: number }>
    canvas: { w: number; h: number }
    autonomy: AutonomyLevel
    critique?: string[]
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

export interface OrchestrationInput {
  thesis: string
  canvasW: number
  canvasH: number
  capability?: CapabilityInput
  autonomyOverride?: AutonomyLevel
  nodeSpec?: FigureNodeSpec
  measure?: typeof measureNode
  maxRecompose?: number
  /** bounded semantic replans (real FigurePlan replacement); default 1 */
  maxSemanticReplans?: number
  /** publication contract (P1): venue, final size, forbidden claims, provenance */
  contract?: import('../contract/figure-contract.js').FigureContract
  /** domain hint when no contract is supplied */
  domainHint?: string
}

export type OrchestrationStage =
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
  /** relations deliberately expressed through position/grouping rather than a connector */
  unrenderedRelations?: RoutedEdge[]
  /** ranked candidate summary (P2 art direction): the set the winner was chosen from */
  candidates?: Array<{ source: string; priorId: string | null; score: number; crossings: number }>
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

const DEFAULT_SPEC: Required<FigureNodeSpec> = {
  titleSizePt: 13,
  detailSizePt: 10.5,
  padX: 10,
  padY: 8,
  minWidth: 96,
  maxWidth: 300,
  minHeight: 52,
  maxHeight: 170,
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
    const evidenceRefs = new Map<string, string[]>()
    for (const node of attemptPlan.nodes) {
      const refs = [...(node.evidenceRefs ?? []), ...(node.provenanceRefs ?? [])]
      if (refs.length > 0) evidenceRefs.set(node.id, refs)
    }
    const issues = auditFigureContract({
      contract: input.contract,
      placedNodeIds: placements.map((placement) => placement.id),
      renderedTexts: rendered,
      evidenceRefs,
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
  const planResult = await planSemanticFigure({
    thesis: input.thesis,
    semanticPlan: llm.semanticPlan,
    onAttempt: (info) => {
      emit(
        'semantic.plan.failed',
        false,
        `attempt ${info.attempt} ${info.failureKind}: ${info.errors.join('; ')}`.slice(0, 500),
        { attemptId: info.attempt - 1 },
      )
    },
  })
  if (!planResult.plan) {
    const error = `${planResult.failureKind ?? 'FIGURE_PLAN_SCHEMA_ERROR'}: ${planResult.errors.join('; ') || 'FigurePlan v2 failed schema validation'}`
    emit('figure.failed', false, error)
    return {
      ok: false,
      trace,
      ...(planResult.diagnostics.length > 0 ? { semanticDiagnostics: planResult.diagnostics } : {}),
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
  // QA-P0-02 family fallback: map the legacy figureType when no contract named one
  if (!family) {
    familyFallback = familyFromFigureType(planResult.plan.figureType) as
      | import('../contract/figure-contract.js').FigureFamily
      | undefined
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
  let scientificIssues: ScientificIssue[] = []
  let lastSemanticDiagnostics = planResult.diagnostics
  // P0.5 delivery-gate counters, recomputed each critic round
  let lastScientificHard = 0
  let lastPublicationHard = 0
  let lastContractViolations = 0
  let lastMissingEvidence = 0
  const repairs: AppliedRepair[] = []
  let routes: RoutedEdge[] = []
  let unrenderedRelations: RoutedEdge[] = []
  // hard bound: the ladder always terminates (fuzz invariant)
  const maxRounds = maxRecompose + maxSemanticReplans + 4

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
      semanticReplans: semanticReplansUsed,
      error,
    }
  }

  for (let round = 0; round < maxRounds; round++) {
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
        try {
          const raw = await llm.compose({
            plan: state.plan,
            measured: state.measured.map((node) => ({
              id: node.id,
              w: node.bounds.preferredWidth,
              h: node.bounds.preferredHeight,
            })),
            canvas: { w: input.canvasW, h: input.canvasH },
            autonomy,
            ...(critique ? { critique } : {}),
          })
          const normalized = normalizeSpatialPlan(
            raw,
            state.plan.nodes.map((node) => node.id),
            { readingFlow: 'LR', visualRole: 'primary' },
          )
          const normalizedVisualPlan = normalizeVisualPlan(
            (raw as Record<string, unknown> | null)?.visualPlan,
            state.plan,
          )
          // the decomposition attaches ONLY to this attempt's model plan;
          // when the spatial plan is unusable the decomposition dies with it
          modelPlan = normalized
            ? {
                ...normalized,
                visualPlan: normalizedVisualPlan,
              }
            : null
        } catch {
          modelPlan = null
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
    emit('critic.started', true, undefined, { candidateId })
    critic = criticVerdict({
      solve: best.solve,
      edges: state.edges,
      canvasW: input.canvasW,
      canvasH: input.canvasH,
      importance: state.importance,
      groupIds: state.groupIds,
      intent: { plan: state.plan, spatial: best.plan },
      routed: routes,
      passThreshold: qualityThresholdFor(input.contract),
      family: (family ?? familyFallback ?? undefined) as
        | import('../contract/figure-contract.js').FigureFamily
        | undefined,
      typography: buildTypographySignals(state),
      ...(input.contract
        ? {
            finalWidthMm:
              input.contract.output.finalWidthMm ??
              OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context],
          }
        : {}),
    })
    // Scientific audit (17.3): evidence coverage, connector realization,
    // causal direction, dominance. Hard scientific failures escalate a PASS —
    // the figure may look clean while silently dropping required science.
    // QA-P0-05: audit against the DECLARED reading flow (all six), the solved
    // spatial plan and family; QA-P1-06/07 validators append structured
    // domain/family checks.
    const declaredFlow: ReadingFlow = resolveReadingFlow(best.plan, state.plan)
    scientificIssues = [
      ...auditScientific({
        plan: state.plan,
        placements: best.solve.placements,
        routes,
        importance: state.importance,
        spatial: best.plan,
        ...((family ?? familyFallback) ? { family: (family ?? familyFallback)! } : {}),
        domain,
        direction: declaredFlow,
      }),
      ...validateDomain(state.plan, domain),
      ...validateFamily(state.plan, (family ?? familyFallback ?? undefined) as string | undefined),
    ]
    const hardScientific = scientificIssues.filter((issue) => issue.severity === 'hard')
    lastScientificHard = hardScientific.length
    if (hardScientific.length > 0 && critic.verdict === 'PASS') {
      const needsRoute = hardScientific.some((issue) => issue.repairClass === 'ROUTE_FIX')
      critic = {
        ...critic,
        verdict: needsRoute ? 'ROUTE_FIX' : 'RECOMPOSE',
        reason: hardScientific.map((issue) => issue.message).join('; '),
        gateIssues: [...critic.gateIssues, ...scientificIssues.map((issue) => issue.message)],
      }
    } else if (scientificIssues.length > 0) {
      critic = {
        ...critic,
        gateIssues: [...critic.gateIssues, ...scientificIssues.map((issue) => issue.message)],
      }
    }
    // P1: forbidden claims / visible-text violations block delivery outright.
    // Recomputed for THIS attempt's plan on every replan (ORCH-P0-03).
    // P0.5: full contract audit over the final render intent feeds the same
    // gate; EVIDENCE_MISSING escalates to semantic replan like forbidden hits.
    const contractAuditResult = auditContract(
      state.plan,
      best.plan.visualPlan,
      best.solve.placements,
    )
    lastContractViolations = contractAuditResult.violations
    lastMissingEvidence = contractAuditResult.missingEvidence
    const contractViolations = contractAuditResult.violations + state.forbiddenHits.length
    if (contractViolations > 0 || contractAuditResult.missingEvidence > 0) {
      const message = [
        ...state.forbiddenHits.map((claim) => `forbidden claim: ${claim}`),
        ...contractAuditResult.messages,
      ].join('; ')
      if (critic.verdict === 'PASS' || critic.verdict === 'LOCAL_LAYOUT_FIX') {
        critic = {
          ...critic,
          verdict: 'RECOMPOSE',
          reason: message,
          gateIssues: [...critic.gateIssues, ...message.split('; ')],
        }
      } else {
        critic = { ...critic, gateIssues: [...critic.gateIssues, ...message.split('; ')] }
      }
    }
    // P3: publication QA at final physical size (fonts scale forward, so this
    // only fires when the plan itself forced text below the contract floor).
    if (input.contract) {
      const pubIssues = publicationAudit({
        contract: input.contract,
        canvasW: input.canvasW,
        canvasH: input.canvasH,
        // P0.5 SSOT: the audit consumes the effective pt the renderer draws
        minFontPt: typography!.minEffectiveTextPt,
      })
      const pubHard = pubIssues.filter((issue) => issue.severity === 'hard')
      lastPublicationHard = pubHard.length
      if (pubHard.length > 0) {
        repairs.push('TYPOGRAPHY_FIX')
        const message = pubHard.map((issue) => issue.detail).join('; ')
        critic = {
          ...critic,
          verdict: 'RECOMPOSE',
          reason: message,
          gateIssues: [...critic.gateIssues, message],
        }
      }
    }
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
      critic = criticVerdict({
        solve: best.solve,
        edges: state.edges,
        canvasW: input.canvasW,
        canvasH: input.canvasH,
        importance: state.importance,
        groupIds: state.groupIds,
        intent: { plan: state.plan, spatial: best.plan },
        routed: routes,
        passThreshold: qualityThresholdFor(input.contract),
        family: (family ?? familyFallback ?? undefined) as
          | import('../contract/figure-contract.js').FigureFamily
          | undefined,
        typography: buildTypographySignals(state),
        ...(input.contract
          ? {
              finalWidthMm:
                input.contract.output.finalWidthMm ??
                OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context],
            }
          : {}),
      })
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
    // L3 budget exhausted: accept the best-ranked candidate we have and ship.
    if (
      (critic.verdict === 'LOCAL_LAYOUT_FIX' || critic.verdict === 'ROUTE_FIX') &&
      candidateIdx >= 2
    ) {
      repairs.push('L3 LOCAL_GEOMETRY_FIX (budget exhausted)')
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

  if (!best || !critic) {
    const error = 'composition pipeline ended without a candidate'
    emit('figure.failed', false, error)
    return failResult(error)
  }

  // P0.5 Delivery Gate — the ONLY source of orchestration.ok. Repair budget
  // exhaustion is never acceptance: a non-PASS verdict after the full ladder
  // fails delivery with every diagnostic preserved.
  const delivery = evaluateDeliveryGate({
    critic,
    scientificHardIssues: lastScientificHard,
    publicationHardIssues: lastPublicationHard,
    contentContractViolations: lastContractViolations + state.forbiddenHits.length,
    requiredEvidenceMissing: lastMissingEvidence,
    repairBudgetExhausted: true,
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
    delivery,
    typography,
  }
}
