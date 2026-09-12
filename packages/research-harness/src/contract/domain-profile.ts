/**
 * Domain Profiles (P1, GOAL section 6; P4 domain masters).
 *
 * A domain decides the SCIENTIFIC VISUAL LANGUAGE — preferred primitives,
 * relation presentation defaults, palette discipline, text density — never
 * the final layout (that is the grammar builder's job). Domain and figure
 * family are orthogonal on purpose.
 */
import type { RelationPresentation } from '../semantic/schema.js'

export const SCIENTIFIC_DOMAINS = [
  'general',
  'cs-ml',
  'materials-chemistry',
  'biomed',
  'engineering',
  'social-science',
] as const

export type ScientificDomain = (typeof SCIENTIFIC_DOMAINS)[number]

export interface DomainProfile {
  id: ScientificDomain
  label: string
  /** registry kinds this domain prefers for its core structures */
  preferredPrimitives: string[]
  /** relation → default presentation override (vs the semantic default) */
  connectorSemantics: Partial<Record<string, RelationPresentation>>
  /** semantic node type → registry kind, applied by the renderer */
  kindOverrides?: Partial<Record<string, string>>
  paletteDiscipline: 'monochrome-accent' | 'categorical-minimal' | 'phase-colored' | 'muted-earth'
  textDensity: 'sparse' | 'medium' | 'dense'
  notes: string[]
}

export const DOMAIN_PROFILES: Record<ScientificDomain, DomainProfile> = {
  general: {
    id: 'general',
    label: 'General research',
    preferredPrimitives: ['process-node', 'mechanism-module', 'output-node', 'evidence-node'],
    connectorSemantics: {},
    paletteDiscipline: 'monochrome-accent',
    textDensity: 'medium',
    notes: ['Neutral academic language; restraint over decoration.'],
  },
  'cs-ml': {
    id: 'cs-ml',
    label: 'Computer science / ML',
    preferredPrimitives: ['model-layer', 'tensor', 'data-store', 'process-stage', 'model-module'],
    connectorSemantics: {
      'data-flow': 'arrow',
      transformation: 'arrow',
      hierarchy: 'containment',
    },
    kindOverrides: {
      mechanism: 'model-module',
      'data-source': 'data-store',
      process: 'process-stage',
    },
    paletteDiscipline: 'categorical-minimal',
    textDensity: 'dense',
    notes: [
      'Layer stacks and tensors read as parallelograms/stage bands.',
      'Data stores read as cylinders; abstraction layers as plain rects.',
    ],
  },
  'materials-chemistry': {
    id: 'materials-chemistry',
    label: 'Materials / chemistry',
    preferredPrimitives: ['material-layer', 'reaction-stage', 'sample', 'process-node'],
    connectorSemantics: {
      transformation: 'arrow',
      inhibition: 'inhibition',
      causal: 'arrow',
    },
    kindOverrides: {
      process: 'reaction-stage',
      context: 'material-layer',
    },
    paletteDiscipline: 'phase-colored',
    textDensity: 'medium',
    notes: [
      'Material phases render as stacked layers; synthesis routes as stage chevrons.',
      'Inhibition gets a flat-ended marker, never a plain arrow.',
    ],
  },
  biomed: {
    id: 'biomed',
    label: 'Biomedical',
    preferredPrimitives: ['mechanism-module', 'condition', 'sample', 'annotation'],
    connectorSemantics: {
      promotion: 'arrow',
      inhibition: 'inhibition',
      association: 'line',
      causal: 'arrow',
    },
    kindOverrides: {
      variable: 'condition',
    },
    paletteDiscipline: 'muted-earth',
    textDensity: 'sparse',
    notes: [
      'Pathway arrows: blunt activation vs flat inhibition ends.',
      'Conditions/compartments read as diamonds/rounded containers.',
    ],
  },
  engineering: {
    id: 'engineering',
    label: 'Engineering',
    preferredPrimitives: ['process-stage', 'device', 'data-store', 'process-node'],
    connectorSemantics: {
      'data-flow': 'arrow',
      causal: 'arrow',
      feedback: 'feedback-loop',
    },
    kindOverrides: {
      process: 'process-stage',
      'data-source': 'data-store',
    },
    paletteDiscipline: 'monochrome-accent',
    textDensity: 'dense',
    notes: ['Block-diagram discipline; signal flow left→right with feedback lanes.'],
  },
  'social-science': {
    id: 'social-science',
    label: 'Social science',
    preferredPrimitives: ['process-node', 'evidence-node', 'condition', 'annotation'],
    connectorSemantics: {
      mediation: 'arrow',
      moderation: 'dashed-arrow',
      association: 'line',
      hypothesis: 'dashed-arrow',
    },
    paletteDiscipline: 'categorical-minimal',
    textDensity: 'medium',
    notes: [
      'X→M→Y mediation triangles; moderators hang above with dashed drops.',
      'Hypotheses stay dashed until evidentially supported.',
    ],
  },
}

export function isScientificDomain(value: string): value is ScientificDomain {
  return (SCIENTIFIC_DOMAINS as readonly string[]).includes(value)
}

/** Planner/user-declared domain wins; unknown values fall back to general. */
export function resolveDomain(hint?: string): ScientificDomain {
  if (hint && isScientificDomain(hint)) return hint
  return 'general'
}

/** Domain-aware default presentation for a relation. */
export function domainPresentationDefault(
  domain: ScientificDomain,
  relation: string,
): RelationPresentation | null {
  return DOMAIN_PROFILES[domain].connectorSemantics[relation] ?? null
}
