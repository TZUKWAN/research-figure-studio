/**
 * project-store core implementation
 *
 * Storage layout (baseDir = userData/projects/):
 *   index.json
 *   <project-id>/
 *     project.json
 *     chats/
 *       <chat-id>.jsonl
 *
 * Design principles:
 * - No Electron dependency; the userData path is injected by the caller
 * - Best-effort telemetry/history writes (chat appends) warn silently and
 *   return a typed ProjectStoreResult. User-visible state mutations
 *   (index.json / project.json / chat-file moves) are transactional: they
 *   either commit fully or roll back and throw ProjectStoreError — a write
 *   failure must never be reported to the UI as success (DESKTOP-P0-05/06)
 * - JSONL parsing is line-by-line tolerant: bad lines are skipped without
 *   crashing, counted, backed up once per session, and surfaced through
 *   chatRecoveryStats so lost history is visible (DESKTOP-P0-08)
 * - seq is a display-ordering hint, not an identity: every record also gets a
 *   stable `id` UUID, and seq init/merge scans the WHOLE chat file instead of
 *   the most recent 10k display window (DESKTOP-P0-07/09)
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  ChatMeta,
  ChatMessage,
  ProjectData,
  ProjectIndex,
  ProjectInfo,
  ProjectSummary,
  TimelineEntry,
} from './types.js'
import { assertStorageId } from './ipc.js'

// ────────────────────────────────────────────────────────────
// Errors & helpers
// ────────────────────────────────────────────────────────────

/** Typed failure for user-visible mutations that refused to commit. */
export class ProjectStoreError extends Error {
  readonly code: 'io' | 'not-found' | 'invalid'

  constructor(code: 'io' | 'not-found' | 'invalid', message: string) {
    super(message)
    this.name = 'ProjectStoreError'
    this.code = code
  }
}

/** Max stored characters for a single tool input/output field */
const TOOL_FIELD_MAX_CHARS = 16_000

/**
 * Max stored characters for message text. A model that falls into a repetition
 * loop can emit megabytes in one turn; stored whole it would both bloat the
 * JSONL line and be replayed into the model context when the file reopens.
 */
const TEXT_MAX_CHARS = 32_000
const TEXT_TRUNCATED_MARK = '\n\n[truncated]'

function nowIso(): string {
  return new Date().toISOString()
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

/** Atomic write: write to .tmp then rename, so a process interruption can't leave half-written JSON */
function writeJson(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmpPath, filePath)
}

// ────────────────────────────────────────────────────────────
// ProjectStore class
// ────────────────────────────────────────────────────────────

export class ProjectStore {
  private baseDir: string

  constructor(userDataPath: string) {
    this.baseDir = join(userDataPath, 'projects')
  }

  // ── Path helpers ──────────────────────────────────────────

  private indexPath(): string {
    return join(this.baseDir, 'index.json')
  }

  private projectDir(projectId: string): string {
    return join(this.baseDir, assertStorageId(projectId, 'project id'))
  }

  private projectJsonPath(projectId: string): string {
    return join(this.projectDir(projectId), 'project.json')
  }

  private chatsDir(projectId: string): string {
    return join(this.projectDir(projectId), 'chats')
  }

  private chatPath(projectId: string, chatId: string): string {
    return join(this.chatsDir(projectId), `${assertStorageId(chatId, 'chat id')}.jsonl`)
  }

  // ── seq counters (in-memory cache, initialized from a full-file scan on first read) ──

  /** projectId:chatId → current max seq */
  private readonly seqCounters = new Map<string, number>()

  private seqKey(projectId: string, chatId: string): string {
    return `${projectId}:${chatId}`
  }

  private nextSeq(projectId: string, chatId: string): number {
    const key = this.seqKey(projectId, chatId)
    const cur = this.seqCounters.get(key)
    if (cur !== undefined) {
      const next = cur + 1
      this.seqCounters.set(key, next)
      return next
    }
    // Initialization scans the WHOLE file for the max seq. Seeding from the
    // display window (loadChat(limit)) would restart numbering inside long
    // chats and collide with existing seq values (DESKTOP-P0-09).
    const { maxSeq } = this.scanChatFile(this.chatPath(projectId, chatId))
    const next = maxSeq + 1
    this.seqCounters.set(key, next)
    return next
  }

  // ── Chat file scanning (tolerant full read) ──────────────

  /**
   * Full tolerant read of a chat JSONL: every parseable record, the max seq,
   * and the corrupted-line count. Records missing a usable seq get one
   * assigned in memory (monotonic after the running max) instead of being
   * dropped — a partially damaged line must not silently delete the history
   * around it.
   */
  private scanChatFile(filePath: string): {
    records: ChatMessage[]
    maxSeq: number
    corrupted: number
  } {
    const records: ChatMessage[] = []
    let maxSeq = -1
    let corrupted = 0
    try {
      if (!existsSync(filePath)) return { records, maxSeq, corrupted }
      const raw = readFileSync(filePath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as ChatMessage
          if (typeof msg.role === 'string' && typeof msg.text === 'string') {
            const seq =
              typeof msg.seq === 'number' && Number.isSafeInteger(msg.seq) ? msg.seq : maxSeq + 1
            records.push({ ...msg, seq })
            if (seq > maxSeq) maxSeq = seq
          } else {
            corrupted++
          }
        } catch {
          corrupted++
        }
      }
    } catch (err) {
      console.warn('[project-store] scanChatFile read failed:', err)
      corrupted++
    }
    return { records, maxSeq, corrupted }
  }

  // ── Corruption recovery evidence (DESKTOP-P0-08) ─────────

  /** projectId:chatId → recovery evidence for the most recent damaged load */
  private readonly recoveryStats = new Map<
    string,
    { corruptedLines: number; backupPath?: string }
  >()

  /** Copies a damaged JSONL aside once per session so evidence survives rewrites. */
  private noteCorruption(
    projectId: string,
    chatId: string,
    filePath: string,
    corrupted: number,
  ): void {
    if (corrupted <= 0) return
    const key = this.seqKey(projectId, chatId)
    if (this.recoveryStats.has(key)) {
      const prev = this.recoveryStats.get(key)!
      prev.corruptedLines = Math.max(prev.corruptedLines, corrupted)
      return
    }
    let backupPath: string | undefined
    try {
      backupPath = `${filePath}.corrupt-${Date.now()}.bak`
      copyFileSync(filePath, backupPath)
    } catch (err) {
      console.warn('[project-store] corrupt chat backup failed:', err)
      backupPath = undefined
    }
    this.recoveryStats.set(key, {
      corruptedLines: corrupted,
      ...(backupPath ? { backupPath } : {}),
    })
  }

  /**
   * Recovery evidence for one chat: how many JSONL lines were unreadable on the
   * last load and where the pre-repair backup lives. The UI can surface
   * "recovered N messages, M lines were corrupted" from this.
   */
  chatRecoveryStats(
    projectId: string,
    chatId: string,
  ): { corruptedLines: number; backupPath?: string } {
    const key = this.seqKey(projectId, chatId)
    const cached = this.recoveryStats.get(key)
    if (cached) return { ...cached }
    const filePath = this.chatPath(projectId, chatId)
    const { corrupted } = this.scanChatFile(filePath)
    if (corrupted > 0) this.noteCorruption(projectId, chatId, filePath, corrupted)
    const stats = this.recoveryStats.get(key)
    return stats ? { ...stats } : { corruptedLines: corrupted }
  }

  // ── Index read/write ──────────────────────────────────────

  private readIndex(): ProjectIndex {
    return readJson<ProjectIndex>(this.indexPath()) ?? { projects: [], fileMap: {} }
  }

  private writeIndex(index: ProjectIndex): void {
    ensureDir(this.baseDir)
    writeJson(this.indexPath(), index)
  }

  // ── Multi-file transactions (DESKTOP-P0-06) ───────────────

  /**
   * Atomic multi-file commit: every payload is staged as `<path>.tx.tmp`, then
   * all renames run. If any rename fails, files already swapped in are restored
   * from the in-memory snapshot (or deleted when they did not exist before),
   * pending stage files are removed, and ProjectStoreError is thrown —
   * index.json / project.json pairs can no longer end up half-committed.
   */
  private commitTransaction(writes: Array<{ path: string; data: unknown }>): void {
    const snapshots = writes.map((w) => ({
      path: w.path,
      existed: existsSync(w.path),
      prior: existsSync(w.path) ? readFileSync(w.path, 'utf8') : null,
    }))
    const staged: Array<{ target: string; tmp: string }> = []
    try {
      for (const w of writes) {
        ensureDir(dirname(w.path))
        const tmp = `${w.path}.tx.tmp`
        writeFileSync(tmp, JSON.stringify(w.data, null, 2), 'utf8')
        staged.push({ target: w.path, tmp })
      }
    } catch (err) {
      for (const s of staged) {
        try {
          unlinkSync(s.tmp)
        } catch {
          /* best-effort cleanup */
        }
      }
      throw new ProjectStoreError('io', `transaction stage failed: ${errMessage(err)}`)
    }
    const swapped: Array<{ path: string; existed: boolean; prior: string | null }> = []
    try {
      for (const s of staged) {
        renameSync(s.tmp, s.target)
        swapped.push(snapshots.find((snap) => snap.path === s.target)!)
      }
    } catch (err) {
      for (const snap of swapped) {
        try {
          if (snap.existed && snap.prior !== null) writeFileSync(snap.path, snap.prior, 'utf8')
          else if (!snap.existed) unlinkSync(snap.path)
        } catch (restoreErr) {
          console.error('[project-store] transaction restore failed:', restoreErr)
        }
      }
      for (const s of staged) {
        try {
          if (existsSync(s.tmp)) unlinkSync(s.tmp)
        } catch {
          /* best-effort cleanup */
        }
      }
      throw new ProjectStoreError('io', `transaction commit failed: ${errMessage(err)}`)
    }
  }

  // ── Project read/write ────────────────────────────────────

  private readProject(projectId: string): ProjectData | null {
    return readJson<ProjectData>(this.projectJsonPath(projectId))
  }

  private writeProject(data: ProjectData): void {
    writeJson(this.projectJsonPath(data.id), data)
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Ensures the default project exists (id: "default", name: the Chinese "default project" label).
   * Idempotent: returns directly if it already exists.
   */
  ensureDefaultProject(): ProjectData {
    const existing = this.readProject('default')
    if (existing) return existing

    const now = nowIso()
    const data: ProjectData = {
      id: 'default',
      name: 'Default Project',
      createdAt: now,
      updatedAt: now,
      files: [],
    }
    ensureDir(this.projectDir('default'))
    this.writeProject(data)

    const index = this.readIndex()
    if (!index.projects.find((p) => p.id === 'default')) {
      index.projects.unshift({ id: data.id, name: data.name, createdAt: now, updatedAt: now })
      this.writeIndex(index)
    }
    return data
  }

  /**
   * Looks up the projectId by absolute file path.
   * If not found, assign to default and register in fileMap.
   */
  resolveProjectForFile(filePath: string): string {
    this.ensureDefaultProject()
    const index = this.readIndex()
    const existing = index.fileMap[filePath]
    if (existing) return existing

    // Assign to default; fileMap + project.json commit as one transaction so a
    // crash between the two writes is repaired instead of diverging.
    index.fileMap[filePath] = 'default'
    const proj = this.readProject('default')
    if (proj && !proj.files.includes(filePath)) {
      proj.files.push(filePath)
      proj.updatedAt = nowIso()
      this.commitTransaction([
        { path: this.indexPath(), data: index },
        { path: this.projectJsonPath('default'), data: proj },
      ])
    } else {
      this.writeIndex(index)
    }
    return 'default'
  }

  /**
   * Derives a chatId from a file path (first 16 hex chars of sha256).
   * Unsaved files use an externally provided temp id (e.g. "unsaved-<timestamp>").
   * Only a fallback derivation for old data without a mapping; new code uses
   * resolveChatForFile (stable mapping).
   */
  static chatIdForFile(filePath: string): string {
    return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  }

  /** Gets the chatId from the mapping; falls back to the path hash without registering. */
  chatIdForPath(filePath: string): string {
    const index = this.readIndex()
    return index.chatIdByPath?.[filePath] ?? ProjectStore.chatIdForFile(filePath)
  }

  /**
   * Resolves { projectId, chatId } by file path (the core of the resolveChat IPC).
   * The chatId is registered into chatIdByPath on first resolve; from then on,
   * renaming/moving the file only changes the mapping key — the chatId stays
   * stable and history always follows the file.
   */
  resolveChatForFile(filePath: string): { projectId: string; chatId: string } {
    const projectId = this.resolveProjectForFile(filePath)
    const index = this.readIndex()
    const mapped = index.chatIdByPath?.[filePath]
    if (mapped) return { projectId, chatId: mapped }
    const chatId = ProjectStore.chatIdForFile(filePath)
    index.chatIdByPath = { ...(index.chatIdByPath ?? {}), [filePath]: chatId }
    this.writeIndex(index)
    return { projectId, chatId }
  }

  /**
   * Called after a file is renamed/moved on disk: the keys in fileMap,
   * project.files and chatIdByPath are updated accordingly, while the chatId
   * stays the same (history needs no relocation).
   */
  fileRenamed(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return
    const index = this.readIndex()
    const pid = index.fileMap[oldPath]
    const proj = pid !== undefined ? this.readProject(pid) : null
    if (pid !== undefined) {
      delete index.fileMap[oldPath]
      index.fileMap[newPath] = pid
      if (proj) {
        proj.files = proj.files.map((f) => (f === oldPath ? newPath : f))
        proj.updatedAt = nowIso()
      }
    }
    // Old data without a mapping: the chatId was derived from the old path hash; register the mapping under that hash on rename so history keeps up
    const chatId = index.chatIdByPath?.[oldPath] ?? ProjectStore.chatIdForFile(oldPath)
    if (index.chatIdByPath?.[oldPath] !== undefined) delete index.chatIdByPath[oldPath]
    index.chatIdByPath = { ...(index.chatIdByPath ?? {}), [newPath]: chatId }

    if (proj) {
      this.commitTransaction([
        { path: this.indexPath(), data: index },
        { path: this.projectJsonPath(pid!), data: proj },
      ])
    } else {
      this.writeIndex(index)
    }
  }

  /**
   * Buffer for the opening messages of a chat that has no file yet: the file
   * is not created until the first assistant reply arrives, so aborted or
   * failed requests never leave behind an empty record with a lone user
   * message.
   */
  private readonly pendingFirstWrite = new Map<string, ChatMessage[]>()

  /** Flushes buffered opening messages to disk (materialized before rebind: once the file is saved, the opening messages should be kept). */
  private flushPending(projectId: string, chatId: string): void {
    const key = this.seqKey(projectId, chatId)
    const buf = this.pendingFirstWrite.get(key)
    this.pendingFirstWrite.delete(key)
    if (!buf || buf.length === 0) return
    try {
      ensureDir(this.chatsDir(projectId))
      const lines = buf.map((r) => JSON.stringify(r) + '\n').join('')
      appendFileSync(this.chatPath(projectId, chatId), lines, 'utf8')
    } catch (err) {
      console.warn('[project-store] flushPending failed:', err)
    }
  }

  /**
   * Appends one message to the JSONL. Write failures are reported through the
   * returned ProjectStoreResult (and warned) instead of throwing — chat history
   * is best-effort telemetry — but they are never silently swallowed.
   * seq is auto-assigned by the store layer (monotonically increasing); each
   * record also receives a stable `id` UUID.
   * When the record file doesn't exist yet, non-assistant messages are buffered;
   * the file is created and flushed only when the first assistant message arrives.
   */
  appendChatMessage(
    projectId: string,
    chatId: string,
    msg: Omit<ChatMessage, 'seq' | 'ts'> & { ts?: string },
  ): { ok: true; seq: number } | { ok: false; error: string } {
    try {
      const seq = this.nextSeq(projectId, chatId)
      const ts = msg.ts ?? nowIso()
      const text =
        msg.text.length > TEXT_MAX_CHARS
          ? msg.text.slice(0, TEXT_MAX_CHARS) + TEXT_TRUNCATED_MARK
          : msg.text
      const record: ChatMessage = { id: randomUUID(), seq, ts, role: msg.role, text }
      if (msg.fileRef !== undefined) record.fileRef = msg.fileRef
      if (msg.tools && msg.tools.length > 0) {
        // Truncate tool inputs/outputs so one JSONL line can't blow up on a huge payload
        record.tools = msg.tools.map((t) => ({
          ...t,
          ...(t.input !== undefined ? { input: t.input.slice(0, TOOL_FIELD_MAX_CHARS) } : {}),
          ...(t.output !== undefined ? { output: t.output.slice(0, TOOL_FIELD_MAX_CHARS) } : {}),
        }))
      }
      if (msg.attachments !== undefined) record.attachments = msg.attachments

      const key = this.seqKey(projectId, chatId)
      if (msg.role !== 'assistant' && !existsSync(this.chatPath(projectId, chatId))) {
        const buf = this.pendingFirstWrite.get(key) ?? []
        buf.push(record)
        this.pendingFirstWrite.set(key, buf)
        return { ok: true, seq }
      }
      ensureDir(this.chatsDir(projectId))
      const buf = this.pendingFirstWrite.get(key) ?? []
      this.pendingFirstWrite.delete(key)
      const lines = [...buf, record].map((r) => JSON.stringify(r) + '\n').join('')
      appendFileSync(this.chatPath(projectId, chatId), lines, 'utf8')
      return { ok: true, seq }
    } catch (err) {
      console.warn('[project-store] appendChatMessage failed:', err)
      return { ok: false, error: errMessage(err) }
    }
  }

  /**
   * Reads the most recent `limit` messages (in ascending seq order).
   * A bad JSONL line is skipped without crashing, counted, and backed up once
   * (see chatRecoveryStats).
   */
  loadChat(projectId: string, chatId: string, limit = 200): ChatMessage[] {
    try {
      const pending = this.pendingFirstWrite.get(this.seqKey(projectId, chatId)) ?? []
      const filePath = this.chatPath(projectId, chatId)
      const { records, corrupted } = this.scanChatFile(filePath)
      if (corrupted > 0) this.noteCorruption(projectId, chatId, filePath, corrupted)
      const messages = [...pending, ...records]
      // Sort by seq and take the most recent `limit` entries
      messages.sort((a, b) => a.seq - b.seq)
      return messages.slice(-limit)
    } catch {
      return []
    }
  }

  /**
   * Lists metadata of all chats in a project.
   */
  listChats(projectId: string): ChatMeta[] {
    try {
      const dir = this.chatsDir(projectId)
      if (!existsSync(dir)) return []
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      return files.map((f) => {
        const chatId = f.replace(/\.jsonl$/, '')
        const fullPath = join(dir, f)
        let updatedAt = nowIso()
        let approxCount = 0
        try {
          const st = statSync(fullPath)
          updatedAt = st.mtime.toISOString()
          // Estimate: assume an average of 120 bytes per line
          approxCount = Math.round(st.size / 120)
        } catch {
          // use defaults if stat fails
        }
        return { chatId, updatedAt, approxCount }
      })
    } catch {
      return []
    }
  }

  /**
   * Moves chats/<fromId>.jsonl to chats/<toId>.jsonl (possibly across projects).
   * If the target exists, don't overwrite: renumber the source messages' seq and
   * append them at the target's end (old conversations of a same-named file are
   * kept). Both sides are read with a FULL scan — chats longer than the display
   * window keep their entire history through a merge (DESKTOP-P0-07).
   */
  private renameOrMergeChat(
    fromProjectId: string,
    fromId: string,
    toProjectId: string,
    toId: string,
  ): { ok: true; merged: boolean } | { ok: false; error: string } {
    if (fromProjectId === toProjectId && fromId === toId) return { ok: true, merged: false }
    // The source may still have buffered opening messages: materialize them first (once the file is saved, they should be kept)
    this.flushPending(fromProjectId, fromId)
    const oldPath = this.chatPath(fromProjectId, fromId)
    const newPath = this.chatPath(toProjectId, toId)
    let mergedMaxSeq: number | undefined
    let merged = false
    try {
      if (existsSync(oldPath)) {
        ensureDir(dirname(newPath))
        if (!existsSync(newPath)) {
          renameSync(oldPath, newPath)
        } else {
          // Append-then-unlink ordering: a crash between the two duplicates at
          // worst re-appends on the next merge attempt, it never loses history.
          const target = this.scanChatFile(newPath)
          const source = this.scanChatFile(oldPath)
          let seq = target.maxSeq
          const lines = source.records
            .map((m) => JSON.stringify({ ...m, seq: ++seq }) + '\n')
            .join('')
          if (lines) appendFileSync(newPath, lines, 'utf8')
          unlinkSync(oldPath)
          mergedMaxSeq = seq
          merged = true
        }
      }
    } catch (err) {
      console.warn('[project-store] rebindChat merge failed:', err)
      return { ok: false, error: errMessage(err) }
    }

    // Migrate the seq counter (when merged, the renumbered max seq wins)
    const oldKey = this.seqKey(fromProjectId, fromId)
    const curSeq = this.seqCounters.get(oldKey)
    this.seqCounters.delete(oldKey)
    this.seqCounters.delete(this.seqKey(toProjectId, toId))
    const next = mergedMaxSeq ?? curSeq
    if (next !== undefined) {
      this.seqCounters.set(this.seqKey(toProjectId, toId), next)
    }
    return { ok: true, merged }
  }

  /**
   * Renames the JSONL file (called after an unsaved file is first written to disk):
   * chats/<tempId>.jsonl → chats/<newChatId>.jsonl (if the target exists, merge by continuing seq).
   */
  rebindChat(projectId: string, tempId: string, newChatId: string): void {
    this.renameOrMergeChat(projectId, tempId, projectId, newChatId)
  }

  /**
   * After an unsaved session first gets a real file path: register in fileMap,
   * compute the chatId from the path, and move the temp JSONL into the target project.
   * Returns the new { projectId, chatId } for the renderer to update its references.
   */
  rebindChatToFile(
    tempProjectId: string,
    tempChatId: string,
    filePath: string,
  ): { projectId: string; chatId: string } {
    const { projectId, chatId } = this.resolveChatForFile(filePath)
    this.renameOrMergeChat(tempProjectId, tempChatId, projectId, chatId)
    return { projectId, chatId }
  }

  /**
   * Gets project info.
   */
  getProject(projectId: string): ProjectData | null {
    return this.readProject(projectId)
  }

  /**
   * Lists all projects.
   */
  listProjects(): ProjectInfo[] {
    return this.readIndex().projects
  }

  // ── Crash-recovery repair (DESKTOP-P0-06) ─────────────────

  /**
   * Reconciles index.json ↔ <project>/project.json ↔ fileMap after a crash
   * left the trio inconsistent. Idempotent and cheap (readdir + stat);
   * returns a human-readable repair log for diagnostics.
   */
  repairConsistency(): string[] {
    this.ensureDefaultProject()
    const repairs: string[] = []
    const index = this.readIndex()
    let indexDirty = false

    // 1. Drop index entries whose project directory is gone entirely
    const liveIds = new Set<string>()
    const liveProjects: ProjectInfo[] = []
    for (const info of index.projects) {
      if (existsSync(this.projectJsonPath(info.id))) {
        liveProjects.push(info)
        liveIds.add(info.id)
      } else if (
        !existsSync(this.projectDir(info.id)) ||
        readdirSync(this.projectDir(info.id)).length === 0
      ) {
        // directory missing or empty: nothing to recover, the entry is stale
        repairs.push(`removed stale index entry: ${info.id}`)
        indexDirty = true
      } else {
        // directory exists without project.json: keep the entry (data may be mid-crash)
        liveProjects.push(info)
        liveIds.add(info.id)
      }
    }

    // 2. Re-register orphaned project directories that carry a project.json
    try {
      for (const entry of readdirSync(this.baseDir)) {
        if (entry.startsWith('.') || liveIds.has(entry)) continue
        const data = this.readProject(entry)
        if (data && data.id === entry) {
          liveProjects.push({
            id: data.id,
            name: data.name,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
          })
          liveIds.add(entry)
          indexDirty = true
          repairs.push(`re-registered orphaned project: ${entry}`)
        }
      }
    } catch {
      /* no baseDir yet */
    }

    // 3. fileMap entries pointing at dead projects return to default
    for (const [filePath, pid] of Object.entries(index.fileMap)) {
      if (pid !== 'default' && !liveIds.has(pid)) {
        index.fileMap[filePath] = 'default'
        indexDirty = true
        repairs.push(`file reassigned to default: ${basename(filePath)}`)
      }
    }

    if (indexDirty) {
      index.projects = liveProjects
      if (!index.projects.some((p) => p.id === 'default')) {
        const def = this.readProject('default')
        if (def) {
          index.projects.unshift({
            id: 'default',
            name: def.name,
            createdAt: def.createdAt,
            updatedAt: def.updatedAt,
          })
        }
      }
      this.writeIndex(index)
    }
    return repairs
  }

  // ── P1 extended API ────────────────────────────────────────

  /**
   * Lists all projects (with file count + last active time).
   * Runs the crash-consistency repair first so the listing never shows a
   * half-deleted or half-moved project.
   */
  listProjectsSummary(): ProjectSummary[] {
    this.repairConsistency()
    const index = this.readIndex()
    return index.projects.map((info) => {
      const fileCount = this.listProjectFiles(info.id).length
      // Take the max of project.json updatedAt and all chat mtimes
      let lastActiveAt = info.updatedAt
      const chats = this.listChats(info.id)
      for (const c of chats) {
        if (c.updatedAt > lastActiveAt) lastActiveAt = c.updatedAt
      }
      return {
        ...info,
        fileCount,
        lastActiveAt,
        isDefault: info.id === 'default',
      }
    })
  }

  /**
   * Lists files that currently exist for a project. Stored paths are historical
   * records and may outlive files deleted or moved outside the app.
   */
  listProjectFiles(projectId: string): string[] {
    const proj = this.readProject(projectId)
    if (!proj) return []
    return [...new Set(proj.files)].filter((filePath) => existsSync(filePath))
  }

  /**
   * Creates a project (name must be non-empty; id is the first 12 hex chars of
   * sha256(name) plus a timestamp suffix to avoid collisions).
   * Returns the newly created ProjectData.
   */
  createProject(name: string): ProjectData {
    const trimmed = name.trim()
    if (!trimmed) throw new ProjectStoreError('invalid', 'Project name cannot be empty')
    const now = nowIso()
    // Generate a stable yet unique id
    const hash = createHash('sha256')
      .update(trimmed + now)
      .digest('hex')
      .slice(0, 12)
    const id = `proj-${hash}`
    const data: ProjectData = {
      id,
      name: trimmed,
      createdAt: now,
      updatedAt: now,
      files: [],
    }
    ensureDir(this.projectDir(id))
    const index = this.readIndex()
    // Append at the end (default always stays first)
    index.projects.push({ id, name: trimmed, createdAt: now, updatedAt: now })
    this.commitTransaction([
      { path: this.projectJsonPath(id), data },
      { path: this.indexPath(), data: index },
    ])
    return data
  }

  /**
   * Renames a project (the default project cannot be renamed).
   * project.json and index.json commit as one transaction.
   */
  renameProject(id: string, name: string): void {
    if (id === 'default')
      throw new ProjectStoreError('invalid', 'The default project cannot be renamed')
    const trimmed = name.trim()
    if (!trimmed) throw new ProjectStoreError('invalid', 'Project name cannot be empty')
    const proj = this.readProject(id)
    if (!proj) throw new ProjectStoreError('not-found', `Project does not exist: ${id}`)
    const now = nowIso()
    proj.name = trimmed
    proj.updatedAt = now
    const index = this.readIndex()
    const entry = index.projects.find((p) => p.id === id)
    if (entry) {
      entry.name = trimmed
      entry.updatedAt = now
    }
    this.commitTransaction([
      { path: this.projectJsonPath(id), data: proj },
      { path: this.indexPath(), data: index },
    ])
  }

  /**
   * Soft-deletes a project:
   * 1. Move the directory into projects/.trash/<id>-<ts>/ — a failed move
   *    aborts the whole delete (the old code removed the index entry anyway,
   *    orphaning the directory)
   * 2. Reassign all of its files in fileMap back to default
   * 3. Remove the project from index.projects
   * Steps 2+3 commit as one transaction.
   * The default project cannot be deleted.
   */
  deleteProject(id: string): void {
    if (id === 'default')
      throw new ProjectStoreError('invalid', 'The default project cannot be deleted')
    const proj = this.readProject(id)
    if (!proj) throw new ProjectStoreError('not-found', `Project does not exist: ${id}`)
    this.ensureDefaultProject()

    // 1. Soft-delete the directory
    const src = this.projectDir(id)
    const ts = Date.now()
    const trashDir = join(this.baseDir, '.trash')
    ensureDir(trashDir)
    const dst = join(trashDir, `${id}-${ts}`)
    if (existsSync(src)) {
      try {
        renameSync(src, dst)
      } catch (err) {
        throw new ProjectStoreError('io', `move to trash failed: ${errMessage(err)}`)
      }
    }

    // 2+3. fileMap reassignment + index update commit as one transaction
    const index = this.readIndex()
    const movedFiles: string[] = []
    for (const [filePath, pid] of Object.entries(index.fileMap)) {
      if (pid === id) {
        index.fileMap[filePath] = 'default'
        movedFiles.push(filePath)
      }
    }
    index.projects = index.projects.filter((p) => p.id !== id)

    const defaultProj = movedFiles.length > 0 ? this.readProject('default') : null
    if (defaultProj) {
      for (const f of movedFiles) {
        if (!defaultProj.files.includes(f)) defaultProj.files.push(f)
      }
      defaultProj.updatedAt = nowIso()
      this.commitTransaction([
        { path: this.indexPath(), data: index },
        { path: this.projectJsonPath('default'), data: defaultProj },
      ])
    } else {
      this.writeIndex(index)
    }
  }

  /**
   * Moves a file from its current project into a target project:
   * 1. fileMap + both project.json files commit as ONE transaction (the old
   *    sequential writes could leave the file registered in two projects after
   *    a mid-sequence failure)
   * 2. The chat's JSONL then moves best-effort: a failed move leaves the chat
   *    under the old project directory (recoverable on the next move) instead
   *    of corrupting the mapping.
   */
  moveFileToProject(filePath: string, targetProjectId: string): void {
    this.ensureDefaultProject()
    const index = this.readIndex()
    const fromProjectId = index.fileMap[filePath] ?? 'default'

    if (fromProjectId === targetProjectId) return // nothing to move

    // The target project must exist
    const targetProj = this.readProject(targetProjectId)
    if (!targetProj)
      throw new ProjectStoreError('not-found', `Target project does not exist: ${targetProjectId}`)

    // 1. Metadata transaction
    index.fileMap[filePath] = targetProjectId
    const fromProj = this.readProject(fromProjectId)
    if (fromProj) {
      fromProj.files = fromProj.files.filter((f) => f !== filePath)
      fromProj.updatedAt = nowIso()
    }
    if (!targetProj.files.includes(filePath)) targetProj.files.push(filePath)
    targetProj.updatedAt = nowIso()

    const writes: Array<{ path: string; data: unknown }> = [
      { path: this.indexPath(), data: index },
      { path: this.projectJsonPath(targetProjectId), data: targetProj },
    ]
    if (fromProj) writes.push({ path: this.projectJsonPath(fromProjectId), data: fromProj })
    this.commitTransaction(writes)

    // 2. Chat move (best-effort, after the metadata commit)
    const chatId = this.chatIdForPath(filePath)
    this.flushPending(fromProjectId, chatId)
    const srcChatPath = this.chatPath(fromProjectId, chatId)
    const dstChatPath = this.chatPath(targetProjectId, chatId)
    try {
      if (existsSync(srcChatPath)) {
        ensureDir(this.chatsDir(targetProjectId))
        renameSync(srcChatPath, dstChatPath)
      }
    } catch (err) {
      console.warn('[project-store] moveFileToProject chat rename failed:', err)
    }

    // 3. Migrate the seq counter cache
    const oldKey = this.seqKey(fromProjectId, chatId)
    const newKey = this.seqKey(targetProjectId, chatId)
    const cur = this.seqCounters.get(oldKey)
    this.seqCounters.delete(oldKey)
    if (cur !== undefined) this.seqCounters.set(newKey, cur)
  }

  /**
   * Aggregates messages from all chats in a project, sorted by ts descending,
   * returning the most recent `limit` entries. Each entry includes the file path
   * (reverse-looked-up from fileMap by chatId), role, and preview text.
   */
  getProjectTimeline(projectId: string, limit = 20): TimelineEntry[] {
    const index = this.readIndex()
    // Build the reverse chatId → filePath map (files in this project only); mapping wins, old data falls back to the path hash
    const chatToFile = new Map<string, string>()
    for (const [filePath, pid] of Object.entries(index.fileMap)) {
      if (pid === projectId) {
        const chatId = index.chatIdByPath?.[filePath] ?? ProjectStore.chatIdForFile(filePath)
        chatToFile.set(chatId, filePath)
      }
    }

    const entries: TimelineEntry[] = []
    const chats = this.listChats(projectId)
    for (const { chatId } of chats) {
      const filePath = chatToFile.get(chatId) ?? ''
      const msgs = this.loadChat(projectId, chatId, 200)
      for (const msg of msgs) {
        entries.push({
          filePath,
          fileName: filePath ? basename(filePath) : chatId,
          chatId,
          ts: msg.ts,
          role: msg.role,
          preview: msg.text.slice(0, 120),
          seq: msg.seq,
        })
      }
    }

    // Sort by ts descending
    entries.sort((a, b) => {
      if (b.ts > a.ts) return 1
      if (b.ts < a.ts) return -1
      return b.seq - a.seq
    })
    return entries.slice(0, limit)
  }
}
