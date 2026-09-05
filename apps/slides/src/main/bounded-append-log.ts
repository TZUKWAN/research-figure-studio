/**
 * Size-bounded append-only diagnostic logs (audit DESKTOP-P1-11).
 *
 * Persistent diagnostics (userData/export-diag.log, ai run-failure records)
 * used to grow without limit: a user retrying a failing export for months
 * would ship megabytes of stale evidence inside their profile. The tail is
 * preserved on rotation so a single runaway session can't evict the earlier
 * evidence a bug report depends on.
 *
 * Never throws: diagnostics must not break the code path being diagnosed.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const DIAG_LOG_MAX_BYTES = 256 * 1024
export const DIAG_LOG_KEEP_BYTES = 128 * 1024

function rotateKeepingTail(filePath: string, keepBytes: number): void {
  const raw = readFileSync(filePath, 'utf8')
  // Start the retained slice at a line boundary so the first kept entry is whole
  const tail = raw.length > keepBytes ? raw.slice(raw.length - keepBytes) : raw
  const trimmed = tail.replace(/^.*\n/, '')
  const tmpPath = `${filePath}.rotate-tmp`
  writeFileSync(tmpPath, trimmed, 'utf8')
  renameSync(tmpPath, filePath)
}

/**
 * Appends one (already-bounded) line to a diagnostic log file, rotating the
 * file when it exceeds maxBytes and keeping roughly the newest keepBytes.
 */
export function appendBoundedLine(
  filePath: string,
  line: string,
  maxBytes = DIAG_LOG_MAX_BYTES,
  keepBytes = DIAG_LOG_KEEP_BYTES,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
      rotateKeepingTail(filePath, keepBytes)
    }
    appendFileSync(filePath, `${line}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the export path */
  }
}
