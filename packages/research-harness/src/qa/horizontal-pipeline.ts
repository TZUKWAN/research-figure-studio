import type { HorizontalPipelineLayout } from '../recipes/horizontal-pipeline.js'

export interface HorizontalPipelineAuditOptions {
  minMarginPx?: number
  maxSpacingVariancePx2?: number
  baselineTolerancePx?: number
}

export interface HorizontalPipelineAuditMetrics {
  leftMarginPx: number
  rightMarginPx: number
  baselineSpreadPx: number
  spacingVariancePx2: number
}

export interface HorizontalPipelineAuditResult {
  ok: boolean
  issues: string[]
  metrics: HorizontalPipelineAuditMetrics
}

const MARGIN_FRAC = 0.06
const MAX_SPACING_VARIANCE_PX2 = 16
const BASELINE_TOLERANCE_PX = 2

/** E8 acceptance rules for a one-row horizontal pipeline. */
export function auditHorizontalPipeline(
  layout: HorizontalPipelineLayout,
  canvasW: number,
  canvasH: number,
  options: HorizontalPipelineAuditOptions = {},
): HorizontalPipelineAuditResult {
  const elements = layout.elements
  const minMargin = options.minMarginPx ?? Math.round(canvasW * MARGIN_FRAC)
  const maxSpacingVariance = options.maxSpacingVariancePx2 ?? MAX_SPACING_VARIANCE_PX2
  const baselineTolerance = options.baselineTolerancePx ?? BASELINE_TOLERANCE_PX
  const first = elements[0]
  const last = elements.at(-1)
  const leftMargin = first ? first.x : canvasW / 2
  const rightMargin = last ? canvasW - (last.x + last.w) : canvasW / 2
  const centers = elements.map((element) => element.y + element.h / 2)
  const baselineSpread = centers.length ? Math.max(...centers) - Math.min(...centers) : 0
  const gaps = elements
    .slice(1)
    .map((element, index) => element.x - (elements[index]!.x + elements[index]!.w))
  const meanGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0
  const spacingVariance = gaps.length
    ? gaps.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gaps.length
    : 0
  const issues: string[] = []

  if (leftMargin < minMargin || rightMargin < minMargin) {
    issues.push(
      `margin violation: left ${Math.round(leftMargin)}px, right ${Math.round(rightMargin)}px; both must be at least ${minMargin}px`,
    )
  }
  if (baselineSpread > baselineTolerance) {
    issues.push(
      `baseline violation: centerline spread is ${Math.round(baselineSpread)}px; maximum is ${baselineTolerance}px`,
    )
  }
  if (spacingVariance > maxSpacingVariance) {
    issues.push(
      `spacing violation: gap variance is ${Math.round(spacingVariance)}px²; maximum is ${maxSpacingVariance}px²`,
    )
  }

  for (const element of elements) {
    if (
      element.x < 0 ||
      element.y < 0 ||
      element.x + element.w > canvasW ||
      element.y + element.h > canvasH
    ) {
      issues.push(`overflow: ${element.title} lies outside the ${canvasW}x${canvasH} canvas`)
    }
  }
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i]!
      const b = elements[j]!
      if (
        Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
        Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
      ) {
        issues.push(`overlap: ${a.title} intersects ${b.title}`)
      }
    }
  }

  // Edge-driven topology: integrity checks only (references + direction), no
  // positional N-1 chain count.
  const mainConnectors = layout.connectors.filter((connector) => connector.role === 'main')
  for (const connector of mainConnectors) {
    const from = elements[connector.fromIndex]
    const to = elements[connector.toIndex]
    if (!from || !to) {
      issues.push(`connector reference violation: ${connector.fromIndex} -> ${connector.toIndex}`)
      continue
    }
    if (from.x + from.w / 2 >= to.x + to.w / 2) {
      issues.push(
        `connector direction violation: ${connector.fromIndex} -> ${connector.toIndex} is not left-to-right`,
      )
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      leftMarginPx: leftMargin,
      rightMarginPx: rightMargin,
      baselineSpreadPx: baselineSpread,
      spacingVariancePx2: spacingVariance,
    },
  }
}
