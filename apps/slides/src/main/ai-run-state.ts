/** Main-process ownership and serialization for asynchronous AI deck mutations. */
export interface AiRunState {
  ownerToken?: string
  mutationTail?: Promise<void>
}

export function claimAiRun(state: AiRunState, ownerToken: string): boolean {
  if (!ownerToken.trim()) return false
  state.ownerToken = ownerToken
  return true
}

export function isAiRunOwner(state: AiRunState, ownerToken?: string): boolean {
  return ownerToken == null || state.ownerToken === ownerToken
}

export function isAiMutationOwner(
  expectedState: AiRunState | undefined,
  currentState: AiRunState | undefined,
  ownerToken?: string,
): boolean {
  if (ownerToken == null) return true
  return (
    expectedState != null &&
    expectedState === currentState &&
    isAiRunOwner(expectedState, ownerToken)
  )
}

export function releaseAiRun(state: AiRunState, ownerToken: string): void {
  if (state.ownerToken === ownerToken) state.ownerToken = undefined
}

/**
 * Whether a queued slides:ai-snapshot-restore may proceed once its mutation turn
 * arrives. `requestState` is the run state captured when the request entered the
 * queue; `currentSession` is the sender's session looked up AFTER the wait — when
 * openPptx/new-blank replaced that session meanwhile, its aiRun is a different (or
 * absent) object, so a still-valid-looking token must not resurrect a rollback on
 * a superseded deck. Tokenless restores are direct user rollbacks and stay tied to
 * whatever session the user sees now.
 */
export function canRestoreAiSnapshot(
  requestState: AiRunState | undefined,
  currentSession: { aiRun?: AiRunState; masterEdit?: unknown; historyBatch?: unknown } | undefined,
  ownerToken?: string,
): boolean {
  if (!currentSession || currentSession.masterEdit || currentSession.historyBatch) return false
  return isAiMutationOwner(requestState, currentSession.aiRun, ownerToken)
}

/** Serialize operations that can replace or persist the session's canonical deck. */
export async function acquireAiMutation(state: AiRunState): Promise<() => void> {
  const previous = state.mutationTail ?? Promise.resolve()
  let release!: () => void
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  state.mutationTail = previous.then(() => turn)
  await previous
  return release
}
