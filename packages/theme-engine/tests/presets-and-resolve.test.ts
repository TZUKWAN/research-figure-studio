import { describe, expect, it } from 'vitest'
import {
  PRESET_THEMES,
  getThemeById,
} from '../src/presets.js'
import { connectorColor, contrastRatio, luminance, resolveComponentColors } from '../src/resolve.js'

describe('preset themes', () => {
  it('ships the ten PRD palettes', () => {
    expect(PRESET_THEMES).toHaveLength(10)
    expect(getThemeById('academic-blue')).toBeDefined()
    expect(getThemeById('dark-academic')).toBeDefined()
    expect(getThemeById('nope')).toBeUndefined()
  })

  it('every role is a valid #RRGGBB hex', () => {
    for (const t of PRESET_THEMES) {
      for (const [role, v] of Object.entries(t.roles)) {
        expect(v, `${t.id}.${role}`).toMatch(/^#[0-9A-F]{6}$/i)
      }
    }
  })
})

describe('resolveComponentColors', () => {
  const blue = getThemeById('academic-blue')!.roles

  it('binds mechanism modules to surface+accent with dark text', () => {
    const c = resolveComponentColors('mechanism-module', blue)
    expect(c.fill).toBe('#FFFFFF')
    expect(c.stroke).toBe('#D68A45')
    expect(c.text).toBe('#17212B')
  })

  it('gives output nodes accent identity with WCAG-readable text', () => {
    const c = resolveComponentColors('output-node', blue)
    expect(c.fill).toBe('#D68A45')
    // whatever direction wins, it must actually read on the fill (AA large-text)
    expect(contrastRatio(c.text, c.fill)).toBeGreaterThan(4)
  })

  it('unknown kinds fall back to surface/primary', () => {
    const c = resolveComponentColors('mystery', blue)
    expect(c.fill).toBe('#FFFFFF')
    expect(c.stroke).toBe('#24527A')
  })

  it('dark themes flip text to stay readable', () => {
    const dark = getThemeById('dark-academic')!.roles
    const c = resolveComponentColors('process-node', dark)
    expect(contrastRatio(c.text, c.fill)).toBeGreaterThan(3)
  })

  it('connector color comes from the connector role', () => {
    expect(connectorColor(blue)).toBe('#687784')
  })
})
