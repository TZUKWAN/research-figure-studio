/**
 * Render Typography — single source of truth (P0.5, GOAL section 4).
 *
 * The orchestrator resolves EVERY visible font size exactly once (per semantic
 * node, plus the micro-unit roles), applying the contract's final-size scale.
 * Measurement, the renderer and the publication audit all consume this same
 * resolved object — nobody re-derives sizes from raw style tables, so the QA'd
 * numbers are the numbers that reach the PPTX.
 */
import type { FigurePlanV2 } from '../semantic/figure-plan.js'
import type { FigureContract } from '../contract/figure-contract.js'
import {
  OUTPUT_CONTEXT_DEFAULT_WIDTH_MM,
  OUTPUT_CONTEXT_MIN_TEXT_PT,
} from '../contract/figure-contract.js'
import { SEMANTIC_NODE_STYLES } from '../components/semantic-styles.js'

export interface ResolvedNodeTypography {
  titlePt: number
  detailPt: number
}

export interface ResolvedFigureTypography {
  /** semantic node id → resolved pt sizes (already contract-scaled) */
  node: Record<string, ResolvedNodeTypography>
  /** micro-unit role sizes (contract-scaled) */
  micro: {
    primaryPt: number
    secondaryPt: number
    annotationPt: number
  }
  /** smallest pt across every resolved text — the number publication QA checks */
  minEffectiveTextPt: number
  /** multiplier applied over the base style table (1 when no contract) */
  scale: number
}

const MICRO_BASE = { primaryPt: 10.5, secondaryPt: 9.5, annotationPt: 9 } as const

export function contractFontScale(contract: FigureContract | undefined, canvasW: number): number {
  if (!contract) return 1
  const finalWidthMm =
    contract.output.finalWidthMm ?? OUTPUT_CONTEXT_DEFAULT_WIDTH_MM[contract.output.context]
  const floorPt =
    contract.minTextPtAtFinalSize ?? OUTPUT_CONTEXT_MIN_TEXT_PT[contract.output.context]
  const canvasMm = (canvasW * 25.4) / 96
  // The scale must lift the SMALLEST text (micro annotation base, 9pt) — not
  // just node details — or micro units print below the floor (GOAL section 4).
  const smallestDefault = Math.min(
    MICRO_BASE.annotationPt,
    ...Object.values(SEMANTIC_NODE_STYLES).map((style) => style.detailSizePt),
  )
  return Math.max(1, (floorPt * canvasMm) / finalWidthMm / smallestDefault)
}

export function resolveFigureTypography(input: {
  plan: FigurePlanV2
  contract?: FigureContract
  canvasW: number
  nodeSpecOverrides?: { titleSizePt?: number; detailSizePt?: number }
}): ResolvedFigureTypography {
  const scale = contractFontScale(input.contract, input.canvasW)
  // Keep full precision: rounding here re-introduces a sub-0.1pt deficit that
  // breaks the floor again at final width (publication audit uses raw math).
  const node: Record<string, ResolvedNodeTypography> = {}
  let min = Number.POSITIVE_INFINITY
  for (const nodeItem of input.plan.nodes) {
    const style = SEMANTIC_NODE_STYLES[nodeItem.type]
    const titlePt = (input.nodeSpecOverrides?.titleSizePt ?? style.titleSizePt) * scale
    const detailPt = (input.nodeSpecOverrides?.detailSizePt ?? style.detailSizePt) * scale
    node[nodeItem.id] = { titlePt, detailPt }
    min = Math.min(min, detailPt)
  }
  const micro = {
    primaryPt: MICRO_BASE.primaryPt * scale,
    secondaryPt: MICRO_BASE.secondaryPt * scale,
    annotationPt: MICRO_BASE.annotationPt * scale,
  }
  min = Math.min(min, micro.annotationPt)
  return { node, micro, minEffectiveTextPt: min, scale }
}
