/**
 * GOAL §23: AI runtime template context. The Template Center sets the user's
 * selected template here; the slides-skill template tools read it as the
 * default for analyze / fill, so "Use Template" is a first-class runtime
 * selection instead of a hidden prompt stuffed into the user's input.
 */
export interface PresentationSessionContext {
  selectedTemplateId?: string
  selectedTemplatePath?: string
  selectedTemplateName?: string
}

let context: PresentationSessionContext = {}
const listeners = new Set<(ctx: PresentationSessionContext) => void>()

export function setPresentationSessionContext(patch: Partial<PresentationSessionContext>): void {
  context = { ...context, ...patch }
  for (const listener of listeners) listener(context)
}

export function getPresentationSessionContext(): PresentationSessionContext {
  return context
}

export function onPresentationSessionContextChange(
  listener: (ctx: PresentationSessionContext) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
