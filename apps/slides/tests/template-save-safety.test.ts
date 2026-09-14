/**
 * GOAL §10: Save-As protection — a generated deck must never overwrite the
 * user's original template. Canonical (realpath) comparison handles Windows
 * case differences, `..` segments, and existing files via hardlinks/symlinks.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSameRealFile } from '../src/main/template-save-safety'

describe('isSameRealFile (GOAL §10)', () => {
  it('flags the exact same path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-safety-'))
    const p = join(dir, 'template.pptx')
    writeFileSync(p, 'x')
    expect(isSameRealFile(p, p)).toBe(true)
  })

  it('flags case-insensitive matches on Windows-style paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-safety-'))
    const p = join(dir, 'Template.PPTX')
    writeFileSync(p, 'x')
    expect(isSameRealFile(p, p.toUpperCase())).toBe(true)
    expect(isSameRealFile(p, p.toLowerCase())).toBe(true)
  })

  it('flags different spellings of the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-safety-'))
    const a = join(dir, 'sub', 'template.pptx')
    const b = join(dir, 'sub', '..', 'sub', 'template.pptx')
    expect(isSameRealFile(a, b)).toBe(true)
  })

  it('does not flag genuinely different files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-safety-'))
    const a = join(dir, 'template.pptx')
    const b = join(dir, 'output.pptx')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    expect(isSameRealFile(a, b)).toBe(false)
  })

  it('is symmetric and works for not-yet-existing outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-safety-'))
    const a = join(dir, 'template.pptx')
    writeFileSync(a, 'a')
    const out = join(dir, 'new-output.pptx')
    expect(isSameRealFile(out, a)).toBe(false)
    expect(isSameRealFile(a, out)).toBe(false)
  })

  it('resolve fallback agreement holds for plain relative paths', () => {
    expect(isSameRealFile(resolve('x.pptx'), resolve('x.pptx'))).toBe(true)
  })
})
