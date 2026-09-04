/**
 * Spatial plan types (Phase 3/4 contracts). A SpatialPlan is the AI Art
 * Director's composition INTENT — normalized 0–1 boxHints, never final pptx
 * coordinates. The solver turns it into legal geometry while preserving intent.
 */

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
