/**
 * Spatial plan types (Phase 3/4 contracts). A SpatialPlan is the AI Art
 * Director's composition INTENT — normalized 0–1 boxHints, never final pptx
 * coordinates. The solver turns it into legal geometry while preserving intent.
 */

import { normalizeVisualPlan } from '../visual/visualPlan.js'

export type ReadingFlow = 'LR' | 'RL' | 'TB' | 'BT' | 'radial' | 'mixed'

export interface NormalizedBox {
  x: number
  y: number
  w: number
  h: number
}

export interface SpatialPlacement {
  id: string
  /** composition intent in 0–1 canvas space; NOT final geometry */
  boxHint: NormalizedBox
  visualRole: 'dominant' | 'primary' | 'secondary' | 'supporting'
  placementIntent?: {
    centrality?: number
    proximityTo?: string[]
    separationFrom?: string[]
    alignWith?: string[]
  }
}

export interface GroupLayout {
  id: string
  memberIds: string[]
  /** optional region background box hint */
  boxHint?: NormalizedBox
}

export interface RoutingIntent {
  edgeKey: string
  /** preferred corridor for feedback/peripheral relations */
  lane?: 'top' | 'bottom' | 'left' | 'right' | 'auto'
}

export interface SpatialPlan {
  composition: {
    readingFlow: ReadingFlow
    balance: 'symmetric' | 'asymmetric' | 'loosely-balanced'
    density: 'low' | 'medium' | 'high'
    visualCenter?: string
    whitespaceStrategy: 'open' | 'balanced' | 'compact'
  }
  placements: SpatialPlacement[]
  groupLayouts?: GroupLayout[]
  routingIntent?: RoutingIntent[]
  /** optional, model-authored decomposition rendered within macro modules */
  visualPlan?: import('../visual/visualPlan.js').VisualPlan
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function normalizeBox(raw: unknown, fallback: NormalizedBox): NormalizedBox {
  const box = (raw ?? {}) as Record<string, unknown>
  const x = clamp01(num(box.x, fallback.x))
  const y = clamp01(num(box.y, fallback.y))
  const w = Math.min(1 - x, Math.max(0.04, num(box.w, fallback.w)))
  const h = Math.min(1 - y, Math.max(0.04, num(box.h, fallback.h)))
  return { x, y, w, h }
}

const VISUAL_ROLES = new Set(['dominant', 'primary', 'secondary', 'supporting'])

/**
 * R0/R1 repair for a model-supplied SpatialPlan: clamps to 0–1, fills missing
 * fields, drops placements that reference unknown ids. Returns null when the
 * shape is fundamentally unusable (no placements or unknown composition).
 */
export function normalizeSpatialPlan(
  raw: unknown,
  knownIds: string[],
  defaults: {
    readingFlow?: ReadingFlow
    visualRole?: SpatialPlacement['visualRole']
    visualPlan?: import('../visual/visualPlan.js').VisualPlan
  } = {},
): SpatialPlan | null {
  if (typeof raw !== 'object' || raw === null) return null
  const plan = raw as Record<string, unknown>
  const composition = (plan.composition ?? {}) as Record<string, unknown>
  const flow = String(composition.readingFlow ?? defaults.readingFlow ?? 'LR')
  const flows: ReadingFlow[] = ['LR', 'RL', 'TB', 'BT', 'radial', 'mixed']
  if (!flows.includes(flow as ReadingFlow)) return null
  const known = new Set(knownIds)
  const rawPlacements = Array.isArray(plan.placements) ? plan.placements : []
  const placements: SpatialPlacement[] = []
  for (const rawPlacement of rawPlacements) {
    const p = (rawPlacement ?? {}) as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (!id || !known.has(id)) continue
    const role = String(p.visualRole ?? defaults.visualRole ?? 'primary')
    const intent = (p.placementIntent ?? {}) as Record<string, unknown>
    placements.push({
      id,
      boxHint: normalizeBox(p.boxHint, { x: 0.08, y: 0.3, w: 0.2, h: 0.24 }),
      visualRole: (VISUAL_ROLES.has(role) ? role : 'primary') as SpatialPlacement['visualRole'],
      placementIntent: {
        ...(typeof intent.centrality === 'number' ? { centrality: intent.centrality } : {}),
        ...(Array.isArray(intent.proximityTo)
          ? { proximityTo: intent.proximityTo.filter((v) => typeof v === 'string' && known.has(v)) }
          : {}),
        ...(Array.isArray(intent.separationFrom)
          ? {
              separationFrom: intent.separationFrom.filter(
                (v) => typeof v === 'string' && known.has(v),
              ),
            }
          : {}),
        ...(Array.isArray(intent.alignWith)
          ? { alignWith: intent.alignWith.filter((v) => typeof v === 'string' && known.has(v)) }
          : {}),
      },
    })
  }
  if (placements.length === 0) return null
  const balance = String(composition.balance ?? 'loosely-balanced')
  const density = String(composition.density ?? 'medium')
  const whitespace = String(composition.whitespaceStrategy ?? 'balanced')
  return {
    composition: {
      readingFlow: flow as ReadingFlow,
      balance: (['symmetric', 'asymmetric', 'loosely-balanced'].includes(balance)
        ? balance
        : 'loosely-balanced') as SpatialPlan['composition']['balance'],
      density: (['low', 'medium', 'high'].includes(density)
        ? density
        : 'medium') as SpatialPlan['composition']['density'],
      ...(typeof composition.visualCenter === 'string' && known.has(composition.visualCenter)
        ? { visualCenter: composition.visualCenter }
        : {}),
      whitespaceStrategy: (['open', 'balanced', 'compact'].includes(whitespace)
        ? whitespace
        : 'balanced') as SpatialPlan['composition']['whitespaceStrategy'],
    },
    placements,
    ...(Array.isArray(plan.groupLayouts) && plan.groupLayouts.length > 0
      ? {
          groupLayouts: (plan.groupLayouts as Record<string, unknown>[]).flatMap((g) => {
            const id = typeof g?.id === 'string' ? g.id : ''
            const memberIds = Array.isArray(g?.memberIds)
              ? (g.memberIds as unknown[]).filter(
                  (m): m is string => typeof m === 'string' && known.has(m),
                )
              : []
            if (!id || memberIds.length === 0) return []
            return [
              {
                id,
                memberIds,
                ...(g?.boxHint !== undefined
                  ? { boxHint: normalizeBox(g.boxHint, { x: 0.05, y: 0.05, w: 0.9, h: 0.9 }) }
                  : {}),
              },
            ]
          }),
        }
      : {}),
  }
}

/**
 * P0-2 (production closure 2): diagnostics-aware SpatialPlan validation for
 * the Composition Designer's structured output. Unlike normalizeSpatialPlan —
 * which silently DROPS unknown placement ids and silently clamps boxHints —
 * this reports every violation with the exact field and id, so the protocol
 * repair loop can fix the real problem instead of shipping a silently
 * truncated composition intent.
 *
 * Empty placements stay legal: the documented fallback contract lets the
 * designer declare "no safe composition intent" and the deterministic priors
 * take over.
 */
export function parseSpatialPlanWithDiagnostics(
  raw: unknown,
  knownIds: string[],
  options?: {
    edgeIds?: string[]
    defaults?: Parameters<typeof normalizeSpatialPlan>[2]
    /** semantic labels/visible titles for visualPlan normalization */
    planNodes?: Array<{ id: string; semanticLabel: string; visible: { title: string } }>
  },
): {
  plan: SpatialPlan | null
  visualPlan: import('../visual/visualPlan.js').VisualPlan | null
  errors: string[]
} {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { plan: null, visualPlan: null, errors: ['SpatialPlan must be a JSON object'] }
  }
  const plan = raw as Record<string, unknown>
  const known = new Set(knownIds)
  const composition = (plan.composition ?? {}) as Record<string, unknown>
  const flow = String(composition.readingFlow ?? 'LR')
  const flows: ReadingFlow[] = ['LR', 'RL', 'TB', 'BT', 'radial', 'mixed']
  if (!flows.includes(flow as ReadingFlow)) {
    errors.push(`composition.readingFlow "${flow}" unsupported (allowed: ${flows.join(', ')})`)
  }
  if (!Array.isArray(plan.placements)) {
    errors.push('"placements" must be an array')
  } else {
    for (const [index, rawPlacement] of plan.placements.entries()) {
      const p = (rawPlacement ?? {}) as Record<string, unknown>
      const id = typeof p.id === 'string' ? p.id.trim() : ''
      if (!id) {
        errors.push(`placement at index ${index} is missing "id"`)
        continue
      }
      if (!known.has(id)) {
        errors.push(
          `placement "${id}" references missing node (must be one of the FigurePlan node ids)`,
        )
      }
      const box = p.boxHint as Record<string, unknown> | undefined
      if (typeof box !== 'object' || box === null) {
        errors.push(`placement "${id}" is missing "boxHint"`)
      } else {
        for (const key of ['x', 'y', 'w', 'h'] as const) {
          const v = box[key]
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`placement "${id}" boxHint.${key} must be a finite number`)
          } else if (v < 0 || v > 1) {
            errors.push(
              `placement "${id}" boxHint.${key}=${v} outside 0..1 (fractions, never pixels)`,
            )
          }
        }
      }
      const role = String(p.visualRole ?? 'primary')
      if (!VISUAL_ROLES.has(role)) {
        errors.push(
          `placement "${id}" visualRole "${role}" unsupported (allowed: ${[...VISUAL_ROLES].join(', ')})`,
        )
      }
    }
  }
  // visualPlan references must resolve against the CURRENT plan
  const visualPlan = plan.visualPlan as Record<string, unknown> | undefined
  if (visualPlan && typeof visualPlan === 'object') {
    const edgeIds = new Set(options?.edgeIds ?? [])
    if (Array.isArray(visualPlan.modules)) {
      for (const rawModule of visualPlan.modules as unknown[]) {
        const m = (rawModule ?? {}) as Record<string, unknown>
        const moduleId = typeof m.moduleId === 'string' ? m.moduleId.trim() : ''
        if (moduleId && !known.has(moduleId)) {
          errors.push(`visualPlan module "${moduleId}" references missing node`)
        }
        if (Array.isArray(m.units)) {
          for (const rawUnit of m.units as unknown[]) {
            const u = (rawUnit ?? {}) as Record<string, unknown>
            const unitRef = typeof u.semanticNodeId === 'string' ? u.semanticNodeId : ''
            if (unitRef && !known.has(unitRef)) {
              errors.push(
                `visualPlan unit "${String(u.id ?? '?')}" references missing node "${unitRef}"`,
              )
            }
            const edgeRef = typeof u.semanticEdgeId === 'string' ? u.semanticEdgeId : ''
            if (edgeRef && options?.edgeIds && !edgeIds.has(edgeRef)) {
              errors.push(
                `visualPlan unit "${String(u.id ?? '?')}" references missing edge "${edgeRef}"`,
              )
            }
          }
        }
      }
    }
  }
  if (errors.length > 0) return { plan: null, visualPlan: null, errors }
  const normalized = normalizeSpatialPlan(raw, knownIds, options?.defaults ?? {})
  if (!normalized) {
    // An EMPTY placements list is the documented "no safe composition intent"
    // fallback (deterministic priors take over) — legal, plan stays null.
    const placements = (plan as Record<string, unknown>).placements
    if (Array.isArray(placements) && placements.length === 0) {
      return { plan: null, visualPlan: null, errors: [] }
    }
    return {
      plan: null,
      visualPlan: null,
      errors: ['SpatialPlan failed structural normalization'],
    }
  }
  // The decomposition travels WITH the spatial plan (the orchestrator treats
  // modelPlan.visualPlan the same way) — normalized against the real plan.
  const planNodes =
    options?.planNodes ?? knownIds.map((id) => ({ id, semanticLabel: id, visible: { title: id } }))
  const normalizedVisualPlan = normalizeVisualPlan(plan.visualPlan, {
    nodes: planNodes,
    edges: (options?.edgeIds ?? []).map((id) => ({ id })),
  })
  return { plan: normalized, visualPlan: normalizedVisualPlan, errors: [] }
}
