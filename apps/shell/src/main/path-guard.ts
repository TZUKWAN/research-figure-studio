/**
 * File-name sanitization for renderer-supplied save/rename targets
 * (audit DESKTOP-P0-04). Complements checkFilePath (electron-utils): that
 * validates an incoming PATH; this validates a bare NAME before it is ever
 * joined onto a directory, so traversal (`..`, separators) and Windows-reserved
 * names are rejected at the boundary.
 */

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

export type FileNameCheck = { ok: true; name: string } | { ok: false }

/**
 * Accepts a plain display name only: no path separators, no Windows-illegal
 * characters, no dot/dot-dot, no trailing dot/space (Windows silently strips
 * those, enabling lookalike collisions), and no reserved device names.
 */
export function sanitizeFileName(value: unknown, maxLength = 200): FileNameCheck {
  if (typeof value !== 'string') return { ok: false }
  const name = value.trim()
  if (name.length === 0 || name.length > maxLength) return { ok: false }
  // eslint-disable-next-line no-control-regex
  if (/[\0\u0001-\u001f]/.test(name)) return { ok: false }
  if (/[\\/:*?"<>|]/.test(name)) return { ok: false }
  if (name === '.' || name === '..') return { ok: false }
  if (name.endsWith('.') || name.endsWith(' ')) return { ok: false }
  if (WINDOWS_RESERVED.has(name.split('.')[0]!.toUpperCase())) return { ok: false }
  return { ok: true, name }
}
