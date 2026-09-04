/** Semantic Component Registry v2 (P1): per-type visual capacity so a
 * mechanism doesn't render like a variable. Measurement, solver collision and
 * renderer typography all read this one table. */
import type { SemanticNodeType } from '../semantic/figure-plan.js'
import type { NodeTextSpec } from '../measurement/measure.js'

export type CollisionClass = 'solid' | 'background' | 'overlay' | 'permeable'

export interface SemanticNodeStyle extends NodeTextSpec {
  /** preferred width/height band; solver uses it to bias boxHint shapes */
  aspectMin: number
  aspectMax: number
  collisionClass: CollisionClass
  /** how much visual emphasis this type may carry (dominant capacity) */
  emphasisCapacity: number
  detailAllowed: boolean
}

const base: SemanticNodeStyle = {
  titleSizePt: 13,
  detailSizePt: 10.5,
  maxTitleLines: 2,
  maxDetailLines: 2,
  padX: 10,
  padY: 8,
  titleGapY: 4,
  lineHeight: 1.25,
  minWidth: 96,
  maxWidth: 280,
  minHeight: 52,
  maxHeight: 150,
  aspectMin: 1.3,
  aspectMax: 2.6,
  collisionClass: 'solid',
  emphasisCapacity: 0.6,
  detailAllowed: true,
}

function style(over: Partial<SemanticNodeStyle>): SemanticNodeStyle {
  return { ...base, ...over }
}

export const SEMANTIC_NODE_STYLES: Record<SemanticNodeType, SemanticNodeStyle> = {
  variable: style({
    minWidth: 88,
    maxWidth: 220,
    minHeight: 46,
    maxHeight: 110,
    emphasisCapacity: 0.4,
    detailSizePt: 10,
  }),
  mechanism: style({
    titleSizePt: 14,
    minWidth: 130,
    maxWidth: 320,
    minHeight: 64,
    maxHeight: 180,
    aspectMin: 1.8,
    aspectMax: 2.6,
    emphasisCapacity: 1,
    padX: 12,
    padY: 10,
  }),
  process: style({ minWidth: 104, maxWidth: 260, emphasisCapacity: 0.5 }),
  model: style({
    titleSizePt: 14,
    minWidth: 120,
    maxWidth: 300,
    minHeight: 60,
    maxHeight: 170,
    emphasisCapacity: 0.9,
  }),
  method: style({ minWidth: 96, maxWidth: 240, emphasisCapacity: 0.5 }),
  'data-source': style({
    minWidth: 96,
    maxWidth: 240,
    aspectMin: 1.2,
    aspectMax: 2.0,
    emphasisCapacity: 0.45,
  }),
  actor: style({ minWidth: 88, maxWidth: 220, emphasisCapacity: 0.4 }),
  evidence: style({
    detailSizePt: 10,
    minWidth: 90,
    maxWidth: 230,
    minHeight: 44,
    maxHeight: 110,
    emphasisCapacity: 0.35,
    maxDetailLines: 1,
  }),
  outcome: style({
    titleSizePt: 13,
    minWidth: 96,
    maxWidth: 240,
    minHeight: 50,
    maxHeight: 120,
    aspectMin: 1.4,
    aspectMax: 2.4,
    emphasisCapacity: 0.75,
    maxDetailLines: 1,
  }),
  hypothesis: style({ minWidth: 96, maxWidth: 250, emphasisCapacity: 0.5, detailAllowed: true }),
  annotation: style({
    titleSizePt: 10.5,
    detailSizePt: 9.5,
    minWidth: 72,
    maxWidth: 200,
    minHeight: 44,
    maxHeight: 96,
    padX: 8,
    padY: 6,
    collisionClass: 'overlay',
    emphasisCapacity: 0.1,
    detailAllowed: true,
    maxTitleLines: 1,
  }),
  context: style({
    titleSizePt: 12,
    minWidth: 140,
    maxWidth: 420,
    minHeight: 80,
    maxHeight: 320,
    padX: 14,
    padY: 12,
    collisionClass: 'background',
    emphasisCapacity: 0.2,
  }),
}

/** Semantic role may promote/demote emphasis beyond the type default. */
export function effectiveEmphasis(type: SemanticNodeType, importance: number): number {
  const style = SEMANTIC_NODE_STYLES[type]
  return Math.min(1, style.emphasisCapacity * (0.75 + 0.5 * importance))
}
