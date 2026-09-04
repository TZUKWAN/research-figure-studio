/**
 * Creation Orchestrator (Phase 3, GOAL §23/§65) with the Visual Quality
 * Stabilization repair hierarchy: ROUTE_FIX re-runs the orthogonal router,
 * LOCAL_LAYOUT_FIX promotes the next-ranked candidate, RECOMPOSE (≤2) redraws
 * composition intent. Creation NEVER depends on tool calling; Editing keeps
 * the existing ReAct + execute_slide_script path untouched.
 */
import { parseFigurePlanV2, type FigurePlanV2 } from '../semantic/figure-plan.js'
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

/** Repair hierarchy actually applied (L2/L3/L5 of GOAL repair ladder). */
export type AppliedRepair =
  | 'L2 ROUTE_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX'
  | 'L3 LOCAL_GEOMETRY_FIX (budget exhausted)'
  | 'L5 RECOMPOSE (semantic replan)'
  | 'L5 RECOMPOSE (composition redesign)'

export interface OrchestrationResult {
  ok: boolean
  trace: OrchestrationEvent[]
  plan?: FigurePlanV2
  autonomy?: AutonomyLevel
  measured?: MeasuredNode[]
  best?: CompositionCandidate
  /** model-authored decomposition already scoped to semantic node IDs */
  visualPlan?: import('../visual/visualPlan.js').VisualPlan
  /** relations deliberately expressed through position/grouping rather than a connector */
  unrenderedRelations?: RoutedEdge[]
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
  const specFor = (type: keyof typeof SEMANTIC_NODE_STYLES): NodeTextSpec => {
    const style = SEMANTIC_NODE_STYLES[type]
    return {
      titleSizePt: input.nodeSpec?.titleSizePt ?? style.titleSizePt,
      detailSizePt: input.nodeSpec?.detailSizePt ?? style.detailSizePt,
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
  const edges: FigureEdgesInput[] = plan.edges.map((edge, index) => ({
    id: edge.id ?? `edge:${edge.from}->${edge.to}:${edge.relation}:${index}`,
    from: edge.from,
    to: edge.to,
    role: edge.role,
    relation: edge.relation,
    ...(edge.presentation ? { presentation: edge.presentation } : {}),
  }))
  const signals = {
    roles: new Set(plan.nodes.map((node) => node.role)),
    relations: new Set(plan.edges.map((edge) => edge.relation)),
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
      presentation: edge.presentation ?? 'arrow',
      priority: edgePriorityById.get(`${edge.from}\u0000${edge.to}`) ?? 'secondary',
    }))
    // Relationship presentation is model-authored: connectors are routed only
    // when the declared representation is a connector, regardless of whether
    // the semantic relationship happened to be classified as primary.
    const routeableInputs = routeInputs.filter((edge) =>
      connectorPresentations.has(edge.presentation),
    )
    unrenderedRelations = routeInputs
      .filter((edge) => !connectorPresentations.has(edge.presentation))
      .map((edge) => ({ ...edge, status: 'suppressed' as const, laneOffsetPx: 0 }))
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
    })
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
      repairs.push(
        critic.decisions?.some((d) => d.scope === 'semantic')
          ? 'L5 RECOMPOSE (semantic replan)'
          : 'L5 RECOMPOSE (composition redesign)',
      )
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
    unrenderedRelations,
    routes,
    critic,
    ...(repairs.length > 0 ? { repairs } : {}),
  }
}
