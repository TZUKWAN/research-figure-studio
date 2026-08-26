export * from './components/registry.js'
export * from './recipes/input-core-output.js'
export * from './events.js'

/** FigurePlan: the planner's temporary contract (PPT state stays source of truth). */
export interface FigurePlanRegion {
  id: string
  role: 'input' | 'core' | 'output' | 'context' | 'feedback'
}

export interface FigurePlanEdge {
  from: string
  to: string
  role: 'main' | 'feedback' | 'annotation'
}

export interface FigurePlan {
  figureType:
    | 'input-core-output'
    | 'horizontal-pipeline'
    | 'layered-architecture'
    | 'parallel-paths'
    | 'feedback-loop'
    | 'hierarchy'
    | 'timeline'
    | 'matrix'
    | 'core-periphery'
  readingDirection: 'LR' | 'TB'
  regions: FigurePlanRegion[]
  nodes: Array<{ region: string; component: string; title: string }>
  edges: FigurePlanEdge[]
  negativeConstraints: string[]
}
