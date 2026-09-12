import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  assertBoundedString,
  assertEnum,
  assertHttpUrl,
  assertSafeInt,
  assertStringArray,
  checkFilePath,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  type SenderTrustOptions,
} from '../src/index'

const DEV: SenderTrustOptions = { packaged: false }
const PACKAGED: SenderTrustOptions = { packaged: true }

describe('assertSafeInt', () => {
  it('accepts integers inside the range', () => {
    expect(assertSafeInt(3, 'idx', { min: 0, max: 10 })).toBe(3)
    expect(assertSafeInt(-1, 'idx', { min: -5 })).toBe(-1)
  })

  it('rejects NaN, floats, and out-of-range values (negative tests)', () => {
    expect(() => assertSafeInt(Number.NaN, 'idx')).toThrow()
    expect(() => assertSafeInt(1.5, 'idx')).toThrow()
    expect(() => assertSafeInt('3', 'idx')).toThrow()
    expect(() => assertSafeInt(Infinity, 'idx')).toThrow()
    expect(() => assertSafeInt(-1, 'idx', { min: 0 })).toThrow()
    expect(() => assertSafeInt(Number.MAX_SAFE_INTEGER + 1, 'idx')).toThrow()
  })
})

describe('assertBoundedString', () => {
  it('accepts strings within bounds', () => {
    expect(assertBoundedString('abc', 'name', 10)).toBe('abc')
    expect(assertBoundedString('', 'opt', 10, { minLength: 0 })).toBe('')
  })

  it('rejects empty/oversized/non-string (negative tests)', () => {
    expect(() => assertBoundedString('', 'name', 10)).toThrow()
    expect(() => assertBoundedString('x'.repeat(11), 'name', 10)).toThrow()
    expect(() => assertBoundedString(42, 'name', 10)).toThrow()
    expect(() => assertBoundedString(null, 'name', 10)).toThrow()
  })
})

describe('assertEnum', () => {
  it('accepts listed values and rejects everything else', () => {
    expect(assertEnum('a', 'mode', ['a', 'b'] as const)).toBe('a')
    expect(() => assertEnum('c', 'mode', ['a', 'b'] as const)).toThrow()
    expect(() => assertEnum(undefined, 'mode', ['a'] as const)).toThrow()
  })
})

describe('assertStringArray', () => {
  it('enforces item count and length caps', () => {
    expect(assertStringArray(['a', 'b'], 'paths', { maxItems: 3, maxLength: 8 })).toEqual([
      'a',
      'b',
    ])
    expect(() => assertStringArray('x', 'paths')).toThrow()
    expect(() => assertStringArray(['a', 'b', 'c', 'd'], 'paths', { maxItems: 3 })).toThrow()
    expect(() => assertStringArray(['ok', 'way-too-long'], 'paths', { maxLength: 4 })).toThrow()
    expect(() => assertStringArray([1], 'paths')).toThrow()
  })
})

describe('assertHttpUrl', () => {
  it('accepts https always', () => {
    expect(assertHttpUrl('https://api.example.com/v1', 'baseUrl', 'https-only')).toBe(
      'https://api.example.com/v1',
    )
  })

  it('https-only rejects plain http even on public hosts', () => {
    expect(() => assertHttpUrl('http://api.example.com', 'baseUrl', 'https-only')).toThrow()
  })

  it('https-or-local-http allows loopback http but not public http (SSRF policy)', () => {
    expect(assertHttpUrl('http://127.0.0.1:11434/v1', 'baseUrl', 'https-or-local-http')).toBe(
      'http://127.0.0.1:11434/v1',
    )
    expect(assertHttpUrl('http://localhost:8080', 'baseUrl', 'https-or-local-http')).toBe(
      'http://localhost:8080',
    )
    expect(() => assertHttpUrl('http://10.0.0.5', 'baseUrl', 'https-or-local-http')).toThrow()
  })

  it('rejects non-http protocols, garbage, and overlong URLs', () => {
    expect(() => assertHttpUrl('file:///etc/passwd', 'baseUrl', 'https-or-local-http')).toThrow()
    expect(() => assertHttpUrl('ftp://example.com', 'baseUrl', 'https-or-local-http')).toThrow()
    expect(() => assertHttpUrl('not a url', 'baseUrl', 'https-or-local-http')).toThrow()
    expect(() =>
      assertHttpUrl(`https://e.com/${'x'.repeat(3000)}`, 'baseUrl', 'https-only'),
    ).toThrow()
  })
})

describe('checkFilePath', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ipc-path-'))
  const file = path.join(dir, 'deck.pptx')
  writeFileSync(file, 'x')
  const subdir = path.join(dir, 'folder.pptx')
  mkdirSync(subdir)
  const link = path.join(dir, 'link.pptx')
  try {
    symlinkSync(file, link)
  } catch {
    // Windows may lack symlink privilege — the symlink cases are skipped below
  }

  it('rejects non-absolute and relative input', () => {
    expect(checkFilePath('deck.pptx')).toEqual({ ok: false, reason: 'not-absolute' })
    expect(checkFilePath('../etc/passwd')).toEqual({ ok: false, reason: 'not-absolute' })
    expect(checkFilePath(42)).toEqual({ ok: false, reason: 'bad-type' })
    expect(checkFilePath('')).toEqual({ ok: false, reason: 'empty' })
  })

  it('resolves to a canonical absolute path', () => {
    const noisy = path.join(dir, 'sub', '..', 'deck.pptx')
    const result = checkFilePath(noisy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolved).toBe(path.resolve(file))
  })

  it('enforces the extension allowlist', () => {
    expect(checkFilePath(path.join(dir, 'note.txt'), { extensions: ['pptx'] })).toEqual({
      ok: false,
      reason: 'bad-ext',
    })
    const ok = checkFilePath(file, { extensions: ['pptx'] })
    expect(ok.ok).toBe(true)
  })

  it('rejects missing paths and directories disguised as files', () => {
    expect(checkFilePath(path.join(dir, 'nope.pptx'), { mustExist: true })).toEqual({
      ok: false,
      reason: 'missing',
    })
    // a directory named *.pptx must never pass a destructive file op
    expect(checkFilePath(subdir, { mustExist: true, extensions: ['pptx'] })).toEqual({
      ok: false,
      reason: 'not-file',
    })
  })

  it('rejects control characters and overlong paths', () => {
    expect(checkFilePath(`${file}\0`)).toEqual({ ok: false, reason: 'bad-type' })
    // platform-absolute overlong path: a hardcoded C:\ drive path is not
    // absolute on Linux and hits 'not-absolute' before the length gate
    const overlong = path.resolve(path.sep, `${'x'.repeat(5000)}.pptx`)
    expect(checkFilePath(overlong)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('follows symlinks to a real file (documented behavior)', () => {
    const result = checkFilePath(link, { mustExist: true, extensions: ['pptx'] })
    if (result.ok || result.reason !== 'missing') {
      // only assert when symlinks are supported on this platform
      expect(result.ok).toBe(true)
    }
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('isTrustedRendererUrl / isTrustedIpcSender', () => {
  it('accepts file:// renderers in packaged runs, rejects remote origins', () => {
    expect(isTrustedRendererUrl('file:///app/out/renderer/index.html', PACKAGED)).toBe(true)
    expect(isTrustedRendererUrl('https://evil.example/x', PACKAGED)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5175', PACKAGED)).toBe(false)
  })

  it('accepts dev-server origins only in unpacked runs', () => {
    expect(isTrustedRendererUrl('http://localhost:5175/', DEV)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:5175/', DEV)).toBe(true)
    expect(isTrustedRendererUrl('http://192.168.1.10:5175/', DEV)).toBe(false)
    expect(isTrustedRendererUrl('devtools://devtools/bundled', DEV)).toBe(false)
    expect(isTrustedRendererUrl('not a url', DEV)).toBe(false)
  })

  it('honors extra devOrigins', () => {
    const opts: SenderTrustOptions = { packaged: false, devOrigins: ['http://localhost:3000'] }
    expect(isTrustedRendererUrl('http://localhost:3000', opts)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:3001', opts)).toBe(false)
  })

  const trustedFrame = (url: string) => ({
    sender: { isDestroyed: () => false, getURL: () => url },
    senderFrame: { url },
  })

  it('isTrustedIpcSender: live app frame passes; destroyed/crashed/remote senders fail closed', () => {
    expect(isTrustedIpcSender(trustedFrame('file:///app/index.html'), PACKAGED)).toBe(true)
    expect(isTrustedIpcSender(trustedFrame('https://evil.example'), PACKAGED)).toBe(false)
    expect(
      isTrustedIpcSender(
        { sender: { isDestroyed: () => true }, senderFrame: { url: 'file:///app/index.html' } },
        PACKAGED,
      ),
    ).toBe(false)
    expect(
      isTrustedIpcSender(
        {
          sender: { isDestroyed: () => false, isCrashed: () => true },
          senderFrame: { url: 'file:///app/index.html' },
        },
        PACKAGED,
      ),
    ).toBe(false)
    expect(isTrustedIpcSender({ sender: { isDestroyed: () => false } }, PACKAGED)).toBe(false)
  })
})
