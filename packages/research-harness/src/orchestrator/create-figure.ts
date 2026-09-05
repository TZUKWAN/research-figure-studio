/**
 * Creation Orchestrator (Phase 3, GOAL §23/§65) with the Visual Quality
 * Stabilization repair hierarchy: ROUTE_FIX re-runs the orthogonal router,
 * LOCAL_LAYOUT_FIX promotes the next-ranked candidate, RECOMPOSE (≤2) redraws
 * composition intent. Creation NEVER depends on tool calling; Editing keeps
 * the existing ReAct + execute_slide_script path untouched.
 */
import { parseFigurePlanV2, type FigurePlanV2 } from '../semantic/figure-plan.js'
import type { RelationPresentation } from '../semantic/schema.js'
import { normalizeSpatialPlan, type SpatialPlan } from '../composition/spatial-plan.js'
import {
  measureNode,
  estimatorMeasurer,
  type MeasuredNode,
  type NodeTextSpec,
} from '../measurement/measure.js'
import { SEMANTIC_NODE_STYLES } from '../components/semantic-styles.js'
import {
  capabilityProfile,
  selectAutonomy,
  type AutonomyLevel,
  type CapabilityInput,
} from '../models/autonomy.js'
import {
  generateCandidates,
  type CompositionCandidate,
  type FigureEdgesInput,
  type NodeMeta,
} from '../composition/candidate.js'
import type { CriticVerdict } from '../critic/metric-critic.js'
import { criticVerdict } from '../critic/metric-critic.js'
import { routeEdgesWithObstacles, type RoutedEdge } from '../routing/router.js'
import { classifyEdges, type EdgeTarget } from '../constraints/edge-aware-solver.js'
import { normalizeVisualPlan } from '../visual/visualPlan.js'
import { compositionSignature } from '../composition/priors.js'
import { auditScientific, type ScientificIssue } from '../critic/scientific-critic.js'
import {
  OUTPUT_CONTEXT_DEFAULT_WIDTH_MM,
  OUTPUT_CONTEXT_MIN_TEXT_PT,
  publicationAudit,
  qualityThresholdFor,
} from '../contract/figure-contract.js'
import {
  domainPresentationDefault,
  resolveDomain,
  DOMAIN_PROFILES,
} from '../contract/domain-profile.js'
import { downgradePresentation } from '../protocol/runtime-capabilities.js'

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

/** Typed machine diagnostics for LLM-stage failures (AI-P0-08/09). The
 *  deterministic fallback may still deliver a figure, but the reason it did is
 *  always recorded here — never swallowed. */
export type OrchestrationDiagnosticCode =
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

/** Run one stage against its budget and the run signal; rejects with StageTimeoutError on budget overrun. */
async function withStageBudget<T>(
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
  /** publication contract (P1): venue, final size, forbidden claims, provenance */
  contract?: import('../contract/figure-contract.js').FigureContract
  /** domain hint when no contract is supplied */
  domainHint?: string
  /** aborts in-flight LLM stages and stops before the next deterministic stage (AI-P1-05) */
  signal?: AbortSignal
  /** per-stage LLM budgets (AI-P0-11); stage-specific policy lives with the caller */
  stageBudgets?: StageBudgets
  /** when false the composition designer is never called (deterministic prior only) */
  allowModelComposition?: boolean
}

export type OrchestrationStage =
  | 'semantic.plan'
  | 'text.optimized'
  | 'measurement.completed'
  | 'capability.selected'
  | 'composition.started'
  | 'composition.completed'
  | 'layout.solved'
  | 'route.repaired'
  | 'layout.repaired'
  | 'critic.completed'
  | 'recompose.started'
  | 'figure.completed'
  | 'figure.failed'

export interface OrchestrationEvent {
  stage: OrchestrationStage
  ok: boolean
  detail?: string
}

/** Repair hierarchy actually applied (extended P0 ladder). */
export type AppliedRepair =
  | 'L2 ROUTE_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX (budget exhausted)'
  | 'L4 COMPOSITION_REDESIGN'
  | 'L5 RECOMPOSE (semantic replan)'
  | 'L5 RECOMPOSE (composition redesign)'
  | 'L6 SEMANTIC_REPLAN'
  | 'CONTENT_REDUCE'
  | 'TYPOGRAPHY_FIX'

export interface OrchestrationResult {
  ok: boolean
  trace: OrchestrationEvent[]
  plan?: FigurePlanV2
  autonomy?: AutonomyLevel
  measured?: MeasuredNode[]
  best?: CompositionCandidate
  /** model-authored decomposition already scoped to semantic node IDs */
  visualPlan?: import('../visual/visualPlan.js').VisualPlan
  /** resolved scientific domain (P1): drives renderer primitives + connector language */
  domain?: import('../contract/domain-profile.js').ScientificDomain
  /** relations deliberately expressed through position/grouping rather than a connector */
  unrenderedRelations?: RoutedEdge[]
  /** ranked candidate summary (P2 art direction): the set the winner was chosen from */
  candidates?: Array<{ source: string; priorId: string | null; score: number; crossings: number }>
  routes?: RoutedEdge[]
  critic?: CriticVerdict
  repairs?: AppliedRepair[]
  /** true when a model composition failed/timed out and a deterministic prior was used */
  fallbackUsed?: boolean
  /** machine reason for the deterministic fallback (see diagnostics) */
  fallbackReason?: string
  /** typed LLM-stage failures; always populated when fallbackUsed (AI-P0-08) */
  diagnostics?: OrchestrationDiagnostic[]
  /** char/latency accounting of the structured planning calls (AI-P1-08) */
  planningMetrics?: PlanningMetric[]
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

export async function orchestrateFigure(
  input: OrchestrationInput,
  llm: OrchestratorLlm,
  onEvent?: (event: OrchestrationEvent) => void,
): Promise<OrchestrationResult> {
  const trace: OrchestrationEvent[] = []
  const emit = (stage: OrchestrationStage, ok: boolean, detail?: string) => {
    const event = { stage, ok, ...(detail ? { detail } : {}) }
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

  // SEMANTIC_PLAN (+R2 repair loop handled by the caller on null). A stage
  // budget (AI-P0-11) applies to the LLM call only; parse/schema failures get
  // distinct typed diagnostics so callers can tell a broken model apart from a
  // slow gateway (AI-P0-08).
  emit('semantic.plan', true)
  let plan: FigurePlanV2 | null = null
  const diagnostics: OrchestrationDiagnostic[] = []
  const planningMetrics: PlanningMetric[] = []
  const diagnose = (code: OrchestrationDiagnosticCode, message: string, attempt = 0) => {
    diagnostics.push({ code, message, attempt })
  }
  try {
    throwIfAborted(input.signal)
    const started = Date.now()
    let raw: unknown
    try {
      raw = await withStageBudget(
        'semantic planner',
        (signal) => llm.semanticPlan(input.thesis, undefined, signal),
        { signal: input.signal, budgetMs: input.stageBudgets?.semanticMs },
      )
    } catch (err) {
      if (err instanceof StageTimeoutError) {
        diagnose('MODEL_SEMANTIC_TIMEOUT', err.message)
        throw new Error(`semantic planner failed: ${err.message}`)
      }
      if (input.signal?.aborted) {
        diagnose('MODEL_SEMANTIC_CANCELLED', 'run cancelled during semantic planning')
        throw new Error('cancelled')
      }
      diagnose('MODEL_SEMANTIC_PROVIDER_FAILED', err instanceof Error ? err.message : String(err))
      throw err
    }
    planningMetrics.push({
      stage: 'semantic',
      inputChars: input.thesis.length,
      outputChars: raw === null || raw === undefined ? 0 : JSON.stringify(raw).length,
      latencyMs: Date.now() - started,
      retries: 0,
    })
    plan = parseFigurePlanV2(raw)
    if (!plan) {
      diagnose('MODEL_SEMANTIC_SCHEMA_FAILED', 'FigurePlan v2 failed schema validation')
      emit('figure.failed', false, 'FigurePlan v2 failed schema validation')
      return {
        ok: false,
        trace,
        error: 'FigurePlan v2 failed schema validation',
        diagnostics,
        planningMetrics,
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'cancelled') {
      emit('figure.failed', false, 'cancelled')
      return { ok: false, trace, error: 'cancelled', diagnostics, planningMetrics }
    }
    emit('figure.failed', false, message)
    return {
      ok: false,
      trace,
      error: `semantic planner failed: ${message}`,
      diagnostics,
      planningMetrics,
    }
  }

  // TEXT_OPTIMIZE: if the planner did not compress visible titles, derive a
  // restrained fallback (first clause, ≤14 chars) — soft rule, meaning kept.
  emit('text.optimized', true)
  for (const node of plan.nodes) {
    if (!node.visible.title) {
      node.visible.title = node.semanticLabel.slice(0, 14)
    }
  }

  // MEASURE — Component Registry v2: each semantic type measures with ITS OWN
  // visual capacity (mechanism ≠ variable ≠ annotation)
  emit('measurement.completed', true)
  const measure = input.measure ?? measureNode
  const measured = plan.nodes.map((node) => ({
    ...measure(
      { title: node.visible.title, detail: node.visible.detail },
      specFor(node.type),
      estimatorMeasurer(),
    ),
    title: node.id,
  }))

  // CAPABILITY_SELECT
  const capability = capabilityProfile(input.capability ?? {})
  const complexity = {
    nodeCount: plan.nodes.length,
    edgeCount: plan.edges.length,
    hasFeedback: plan.edges.some((edge) => edge.relation === 'feedback'),
    hasModeration: plan.edges.some((edge) => edge.relation === 'moderation'),
  }
  const autonomy = input.autonomyOverride ?? selectAutonomy(capability, complexity)
  emit('capability.selected', true, autonomy)

  // Semantic IDs are the internal identity everywhere. Visible titles remain
  // display text only, so routing and criticism cannot lose a node to title
  // translation or duplicate labels.
  // Capability contract (AI-P0-05): a stale prompt may still have let the model
  // declare a presentation this renderer does not realize (e.g. `junction`);
  // such edges are downgraded to the renderer-realizable default here instead
  // of producing a visually meaningless line.
  const downgradedPresentations: string[] = []
  const edges: FigureEdgesInput[] = plan.edges.map((edge, index) => {
    let presentation =
      edge.presentation ?? domainPresentationDefault(domain, edge.relation) ?? undefined
    if (presentation) {
      const downgrade = downgradePresentation(presentation)
      if (downgrade) {
        downgradedPresentations.push(`edge ${edge.id ?? index}: ${downgrade.reason}`)
        presentation = downgrade.fallback
      }
    }
    return {
      id: edge.id ?? `edge:${edge.from}->${edge.to}:${edge.relation}:${index}`,
      from: edge.from,
      to: edge.to,
      role: edge.role,
      relation: edge.relation,
      ...(presentation ? { presentation } : {}),
    }
  })
  for (const reason of downgradedPresentations) {
    diagnose('MODEL_PRESENTATION_DOWNGRADED', reason)
  }
  // P1: forbidden claims / visible-text violations are semantic hard failures.
  const forbiddenClaims = [
    ...(input.contract?.forbiddenClaims ?? []),
    ...(input.contract?.visibleTextPolicy.forbidden ?? []),
  ]
  const forbiddenHits = forbiddenClaims.filter((claim) => {
    const needle = claim.toLowerCase()
    return plan.nodes.some(
      (node) =>
        node.visible.title.toLowerCase().includes(needle) ||
        node.visible.detail?.toLowerCase().includes(needle) ||
        node.semanticLabel.toLowerCase().includes(needle),
    )
  })
  const signals = {
    roles: new Set(plan.nodes.map((node) => node.role)),
    relations: new Set(plan.edges.map((edge) => edge.relation)),
    signature: compositionSignature({
      nodeCount: plan.nodes.length,
      edgeCount: plan.edges.length,
      relations: new Set(plan.edges.map((edge) => edge.relation)),
      roles: new Set(plan.nodes.map((node) => node.role)),
      edges: plan.edges.map((edge) => ({ from: edge.from, to: edge.to, role: edge.role })),
      importances: plan.nodes.map((node) => node.importance),
    }),
  }
  const meta = new Map<string, NodeMeta>(
    plan.nodes.map((node) => [
      node.id,
      { importance: node.importance, ...(node.groupId ? { groupId: node.groupId } : {}) },
    ]),
  )
  const edgeTargets: EdgeTarget[] = classifyEdges(plan)
  const edgePriorityById = new Map<string, 'primary' | 'secondary' | 'feedback'>()
  for (const e of edgeTargets) {
    edgePriorityById.set(`${e.fromId}\u0000${e.toId}`, e.priority)
  }
  const collisionClasses = new Map(
    plan.nodes.map((node) => [node.id, SEMANTIC_NODE_STYLES[node.type].collisionClass]),
  )
  const importance = new Map(plan.nodes.map((node) => [node.id, node.importance]))
  const groupIds = new Map(
    plan.nodes.flatMap((node) => (node.groupId ? [[node.id, node.groupId] as const] : [])),
  )
  const direction = plan.readingIntent?.preferredDirection === 'TB' ? 'TB' : 'LR'

  const maxRecompose = input.maxRecompose ?? 2
  let critique: string[] | undefined
  let best: CompositionCandidate | null = null
  let critic: CriticVerdict | undefined = undefined
  let candidates: CompositionCandidate[] = []
  let candidateIdx = 0
  let attempt = 0
  let routeRetried = false
  const repairs: AppliedRepair[] = []
  let routes: RoutedEdge[] = []
  let unrenderedRelations: RoutedEdge[] = []
  let visualPlan: ReturnType<typeof normalizeVisualPlan> = { modules: [] }
  let fallbackUsed = false
  let fallbackReason: string | undefined

  try {
    while (true) {
      throwIfAborted(input.signal)
      if (candidates.length === 0) {
        emit('composition.started', true, attempt === 0 ? autonomy : `recompose#${attempt}`)
        let modelPlan: SpatialPlan | null = null
        if (autonomy !== 'A0' && llm.compose && input.allowModelComposition !== false) {
          const composeStart = Date.now()
          let raw: unknown = null
          let providerFailed: string | null = null
          let stageDiagnosed = false
          try {
            throwIfAborted(input.signal)
            raw = await withStageBudget(
              'composition designer',
              (signal) =>
                llm.compose!({
                  plan,
                  measured: measured.map((node, index) => ({
                    id: plan.nodes[index]?.id ?? node.title,
                    w: node.bounds.preferredWidth,
                    h: node.bounds.preferredHeight,
                  })),
                  canvas: { w: input.canvasW, h: input.canvasH },
                  autonomy,
                  ...(critique ? { critique } : {}),
                  ...(signal ? { signal } : {}),
                }),
              { signal: input.signal, budgetMs: input.stageBudgets?.compositionMs },
            )
          } catch (err) {
            if (err instanceof StageTimeoutError) {
              diagnose('MODEL_COMPOSITION_TIMEOUT', err.message, attempt)
              fallbackUsed = true
              fallbackReason = err.message
              stageDiagnosed = true
            } else if (input.signal?.aborted) {
              diagnose('MODEL_COMPOSITION_CANCELLED', 'run cancelled during composition', attempt)
              throw new Error('cancelled')
            } else {
              providerFailed = err instanceof Error ? err.message : String(err)
              diagnose('MODEL_COMPOSITION_PROVIDER_FAILED', providerFailed, attempt)
              fallbackUsed = true
              fallbackReason = providerFailed
              stageDiagnosed = true
            }
          }
          if (raw === null || raw === undefined) {
            if (!stageDiagnosed) {
              diagnose(
                'MODEL_COMPOSITION_PROVIDER_FAILED',
                'composition call returned no result',
                attempt,
              )
              fallbackUsed = true
              fallbackReason = 'composition call returned no result'
            }
          } else {
            // Distinguish "model emitted no parseable JSON" from "JSON violated
            // the SpatialPlan contract" — the fallback is allowed either way, but
            // the diagnostics must say which (AI-P0-08).
            let parsed: unknown = raw
            let parseFailed = false
            if (typeof raw === 'string') {
              try {
                parsed = JSON.parse(raw)
              } catch {
                parseFailed = true
              }
            }
            if (parseFailed) {
              diagnose(
                'MODEL_COMPOSITION_PARSE_FAILED',
                'composition response was not parseable JSON',
                attempt,
              )
              fallbackUsed = true
              fallbackReason = 'composition response was not parseable JSON'
            } else {
              const normalized = normalizeSpatialPlan(
                parsed,
                plan.nodes.map((node) => node.id),
                { readingFlow: 'LR', visualRole: 'primary' },
              )
              const normalizedVisualPlan = normalizeVisualPlan(
                (parsed as Record<string, unknown> | null)?.visualPlan,
                plan,
              )
              if (normalized) {
                modelPlan = { ...normalized, visualPlan: normalizedVisualPlan }
                if (normalizedVisualPlan.modules.length > 0) visualPlan = normalizedVisualPlan
              } else {
                diagnose(
                  'MODEL_COMPOSITION_SCHEMA_FAILED',
                  'SpatialPlan failed schema validation (no usable placements)',
                  attempt,
                )
                fallbackUsed = true
                fallbackReason = 'SpatialPlan failed schema validation'
              }
            }
            planningMetrics.push({
              stage: 'composition',
              inputChars: JSON.stringify(plan.thesis).length,
              outputChars: JSON.stringify(raw).length,
              latencyMs: Date.now() - composeStart,
              retries: 0,
              providerMode: modelPlan ? 'model-composition' : 'deterministic-fallback',
            })
          }
        }
        candidates = generateCandidates(
          autonomy,
          measured,
          edges,
          signals,
          input.canvasW,
          input.canvasH,
          modelPlan,
          meta,
        )
        if (candidates.length === 0) {
          emit('figure.failed', false, 'no composition candidates generated')
          return {
            ok: false,
            trace,
            error: 'no composition candidates generated',
            plan,
            autonomy,
            measured,
            diagnostics,
            planningMetrics,
            ...(fallbackUsed ? { fallbackUsed, fallbackReason } : {}),
            ...(best
              ? {
                  best,
                  visualPlan,
                  domain,
                  unrenderedRelations,
                  routes,
                  critic,
                  repairs: repairs as AppliedRepair[],
                }
              : {}),
          }
        }
        candidateIdx = 0
      }
      best = candidates[Math.min(candidateIdx, candidates.length - 1)]!
      if (best.plan.visualPlan) visualPlan = best.plan.visualPlan
      emit('composition.completed', true, best.source)

      // Geometry legalizes the designer's composition but never repositions
      // boxes merely to make a primary connector straighter.
      emit('layout.solved', true, `${best.solve.issues.length} issues`)

      const rectMap = new Map(best.solve.placements.map((placement) => [placement.id, placement]))
      const connectorPresentations = new Set([
        'arrow',
        'line',
        'dashed-arrow',
        'inhibition',
        'feedback-loop',
        'junction',
      ])
      const routeInputs = edges.map((edge) => ({
        key: edge.id ?? `${edge.from}->${edge.to}`,
        semanticEdgeId: edge.id ?? `${edge.from}->${edge.to}`,
        fromId: edge.from,
        toId: edge.to,
        role: edge.role,
        relation: edge.relation,
        presentation: (edge.presentation ?? 'arrow') as RelationPresentation,
        priority: edgePriorityById.get(`${edge.from}\u0000${edge.to}`) ?? 'secondary',
      }))
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
      const densityCap = Math.max(3, Math.ceil(plan.nodes.length * 1.8))
      let routeableInputs = connectorInputs
      if (connectorInputs.length > densityCap) {
        const rank: Record<string, number> = { primary: 0, feedback: 1, secondary: 2 }
        const sorted = [...connectorInputs].sort(
          (a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) || a.key.localeCompare(b.key),
        )
        const kept = sorted.slice(0, densityCap)
        const demoted = sorted.slice(densityCap)
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
        direction,
      )
      critic = criticVerdict({
        solve: best.solve,
        edges,
        canvasW: input.canvasW,
        canvasH: input.canvasH,
        importance,
        groupIds,
        intent: { plan, spatial: best.plan },
        routed: routes,
        passThreshold: qualityThresholdFor(input.contract),
      })
      // Scientific audit (17.3): evidence coverage, connector realization,
      // causal direction, dominance. Hard scientific failures escalate a PASS —
      // the figure may look clean while silently dropping required science.
      const scientificIssues: ScientificIssue[] = auditScientific({
        plan,
        placements: best.solve.placements,
        routes,
        importance,
        ...(direction === 'TB' ? { direction } : {}),
      })
      const hardScientific = scientificIssues.filter((issue) => issue.severity === 'hard')
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
      if (forbiddenHits.length > 0) {
        const message = `forbidden claim(s) reached the canvas: ${forbiddenHits.join('; ')}`
        if (critic.verdict === 'PASS' || critic.verdict === 'LOCAL_LAYOUT_FIX') {
          critic = {
            ...critic,
            verdict: 'RECOMPOSE',
            reason: message,
            gateIssues: [...critic.gateIssues, message],
          }
        } else {
          critic = { ...critic, gateIssues: [...critic.gateIssues, message] }
        }
      }
      // P3: publication QA at final physical size (fonts scale forward, so this
      // only fires when the plan itself forced text below the contract floor).
      if (input.contract) {
        const pubIssues = publicationAudit({
          contract: input.contract,
          canvasW: input.canvasW,
          canvasH: input.canvasH,
          minFontPt: Math.min(
            ...plan.nodes.map(
              (node) => SEMANTIC_NODE_STYLES[node.type].detailSizePt * contractFontScale,
            ),
          ),
        })
        const pubHard = pubIssues.filter((issue) => issue.severity === 'hard')
        if (pubHard.length > 0) {
          repairs.push('TYPOGRAPHY_FIX' as AppliedRepair)
          const message = pubHard.map((issue) => issue.detail).join('; ')
          critic = {
            ...critic,
            verdict: 'RECOMPOSE',
            reason: message,
            gateIssues: [...critic.gateIssues, message],
          }
        }
      }
      emit('critic.completed', true, critic.verdict)

      if (critic.verdict === 'ROUTE_FIX' && !routeRetried) {
        // Geometry fix for connector geometry only: admit one extra corridor,
        // never touch the composition or suppress a declared relation.
        routeRetried = true
        repairs.push('L2 ROUTE_FIX')
        const extraLanes = [median(best.solve.placements.map((p) => p.y + p.h / 2))]
        routes = routeEdgesWithObstacles(
          routeableInputs,
          rectMap,
          { w: input.canvasW, h: input.canvasH },
          direction,
          extraLanes,
        )
        critic = criticVerdict({
          solve: best.solve,
          edges,
          canvasW: input.canvasW,
          canvasH: input.canvasH,
          importance,
          groupIds,
          intent: { plan, spatial: best.plan },
          routed: routes,
          passThreshold: qualityThresholdFor(input.contract),
        })
        emit('route.repaired', true, critic.verdict)
        emit('critic.completed', true, `${critic.verdict} (after L2)`)
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

      if (critic.verdict === 'RECOMPOSE' && attempt < maxRecompose) {
        attempt++
        const semanticFailure =
          critic.hardGates.some((gate) => gate.scope === 'semantic' && !gate.pass) ||
          (critic.decisions?.some((d) => d.scope === 'semantic') ?? false)
        repairs.push(semanticFailure ? 'L6 SEMANTIC_REPLAN' : 'L5 RECOMPOSE (composition redesign)')
        if (critic.scores.compositionQuality <= 3) repairs.push('CONTENT_REDUCE')
        emit('recompose.started', true, `attempt ${attempt}`)
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
    // Cancel between deterministic stages: surface a typed cancelled result
    // instead of throwing through the caller's tool executor.
    if (input.signal?.aborted) {
      diagnose(
        'MODEL_COMPOSITION_CANCELLED',
        'run cancelled during the composition ladder',
        attempt,
      )
      emit('figure.failed', false, 'cancelled')
      return {
        ok: false,
        trace,
        error: 'cancelled',
        plan,
        autonomy,
        measured,
        diagnostics,
        planningMetrics,
      }
    }
    throw err
  }

  if (!best || !critic) {
    emit('figure.failed', false, 'composition pipeline ended without a candidate')
    return {
      ok: false,
      trace,
      error: 'composition pipeline ended without a candidate',
      plan,
      autonomy,
      diagnostics,
      planningMetrics,
      ...(fallbackUsed ? { fallbackUsed, fallbackReason } : {}),
      ...(best
        ? {
            best,
            visualPlan,
            domain,
            unrenderedRelations,
            routes,
            measured,
            critic,
            repairs: repairs as AppliedRepair[],
          }
        : {}),
    }
  }

  emit('figure.completed', true, critic.verdict)
  return {
    ok: critic.verdict !== 'RECOMPOSE',
    trace,
    plan,
    autonomy,
    measured,
    best,
    visualPlan,
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
    ...(repairs.length > 0 ? { repairs } : {}),
    ...(fallbackUsed ? { fallbackUsed, fallbackReason } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(planningMetrics.length > 0 ? { planningMetrics } : {}),
  }
}
