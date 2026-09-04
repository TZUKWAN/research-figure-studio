/**
 * Resolve semantic component roles to concrete hex colors for a given theme.
 * Pure function: theme + registry kind → fill/stroke/text, so a theme swap
 * re-colors without touching layout (PRD section 43 theme acceptance criteria).
 */

import type { ThemeRoles } from './presets.js'

export interface ComponentColors {
  fill: string
  stroke: string
  text: string
  subtitle?: string
}

export interface ComponentThemeTokens {
  fill: keyof ThemeRoles
  stroke: keyof ThemeRoles
  text: keyof ThemeRoles
  subtitle: keyof ThemeRoles
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

export function componentThemeTokens(kind: string): ComponentThemeTokens {
  const b = KIND_BINDING[kind] ?? { fill: 'surface' as const, stroke: 'primary' as const }
  return { ...b, text: 'textPrimary', subtitle: 'textSecondary' }
}

export function resolveComponentColors(kind: string, roles: ThemeRoles): ComponentColors {
  const tokens = componentThemeTokens(kind)
  const fill = roles[tokens.fill]
  const stroke = roles[tokens.stroke]
  const text = pickReadableText(roles, fill)
  // Keep the secondary tone where it meets body-text contrast; otherwise use the same
  // readable foreground as the title instead of rendering a low-contrast subtitle.
  const subtitle = contrastRatio(roles.textSecondary, fill) >= 4.5 ? roles.textSecondary : text
  return {
    fill,
    stroke,
    text,
    subtitle,
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

function pickReadableText(roles: ThemeRoles, onFill: string): string {
  if (contrastRatio(roles.textPrimary, onFill) >= 4.5) return roles.textPrimary
  // Choose against the actual fill; both extreme fallbacks are needed for accent
  // roles that can be light in a dark theme.
  const candidates = [roles.textPrimary, roles.textSecondary, '#FFFFFF', '#000000']
  return candidates.reduce((best, candidate) =>
    contrastRatio(candidate, onFill) > contrastRatio(best, onFill) ? candidate : best,
  )
}
