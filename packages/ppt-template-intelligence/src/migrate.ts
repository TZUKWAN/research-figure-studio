/**
 * TemplateDefinition versioning + migration (GOAL §十一).
 *
 * Persisted analyses may predate the current schema. Migration is STEPWISE
 * (each version upgrades exactly one step) and ADDITIVE: unknown fields from
 * newer payloads survive untouched, missing fields from older payloads get
 * safe defaults. An entry that cannot be migrated at all is an ERROR — never
 * silently treated as current, never silently dropped.
 */
import { TEMPLATE_SCHEMA_VERSION, type TemplateDefinition } from './schema.js'

type RawDefinition = Record<string, unknown>

/** One migration step: key = the version the payload is COMING FROM. */
const MIGRATIONS: Record<string, (d: RawDefinition) => RawDefinition> = {
  // 0.9 drafts lacked the style block and pageRoles; synthesize empty ones so
  // downstream consumers see the current shape.
  '0.9': (d) => ({
    ...d,
    style: d.style ?? { tags: [], colors: [], fonts: {}, typeScale: [], density: 'medium' },
    pageRoles: d.pageRoles ?? {},
    editingRules: d.editingRules ?? [],
  }),
}

/** Structural sanity for anything claiming to be a TemplateDefinition. */
function isDefinitionLike(d: unknown): d is RawDefinition {
  return (
    typeof d === 'object' &&
    d !== null &&
    typeof (d as RawDefinition).id === 'string' &&
    typeof (d as RawDefinition).name === 'string' &&
    Array.isArray((d as RawDefinition).pages)
  )
}

export type MigrationResult =
  | { ok: true; definition: TemplateDefinition; migratedFrom?: string }
  | { ok: false; error: string }

/**
 * Validate + migrate an unknown persisted payload to TEMPLATE_SCHEMA_VERSION.
 * Forward-compat: a payload from a NEWER schema version is returned as-is
 * (unknown fields are preserved by design; consumers read what they know) —
 * only the schemaVersion string is reported back via migratedFrom.
 */
export function migrateTemplateDefinition(raw: unknown): MigrationResult {
  if (!isDefinitionLike(raw)) {
    return { ok: false, error: 'payload is not a TemplateDefinition (id/name/pages missing)' }
  }
  let d: RawDefinition = { ...raw }
  const from = typeof d.schemaVersion === 'string' ? d.schemaVersion : '(none)'
  if (from !== '(none)' && from !== TEMPLATE_SCHEMA_VERSION && !MIGRATIONS[from]) {
    // version we never emitted → corrupt or foreign payload
    if (from > TEMPLATE_SCHEMA_VERSION) {
      // newer: keep, callers read the fields they know (graceful downgrade)
      return { ok: true, definition: d as unknown as TemplateDefinition, migratedFrom: from }
    }
    return { ok: false, error: `no migration path from schemaVersion "${from}"` }
  }
  if (from === '(none)' || MIGRATIONS[from]) {
    const migration = from === '(none)' ? undefined : MIGRATIONS[from]
    if (migration) d = migration(d)
    d.schemaVersion = TEMPLATE_SCHEMA_VERSION
    return { ok: true, definition: d as unknown as TemplateDefinition, migratedFrom: from === '(none)' ? undefined : from }
  }
  return { ok: true, definition: d as unknown as TemplateDefinition }
}
