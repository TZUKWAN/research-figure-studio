/**
 * RELATION_SEMANTICS — the single source of truth for what each scientific
 * relation MEANS operationally (QA-P0-06). Critics, validators and routers
 * must import their assumptions from this table instead of scattering ad-hoc
 * Sets across modules.
 *
 * Dimensions per relation:
 *   directional          — the relation encodes a from→to direction at all
 *   monotonicAlongFlow   — reading progress along the declared flow is expected
 *   allowsInverse        — an opposite-polarity edge on the same pair can be
 *                          legitimate (e.g. explicit bidirectional exchange)
 *   polarity             — sign carried for contradiction audits
 *   defaultPresentation  — visual default when the planner omits one
 */
import type { RelationPresentation, RelationType } from './schema.js'

export type RelationPolarity = 'positive' | 'negative' | 'regulatory' | 'structural' | 'none'

export interface RelationSemantic {
  directional: boolean
  monotonicAlongFlow: boolean
  allowsInverse: boolean
  polarity: RelationPolarity
  defaultPresentation: RelationPresentation
}

export const RELATION_SEMANTICS: Record<RelationType, RelationSemantic> = {
  causal: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'positive',
    defaultPresentation: 'arrow',
  },
  process: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'none',
    defaultPresentation: 'arrow',
  },
  'data-flow': {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'none',
    defaultPresentation: 'arrow',
  },
  transformation: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'none',
    defaultPresentation: 'arrow',
  },
  promotion: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'positive',
    defaultPresentation: 'arrow',
  },
  inhibition: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'negative',
    defaultPresentation: 'inhibition',
  },
  mediation: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: false,
    polarity: 'positive',
    defaultPresentation: 'arrow',
  },
  moderation: {
    directional: true,
    monotonicAlongFlow: false,
    allowsInverse: true,
    polarity: 'regulatory',
    defaultPresentation: 'dashed-arrow',
  },
  feedback: {
    directional: true,
    monotonicAlongFlow: false,
    allowsInverse: true,
    polarity: 'regulatory',
    defaultPresentation: 'feedback-loop',
  },
  hypothesis: {
    directional: true,
    monotonicAlongFlow: true,
    allowsInverse: true,
    polarity: 'none',
    defaultPresentation: 'dashed-arrow',
  },
  association: {
    directional: false,
    monotonicAlongFlow: false,
    allowsInverse: true,
    polarity: 'none',
    defaultPresentation: 'line',
  },
  mapping: {
    directional: false,
    monotonicAlongFlow: false,
    allowsInverse: true,
    polarity: 'structural',
    defaultPresentation: 'line',
  },
  hierarchy: {
    directional: true,
    monotonicAlongFlow: false,
    allowsInverse: false,
    polarity: 'structural',
    defaultPresentation: 'containment',
  },
  bidirectional: {
    directional: false,
    monotonicAlongFlow: false,
    allowsInverse: true,
    polarity: 'none',
    defaultPresentation: 'line',
  },
}

/** Relations whose realization REQUIRES a connector-like presentation. */
export function isConnectorRelation(relation: string): boolean {
  return relation !== 'hierarchy'
}

export function relationSemantic(relation: string): RelationSemantic | null {
  const key = relation as RelationType
  return Object.prototype.hasOwnProperty.call(RELATION_SEMANTICS, key)
    ? RELATION_SEMANTICS[key]
    : null
}
