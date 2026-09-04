/**
 * Visual Decomposition + shape vocabulary (Density round 2).
 */

export type MicroLayout = 'flow' | 'chips' | 'grid' | 'rows' | 'parallel' | 'subnodes' | 'free'

export type VisualRole =
  'keyword' | 'substep' | 'metric' | 'condition' | 'output' | 'annotation' | 'child-node'

export type ShapeKind =
  | 'roundedRect'
  | 'rect'
  | 'parallelogram'
  | 'circle'
  | 'ellipse'
  | 'pentagon'
  | 'hexagon'
  | 'diamond'

export const ROLE_SHAPE: Record<VisualRole, ShapeKind> = {
  keyword: 'roundedRect',
  substep: 'rect',
  metric: 'parallelogram',
  condition: 'diamond',
  output: 'hexagon',
  annotation: 'ellipse',
  'child-node': 'roundedRect',
}

export function shapePreset(kind: ShapeKind): string {
  switch (kind) {
    case 'roundedRect':
      return 'roundRect'
    case 'rect':
      return 'rect'
    case 'parallelogram':
      return 'parallelogram'
    case 'circle':
      return 'ellipse'
    case 'ellipse':
      return 'ellipse'
    case 'pentagon':
      return 'pentagon'
    case 'hexagon':
      return 'hexagon'
    case 'diamond':
      return 'diamond'
  }
}

export interface VisualUnit {
  id: string
  label: string
  detail?: string
  role: VisualRole
  shape?: ShapeKind
  semanticNodeId?: string
  semanticEdgeId?: string
}

export interface MajorModuleVisual {
  moduleId: string
  microLayout: MicroLayout
  units: VisualUnit[]
  hints?: {
    columns?: number
    direction?: 'lr' | 'rl' | 'tb'
    spacing?: 'tight' | 'normal' | 'loose'
  }
}

export interface VisualRelationPresentation {
  semanticEdgeId: string
  presentation:
    | 'arrow'
    | 'line'
    | 'dashed-arrow'
    | 'inhibition'
    | 'feedback-loop'
    | 'junction'
    | 'containment'
    | 'proximity'
    | 'alignment'
    | 'annotation'
}

export interface VisualPlan {
  modules: MajorModuleVisual[]
  relations?: VisualRelationPresentation[]
}

export interface VisualEdge {
  from: string
  to: string
  intent: 'primary' | 'feedback' | 'cross-group'
}

const ROLES = new Set<VisualRole>([
  'keyword',
  'substep',
  'metric',
  'condition',
  'output',
  'annotation',
  'child-node',
])
const SHAPES = new Set<ShapeKind>([
  'roundedRect',
  'rect',
  'parallelogram',
  'circle',
  'ellipse',
  'pentagon',
  'hexagon',
  'diamond',
])
const LAYOUTS = new Set<MicroLayout>([
  'flow',
  'chips',
  'grid',
  'rows',
  'parallel',
  'subnodes',
  'free',
])

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function normalizeVisualPlan(
  raw: unknown,
  plan: {
    nodes: Array<{ id: string; semanticLabel: string; visible: { title: string; detail?: string } }>
    edges?: Array<{ id?: string }>
  },
): VisualPlan {
  const known = new Set((plan?.nodes ?? []).map((n) => n.id))
  const knownEdges = new Set((plan?.edges ?? []).flatMap((edge) => (edge.id ? [edge.id] : [])))
  const out: VisualPlan = { modules: [] }
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.modules)) return out
  for (const m of r.modules as unknown[]) {
    const mv = (m ?? {}) as Record<string, unknown>
    const moduleId = str(mv.moduleId)
    if (!moduleId || !known.has(moduleId)) continue
    const microLayout = LAYOUTS.has(mv.microLayout as MicroLayout)
      ? (mv.microLayout as MicroLayout)
      : 'rows'
    const units: VisualUnit[] = []
    if (Array.isArray(mv.units)) {
      for (const u of mv.units as unknown[]) {
        const uv = (u ?? {}) as Record<string, unknown>
        const label = str(uv.label)
        if (!label) continue
        const role = ((): VisualRole => {
          const r = str(uv.role)
          return (ROLES.has(r as VisualRole) ? r : 'keyword') as VisualRole
        })()
        const unit: VisualUnit = {
          id: str(uv.id) || `${moduleId}::u${units.length}`,
          label,
          role,
        }
        if (str(uv.detail)) unit.detail = str(uv.detail)
        const shape = str(uv.shape)
        if (shape && SHAPES.has(shape as ShapeKind)) unit.shape = shape as ShapeKind
        if (str(uv.semanticNodeId) && known.has(str(uv.semanticNodeId))) {
          unit.semanticNodeId = str(uv.semanticNodeId)
        }
        if (str(uv.semanticEdgeId) && knownEdges.has(str(uv.semanticEdgeId))) {
          unit.semanticEdgeId = str(uv.semanticEdgeId)
        }
        units.push(unit)
      }
    }
    // Visual decomposition is model-authored. Do not manufacture chips from
    // parent copy: absence of units deliberately means a clean macro node.
    if (units.length === 0) continue
    const module: MajorModuleVisual = { moduleId, microLayout, units }
    if (mv.hints && typeof mv.hints === 'object') {
      const h = mv.hints as Record<string, unknown>
      const hints: NonNullable<MajorModuleVisual['hints']> = {}
      if (typeof h.columns === 'number' && h.columns > 0) hints.columns = h.columns
      if (str(h.direction) && ['lr', 'rl', 'tb'].includes(str(h.direction))) {
        hints.direction = str(h.direction) as 'lr' | 'rl' | 'tb'
      }
      if (str(h.spacing) && ['tight', 'normal', 'loose'].includes(str(h.spacing))) {
        hints.spacing = str(h.spacing) as 'tight' | 'normal' | 'loose'
      }
      if (Object.keys(hints).length > 0) module.hints = hints
    }
    out.modules.push(module)
  }
  if (Array.isArray(r.relations)) {
    const presentations = new Set<VisualRelationPresentation['presentation']>([
      'arrow',
      'line',
      'dashed-arrow',
      'inhibition',
      'feedback-loop',
      'junction',
      'containment',
      'proximity',
      'alignment',
      'annotation',
    ])
    const relations = (r.relations as unknown[]).flatMap((item) => {
      const relation = (item ?? {}) as Record<string, unknown>
      const semanticEdgeId = str(relation.semanticEdgeId)
      const presentation = str(relation.presentation) as VisualRelationPresentation['presentation']
      return semanticEdgeId && knownEdges.has(semanticEdgeId) && presentations.has(presentation)
        ? [{ semanticEdgeId, presentation }]
        : []
    })
    if (relations.length > 0) out.relations = relations
  }
  return out
}
