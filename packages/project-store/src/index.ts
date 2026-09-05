export { ProjectStore, ProjectStoreError } from './store.js'
export type {
  ChatMessage,
  ChatMeta,
  ChatRecoveryStats,
  ProjectStoreResult,
  ProjectData,
  ProjectIndex,
  ProjectInfo,
  ProjectSummary,
  TimelineEntry,
  ToolActivity,
} from './types.js'
export type {
  AppendChatArgs,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from './ipc.js'
export {
  assertAppendChatArgs,
  assertLoadChatArgs,
  assertRebindChatArgs,
  assertResolveChatArgs,
  assertStorageId,
  CHAT_LIMIT_MAX,
  isStorageId,
} from './ipc.js'
