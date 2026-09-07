/**
 * Machine protocol for the research-figure pipeline (AI-P0-01/02).
 *
 * Single source of truth: the enum vocabularies exported by
 * semantic/schema.ts, semantic/figure-plan.ts, visual/visualPlan.ts and
 * composition/spatial-plan.ts are THE vocabulary. The JSON Schemas here are
 * generated from those constants — never hand-copied — so the TypeScript
 * parsers, the provider structured-output schemas and the prompt-embedded
 * contracts cannot drift apart.
 *
 * Consumers:
 * - provider structured output (ai:stream jsonSchema / structuredCallForProvider)
 * - the immutable protocol section of planner / designer prompts
 * - contract tests asserting prompt ⇄ schema ⇄ parser agreement
 */

export const FIGURE_PLAN_PROTOCOL_VERSION = '2.1.0'

import { RELATION_PRESENTATIONS, RELATION_TYPES } from '../semantic/schema.js'
import {
  EXPRESSION_MODES,
  SEMANTIC_NODE_TYPES,
  type SemanticRole,
} from '../semantic/figure-plan.js'
import type { MicroLayout, ShapeKind, VisualRole } from '../visual/visualPlan.js'

const RELATION_TYPE_VALUES: readonly string[] = RELATION_TYPES
const RELATION_PRESENTATION_VALUES: readonly string[] = RELATION_PRESENTATIONS
const SEMANTIC_NODE_TYPE_VALUES: readonly string[] = SEMANTIC_NODE_TYPES
const EXPRESSION_MODE_VALUES: readonly string[] = EXPRESSION_MODES
const MICRO_LAYOUT_VALUES: readonly MicroLayout[] = [
  'flow',
  'chips',
  'grid',
  'rows',
  'parallel',
  'subnodes',
  'free',
]
const VISUAL_SHAPE_VALUES: readonly ShapeKind[] = [
  'roundedRect',
  'rect',
  'parallelogram',
  'circle',
  'ellipse',
  'pentagon',
  'hexagon',
  'diamond',
]
const VISUAL_ROLE_VALUES: readonly VisualRole[] = [
  'keyword',
  'substep',
  'metric',
  'condition',
  'output',
  'annotation',
  'child-node',
]
const SEMANTIC_ROLE_VALUES: readonly SemanticRole[] = [
  'input',
  'core',
  'intermediate',
  'output',
  'context',
  'moderator',
  'support',
]

const enumOf = (values: readonly string[]): Record<string, unknown> => ({
  type: 'string',
  enum: [...values],
})

const strArray = (items: Record<string, unknown>): Record<string, unknown> => ({
  type: 'array',
  items,
})

const nodeRef = { type: 'string', description: 'semantic node id' }
const nodeRefArray = strArray(nodeRef)

const visibleText = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['title'],
  additionalProperties: false,
} as const

const semanticNodeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: enumOf(SEMANTIC_NODE_TYPE_VALUES),
    semanticLabel: {
      type: 'string',
      description: 'full scientific meaning (not rendered verbatim)',
    },
    visible: visibleText,
    importance: { type: 'number', minimum: 0, maximum: 1 },
    role: enumOf(SEMANTIC_ROLE_VALUES),
    groupId: { type: 'string' },
    evidenceRefs: strArray({ type: 'string' }),
    provenanceRefs: strArray({ type: 'string' }),
    claimType: enumOf(['qualitative', 'quantitative', 'derived', 'sample']),
    phase: { type: 'string' },
    timePoint: { type: 'string' },
  },
  required: ['id', 'type', 'semanticLabel', 'visible', 'importance', 'role'],
  additionalProperties: false,
} as const

const semanticEdgeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    from: nodeRef,
    to: nodeRef,
    role: enumOf(['main', 'feedback']),
    relation: enumOf(RELATION_TYPE_VALUES),
    presentation: enumOf(RELATION_PRESENTATION_VALUES),
    label: { type: 'string' },
    targetEdge: {
      type: 'string',
      description: 'id of the edge this relation qualifies (moderation)',
    },
    qualifiedBy: nodeRefArray,
  },
  required: ['from', 'to', 'relation'],
  additionalProperties: false,
} as const

const semanticGroupSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    memberIds: nodeRefArray,
  },
  required: ['id', 'memberIds'],
  additionalProperties: false,
} as const

const narrativeSchema = {
  type: 'object',
  properties: {
    expressionMode: enumOf(EXPRESSION_MODE_VALUES),
    complexity: enumOf(['minimal', 'compact', 'rich']),
    centralMessage: { type: 'string' },
    visualCenter: nodeRef,
    readingPath: nodeRefArray,
    mustShow: nodeRefArray,
    mayMerge: {
      type: 'array',
      items: nodeRefArray,
      description: 'groups of interchangeable node ids',
    },
    omitFromCanvas: strArray({ type: 'string' }),
    evidenceMustShow: nodeRefArray,
    offCanvasReasoning: strArray({ type: 'string' }),
  },
  required: [
    'expressionMode',
    'complexity',
    'centralMessage',
    'mustShow',
    'mayMerge',
    'omitFromCanvas',
  ],
  additionalProperties: false,
} as const

/** JSON Schema for a FigurePlan v2 model response. Deterministic and vocabulary-backed. */
export function figurePlanJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://metis.diagram/protocol/figure-plan-v2',
    title: `FigurePlanV2 (protocol ${FIGURE_PLAN_PROTOCOL_VERSION})`,
    type: 'object',
    properties: {
      thesis: { type: 'string' },
      figureType: { type: 'string' },
      narrative: narrativeSchema,
      primarySpine: nodeRefArray,
      nodes: { type: 'array', items: semanticNodeSchema, minItems: 1 },
      edges: strArray(semanticEdgeSchema),
      groups: strArray(semanticGroupSchema),
      globalIntent: {
        type: 'object',
        properties: {
          emphasis: nodeRefArray,
          secondary: nodeRefArray,
          optional: nodeRefArray,
        },
        required: ['emphasis', 'secondary', 'optional'],
        additionalProperties: false,
      },
      readingIntent: {
        type: 'object',
        properties: {
          preferredDirection: enumOf(['LR', 'RL', 'TB', 'BT', 'radial', 'mixed']),
        },
        additionalProperties: false,
      },
      timeOrder: nodeRefArray,
      matrix: {
        type: 'object',
        properties: {
          rowGroupIds: strArray({ type: 'string', description: 'group id' }),
          columnGroupIds: strArray({ type: 'string', description: 'group id' }),
          cellRelation: { type: 'string' },
        },
        required: ['rowGroupIds', 'columnGroupIds'],
        additionalProperties: false,
      },
    },
    required: ['thesis', 'figureType', 'nodes', 'edges', 'groups', 'globalIntent'],
    additionalProperties: false,
  }
}

// ── SpatialPlan (Composition Designer response) ──

const boxHint = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    w: { type: 'number', minimum: 0, maximum: 1 },
    h: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
} as const

const placementSchema = {
  type: 'object',
  properties: {
    id: nodeRef,
    boxHint,
    visualRole: enumOf(['dominant', 'primary', 'secondary', 'supporting']),
    placementIntent: {
      type: 'object',
      properties: {
        centrality: { type: 'number', minimum: 0, maximum: 1 },
        proximityTo: nodeRefArray,
        separationFrom: nodeRefArray,
        alignWith: nodeRefArray,
      },
      additionalProperties: false,
    },
  },
  required: ['id', 'boxHint', 'visualRole'],
  additionalProperties: false,
} as const

/**
 * JSON Schema for a SpatialPlan response. `presentations` and `microLayouts`
 * come from the runtime capability contract (AI-P0-05): the model can only
 * declare what the renderer realizes.
 */
export function spatialPlanJsonSchema(capabilities?: {
  presentations?: readonly string[]
  microLayouts?: readonly string[]
  shapes?: readonly string[]
}): Record<string, unknown> {
  const visualUnit = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      label: { type: 'string' },
      detail: { type: 'string' },
      role: enumOf(VISUAL_ROLE_VALUES),
      shape: enumOf(capabilities?.shapes ?? VISUAL_SHAPE_VALUES),
      semanticNodeId: nodeRef,
      semanticEdgeId: { type: 'string' },
    },
    required: ['id', 'label', 'role'],
    additionalProperties: false,
  } as const
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://metis.diagram/protocol/spatial-plan-v2',
    title: 'SpatialPlan',
    type: 'object',
    properties: {
      composition: {
        type: 'object',
        properties: {
          readingFlow: enumOf(['LR', 'RL', 'TB', 'BT', 'radial', 'mixed']),
          balance: enumOf(['symmetric', 'asymmetric', 'loosely-balanced']),
          density: enumOf(['low', 'medium', 'high']),
          visualCenter: nodeRef,
          whitespaceStrategy: enumOf(['open', 'balanced', 'compact']),
        },
        required: ['readingFlow', 'balance', 'density', 'whitespaceStrategy'],
        additionalProperties: false,
      },
      placements: { type: 'array', items: placementSchema, minItems: 1 },
      groupLayouts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            memberIds: nodeRefArray,
            boxHint,
          },
          required: ['id', 'memberIds'],
          additionalProperties: false,
        },
      },
      routingIntent: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            edgeKey: { type: 'string', description: 'semantic edge id' },
            lane: enumOf(['top', 'bottom', 'left', 'right', 'auto']),
          },
          required: ['edgeKey'],
          additionalProperties: false,
        },
      },
      visualPlan: {
        type: 'object',
        properties: {
          modules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                moduleId: nodeRef,
                microLayout: enumOf(capabilities?.microLayouts ?? MICRO_LAYOUT_VALUES),
                units: { type: 'array', items: visualUnit, minItems: 1 },
                hints: {
                  type: 'object',
                  properties: {
                    columns: { type: 'integer', minimum: 1 },
                    direction: enumOf(['lr', 'rl', 'tb']),
                    spacing: enumOf(['tight', 'normal', 'loose']),
                  },
                  additionalProperties: false,
                },
              },
              required: ['moduleId', 'microLayout', 'units'],
              additionalProperties: false,
            },
          },
          relations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                semanticEdgeId: { type: 'string' },
                presentation: enumOf(capabilities?.presentations ?? RELATION_PRESENTATION_VALUES),
              },
              required: ['semanticEdgeId', 'presentation'],
              additionalProperties: false,
            },
          },
        },
        required: ['modules'],
        additionalProperties: false,
      },
    },
    required: ['composition', 'placements'],
    additionalProperties: false,
  }
}

/**
 * Render a JSON Schema as the compact textual contract embedded in prompts
 * (the immutable protocol section). Deterministic: same schema → same text,
 * so prompt-regression tests can diff it.
 */
export function renderJsonContract(schema: Record<string, unknown>): string {
  return JSON.stringify(schema)
}
