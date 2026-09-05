/// Runtime validation for IPC handler arguments and IPC sender identity.
///
/// TypeScript types on `ipcMain.handle` callbacks are compile-time only: every
/// payload crossing the preload boundary is untrusted data at runtime (a
/// compromised renderer can invoke any channel with any value). Handlers that
/// touch the file system, persisted state, or external processes must validate
/// on the first line — types never substitute for runtime checks.
///
/// The validators are dependency-light (node:path / node:fs only, no electron
/// import) so they run in unit tests on every CI platform. Sender checks take
/// the packaged/dev mode explicitly instead of reading `app.isPackaged`, for
/// the same reason.

import { statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'

// ────────────────────────────────────────────────────────────
// Primitive validators (throwing style: call on the first line of a handler)
// ────────────────────────────────────────────────────────────

export function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid ${label}: expected string`)
  return value
}

/** Non-empty string with a hard character cap (message text, names, ids…). */
export function assertBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { minLength?: number } = {},
): string {
  const min = options.minLength ?? 1
  if (typeof value !== 'string' || value.length < min || value.length > maxLength) {
    throw new TypeError(`Invalid ${label}: expected string of ${min}..${maxLength} chars`)
  }
  return value
}

export function assertSafeInt(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {},
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max)
  ) {
    const range =
      options.min !== undefined || options.max !== undefined
        ? ` in [${options.min ?? '-inf'}, ${options.max ?? '+inf'}]`
        : ''
    throw new TypeError(`Invalid ${label}: expected safe integer${range}`)
  }
  return value
}

export function assertEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`Invalid ${label}: expected one of ${allowed.join(' | ')}`)
  }
  return value as T
}

export function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Invalid ${label}: expected boolean`)
  return value
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}: expected object`)
  }
  return value as Record<string, unknown>
}

export function assertStringArray(
  value: unknown,
  label: string,
  options: { maxItems?: number; maxLength?: number } = {},
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`Invalid ${label}: expected array`)
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new TypeError(`Invalid ${label}: more than ${options.maxItems} items`)
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || (options.maxLength !== undefined && item.length > options.maxLength)) {
      throw new TypeError(`Invalid ${label}[${i}]: expected bounded string`)
    }
    return item
  })
}

// ────────────────────────────────────────────────────────────
// URL policy
// ────────────────────────────────────────────────────────────

/** `https-only` for remote content fetched on behalf of the renderer; BYOK provider endpoints may use plain http on loopback. */
export type UrlPolicy = 'https-only' | 'https-or-local-http'

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
}

export function assertHttpUrl(value: unknown, label: string, policy: UrlPolicy): string {
  const raw = assertString(value, label)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(`Invalid ${label}: not a URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`Invalid ${label}: only http(s) URLs are allowed`)
  }
  // https-only rejects every plain-http target; https-or-local-http admits
  // loopback http (local LLM servers, dev endpoints) and nothing else.
  const insecure = url.protocol !== 'https:'
  if (insecure && (policy === 'https-only' || !isLoopbackHost(url.hostname))) {
    throw new TypeError(`Invalid ${label}: insecure http is only allowed for local endpoints`)
  }
  if (raw.length > 2048) throw new TypeError(`Invalid ${label}: URL too long`)
  return raw
}

// ────────────────────────────────────────────────────────────
// File path checks (shell file operations)
// ────────────────────────────────────────────────────────────

export interface FilePathCheckOptions {
  /** Allowed extensions, lowercase without dot (e.g. ['pptx']). Empty/omitted = any. */
  extensions?: readonly string[]
  /** Path must exist and resolve to a regular file (symlinks are followed). */
  mustExist?: boolean
  maxPathLength?: number
}

export type FilePathCheckResult =
  | { ok: true; resolved: string }
  | {
      ok: false
      reason: 'bad-type' | 'empty' | 'not-absolute' | 'too-long' | 'bad-ext' | 'missing' | 'not-file'
    }

/**
 * Canonicalized existence/extension/type check for a renderer-supplied path.
 *
 * Design constraints (audit DESKTOP-P0-04):
 * - Always resolves to an absolute path; relative input is rejected, not joined.
 * - Follows symlinks on purpose: the product model references user files that
 *   may legitimately live behind links. `mustExist` therefore validates the
 *   *target*, not the link.
 * - Directories (or any non-regular file, e.g. devices, FIFOs, reparse points
 *   that resolve to non-files) are rejected when `mustExist` is set — a
 *   folder named `deck.pptx` must never be renamed, duplicated, or trashed.
 * - Path length is capped (Windows MAX_PATH interactions).
 */
export function checkFilePath(value: unknown, options: FilePathCheckOptions = {}): FilePathCheckResult {
  if (typeof value !== 'string') return { ok: false, reason: 'bad-type' }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty' }
  // NUL and control characters never appear in legitimate paths
  // eslint-disable-next-line no-control-regex
  if (/[\0\u0001-\u001f]/.test(trimmed)) return { ok: false, reason: 'bad-type' }
  if (!isAbsolute(trimmed)) return { ok: false, reason: 'not-absolute' }
  const maxLen = options.maxPathLength ?? 4096
  if (trimmed.length > maxLen) return { ok: false, reason: 'too-long' }
  const resolved = resolve(trimmed)
  const ext = extname(resolved).slice(1).toLowerCase()
  if (options.extensions && options.extensions.length > 0 && !options.extensions.includes(ext)) {
    return { ok: false, reason: 'bad-ext' }
  }
  if (options.mustExist) {
    let stat
    try {
      stat = statSync(resolved)
    } catch {
      return { ok: false, reason: 'missing' }
    }
    if (!stat.isFile()) return { ok: false, reason: 'not-file' }
  }
  return { ok: true, resolved }
}

// ────────────────────────────────────────────────────────────
// IPC sender authorization (audit DESKTOP-P0-03)
// ────────────────────────────────────────────────────────────

/**
 * Structural subset of Electron's IpcMainInvokeEvent/IpcMainEvent so this
 * module stays unit-testable without loading electron.
 */
export interface TrustedSenderEvent {
  sender: { isDestroyed(): boolean; isCrashed?(): boolean; getURL?(): string }
  senderFrame?: { url: string } | null
}

export interface SenderTrustOptions {
  /** Pass `app.isPackaged`. Unpacked runs may load renderers from a dev server. */
  packaged: boolean
  /**
   * Extra origins accepted in unpacked runs (dev renderer servers, e.g.
   * `http://localhost:5175`). Ignored when packaged. Loopback http on any port
   * is accepted by default in unpacked runs.
   */
  devOrigins?: readonly string[]
}

/**
 * True when `url` is app content: a bundled file:// renderer, or a dev-server
 * origin in an unpacked run. Everything else (remote navigation, hostile
 * frames) is rejected as an IPC sender.
 */
export function isTrustedRendererUrl(rawUrl: string, options: SenderTrustOptions): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === 'file:') return true
  if (options.packaged) return false
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // An explicit devOrigins list is a whitelist (it replaces the default
  // any-loopback rule), so a stray port like :3001 does not pass by accident.
  if (options.devOrigins && options.devOrigins.length > 0) {
    return options.devOrigins.includes(url.origin)
  }
  return isLoopbackHost(url.hostname)
}

/** True when the event's sender is a live renderer frame hosting app content. */
export function isTrustedIpcSender(event: TrustedSenderEvent, options: SenderTrustOptions): boolean {
  const sender = event?.sender
  if (!sender || typeof sender.isDestroyed !== 'function' || sender.isDestroyed()) return false
  if (typeof sender.isCrashed === 'function' && sender.isCrashed()) return false
  const url =
    (event.senderFrame && typeof event.senderFrame.url === 'string' && event.senderFrame.url) ||
    (typeof sender.getURL === 'function' ? sender.getURL() : '')
  if (!url) return false
  return isTrustedRendererUrl(url, options)
}

/** Fail-closed variant: throws so destructive handlers never act on a hostile sender. */
export function assertTrustedIpcSender(
  event: TrustedSenderEvent,
  options: SenderTrustOptions,
  label = 'ipc',
): void {
  if (!isTrustedIpcSender(event, options)) {
    throw new Error(`Untrusted IPC sender rejected on ${label}`)
  }
}
