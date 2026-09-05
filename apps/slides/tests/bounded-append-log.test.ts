import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendBoundedLine } from '../src/main/bounded-append-log'

describe('appendBoundedLine (DESKTOP-P1-11)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounded-log-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends lines and creates the file lazily', () => {
    const log = join(dir, 'nested', 'diag.log')
    appendBoundedLine(log, 'one')
    appendBoundedLine(log, 'two')
    expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n')
  })

  it('rotates around maxBytes while keeping the newest tail', () => {
    const log = join(dir, 'diag.log')
    // A short preamble with a large budget: no rotation yet
    for (let i = 0; i < 10; i++) appendBoundedLine(log, `pre-${String(i).padStart(3, '0')}`)
    const head = readFileSync(log, 'utf8').split('\n')[0]
    expect(head).toContain('pre-000')
    // Now a bulk phase under a tight budget: ~30 bytes per line, 100 lines
    const bulk = (line: string) => appendBoundedLine(log, line, 1024, 512)
    for (let i = 0; i < 100; i++) bulk(`bulk-${String(i).padStart(3, '0')}-${'x'.repeat(16)}`)
    const content = readFileSync(log, 'utf8')
    expect(content.length).toBeLessThan(1024 + 64) // bounded around max + last line
    expect(content).not.toContain('pre-000') // oldest evidence evicted...
    expect(content).toContain('bulk-099') // ...newest lines all kept
    expect(content.trimEnd().split('\n')[0]).toMatch(/^bulk-\d{3}/) // tail starts at a line boundary
    expect(existsSync(`${log}.rotate-tmp`)).toBe(false) // no rotation residue
  })

  it('never throws when the log path is unwritable', () => {
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'not a directory', 'utf8')
    expect(() => appendBoundedLine(join(blocker, 'diag.log'), 'x')).not.toThrow()
  })
})
