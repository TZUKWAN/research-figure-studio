/**
 * IPC interface type definitions (shared by the renderer and main processes).
 * No Electron dependency; importable from the renderer.
 */
import type {
  ChatAttachment,
  ChatMessage,
  ChatMeta,
  ProjectSummary,
  TimelineEntry,
  ToolActivity,
} from './types.js'

export type { ChatAttachment, ChatMessage, ChatMeta, ProjectSummary, TimelineEntry, ToolActivity }

const STORAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const CHAT_LIMIT_MAX = 10_000

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function invalidArgs(operation: string): never {
  throw new TypeError(`Invalid ${operation} args`)
}

export function isStorageId(value: unknown): value is string {
  return typeof value === 'string' && STORAGE_ID_RE.test(value)
}

export function assertStorageId(value: unknown, label: string): string {
  if (!isStorageId(value)) throw new Error(`Invalid ${label}`)
  return value
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isToolActivity(value: unknown): value is ToolActivity {
  const tool = asRecord(value)
  return (
    tool !== null &&
    typeof tool.name === 'string' &&
    typeof tool.summary === 'string' &&
    (tool.isError === undefined || typeof tool.isError === 'boolean') &&
    isOptionalString(tool.input) &&
    isOptionalString(tool.output)
  )
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  const attachment = asRecord(value)
  const sizeBytes = attachment?.sizeBytes
  return (
    attachment !== null &&
    typeof attachment.name === 'string' &&
    isOptionalString(attachment.path) &&
    isOptionalString(attachment.ext) &&
    (sizeBytes === undefined ||
      (typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0))
  )
}

export function assertResolveChatArgs(value: unknown): ResolveChatArgs {
  const args = asRecord(value)
  if (
    args === null ||
    !Object.prototype.hasOwnProperty.call(args, 'filePath') ||
    (args.filePath !== null && (typeof args.filePath !== 'string' || args.filePath.length === 0)) ||
    (args.tempChatId !== undefined && !isStorageId(args.tempChatId))
  ) {
    invalidArgs('resolveChat')
  }
  return args as unknown as ResolveChatArgs
}

export function assertAppendChatArgs(value: unknown): AppendChatArgs {
  const args = asRecord(value)
  if (
    args === null ||
    !isStorageId(args.projectId) ||
    !isStorageId(args.chatId) ||
    (args.role !== 'user' && args.role !== 'assistant') ||
    typeof args.text !== 'string' ||
    (args.tools !== undefined &&
      (!Array.isArray(args.tools) || !args.tools.every((tool) => isToolActivity(tool)))) ||
    (args.attachments !== undefined &&
      (!Array.isArray(args.attachments) ||
        !args.attachments.every((attachment) => isChatAttachment(attachment))))
  ) {
    invalidArgs('appendChat')
  }
  return args as unknown as AppendChatArgs
}

export function assertLoadChatArgs(value: unknown): LoadChatArgs {
  const args = asRecord(value)
  const limit = args?.limit
  if (
    args === null ||
    !isStorageId(args.projectId) ||
    !isStorageId(args.chatId) ||
    (limit !== undefined &&
      (typeof limit !== 'number' ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > CHAT_LIMIT_MAX))
  ) {
    invalidArgs('loadChat')
  }
  return args as unknown as LoadChatArgs
}

export function assertRebindChatArgs(value: unknown): RebindChatArgs {
  const args = asRecord(value)
  const hasNewChatId = args?.newChatId !== undefined
  const hasNewFilePath = args?.newFilePath !== undefined
  if (
    args === null ||
    !isStorageId(args.projectId) ||
    !isStorageId(args.tempChatId) ||
    hasNewChatId === hasNewFilePath ||
    (hasNewChatId && !isStorageId(args.newChatId)) ||
    (hasNewFilePath && (typeof args.newFilePath !== 'string' || args.newFilePath.length === 0))
  ) {
    invalidArgs('rebindChat')
  }
  return args as unknown as RebindChatArgs
}

export interface AppendChatArgs {
  projectId: string
  chatId: string
  role: 'user' | 'assistant'
  text: string
  tools?: ToolActivity[]
  attachments?: ChatAttachment[]
}

export interface LoadChatArgs {
  projectId: string
  chatId: string
  limit?: number
}

export interface ResolveChatArgs {
  /** Absolute path of the currently open file; null means an unsaved new file */
  filePath: string | null
  /** Temp chatId for unsaved files, e.g. "unsaved-<timestamp>" */
  tempChatId?: string
  /** Sheets mode: look up the file path by sessionId (handled in the main process) */
  sessionId?: string
}

export interface ResolveChatResult {
  projectId: string
  chatId: string
}

export interface RebindChatArgs {
  projectId: string
  tempChatId: string
  /** Specify the new chatId directly; one of newChatId / newFilePath / sessionId */
  newChatId?: string
  /** File path where the unsaved session first hit disk: the main process derives the chatId from it and registers fileMap */
  newFilePath?: string
  /** Sheets mode: the renderer can't get the path, so it passes sessionId for the main process to look up and rebind */
  sessionId?: string
}

// ── P1 extensions ──────────────────────────────────────────

export interface CreateProjectArgs {
  name: string
}

export interface RenameProjectArgs {
  id: string
  name: string
}

export interface DeleteProjectArgs {
  id: string
}

export interface MoveFileArgs {
  filePath: string
  projectId: string
}

export interface GetTimelineArgs {
  projectId: string
  limit?: number
}

/** Project storage API the main process exposes to the renderer */
export interface ProjectApi {
  /**
   * Resolves projectId and chatId from a file path.
   * When filePath is null, returns the default project + tempChatId (if provided).
   */
  resolveChat(args: ResolveChatArgs): Promise<ResolveChatResult>
  /** Appends one message to the JSONL */
  appendChat(args: AppendChatArgs): Promise<void>
  /** Reads the most recent `limit` messages */
  loadChat(args: LoadChatArgs): Promise<ChatMessage[]>
  /** Renames the JSONL file (called after the file first hits disk); returns the new projectId/chatId */
  rebindChat(args: RebindChatArgs): Promise<ResolveChatResult>
  // ── P1 extensions ──
  /** Lists all projects (with file count + last active time) */
  listProjects(): Promise<ProjectSummary[]>
  /** Creates a project */
  createProject(args: CreateProjectArgs): Promise<ProjectSummary>
  /** Renames a project */
  renameProject(args: RenameProjectArgs): Promise<void>
  /** Soft-deletes a project (directory moved into .trash) */
  deleteProject(args: DeleteProjectArgs): Promise<void>
  /** Moves a file into the given project */
  moveFile(args: MoveFileArgs): Promise<void>
  /** Gets the project timeline */
  getTimeline(args: GetTimelineArgs): Promise<TimelineEntry[]>
}
