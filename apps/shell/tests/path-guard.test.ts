import { describe, expect, it } from 'vitest'

import { sanitizeFileName } from '../src/main/path-guard'

// Negative tests for renderer-supplied file NAMES before they are joined onto
// a directory (audit DESKTOP-P0-04 / IPC negative matrix). Path-level checks
// (absolute/extension/regular-file) are covered by checkFilePath tests in
// @genoffice/electron-utils.

describe('sanitizeFileName', () => {
  it('accepts ordinary names, including unicode and spaces inside the name', () => {
    expect(sanitizeFileName('deck.pptx')).toEqual({ ok: true, name: 'deck.pptx' })
    expect(sanitizeFileName('  长江文化研究.pptx  ')).toEqual({
      ok: true,
      name: '长江文化研究.pptx',
    })
    expect(sanitizeFileName('my deck (v2) final.pptx')).toEqual({
      ok: true,
      name: 'my deck (v2) final.pptx',
    })
  })

  it('rejects path traversal and separators (IPC negative)', () => {
    expect(sanitizeFileName('../escape.pptx').ok).toBe(false)
    expect(sanitizeFileName('..\\escape.pptx').ok).toBe(false)
    expect(sanitizeFileName('a/b.pptx').ok).toBe(false)
    expect(sanitizeFileName('a\\b.pptx').ok).toBe(false)
    expect(sanitizeFileName('C:evil.pptx').ok).toBe(false)
    expect(sanitizeFileName('..')).toEqual({ ok: false })
    expect(sanitizeFileName('.')).toEqual({ ok: false })
  })

  it('rejects Windows-illegal characters and control characters', () => {
    for (const bad of ['a*b.pptx', 'a?b.pptx', 'a"b.pptx', 'a<b.pptx', 'a>b.pptx', 'a|b.pptx']) {
      expect(sanitizeFileName(bad).ok).toBe(false)
    }
    expect(sanitizeFileName('a\u0000b.pptx').ok).toBe(false)
    expect(sanitizeFileName('a\u001fb.pptx').ok).toBe(false)
  })

  it('rejects trailing dot lookalikes and reserved device names', () => {
    // trailing spaces are trimmed first (pre-existing trim behavior), but a
    // trailing DOT survives trimming and would create a Windows lookalike name
    expect(sanitizeFileName('deck.pptx.').ok).toBe(false)
    expect(sanitizeFileName('deck.pptx ').ok).toBe(true) // trimmed to 'deck.pptx' — unchanged original behavior
    expect(sanitizeFileName('CON.pptx').ok).toBe(false)
    expect(sanitizeFileName('nul').ok).toBe(false)
    expect(sanitizeFileName('com1.pptx').ok).toBe(false)
    expect(sanitizeFileName('lpt9.pptx').ok).toBe(false)
  })

  it('rejects non-strings, empties, and overlong names', () => {
    expect(sanitizeFileName(42).ok).toBe(false)
    expect(sanitizeFileName(null).ok).toBe(false)
    expect(sanitizeFileName(undefined).ok).toBe(false)
    expect(sanitizeFileName('').ok).toBe(false)
    expect(sanitizeFileName('   ').ok).toBe(false)
    expect(sanitizeFileName('x'.repeat(201)).ok).toBe(false)
    expect(sanitizeFileName('x'.repeat(200)).ok).toBe(true)
  })
})
