/** Execution Event Layer — semantic-action granularity live feedback (v1.1 section 7). */

export type ResearchActionEvent =
  | { type: 'researchActionStarted'; actionId: string; label: string }
  | { type: 'researchActionCommitted'; actionId: string; detail?: string }
  | { type: 'researchActionReverted'; actionId: string; reason?: string }
  | { type: 'researchActionCompleted'; actionId: string; summary: string }

type Listener = (e: ResearchActionEvent) => void

const listeners = new Set<Listener>()

let counter = 0

export function beginAction(label: string): string {
  const actionId = `ra_${++counter}`
  emit({ type: 'researchActionStarted', actionId, label })
  return actionId
}

export function commitAction(actionId: string, detail?: string): void {
  emit({ type: 'researchActionCommitted', actionId, ...(detail ? { detail } : {}) })
}

export function revertAction(actionId: string, reason?: string): void {
  emit({ type: 'researchActionReverted', actionId, ...(reason ? { reason } : {}) })
}

export function completeAction(actionId: string, summary: string): void {
  emit({ type: 'researchActionCompleted', actionId, summary })
}

export function onResearchAction(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(e: ResearchActionEvent): void {
  for (const l of listeners) l(e)
}
