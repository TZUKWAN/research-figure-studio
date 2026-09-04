import type { ConnectorRoute, ElementPlacement, IceLayout } from '../recipes/input-core-output.js'

export interface InputCoreOutputAuditOptions {
  minMarginPx?: number
  requireFeedback?: boolean
}

export interface InputCoreOutputAuditMetrics {
  elementCount: number
  mainConnectorCount: number
  feedbackConnectorCount: number
  overlapCount: number
  leftMarginPx: number
  rightMarginPx: number
}

export interface InputCoreOutputAuditResult {
  ok: boolean
  issues: string[]
  metrics: InputCoreOutputAuditMetrics
}

const MARGIN_FRAC = 0.06

function inBounds(element: ElementPlacement, canvasW: number, canvasH: number): boolean {
  return (
    Number.isFinite(element.x) &&
    Number.isFinite(element.y) &&
    Number.isFinite(element.w) &&
    Number.isFinite(element.h) &&
    element.w > 0 &&
    element.h > 0 &&
    element.x >= 0 &&
    element.y >= 0 &&
    element.x + element.w <= canvasW &&
    element.y + element.h <= canvasH
  )
}

function overlaps(a: ElementPlacement, b: ElementPlacement): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  )
}

function connectorDirectionIsForward(
  connector: ConnectorRoute,
  elements: ElementPlacement[],
  regions: IceLayout['regions'],
): boolean {
  const from = elements[connector.fromIndex]
  const to = elements[connector.toIndex]
  if (!from || !to) return false
  const zones = [regions.input, regions.core, regions.output]
  const zoneOf = (element: ElementPlacement) =>
    zones.findIndex(
      (zone) => element.x + element.w / 2 >= zone.x && element.x + element.w / 2 <= zone.x + zone.w,
    )
  const fromZone = zoneOf(from)
  const toZone = zoneOf(to)
  return fromZone !== toZone
    ? fromZone >= 0 && toZone > fromZone
    : from.y + from.h / 2 < to.y + to.h / 2
}

/** E8 acceptance rules for the three-zone Input → Core → Output recipe. */
export function auditInputCoreOutput(
  layout: IceLayout,
  canvasW: number,
  canvasH: number,
  options: InputCoreOutputAuditOptions = {},
): InputCoreOutputAuditResult {
  const minMargin = options.minMarginPx ?? Math.round(canvasW * MARGIN_FRAC)
  const issues: string[] = []
  const elements = layout.elements
  const mainConnectors = layout.connectors.filter((connector) => connector.role === 'main')
  const feedbackConnectors = layout.connectors.filter((connector) => connector.role === 'feedback')
  const regions = [layout.regions.input, layout.regions.core, layout.regions.output]
  const leftMargin = regions[0].x
  const rightMargin = canvasW - (regions.at(-1)!.x + regions.at(-1)!.w)

  if (leftMargin < minMargin || rightMargin < minMargin) {
    issues.push(
      `margin violation: left ${Math.round(leftMargin)}px, right ${Math.round(rightMargin)}px; both must be at least ${minMargin}px`,
    )
  }

  for (const [index, region] of regions.entries()) {
    if (
      !Number.isFinite(region.x) ||
      !Number.isFinite(region.y) ||
      !Number.isFinite(region.w) ||
      !Number.isFinite(region.h) ||
      region.w <= 0 ||
      region.h <= 0 ||
      region.x < 0 ||
      region.y < 0 ||
      region.x + region.w > canvasW ||
      region.y + region.h > canvasH
    ) {
      issues.push(
        `region overflow: zone ${index + 1} lies outside the ${canvasW}x${canvasH} canvas`,
      )
    }
  }

  for (const element of elements) {
    if (!inBounds(element, canvasW, canvasH)) {
      issues.push(`overflow: ${element.title} lies outside the ${canvasW}x${canvasH} canvas`)
    }
    const containedInZone = regions.some(
      (region) =>
        element.x >= region.x &&
        element.y >= region.y &&
        element.x + element.w <= region.x + region.w &&
        element.y + element.h <= region.y + region.h,
    )
    if (!containedInZone) {
      issues.push(`zone overflow: ${element.title} crosses its assigned zone boundary`)
    }
  }

  let overlapCount = 0
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      if (overlaps(elements[i]!, elements[j]!)) {
        overlapCount++
        issues.push(`overlap: ${elements[i]!.title} intersects ${elements[j]!.title}`)
      }
    }
  }

  // Connector topology is edge-driven: the layout guarantees a 1:1 match with
  // the declared semantic edges, so the audit checks integrity (references,
  // direction, duplicates) rather than a positional N-1 chain count.
  const seenRoutes = new Set<string>()
  for (const connector of mainConnectors) {
    const from = elements[connector.fromIndex]
    const to = elements[connector.toIndex]
    if (!from || !to) {
      issues.push(`connector reference violation: ${connector.fromIndex} -> ${connector.toIndex}`)
      continue
    }
    const routeKey = `${connector.fromIndex}->${connector.toIndex}`
    if (seenRoutes.has(routeKey)) {
      issues.push(`connector duplicate violation: ${connector.fromIndex} -> ${connector.toIndex}`)
    }
    seenRoutes.add(routeKey)
    if (!connectorDirectionIsForward(connector, elements, layout.regions)) {
      issues.push(`connector direction violation: ${connector.fromIndex} -> ${connector.toIndex}`)
    }
  }

  if (options.requireFeedback && feedbackConnectors.length !== 1) {
    issues.push(
      `feedback coverage violation: expected 1 feedback connector, found ${feedbackConnectors.length}`,
    )
  }
  for (const connector of feedbackConnectors) {
    const from = elements[connector.fromIndex]
    const to = elements[connector.toIndex]
    if (!from || !to) {
      issues.push(`feedback reference violation: ${connector.fromIndex} -> ${connector.toIndex}`)
    }
    if (connector.kind !== 'elbow') {
      issues.push(`feedback routing violation: expected elbow, found ${connector.kind}`)
    }
    if (layout.regions.feedbackLaneY == null) {
      issues.push('feedback routing violation: missing feedback lane')
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      elementCount: elements.length,
      mainConnectorCount: mainConnectors.length,
      feedbackConnectorCount: feedbackConnectors.length,
      overlapCount,
      leftMarginPx: leftMargin,
      rightMarginPx: rightMargin,
    },
  }
}
