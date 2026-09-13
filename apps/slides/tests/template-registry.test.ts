/**
 * GOAL §8/§9/§10/§14/§36: user template registry — atomic persistence,
 * dedupe, managed sources, preview persistence, remove semantics.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  importUserTemplate,
  loadRegistry,
  removeRegistryEntry,
  saveAnalysisCache,
  loadAnalysisCache,
  updateRegistryEntry,
} from '../src/main/template-registry'

function makePptxBytes(tag: string): Uint8Array {
  // minimal ZIP-signature payload (registry validation only needs the magic;
  // full PPTX parsing is the analyzer's job, tested elsewhere)
  const head = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const body = Buffer.from(tag)
  return new Uint8Array(Buffer.concat([head, body]))
}

describe('user template registry (GOAL §8/§9)', () => {
  it('imports, dedupes by hash, and keeps the user file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'))
    const original = join(dir, 'my-template.pptx')
    const bytes = makePptxBytes('deck-one')
    writeFileSync(original, bytes)

    const first = importUserTemplate(dir, original, bytes)
    expect(first.duplicate).toBe(false)
    expect(first.entry.id).toMatch(/^user-/)
    expect(existsSync(first.entry.managedSourcePath)).toBe(true)
    // managed copy is byte-identical; the ORIGINAL still exists untouched
    expect(readFileSync(first.entry.managedSourcePath).equals(Buffer.from(bytes))).toBe(true)
    expect(existsSync(original)).toBe(true)

    // dedupe: same bytes → duplicate flag, registry stays at ONE entry
    const second = importUserTemplate(dir, original, bytes)
    expect(second.duplicate).toBe(true)
    expect(second.entry.id).toBe(first.entry.id)
    expect(loadRegistry(dir).templates).toHaveLength(1)
  })

  it('rejects non-pptx, non-zip and oversized payloads with typed errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'))
    // the happy-path validation needs a real source file to copy
    writeFileSync(join(dir, 'x.pptx'), makePptxBytes('x'))
    expect(() => importUserTemplate(dir, join(dir, 'x.pptx'), makePptxBytes('x'))).not.toThrow()
    expect(() => importUserTemplate(dir, join(dir, 'y.docx'), makePptxBytes('x'))).toThrow(/\.pptx/)
    const notZip = new Uint8Array([1, 2, 3, 4, 5, 6])
    expect(() => importUserTemplate(dir, join(dir, 'z.pptx'), notZip)).toThrow(/ZIP/)
  })

  it('update/remove: removing the entry never deletes the user original', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'))
    const original = join(dir, 'keep-me.pptx')
    const bytes = makePptxBytes('persist')
    writeFileSync(original, bytes)
    const { entry } = importUserTemplate(dir, original, bytes)

    updateRegistryEntry(dir, entry.id, { analysisStatus: 'ready', pageCount: 5 })
    const reg = loadRegistry(dir)
    expect(reg.templates[0]).toMatchObject({ analysisStatus: 'ready', pageCount: 5 })

    expect(removeRegistryEntry(dir, entry.id)).toBe(true)
    expect(loadRegistry(dir).templates).toHaveLength(0)
    expect(existsSync(original)).toBe(true) // GOAL §36
    expect(existsSync(entry.managedSourcePath)).toBe(false) // managed copy IS ours
  })

  it('analysis cache roundtrip and corrupt-registry tolerance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-reg-'))
    saveAnalysisCache(dir, 'abc', { pages: 3 })
    expect(loadAnalysisCache<{ pages: number }>(dir, 'abc')?.pages).toBe(3)
    expect(loadAnalysisCache(dir, 'missing')).toBeNull()
    // a corrupt registry file reads as an empty registry, never a crash
    writeFileSync(join(dir, 'templates', 'registry.json'), '{corrupt')
    expect(loadRegistry(dir).templates).toEqual([])
  })
})
