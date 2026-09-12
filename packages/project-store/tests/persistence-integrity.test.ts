import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore, ProjectStoreError } from '../src/store.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'project-store-integrity-'))
}

describe('persistence integrity (DESKTOP-P0-05..09)', () => {
  let tmpDir: string
  let store: ProjectStore

  beforeEach(() => {
    tmpDir = makeTempDir()
    store = new ProjectStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('every appended message carries a stable UUID id distinct from seq', () => {
    store.ensureDefaultProject()
    store.appendChatMessage('default', 'chat-a', { role: 'user', text: 'one' })
    store.appendChatMessage('default', 'chat-a', { role: 'assistant', text: 'two' })
    const msgs = store.loadChat('default', 'chat-a', 100)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(msgs[1]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(msgs[0]!.id).not.toBe(msgs[1]!.id)
    expect(msgs[1]!.seq).toBe(msgs[0]!.seq + 1)
  })

  it('seq keeps increasing in chats longer than the 10k display window (P0-07/09)', () => {
    store.ensureDefaultProject()
    // Write 10_050 records directly into the JSONL (fast, no per-call scans)
    const dir = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'big.jsonl')
    const lines: string[] = []
    for (let i = 1; i <= 10_050; i++) {
      lines.push(
        JSON.stringify({ seq: i, ts: '2026-01-01T00:00:00.000Z', role: 'user', text: `m${i}` }),
      )
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    // A fresh store instance must seed its seq cache from a FULL scan, not the
    // display window — otherwise the next append would collide with seq 1..50.
    const fresh = new ProjectStore(tmpDir)
    const res = fresh.appendChatMessage('default', 'big', { role: 'assistant', text: 'after-10k' })
    expect(res.ok).toBe(true)
    const tail = fresh.loadChat('default', 'big', 5)
    expect(tail.at(-1)).toMatchObject({ seq: 10_051, text: 'after-10k' })
  })

  it('merging chats longer than the display window keeps ALL history (P0-07)', () => {
    store.ensureDefaultProject()
    const base = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(base, { recursive: true })
    const write = (name: string, from: number, to: number) => {
      const lines: string[] = []
      for (let i = from; i <= to; i++) {
        lines.push(
          JSON.stringify({ seq: i, ts: '2026-01-01T00:00:00.000Z', role: 'user', text: `t${i}` }),
        )
      }
      writeFileSync(join(base, `${name}.jsonl`), lines.join('\n') + '\n', 'utf8')
    }
    write('target', 1, 10_400)
    write('source', 1, 9_800)
    store.rebindChat('default', 'source', 'target')
    const stats = { count: 0 }
    // Read in windows of 10k via repeated loadChat calls: slice(-limit) returns
    // the tail, so walk backwards using distinct stores to avoid seq cache —
    // simplest full check: file line count.
    const merged = readFileSync(join(base, 'target.jsonl'), 'utf8').trim().split('\n')
    expect(merged).toHaveLength(10_400 + 9_800)
    // source renumbered after the target's max seq
    const last = JSON.parse(merged.at(-1)!) as { seq: number }
    expect(last.seq).toBe(10_400 + 9_800)
    expect(stats.count).toBe(0)
    expect(existsSync(join(base, 'source.jsonl'))).toBe(false)
  })

  it('corrupted JSONL lines are counted and backed up, good lines still load (P0-08)', () => {
    store.ensureDefaultProject()
    const base = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(base, { recursive: true })
    const good1 = JSON.stringify({
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      role: 'user',
      text: 'g1',
    })
    const good2 = JSON.stringify({
      seq: 2,
      ts: '2026-01-01T00:00:01.000Z',
      role: 'assistant',
      text: 'g2',
    })
    writeFileSync(join(base, 'broken.jsonl'), `${good1}\n{not json\n${good2}\n`, 'utf8')

    const msgs = store.loadChat('default', 'broken', 100)
    expect(msgs.map((m) => m.text)).toEqual(['g1', 'g2'])

    const stats = store.chatRecoveryStats('default', 'broken')
    expect(stats.corruptedLines).toBeGreaterThanOrEqual(1)
    expect(stats.backupPath).toBeTruthy()
    expect(existsSync(stats.backupPath!)).toBe(true)
    // the backup preserves the pre-repair bytes
    expect(readFileSync(stats.backupPath!, 'utf8')).toContain('{not json')
  })

  it('records with a missing seq are repaired in memory instead of dropped', () => {
    store.ensureDefaultProject()
    const base = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(base, { recursive: true })
    const a = JSON.stringify({ seq: 1, ts: '2026-01-01T00:00:00.000Z', role: 'user', text: 'a' })
    const b = JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', role: 'assistant', text: 'b' })
    const c = JSON.stringify({ seq: 3, ts: '2026-01-01T00:00:02.000Z', role: 'user', text: 'c' })
    writeFileSync(join(base, 'repaired.jsonl'), `${a}\n${b}\n${c}\n`, 'utf8')
    const msgs = store.loadChat('default', 'repaired', 100)
    expect(msgs.map((m) => m.text)).toEqual(['a', 'b', 'c'])
  })

  it('appendChatMessage reports write failures through the typed result', () => {
    store.ensureDefaultProject()
    // Force a failure: chats dir path is occupied by a regular file
    const chatsPath = join(tmpDir, 'projects', 'default', 'chats')
    mkdirSync(join(tmpDir, 'projects', 'default'), { recursive: true })
    writeFileSync(chatsPath, 'not a directory', 'utf8')
    const res = store.appendChatMessage('default', 'blocked', { role: 'assistant', text: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(typeof res.error).toBe('string')
  })

  it('deleteProject with an un-trashable directory fails loudly and keeps the index entry', () => {
    store.ensureDefaultProject()
    const proj = store.createProject('doomed')
    // Make the trash rename fail: create a NON-EMPTY directory in .trash
    // occupying the target name (POSIX rename() legally replaces an EMPTY
    // target directory, so the blocker must contain a file to fail on both
    // Windows and Linux)
    const ts = Date.now()
    const trashTarget = join(tmpDir, 'projects', '.trash', `${proj.id}-${ts}`)
    mkdirSync(trashTarget, { recursive: true })
    writeFileSync(join(trashTarget, 'occupied'), 'x')
    // Patch Date.now just long enough for the delete call
    const realNow = Date.now
    Date.now = () => ts
    try {
      expect(() => store.deleteProject(proj.id)).toThrow(ProjectStoreError)
    } finally {
      Date.now = realNow
    }
    // The project must still be listed — no silent half-delete
    const names = store.listProjects().map((p) => p.id)
    expect(names).toContain(proj.id)
  })

  it('a failed metadata transaction rolls back: index stays consistent (P0-06)', () => {
    store.ensureDefaultProject()
    const source = store.createProject('source')
    const target = store.createProject('target')
    const filePath = '/fake/room.pptx'
    store.resolveProjectForFile(filePath)
    store.moveFileToProject(filePath, source.id)

    // Sabotage the TARGET project.json: replace the file with a directory so
    // the transaction's rename onto it fails after index.json was swapped in.
    const targetJson = join(tmpDir, 'projects', target.id, 'project.json')
    const original = readFileSync(targetJson, 'utf8')
    rmSync(targetJson)
    mkdirSync(targetJson)

    expect(() => store.moveFileToProject(filePath, target.id)).toThrow(ProjectStoreError)
    // Rollback must restore the pre-transaction index: the file still maps to source
    const rawIndex = JSON.parse(readFileSync(join(tmpDir, 'projects', 'index.json'), 'utf8')) as {
      fileMap: Record<string, string>
    }
    expect(rawIndex.fileMap[filePath]).toBe(source.id)

    // Cleanup the sabotage so afterEach rm works
    rmSync(targetJson, { recursive: true, force: true })
    writeFileSync(targetJson, original, 'utf8')
  })

  it('repairConsistency re-registers orphaned projects and reassigns dead fileMap entries', () => {
    store.ensureDefaultProject()
    const proj = store.createProject('orphan-test')
    const filePath = '/fake/slide-deck.pptx'
    store.resolveProjectForFile(filePath)
    store.moveFileToProject(filePath, proj.id)

    // Simulate a torn delete: project dir removed but the index entry left in
    const projDir = join(tmpDir, 'projects', proj.id)
    rmSync(projDir, { recursive: true, force: true })

    const repairs = store.repairConsistency()
    expect(repairs.some((r) => r.includes(proj.id))).toBe(true)
    const index = JSON.parse(readFileSync(join(tmpDir, 'projects', 'index.json'), 'utf8')) as {
      projects: { id: string }[]
      fileMap: Record<string, string>
    }
    expect(index.projects.find((p) => p.id === proj.id)).toBeUndefined()
    // the orphaned file mapping returned to default
    expect(index.fileMap[filePath]).toBe('default')
    // and listProjectsSummary runs the repair implicitly, remaining stable
    expect(store.listProjectsSummary().find((p) => p.id === proj.id)).toBeUndefined()
  })

  it('restart recovery: a fresh store instance sees consistent state and continues seq without duplicates', () => {
    store.ensureDefaultProject()
    // The first assistant reply materializes the JSONL (pending user messages flush with it)
    store.appendChatMessage('default', 'chat-r', { role: 'user', text: 'before' })
    store.appendChatMessage('default', 'chat-r', { role: 'assistant', text: 'reply' })
    const fresh = new ProjectStore(tmpDir)
    fresh.appendChatMessage('default', 'chat-r', { role: 'assistant', text: 'after' })
    const msgs = fresh.loadChat('default', 'chat-r', 100)
    // seq starts at 0 (pre-existing store semantics) and continues without collision
    expect(msgs.map((m) => m.seq)).toEqual([0, 1, 2])
    expect(new Set(msgs.map((m) => m.id)).size).toBe(3)
  })

  it('moveFileToProject carries the chat file and keeps history readable after the move', () => {
    store.ensureDefaultProject()
    const target = store.createProject('destination')
    const filePath = '/fake/moved.pptx'
    store.resolveProjectForFile(filePath)
    store.appendChatMessage('default', ProjectStore.chatIdForFile(filePath), {
      role: 'user',
      text: 'history follows the file',
    })
    store.moveFileToProject(filePath, target.id)
    const chatId = ProjectStore.chatIdForFile(filePath)
    const msgs = store.loadChat(target.id, chatId, 10)
    expect(msgs.map((m) => m.text)).toEqual(['history follows the file'])
    expect(existsSync(join(tmpDir, 'projects', 'default', 'chats', `${chatId}.jsonl`))).toBe(false)
    expect(existsSync(join(tmpDir, 'projects', target.id, 'chats', `${chatId}.jsonl`))).toBe(true)
  })
})
