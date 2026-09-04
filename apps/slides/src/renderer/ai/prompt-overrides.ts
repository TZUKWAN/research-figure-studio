/**
 * Cached view of the user's Standards prompt overrides (Settings → Standards).
 * Consumers resolve prompts through effectivePrompt(); the cache refreshes at
 * module load and whenever a run starts (refreshPromptOverrides from AiPanel).
 */
let cache: Record<string, string> = {}
let loaded = false

export async function refreshPromptOverrides(): Promise<void> {
  try {
    const overrides = await window.slidesApi.getPromptOverrides()
    if (overrides && typeof overrides === 'object') cache = overrides
    loaded = true
  } catch {
    // settings unreachable — keep whatever we have (defaults on first failure)
  }
}

export function ensurePromptOverrides(): void {
  if (!loaded) void refreshPromptOverrides()
}

/** override when present and non-blank, otherwise the built-in default */
export function effectivePrompt(id: string, fallback: string): string {
  ensurePromptOverrides()
  const override = cache[id]
  return typeof override === 'string' && override.trim() !== '' ? override : fallback
}
