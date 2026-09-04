/**
 * Regression for the AI snapshot-restore lifecycle race: slides:ai-snapshot-restore
 * queues behind the run's mutation lock; while it waits, openPptx/new-blank may
 * replace the sender's session outright, and a replace-mode landing may swap in a
 * session that merely carries the old aiRun object. A stale tokenized rollback must
 * never mutate a superseded deck or hand its slides back to the renderer.
 *
 * The full registerSlidesIpc handler needs electron ipcMain/app/dialogs at import
 * time, which vitest cannot host; these tests instead drive the real production
 * pieces the handler composes — the exported `sessions` map, real Session objects,
 * real snapshot registration/rollback, and the production post-queue guard from
 * ai-run-state.ts — arranged exactly as slides-main.ts arranges them.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  webContents: { fromId: () => undefined },
}))
vi.mock('../src/main/fonts', () => ({
  createSystemFontMetrics: () => ({}),
}))

import { acquireAiMutation, canRestoreAiSnapshot, claimAiRun } from '../src/main/ai-run-state'
import {
  carryHistoryForReplacement,
  pushHistory,
  registerAiSnapshot,
  restoreAiSnapshot,
  sessions,
  takeSnapshot,
  type Session,
} from '../src/main/session-state'

function deckSession(value: string): Session {
  return {
    path: '',
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
    opened: {
      deck: {
        slides: [{ value }],
        size: { cx: 1, cy: 1 },
      },
      archive: { entries: new Map() },
    },
  } as unknown as Session
}

function valueOf(session: Session): string {
  return (session.opened.deck.slides[0] as unknown as { value: string }).value
}

function slideValue(slide: unknown): string {
  return (slide as { value: string }).value
}

function setValue(session: Session, value: string): void {
  ;(session.opened.deck.slides[0] as unknown as { value: string }).value = value
}

/** Register one 'before'-rollback point on a deck already edited by the run. */
function editedRunWithSnapshot(session: Session): number {
  claimAiRun((session.aiRun ??= {}), 'run-1')
  pushHistory(session)
  setValue(session, 'ai edited')
  const stackSnap = session.undoStack[session.undoStack.length - 1]!
  return registerAiSnapshot(session, stackSnap ?? takeSnapshot(session))
}

/**
 * Mirror of the slides:ai-snapshot-restore flow around the production pieces:
 * capture request state, wait for the mutation turn, re-read the session, ask the
 * production guard, then roll back. `duringWait` models an interleaving IPC
 * replacement (open/newBlank firing while this request sits queued).
 */
async function driveRestore(
  wcId: number,
  id: number,
  ownerToken?: string,
  duringWait?: () => void,
): Promise<string[] | null> {
  const requestState = sessions.get(wcId)?.aiRun
  const releaseMutation = requestState ? await acquireAiMutation(requestState) : undefined
  try {
    duringWait?.()
    const session = sessions.get(wcId)
    if (!session || !canRestoreAiSnapshot(requestState, session, ownerToken)) return null
    if (!restoreAiSnapshot(session, id)) return null
    return session.opened.deck.slides.map(slideValue)
  } finally {
    releaseMutation?.()
  }
}
let nextWcId = 100

describe('queued AI snapshot restore across session replacement', () => {
  it('a tokenized rollback whose session was replaced while queued must be rejected outright', async () => {
    const wcId = nextWcId++
    const old = deckSession('before')
    sessions.set(wcId, old)
    const snapId = editedRunWithSnapshot(old)
    const requestState = old.aiRun!
    const deadDeckValue = valueOf(old)
    const deadStackSize = old.undoStack.length

    let guardVerdict: boolean | undefined
    const restoreDone = driveRestore(wcId, snapId, 'run-1', () => {
      // openPptx/new-blank swapped in a fresh session (no aiRun) mid-wait;
      // expose the exact inputs the repaired handler must hand the guard.
      const blank = deckSession('blank')
      sessions.set(wcId, blank)
      guardVerdict = canRestoreAiSnapshot(requestState, blank, 'run-1')
    })
    // Queued behind the restore on the SAME run state; resolving proves the
    // restore released the mutation lock through its finally path.
    const releaseSentinel = await acquireAiMutation(requestState)
    const restored = await restoreDone

    expect(guardVerdict).toBe(false)
    expect(restored).toBeNull()
    expect(old.undoStack).toHaveLength(deadStackSize) // no rollback step pushed on the dead deck
    expect(valueOf(old)).toBe(deadDeckValue)
    expect(sessions.get(wcId)).not.toBe(old)
    releaseSentinel()
  })

  it('restores normally when no replacement happened while queued', async () => {
    const wcId = nextWcId++
    const session = deckSession('before')
    sessions.set(wcId, session)
    const snapId = editedRunWithSnapshot(session)

    const restored = await driveRestore(wcId, snapId, 'run-1')

    expect(restored).toEqual(['before'])
    expect(valueOf(session)).toBe('before')
    expect(session.undoStack).toHaveLength(2) // pre-run edit snapshot + the rollback itself
  })

  it('replace-mode internal replacement keeps the same run object, so its queued rollback lands on the new deck', async () => {
    const wcId = nextWcId++
    const old = deckSession('before')
    sessions.set(wcId, old)
    const snapId = editedRunWithSnapshot(old)

    const replacement = deckSession('generated')
    carryHistoryForReplacement(old, replacement) // transfer history + snapshots + aiRun object
    sessions.set(wcId, replacement)

    const restored = await driveRestore(wcId, snapId, 'run-1')

    expect(restored).toEqual(['before'])
    expect(valueOf(replacement)).toBe('before')
    expect(valueOf(old)).toBe('ai edited') // superseded deck stays untouched
  })

  it('rejects a token whose run was superseded by a newer claim while queued', async () => {
    const wcId = nextWcId++
    const session = deckSession('before')
    sessions.set(wcId, session)
    const snapId = editedRunWithSnapshot(session)
    const state = session.aiRun!

    const restoreDone = driveRestore(wcId, snapId, 'run-1', () => {
      claimAiRun(state, 'run-2')
    })
    const releaseSentinel = await acquireAiMutation(state)
    const restored = await restoreDone

    expect(restored).toBeNull()
    expect(valueOf(session)).toBe('ai edited')
    releaseSentinel()
  })

  it('refuses while the current session entered a history batch during the wait', async () => {
    const wcId = nextWcId++
    const session = deckSession('before')
    sessions.set(wcId, session)
    const snapId = editedRunWithSnapshot(session)
    const state = session.aiRun!

    const restoreDone = driveRestore(wcId, snapId, 'run-1', () => {
      session.historyBatch = { depth: 1, undoStart: 0, before: takeSnapshot(session) }
    })
    const releaseSentinel = await acquireAiMutation(state)
    const restored = await restoreDone

    expect(restored).toBeNull()
    expect(valueOf(session)).toBe('ai edited')
    releaseSentinel()
  })

  it('a tokenless manual rollback after replacement applies to the current session only', async () => {
    const wcId = nextWcId++
    const old = deckSession('before')
    sessions.set(wcId, old)
    const snapId = editedRunWithSnapshot(old)

    const restored = await driveRestore(wcId, snapId, undefined, () => {
      sessions.set(wcId, deckSession('blank'))
    })

    // The manual rollback targets whatever session the user sees now; a freshly
    // replaced deck has no such snapshot id, so nothing happens anywhere.
    expect(restored).toBeNull()
    expect(valueOf(old)).toBe('ai edited')
    expect(sessions.get(wcId)!.undoStack).toHaveLength(0)
  })
})
