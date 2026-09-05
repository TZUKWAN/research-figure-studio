/**
 * Cached view of the user's Standards prompt overrides (Settings → Standards).
 * Consumers resolve prompts through effectivePrompt(); the cache refreshes at
 * module load and whenever a run starts (refreshPromptOverrides from AiPanel).
 *
 * AI-P0-04: overrides carry the policy version they were saved under. Stale
 * (pre-split) overrides are still usable — the editable layer is what they
 * contain — but the composed research prompts always re-append the freshly
 * generated machine protocol and strip legacy embedded schema sections, so an
 * old override can never delete or contradict the current machine contract.
 */
import type { PromptOverrideRecord } from '../../shared/prompt-protocol'

let cache: Record<string, string> = {}
let records: Record<string, PromptOverrideRecord> = {}
let loaded = false

export async function refreshPromptOverrides(): Promise<void> {
  try {
    const api = window.slidesApi as unknown as {
      getPromptOverrideRecords?: () => Promise<Record<string, PromptOverrideRecord>>
      getPromptOverrides?: () => Promise<Record<string, string>>
    }
    if (api.getPromptOverrideRecords) {
      records = (await api.getPromptOverrideRecords()) ?? {}
      cache = Object.fromEntries(Object.entries(records).map(([id, r]) => [id, r.content]))
    } else if (api.getPromptOverrides) {
      const overrides = await api.getPromptOverrides()
      cache = overrides && typeof overrides === 'object' ? overrides : {}
      records = {}
    }
    loaded = true
  } catch {
    // settings unreachable — keep whatever we have (defaults on first failure)
  }
}

export function ensurePromptOverrides(): void {
  if (!loaded) void refreshPromptOverrides()
}

/** override policy when present and non-blank, otherwise the built-in default */
export function effectivePrompt(id: string, fallback: string): string {
  ensurePromptOverrides()
  const override = cache[id]
  return typeof override === 'string' && override.trim() !== '' ? override : fallback
}

/** versioned records (may be empty on legacy main processes or first failure) */
export function promptOverrideRecords(): Record<string, PromptOverrideRecord> {
  ensurePromptOverrides()
  return records
}

/** true when the override for `id` was saved under an older policy version */
export function overrideNeedsMigration(id: string, currentVersion: number): boolean {
  const record = records[id]
  return !!record && record.policyVersion < currentVersion
}
