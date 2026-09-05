export * from './components/registry.js'
export * from './components/semantic-styles.js'
export * from './recipes/input-core-output.js'
export * from './recipes/horizontal-pipeline.js'
export * from './qa/input-core-output.js'
export * from './qa/horizontal-pipeline.js'
export * from './semantic/schema.js'
export * from './semantic/figure-plan.js'
export * from './contract/figure-contract.js'
export * from './contract/domain-profile.js'
export * from './measurement/measure.js'
export * from './composition/spatial-plan.js'
export * from './composition/priors.js'
export * from './composition/candidate.js'
export * from './constraints/solver.js'
export * from './routing/geometry.js'
export * from './routing/router.js'
export * from './routing/orthogonal.js'
export * from './models/autonomy.js'
export * from './critic/metric-critic.js'
export * from './critic/scientific-critic.js'
export * from './critic/intent.js'
export * from './critic/info-density.js'
export * from './orchestrator/create-figure.js'
export * from './events.js'
export * from './protocol/figure-plan-protocol.js'
export * from './protocol/runtime-capabilities.js'

/** FigurePlan: the planner's temporary contract (PPT state stays source of truth). */
export interface FigurePlanRegion {
  id: string
  role: 'input' | 'core' | 'output' | 'context' | 'feedback'
}

export interface FigurePlanEdge {
  from: string
  to: string
  role: 'main' | 'feedback' | 'annotation'
  /** scientific relation; defaults to 'process' when the planner omits it */
  relation?: string
  label?: string
  id?: string
  /** moderation edges may target another edge instead of a node */
  targetEdge?: string
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
export * from './visual/visualPlan.js'
export * from './visual/microLayout.js'
