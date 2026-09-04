import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, afterEach } from 'vitest'
import { beginAction, commitAction, completeAction } from '@genoffice/research-harness'
import { ResearchActionStatus } from '../src/renderer/research-action-ui'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('ResearchActionStatus', () => {
  it('shows semantic action progress as the event layer advances', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => root!.render(createElement(ResearchActionStatus)))
    expect(container.querySelector('[data-research-action]')).toBeNull()

    let actionId = ''
    act(() => {
      actionId = beginAction('Create input region')
    })
    expect(container.querySelector('[data-research-action]')?.textContent).toContain(
      'Create input region',
    )

    act(() => commitAction(actionId, 'input nodes'))
    expect(container.querySelector('[data-research-action]')?.getAttribute('data-state')).toBe(
      'committed',
    )
    expect(container.textContent).toContain('input nodes')

    act(() => completeAction(actionId, 'Input region complete'))
    expect(container.querySelector('[data-research-action]')?.getAttribute('data-state')).toBe(
      'completed',
    )
    expect(container.textContent).toContain('Input region complete')
  })
})
