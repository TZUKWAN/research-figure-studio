import { describe, expect, it } from 'vitest'
import {
  acquireAiMutation,
  claimAiRun,
  isAiMutationOwner,
  isAiRunOwner,
  releaseAiRun,
  type AiRunState,
} from '../src/main/ai-run-state'

describe('AI run ownership', () => {
  it('invalidates an older owner without allowing its release to clear the newer owner', () => {
    const state: AiRunState = {}

    expect(claimAiRun(state, 'old')).toBe(true)
    expect(claimAiRun(state, 'new')).toBe(true)
    expect(isAiRunOwner(state, 'old')).toBe(false)
    expect(isAiRunOwner(state, 'new')).toBe(true)

    releaseAiRun(state, 'old')
    expect(isAiRunOwner(state, 'new')).toBe(true)
    releaseAiRun(state, 'new')
    expect(isAiRunOwner(state, 'new')).toBe(false)
  })

  it('serializes deck mutations until the previous mutation releases its turn', async () => {
    const state: AiRunState = {}
    const firstRelease = await acquireAiMutation(state)
    let secondStarted = false
    const secondReleasePromise = acquireAiMutation(state).then((release) => {
      secondStarted = true
      return release
    })

    await Promise.resolve()
    expect(secondStarted).toBe(false)

    firstRelease()
    const secondRelease = await secondReleasePromise
    expect(secondStarted).toBe(true)
    secondRelease()
  })

  it('rejects an owner whose session was replaced while its mutation was waiting', () => {
    const oldState: AiRunState = {}
    const replacementState: AiRunState = {}
    expect(claimAiRun(oldState, 'run-1')).toBe(true)

    expect(isAiMutationOwner(oldState, oldState, 'run-1')).toBe(true)
    expect(isAiMutationOwner(oldState, replacementState, 'run-1')).toBe(false)
  })
})
