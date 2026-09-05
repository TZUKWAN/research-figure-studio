/**
 * Native figure renderer (RENDER-P0-01…06, P1-03).
 *
 * A PURE translation from an OrchestrationResult to a FigureRenderPlan — no
 * IPC, no LLM, fully deterministic and unit-testable. The transaction layer
 * (transaction.ts) executes the plan; nothing here may mutate solver geometry.
 *
 * Hard invariants:
 *  - INVARIANT EXACT-GEOMETRY: module boxes are the solver placements,
 *    verbatim. The renderer never grows/shrinks a solved box (P0-01).
 *  - INVARIANT MICRO-FIT: micro unit boxes come from layoutMicro run against
 *    the SAME placement; unit heights are never re-clamped at emit time
 *    (P0-02). A module whose units cannot fit its solved box is a hard
 *    defect — creation fails instead of silently overflowing.
 *  - INVARIANT CONTENT-POLICY: every visible detail has a DetailDisposition
 *    (P0-05); a node without a visualPlan module renders its detail in the
 *    parent body — content never disappears.
 *  - INVARIANT DOMAIN-INHERITANCE: micro units compile from the module's
 *    domain-resolved kind, not a generic fallback (P0-06).
 *  - INVARIANT Z-ORDER: deterministic tiers — background region, container
 *    module, connector, node (grouped composite/leaf), annotation (P1-03).
 */
import {
  DOMAIN_PROFILES,
  getComponentSpec,
  layoutMicro,
  minimumHeightForUnits,
  type MajorModuleVisual,
  type RoutedEdge,
  type SemanticNodeType,
} from '@genoffice/research-harness'
import {
  connectorColor,
  resolveComponentColors,
  type ThemeRoles,
} from '@genoffice/theme-engine'
import type { SemanticMetadata } from '@genoffice/pptx-engine'
import type {
  ResearchNodeRecord,
} from '@genoffice/pptx-engine/research-metadata'
import { SEMANTIC_NODE_STYLES } from '@genoffice/research-harness'
import {
  compileComponentRenderSpec,
  connectorStyleFor,
  MICRO_UNIT_STROKE_PT,
  resolveDetailDisposition,
  roundRectAdjust,
  validateAnchorSide,
  type ComponentRenderSpec,
  type DetailDisposition,
} from './render-spec'
import {
  connectorMetadata,
  figureIdentity,
  microUnitMetadata,
  moduleMetadata,
  relationRecords,
  slidePayload,
} from './metadata'

/** Orchestrator result slice this renderer needs (structural, for tests). */
export interface FigureRenderInput {
  plan: {
    nodes: Array<{
      id: string
      type: SemanticNodeType
      visible: { title: string; detail?: string }
    }>
    edges: Array<{
      id?: string
      from: string
      to: string
      relation: string
      role?: string
      presentation?: string
      key?: string
    }>
  }
  solve: { placements: Array<{ id: string; x: number; y: number; w: number; h: number }> }
  routes: RoutedEdge[]
  visualPlan: { modules: MajorModuleVisual[] }
  domain?: string
  canvasW: number
  canvasH: number
  theme: ThemeRoles
  /** contract typography scale (1 when no contract) */
  fontScale?: number
  thesis: string
}

/** z-order tiers (creation order); background first, annotations last. */
export const Z_TIERS = {
  backgroundRegion: 0,
  containerModule: 1,
  connector: 2,
  compositeNode: 3,
  leafNode: 3,
  annotation: 4,
} as const

export interface NativeElementSpec {
  /** plan-local stable id — "$<specId>" in txn ops references the created element */
  specId: string
  zTier: number
  kind: string
  x: number
  y: number
  w: number
  h: number
  paragraphs: Array<{
    runs: Array<{ text: string; bold?: boolean; fontSize: number; color: string }>
    align?: 'left' | 'center' | 'right'
  }>
  fillColor: string
  stroke: { color: string; widthPt: number; dash?: string }
  adjust?: Record<string, number>
  insetsPx: { l: number; t: number; r: number; b: number }
  semanticMetadata: SemanticMetadata
  /** composite modules group with their micro units (native p:grpSp) */
  groupWithUnits?: boolean
  detailDisposition?: DetailDisposition
}

export interface ConnectorBindingSpec {
  specId: string
  semanticEdgeId: string
  start: { targetSpecId: string; idx: number }
  end: { targetSpecId: string; idx: number }
  routeYPx?: number
}

export interface FigureDefect {
  severity: 'hard' | 'soft'
  message: string
}

export interface FigureRenderPlan {
  elements: NativeElementSpec[]
  bindings: ConnectorBindingSpec[]
  groups: Array<{ specId: string; memberSpecIds: string[] }>
  /** complete slide-level payload (versioned) — written inside the same txn */
  slideMetadata: ReturnType<typeof slidePayload>
  defects: FigureDefect[]
}

const nodeTypeSet = new Set(Object.keys(SEMANTIC_NODE_STYLES))
void nodeTypeSet

export function buildFigureRenderPlan(input: FigureRenderInput): FigureRenderPlan {
  const defects: FigureDefect[] = []
  const identity = figureIdentity({ figureFamily: undefined, domain: input.domain })
  const fontScale = input.fontScale ?? 1
  const nodeById = new Map(input.plan.nodes.map((node) => [node.id, node]))
  const moduleByNodeId = new Map(
    input.visualPlan.modules.map((module) => [module.moduleId, module]),
  )
  // Domain-override resolution reads the authoritative DOMAIN_PROFILES table;
  // micro units inherit the module's resolved kind (P0-06).
  const domainOverrides =
    (input.domain && (DOMAIN_PROFILES as Record<string, { kindOverrides?: Record<string, string> }>)[input.domain]?.kindOverrides) || {}
  const kindOf = (node: { type: string }): string => {
    const fallback: Record<string, string> = {
      'data-source': 'data-source',
      variable: 'input-node',
      mechanism: 'mechanism-module',
      process: 'process-node',
      model: 'model-module',
      method: 'process-node',
      actor: 'process-node',
      evidence: 'evidence-node',
      outcome: 'output-node',
      hypothesis: 'evidence-node',
      annotation: 'annotation',
      context: 'process-node',
    }
    return domainOverrides[node.type] ?? fallback[node.type] ?? 'process-node'
  }

  const elements: NativeElementSpec[] = []
  const groups: Array<{ specId: string; memberSpecIds: string[] }> = []
  const nodeRecords: ResearchNodeRecord[] = []
  const specIdByNodeId = new Map<string, string>()

  type Emit = Array<{
    tier: number
    emit: () => void
  }>
  const passes: Emit = []

  // ── pass 1: modules (background/containers/leaves; annotations re-emitted last) ──
  for (const placement of input.solve.placements) {
    const node = nodeById.get(placement.id)
    if (!node) {
      defects.push({ severity: 'hard', message: `unmeasured node "${placement.id}"` })
      continue
    }
    const kind = kindOf(node)
    const style = SEMANTIC_NODE_STYLES[node.type]
    const module = moduleByNodeId.get(placement.id)
    const disposition = resolveDetailDisposition(node.visible.detail, !!module)

    // EXACT-GEOMETRY: the solved box is consumed verbatim; no Math.max inflation.
    if (module) {
      const needed = minimumHeightForUnits(module, Math.max(60, placement.w - 8))
      if (needed > placement.h + 0.5) {
        defects.push({
          severity: 'hard',
          message: `module "${placement.id}" solved at ${Math.round(placement.h)}px but its ${module.units.length} visual unit(s) need ${Math.round(needed)}px`,
        })
      }
    }

    const specId = `module:${placement.id}`
    specIdByNodeId.set(placement.id, specId)
    // P0-04: the registry + semantic style compile HERE; the element below is
    // a pure consumer of the compiled spec.
    const compiled: ComponentRenderSpec = compileComponentRenderSpec({
      kind,
      style: {
        titleSizePt: Math.round(style.titleSizePt * fontScale * 10) / 10,
        detailSizePt: Math.round(style.detailSizePt * fontScale * 10) / 10,
        padX: style.padX,
        padY: style.padY,
      },
      placement,
      colors: resolveComponentColors(kind, input.theme),
    })
    const colors = resolveComponentColors(kind, input.theme)
    const paragraphs: NativeElementSpec['paragraphs'] = [
      {
        runs: [
          {
            text: node.visible.title,
            bold: true,
            fontSize: compiled.titleFontPt,
            color: colors.text,
          },
        ],
      },
    ]
    if (disposition === 'render-in-parent') {
      paragraphs.push({
        runs: [
          {
            text: node.visible.detail!,
            fontSize: compiled.bodyFontPt,
            color: colors.subtitle ?? colors.text,
          },
        ],
      })
    }
    if (node.visible.title.length > compiled.textCapacity) {
      defects.push({
        severity: 'soft',
        message: `module "${placement.id}" title exceeds ${kind}.textCapacity (${node.visible.title.length} > ${compiled.textCapacity})`,
      })
    }

    const tier =
      style.collisionClass === 'background'
        ? Z_TIERS.backgroundRegion
        : style.collisionClass === 'overlay'
          ? Z_TIERS.annotation
          : module
            ? Z_TIERS.containerModule
            : Z_TIERS.leafNode

    const element: NativeElementSpec = {
      specId,
      zTier: tier,
      kind: compiled.preset,
      x: compiled.x,
      y: compiled.y,
      w: compiled.w,
      h: compiled.h,
      paragraphs,
      fillColor: compiled.fillColor,
      stroke:
        colors.stroke === 'none'
          ? { color: colors.fill, widthPt: compiled.strokeWidthPt }
          : { color: compiled.strokeColor, widthPt: compiled.strokeWidthPt },
      adjust: roundRectAdjust(compiled.radiusPx, compiled.w, compiled.h),
      insetsPx: { l: compiled.padXPx, t: compiled.padYPx, r: compiled.padXPx, b: compiled.padYPx },
      semanticMetadata: moduleMetadata({
        ...identity,
        semanticNodeId: placement.id,
        primitiveKind: kind,
      }),
      groupWithUnits: !!module,
      detailDisposition: disposition,
    }
    passes.push({ tier, emit: () => elements.push(element) })
    nodeRecords.push({
      id: placement.id,
      title: node.visible.title,
      type: node.type,
      primitiveKind: kind,
      detailDisposition: disposition,
    })
  }

  // ── pass 2: micro units (inside composite modules; inherit domain kind) ──
  const microSpecIdsByModule = new Map<string, string[]>()
  for (const placement of input.solve.placements) {
    const module = moduleByNodeId.get(placement.id)
    if (!module) continue
    const node = nodeById.get(placement.id)!
    const kind = kindOf(node)
    const style = SEMANTIC_NODE_STYLES[node.type]
    const colors = resolveComponentColors(kind, input.theme)
    const microMap = new Map([
      [
        placement.id,
        { x: placement.x, y: placement.y, w: placement.w, h: placement.h },
      ],
    ])
    const micro = layoutMicro([module], microMap)
    const microIds: string[] = []
    for (const u of micro.units) {
      // MICRO-FIT: u.h is layoutMicro's output — the same engine the solver's
      // fit constraint was derived from. No last-second Math.max clamp here.
      const specId = `unit:${placement.id}#${u.id}`
      microIds.push(specId)
      const spec = getComponentSpec(kind)
      const unitShapePreset = shapePresetFor(u, spec.preset)
      const element: NativeElementSpec = {
        specId,
        zTier: Z_TIERS.compositeNode,
        kind: unitShapePreset,
        x: u.x,
        y: u.y,
        w: u.w,
        h: u.h,
        paragraphs: [
          {
            runs: [
              {
                text: u.label,
                bold: u.role === 'output' || u.role === 'substep',
                fontSize: Math.round((u.role === 'annotation' ? 9.5 : style.detailSizePt) * fontScale * 10) / 10,
                color: colors.text,
              },
            ],
            align: 'center',
          },
        ],
        fillColor: colors.fill,
        stroke: { color: colors.stroke, widthPt: MICRO_UNIT_STROKE_PT },
        insetsPx: { l: 2, t: 1, r: 2, b: 1 },
        semanticMetadata: microUnitMetadata({
          ...identity,
          semanticNodeId: u.semanticNodeId ?? placement.id,
          parentModuleId: placement.id,
          visualUnitId: u.id,
          primitiveKind: kind,
        }),
      }
      passes.push({ tier: Z_TIERS.compositeNode, emit: () => elements.push(element) })
    }
    microSpecIdsByModule.set(placement.id, microIds)
  }

  // ── pass 3: connectors between FINAL module rects (P0-03) ──
  const rectById = new Map(
    input.solve.placements.map((placement) => [placement.id, placement]),
  )
  const bindings: ConnectorBindingSpec[] = []
  const seenConnectorSpecIds = new Set<string>()
  for (const route of input.routes) {
    if (route.status !== 'routed' || !route.start || !route.end) continue
    const from = rectById.get(route.fromId)
    const to = rectById.get(route.toId)
    if (!from || !to) continue
    // Multi-edge safety (P0-14): one native connector per ROUTE, keyed by the
    // semantic edge id — never merged by endpoint pair.
    const specId = `connector:${route.semanticEdgeId ?? route.key}`
    if (seenConnectorSpecIds.has(specId)) {
      defects.push({ severity: 'hard', message: `duplicate connector for edge ${specId}` })
      continue
    }
    seenConnectorSpecIds.add(specId)
    const fromNode = nodeById.get(route.fromId)
    const toNode = nodeById.get(route.toId)
    const style = connectorStyleFor(route.presentation)
    const startSide = validateAnchorSide(route.start.side, getComponentSpec(kindOf(fromNode ?? { type: 'process' })).anchors)
    const endSide = validateAnchorSide(route.end.side, getComponentSpec(kindOf(toNode ?? { type: 'process' })).anchors)
    if (startSide.remapped || endSide.remapped) {
      defects.push({
        severity: 'soft',
        message: `edge ${specId}: anchor remapped to a registry-allowed side (${route.start.side}→${startSide.side}, ${route.end.side}→${endSide.side})`,
      })
    }
    const element: NativeElementSpec = {
      specId,
      zTier: Z_TIERS.connector,
      // Presentation decides arrowhead presence; route geometry decides straight vs bent.
      kind:
        route.kind === 'elbow'
          ? 'lineBent'
          : route.presentation === 'line' ||
              route.presentation === 'containment' ||
              route.presentation === 'proximity' ||
              route.presentation === 'alignment'
            ? 'line'
            : 'lineArrow',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      paragraphs: [],
      fillColor: 'none',
      stroke: { color: connectorColor(input.theme), widthPt: style.widthPt, ...(style.dash ? { dash: style.dash } : {}) },
      insetsPx: { l: 0, t: 0, r: 0, b: 0 },
      semanticMetadata: connectorMetadata({
        ...identity,
        semanticEdgeId: route.semanticEdgeId ?? route.key,
        relationType: route.relation,
        relationPresentation: route.presentation ?? 'arrow',
      }),
    }
    passes.push({ tier: Z_TIERS.connector, emit: () => elements.push(element) })
    bindings.push({
      specId,
      semanticEdgeId: route.semanticEdgeId ?? route.key,
      start: { targetSpecId: specIdByNodeId.get(route.fromId)!, idx: startSide.side === 'top' ? 0 : startSide.side === 'left' ? 1 : startSide.side === 'bottom' ? 2 : 3 },
      end: { targetSpecId: specIdByNodeId.get(route.toId)!, idx: endSide.side === 'top' ? 0 : endSide.side === 'left' ? 1 : endSide.side === 'bottom' ? 2 : 3 },
      ...(route.routeY !== undefined ? { routeYPx: route.routeY } : {}),
    })
  }

  // Deterministic z-order: tier ascending, plan order within a tier.
  passes.sort((a, b) => a.tier - b.tier)
  for (const pass of passes) pass.emit()

  // Composite modules close as native groups (parent first, then its units).
  for (const placement of input.solve.placements) {
    const microIds = microSpecIdsByModule.get(placement.id)
    if (microIds && microIds.length > 0) {
      groups.push({
        specId: specIdByNodeId.get(placement.id)!,
        memberSpecIds: [specIdByNodeId.get(placement.id)!, ...microIds],
      })
    }
  }

  return {
    elements,
    bindings,
    groups,
    // RENDER-P0-10: statuses derived from routes at plan time — rendered (with
    // route), spatial (non-connector presentation), or suppressed (unroutable /
    // density cap). Native connector ids join later via per-shape semanticEdgeId.
    slideMetadata: slidePayload({
      identity,
      thesis: input.thesis,
      nodes: nodeRecords,
      relations: relationRecords(
        input.plan.edges.map((edge) => ({
          ...(edge.id ? { id: edge.id } : {}),
          from: edge.from,
          to: edge.to,
          relation: edge.relation,
          ...(edge.presentation ? { presentation: edge.presentation } : {}),
          key: edge.key ?? `${edge.from}->${edge.to}`,
        })),
        input.routes,
        new Map(),
      ),
      typography: { fontScale, measurer: 'calibrated-estimator' },
    }),
    defects,
  }
}

function shapePresetFor(
  unit: { role: string; shape?: string },
  fallback: string,
): string {
  const ROLE_SHAPE: Record<string, string> = {
    keyword: 'roundRect',
    substep: 'rect',
    metric: 'parallelogram',
    condition: 'diamond',
    output: 'hexagon',
    annotation: 'ellipse',
    'child-node': 'roundRect',
  }
  return unit.shape ?? ROLE_SHAPE[unit.role] ?? fallback
}
