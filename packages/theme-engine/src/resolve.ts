/**
 * Resolve semantic component roles to concrete hex colors for a given theme.
 * Pure function: theme + registry kind → fill/stroke/text, so a theme swap
 * re-colors without touching layout (PRD §43 Theme 验收标准).
 */

import type { ThemeRoles } from './presets.js'

export interface ComponentColors {
  fill: string
  stroke: string
  text: string
  subtitle?: string
}

/** Per-kind token binding (mirrors research-harness registry kinds). */
const KIND_BINDING: Record<string, { fill: keyof ThemeRoles; stroke: keyof ThemeRoles }> = {
  'data-source': { fill: 'surface', stroke: 'secondary' },
  'input-node': { fill: 'primary', stroke: 'primary' },
  'process-node': { fill: 'surface', stroke: 'primary' },
  'model-module': { fill: 'primary', stroke: 'primary' },
  'mechanism-module': { fill: 'surface', stroke: 'accent' },
  'output-node': { fill: 'accent', stroke: 'accent' },
  'evidence-node': { fill: 'background', stroke: 'border' },
  annotation: { fill: 'background', stroke: 'background' },
  'section-container': { fill: 'surface', stroke: 'border' },
}

export function resolveComponentColors(
  kind: string,
  roles: ThemeRoles,
): ComponentColors {
  const b = KIND_BINDING[kind] ?? { fill: 'surface' as const, stroke: 'primary' as const }
  const fill = roles[b.fill]
  const stroke = roles[b.stroke]
  // Contrast rule: dark fills get light text and vice versa (relative luminance).
  const lightFill = luminance(fill) > 0.55
  return {
    fill,
    stroke,
    text: lightFill ? roles.textPrimary : pickReadableOnDark(roles),
    subtitle: lightFill ? roles.textSecondary : roles.textSecondary,
  }
}

export function connectorColor(roles: ThemeRoles): string {
  return roles.connector
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** WCAG-style relative luminance (0..1). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio between two hex colors (1..21); ≥4.5 passes WCAG AA for body text. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

function pickReadableOnDark(roles: ThemeRoles): string {
  // Pick whichever role text reads better on the dark fill; fall back to near-white.
  const cPrimary = contrastRatio(roles.textPrimary, roles.primary)
  const cSecondary = contrastRatio(roles.textSecondary, roles.primary)
  return cPrimary >= cSecondary ? roles.textPrimary : '#F2F5F8'
}
