/**
 * GOAL §十一: TemplateDefinition versioning — stepwise migration, additive
 * forward-compat, hard error on unmigratable payloads. Never silently current.
 */
import { describe, expect, it } from 'vitest'
import { migrateTemplateDefinition } from '../src/migrate.js'
import { TEMPLATE_SCHEMA_VERSION } from '../src/schema.js'

const BASE = {
  id: 'tpl',
  name: 'Template',
  source: { type: 'gorden-local' },
  pages: [{ slideId: 'slide-1', originalSlideIndex: 1, editableSlots: [] }],
}

describe('migrateTemplateDefinition (GOAL §十一)', () => {
  it('returns current-version payloads unchanged', () => {
    const r = migrateTemplateDefinition({
      ...BASE,
      schemaVersion: TEMPLATE_SCHEMA_VERSION,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.migratedFrom).toBeUndefined()
  })

  it('migrates 0.9 drafts stepwise and stamps the current version', () => {
    const r = migrateTemplateDefinition({ ...BASE, schemaVersion: '0.9' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.definition.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION)
      expect(r.migratedFrom).toBe('0.9')
      expect((r.definition as unknown as Record<string, unknown>).style).toBeDefined()
      expect((r.definition as unknown as Record<string, unknown>).pageRoles).toEqual({})
    }
  })

  it('preserves unknown fields from newer payloads (graceful downgrade)', () => {
    const r = migrateTemplateDefinition({
      ...BASE,
      schemaVersion: '9.9',
      futureField: { extra: true },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.migratedFrom).toBe('9.9')
      expect((r.definition as unknown as Record<string, unknown>).futureField).toEqual({
        extra: true,
      })
    }
  })

  it('errors on payloads with no migration path and on non-definitions', () => {
    const bad = migrateTemplateDefinition({ ...BASE, schemaVersion: '0.42' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/no migration path/)

    const junk = migrateTemplateDefinition({ hello: 1 })
    expect(junk.ok).toBe(false)
    if (!junk.ok) expect(junk.error).toMatch(/not a TemplateDefinition/)
  })
})
