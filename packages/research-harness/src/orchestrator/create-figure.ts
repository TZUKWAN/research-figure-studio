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
  validateDomain,
  validateFamily,
  familyFromFigureType,
} from '../critic/family-validators.js'
import type { TypographySignal } from '../critic/metric-critic.js'
import {
  OUTPUT_CONTEXT_DEFAULT_WIDTH_MM,
  OUTPUT_CONTEXT_MIN_TEXT_PT,
  publicationAudit,
  qualityThresholdFor,
} from '../contract/figure-contract.js'
import { auditFigureContract, type RenderedText } from '../contract/contract-audit.js'
import { evaluateDeliveryGate } from '../delivery/delivery-gate.js'
import { resolveFigureTypography } from '../render/typography.js'
import {
  domainPresentationDefault,
  resolveDomain,
} from '../contract/domain-profile.js'

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
  /** publication contract (P1): venue, final size, forbidden claims, provenance */
  contract?: import('../contract/figure-contract.js').FigureContract
  /** domain hint when no contract is supplied */
  domainHint?: string
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
  /** P0.5 delivery gate verdict — ok === delivery.pass, always */
  delivery?: import('../delivery/delivery-gate.js').DeliveryGateResult
  /** resolved render typography (P0.5 SSOT): what the renderer must draw */
  typography?: import('../render/typography.js').ResolvedFigureTypography
  routes?: RoutedEdge[]
  critic?: CriticVerdict
  repairs?: AppliedRepair[]
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
  // P1/P0.5: domain resolution + Render Typography single source of truth.
  // Every visible pt size is resolved ONCE here (contract-scaled); measurement,
  // the renderer and the publication audit all consume the same object.
  const domain = resolveDomain(input.contract?.domain ?? input.domainHint)
  /** P0.5: single source of truth for every visible pt; resolved after parse */
  let typography: import('../render/typography.js').ResolvedFigureTypography | null = null
  const specFor = (type: keyof typeof SEMANTIC_NODE_STYLES): NodeTextSpec => {
    const style = SEMANTIC_NODE_STYLES[type]
    return {
      titleSizePt: style.titleSizePt,
      detailSizePt: style.detailSizePt,
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

  // SEMANTIC_PLAN (+R2 repair loop handled by the caller on null)
  emit('semantic.plan', true)
  let plan: FigurePlanV2 | null = null
  try {
    plan = parseFigurePlanV2(await llm.semanticPlan(input.thesis))
  } catch (err) {
    emit('figure.failed', false, err instanceof Error ? err.message : String(err))
    return {
      ok: false,
      trace,
      error: `semantic planner failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!plan) {
    emit('figure.failed', false, 'FigurePlan v2 failed schema validation')
    return { ok: false, trace, error: 'FigurePlan v2 failed schema validation' }
  }

  // P0.5: resolve the contract-scaled typography NOW (after parse, before any
  // measurement). The renderer and publication audit consume this same object.
  typography = resolveFigureTypography({
    plan,
    contract: input.contract,
    canvasW: input.canvasW,
    nodeSpecOverrides: input.nodeSpec,
  })

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
      {
        ...specFor(node.type),
        titleSizePt: typography!.node[node.id]!.titlePt,
        detailSizePt: typography!.node[node.id]!.detailPt,
      },
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
  const edges: FigureEdgesInput[] = plan.edges.map((edge, index) => {
    const presentation =
      edge.presentation ?? domainPresentationDefault(domain, edge.relation) ?? undefined
    return {
      id: edge.id ?? `edge:${edge.from}->${edge.to}:${edge.relation}:${index}`,
      from: edge.from,
      to: edge.to,
      role: edge.role,
      relation: edge.relation,
      ...(presentation ? { presentation } : {}),
    }
  })
  // P0.5: full contract audit over the FINAL render intent (macro titles/details,
  // micro-unit labels, edge labels). Runs each critic round; results feed the
  // delivery gate. Plan-level claims stay as an early precheck signal.
  const auditContract = (
    placements: Array<{ id: string }>,
  ): { violations: number; missingEvidence: number; messages: string[] } => {
    if (!input.contract) return { violations: 0, missingEvidence: 0, messages: [] }
    const rendered: RenderedText[] = []
    for (const node of plan.nodes) {
      rendered.push({ id: node.id, kind: 'title', text: node.visible.title })
      if (node.visible.detail)
        rendered.push({ id: node.id, kind: 'detail', text: node.visible.detail })
    }
    for (const module of visualPlan.modules) {
      for (const unit of module.units) {
        rendered.push({ id: unit.id, kind: 'micro', text: unit.label })
        if (unit.detail) rendered.push({ id: unit.id, kind: 'micro', text: unit.detail })
      }
    }
    for (const edge of plan.edges) {
      if (edge.label)
        rendered.push({
          id: edge.id ?? `${edge.from}->${edge.to}`,
          kind: 'label',
          text: edge.label,
        })
    }
    const evidenceRefs = new Map<string, string[]>()
    for (const node of plan.nodes) {
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
  const forbiddenClaims = [
    ...(input.contract?.forbiddenClaims ?? []),
    ...(input.contract?.visibleTextPolicy?.forbidden ?? []),
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
  // QA-P0-02/01: the critic scores composition against the figure FAMILY and
  // typography against MEASURED signals — both wired from the same data the
  // composer used, so the rubric can never silently drift from reality.
  const family = (input.contract?.figureFamily ??
    familyFromFigureType(plan.figureType) ??
    'freeform') as import('../contract/figure-contract.js').FigureFamily
  const PT_TO_PX = 96 / 72
  const typographySignals = new Map<string, TypographySignal>()
  for (const [index, node] of plan.nodes.entries()) {
    const m = measured[index]
    if (!m || m.title !== node.id) continue
    const spec = specFor(node.type)
    // P0.5 typography SSOT wins: the resolved (contract-scaled) pt is what the
    // renderer actually draws, so the critic must audit THAT, not the raw spec
    const resolvedPt = typography?.node[node.id]
    const titlePt = resolvedPt?.titlePt ?? spec.titleSizePt
    const detailPt = resolvedPt?.detailPt ?? spec.detailSizePt
    const textBlockH =
      m.titleLines * titlePt * PT_TO_PX * spec.lineHeight +
      (m.detailLines > 0 ? spec.titleGapY + m.detailLines * detailPt * PT_TO_PX * spec.lineHeight : 0)
    typographySignals.set(node.id, {
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
  // last per-iteration audit counters feeding the delivery gate
  let lastScientificHard = 0
  let lastPublicationHard = 0
  let lastContractViolations = 0
  let lastMissingEvidence = 0
  let unrenderedRelations: RoutedEdge[] = []
  let visualPlan: ReturnType<typeof normalizeVisualPlan> = { modules: [] }

  while (true) {
    if (candidates.length === 0) {
      emit('composition.started', true, attempt === 0 ? autonomy : `recompose#${attempt}`)
      let modelPlan: SpatialPlan | null = null
      if (autonomy !== 'A0' && llm.compose) {
        try {
          const raw = await llm.compose({
            plan,
            measured: measured.map((node, index) => ({
              id: plan.nodes[index]?.id ?? node.title,
              w: node.bounds.preferredWidth,
              h: node.bounds.preferredHeight,
            })),
            canvas: { w: input.canvasW, h: input.canvasH },
            autonomy,
            ...(critique ? { critique } : {}),
          })
          const normalized = normalizeSpatialPlan(
            raw,
            plan.nodes.map((node) => node.id),
            { readingFlow: 'LR', visualRole: 'primary' },
          )
          const normalizedVisualPlan = normalizeVisualPlan(
            (raw as Record<string, unknown> | null)?.visualPlan,
            plan,
          )
          modelPlan = normalized
            ? {
                ...normalized,
                visualPlan: normalizedVisualPlan,
              }
            : null
          if (normalizedVisualPlan.modules.length > 0) visualPlan = normalizedVisualPlan
        } catch {
          modelPlan = null
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
      // Directional relations (causal/inhibition/feedback/moderation primaries)
      // are NEVER density-suppressed: without an explicit directional symbol the
      // science is lost. Only secondary relations may be demoted to spatial
      // presentation; if directional edges alone exceed the cap, we keep them
      // all and let the delivery gate force a semantic replan instead.
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
      family,
      typography: typographySignals,
      ...(input.contract
        ? {
            finalWidthMm:
              input.contract.output.finalWidthMm ??
              OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context],
          }
        : {}),
    })
    // Scientific audit (17.3): evidence coverage, connector realization,
    // direction across ALL reading flows, contradiction/cycle policy, orphans,
    // scoped duplicate labels, multi-signal dominance. Hard scientific
    // failures escalate a PASS — the figure may look clean while silently
    // dropping required science.
    const scientificIssues: ScientificIssue[] = [
      ...auditScientific({
        plan,
        placements: best.solve.placements,
        routes,
        importance,
        spatial: best.plan,
        family,
        domain,
        ...(plan.readingIntent?.preferredDirection
          ? { direction: plan.readingIntent.preferredDirection }
          : {}),
      }),
      // QA-P1-06/07: domain + family validators (structured, soft)
      ...validateDomain(plan, domain),
      ...validateFamily(plan, family),
    ]
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
    // P0.5: full Figure Contract audit over the final render intent.
    const contractAuditResult = auditContract(best.solve.placements)
    lastContractViolations = contractAuditResult.violations
    lastMissingEvidence = contractAuditResult.missingEvidence
    lastScientificHard = hardScientific.length
    // P1: forbidden claims / visible-text violations block delivery outright.
    const contractViolations = contractAuditResult.violations + forbiddenHits.length
    if (contractViolations > 0 || contractAuditResult.missingEvidence > 0) {
      const messages = [
        ...forbiddenHits.map((claim) => `forbidden claim: ${claim}`),
        ...contractAuditResult.messages,
      ]
      const message = messages.join('; ')
      if (critic.verdict === 'PASS' || critic.verdict === 'LOCAL_LAYOUT_FIX') {
        critic = {
          ...critic,
          verdict: 'RECOMPOSE',
          reason: message,
          gateIssues: [...critic.gateIssues, ...messages],
        }
      } else {
        critic = { ...critic, gateIssues: [...critic.gateIssues, ...messages] }
      }
    }
    // P3: publication QA at final physical size (fonts scale forward, so this
    // only fires when the plan itself forced text below the contract floor).
    if (input.contract) {
      const pubIssues = publicationAudit({
        contract: input.contract,
        canvasW: input.canvasW,
        canvasH: input.canvasH,
        minFontPt: typography!.minEffectiveTextPt,
      })
      const pubHard = pubIssues.filter((issue) => issue.severity === 'hard')
      lastPublicationHard = pubHard.length
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
        family,
        typography: typographySignals,
        ...(input.contract
          ? {
              finalWidthMm:
                input.contract.output.finalWidthMm ??
                OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[input.contract.output.context],
            }
          : {}),
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

  if (!best || !critic) {
    emit('figure.failed', false, 'composition pipeline ended without a candidate')
    return {
      ok: false,
      trace,
      error: 'composition pipeline ended without a candidate',
      plan,
      autonomy,
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

  // P0.5 Delivery Gate — the ONLY source of orchestration.ok. Repair budget
  // exhaustion is never acceptance: a non-PASS verdict after the full ladder
  // fails delivery with every diagnostic preserved.
  const delivery = evaluateDeliveryGate({
    critic,
    scientificHardIssues: lastScientificHard,
    publicationHardIssues: lastPublicationHard,
    contentContractViolations: lastContractViolations + forbiddenHits.length,
    requiredEvidenceMissing: lastMissingEvidence,
    repairBudgetExhausted: true,
  })
  if (!delivery.pass) {
    const error = `delivery gate failed: ${delivery.detail} — ${critic.reason ?? critic.gateIssues.join('; ') ?? 'quality below threshold'}`
    emit('figure.failed', false, error)
    return {
      ok: false,
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
      error,
      delivery,
    }
  }
  emit('figure.completed', true, critic.verdict)
  return {
    ok: delivery.pass,
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
    delivery,
    typography,
  }
}
