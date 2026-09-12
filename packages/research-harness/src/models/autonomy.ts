/**
 * Capability Profile + Autonomy Controller (Phase 3, GOAL section 19-22).
 * Model-agnostic: no per-vendor design logic — only capability metadata and
 * deterministic autonomy selection from profile × graph complexity.
 */

export interface ModelCapabilities {
  structuredOutput: boolean
  toolCalling: boolean
  vision: boolean
  contextClass: 'small' | 'medium' | 'large'
  instructionFollowing: 'basic' | 'strong'
  /** calibrated estimate of the model's spatial composition ability */
  spatialPlanning: 'unknown' | 'weak' | 'medium' | 'strong'
  jsonReliability: 'low' | 'medium' | 'high'
}

export interface CapabilityInput {
  vision?: boolean
  /** provider metadata context window, tokens */
  contextTokens?: number
  /** calibration overrides (benchmark-derived; see benchmark/runner) */
  calibration?: Partial<
    Pick<ModelCapabilities, 'spatialPlanning' | 'jsonReliability' | 'instructionFollowing'>
  >
}

/**
 * Derive a capability profile. Only provider-agnostic metadata plus optional
 * calibration entries — never `if (model === 'x')` design branches.
 */
export function capabilityProfile(input: CapabilityInput = {}): ModelCapabilities {
  const contextClass =
    input.contextTokens === undefined
      ? 'medium'
      : input.contextTokens >= 200_000
        ? 'large'
        : input.contextTokens >= 32_000
          ? 'medium'
          : 'small'
  return {
    structuredOutput: true,
    toolCalling: true,
    vision: input.vision === true,
    contextClass,
    instructionFollowing: input.calibration?.instructionFollowing ?? 'strong',
    spatialPlanning: input.calibration?.spatialPlanning ?? 'unknown',
    jsonReliability: input.calibration?.jsonReliability ?? 'medium',
  }
}

export type AutonomyLevel = 'A0' | 'A1' | 'A2'

export interface GraphComplexity {
  nodeCount: number
  edgeCount: number
  hasFeedback: boolean
  hasModeration: boolean
}

/**
 * Autonomy = f(model capability, graph complexity, figure type, canvas).
 * Even a strong model is capped on complex graphs; an unknown or weak spatial
 * planner never gets free composition.
 */
export function selectAutonomy(
  profile: ModelCapabilities,
  complexity: GraphComplexity,
): AutonomyLevel {
  const complex =
    complexity.nodeCount > 14 ||
    complexity.edgeCount > 18 ||
    (complexity.hasFeedback && complexity.hasModeration)
  if (profile.spatialPlanning === 'strong' && profile.jsonReliability !== 'low') {
    return complex ? 'A1' : 'A2'
  }
  if (profile.spatialPlanning === 'medium' && profile.jsonReliability !== 'low') {
    return complex ? 'A0' : 'A1'
  }
  return 'A0'
}
