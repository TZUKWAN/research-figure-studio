import React, { useEffect, useState } from 'react'
import { onResearchAction, type ResearchActionEvent } from '@genoffice/research-harness'

export type ResearchActionPhase = 'started' | 'committed' | 'reverted' | 'completed'

export function researchActionPhase(type: ResearchActionEvent['type']): ResearchActionPhase {
  return type.slice('researchAction'.length).toLowerCase() as ResearchActionPhase
}

export function useResearchAction(): ResearchActionEvent | null {
  const [event, setEvent] = useState<ResearchActionEvent | null>(null)
  useEffect(() => onResearchAction(setEvent), [])
  return event
}

function researchActionText(event: ResearchActionEvent): string {
  if (event.type === 'researchActionStarted') return event.label
  if (event.type === 'researchActionCommitted') return event.detail ?? 'Changes committed'
  if (event.type === 'researchActionReverted') return event.reason ?? 'Changes reverted'
  return event.summary
}

export function ResearchActionStatus() {
  const event = useResearchAction()
  if (!event) return null
  const phase = researchActionPhase(event.type)
  return (
    <div
      className={`research-action-status research-action-${phase}`}
      data-research-action
      data-state={phase}
      aria-live="polite"
    >
      <span className="research-action-dot" aria-hidden="true" />
      <span className="research-action-text">{researchActionText(event)}</span>
    </div>
  )
}
