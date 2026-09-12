/**
 * Theme Bridge (GOAL §20): map an analyzed template's theme onto the
 * research-figure pipeline's semantic roles, so a figure generated INTO a
 * template-based deck inherits the template's palette/fonts instead of the
 * academic defaults.
 *
 * The mapping is deterministic and REVIEWED: template theme colors are
 * assigned to figure roles by luminance/chroma ordering (darkest readable →
 * primary text, mid-tones → primary/secondary structure, vivid mid → accent),
 * never by index guessing alone. Consumers may override any role explicitly.
 */
import type { TemplateDefinition } from './schema.js'

export interface BridgedTheme {
  roles: {
    primary: string
    secondary: string
    accent: string
    background: string
    surface: string
    textPrimary: string
    textSecondary: string
    border: string
    connector: string
  }
  fonts?: { cjk?: string; latin?: string }
  /** which colors the bridge assigned — surfaced for review/debug */
  source: { palette: string[]; background?: string }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance(hex: string): number | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function chroma(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 0
  return Math.max(...rgb) - Math.min(...rgb)
}

/**
 * Build a figure-pipeline theme from a TemplateDefinition. Falls back per
 * role when the template does not supply enough colors (never throws — a
 * poor template theme degrades to defaults instead of blocking the figure).
 */
export function bridgeTemplateTheme(
  def: Pick<TemplateDefinition, 'style'>,
  opts?: { preferredCjkFont?: string; preferredLatinFont?: string },
): BridgedTheme {
  const palette = def.style.colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
  const opaque = palette.filter((c) => !/[0-9a-fA-F]{2}$/.test(c) || luminance(c) !== null)
  const unique = [...new Set(opaque)]

  const byLum = [...unique].sort(
    (a, b) => (luminance(a) ?? 0.5) - (luminance(b) ?? 0.5),
  )
  const darkest = byLum[0]
  const lightest = byLum[byLum.length - 1]
  const mids = byLum.slice(1, Math.max(1, byLum.length - 1))
  const vividMids = [...mids].sort((a, b) => chroma(b) - chroma(a))

  const background = def.style.colors.length > 0 ? (lightest ?? '#FFFFFF') : '#FFFFFF'
  const primary = mids[0] ?? darkest ?? '#24527A'
  const secondary = mids[1] ?? primary
  const accent = vividMids.find((c) => c !== primary && c !== secondary) ?? accentFallback(primary)
  const textPrimary = darkest ?? '#222222'
  const textSecondary = mids[0] ?? '#555555'
  const surface = lightest ?? '#FFFFFF'
  const border = mids[mids.length - 1] ?? secondary
  const connector = secondary

  const fontProfile = def.style.fontProfile
  const themeEa = fontProfile?.theme.majorEa ?? fontProfile?.theme.minorEa
  const themeLatin = fontProfile?.theme.majorLatin ?? fontProfile?.theme.minorLatin
  const observedEa = fontProfile?.observed.find((o) => o.script === 'ea')?.family

  return {
    roles: {
      primary,
      secondary,
      accent,
      background,
      surface,
      textPrimary,
      textSecondary,
      border,
      connector,
    },
    fonts: {
      cjk: opts?.preferredCjkFont ?? observedEa ?? themeEa ?? undefined,
      latin: opts?.preferredLatinFont ?? themeLatin ?? undefined,
    },
    source: { palette: unique, background: def.style.colors[0] },
  }
}

function accentFallback(primary: string): string {
  // derive a perceptible accent by rotating hue 40° when the template offers
  // only one mid tone; primary stays untouched
  const rgb = hexToRgb(primary)
  if (!rgb) return '#C0504D'
  const [r, g, b] = rgb
  const rotated = [b * 0.8 + r * 0.2, r, g]
  const toHex = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(rotated[0]!)}${toHex(rotated[1]!)}${toHex(rotated[2]!)}`
}
