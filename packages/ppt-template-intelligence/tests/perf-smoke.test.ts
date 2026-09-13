/**
 * GOAL §40: analyzer performance smoke on the owned 100-slide pressure
 * fixture. Runs inside the template-intelligence CI job (which generates the
 * fixtures first); clean-skips when the fixture is absent locally.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTemplateBytes } from '../src/analyzer.js'

const FIXTURE = join(
  process.cwd(),
  '..',
  '..',
  'e2e',
  'fixtures',
  'templates',
  'large-100-slide.pptx',
)

async function ensureFixture(): Promise<string> {
  // self-generate via the owned generator (GOAL §42) so any environment that
  // runs this suite has the pressure fixture available
  const { ensureOwnedFixtures } = await import('../../../e2e/fixtures/generate-fixtures')
  return ensureOwnedFixtures()
}

describe('analyzer performance (GOAL §40)', () => {
  it('100-slide deck analyzes within the CI budget', async () => {
    await ensureFixture()
    expect(existsSync(FIXTURE)).toBe(true)
    const bytes = readFileSync(FIXTURE)
    const started = Date.now()
    const events: Array<{ stage: string; current: number; total: number }> = []
    const def = await analyzeTemplateBytes(bytes, { type: 'user-upload' }, undefined, {
      onProgress: (p) => events.push({ ...p }),
    })
    const elapsed = Date.now() - started
    expect(def.pages).toHaveLength(100)
    expect(events.filter((e) => e.stage === 'parse')).toHaveLength(100)
    // generous ceiling: the analyzer is a fast tree walk; this only catches
    // pathological regressions (accidental O(n²) reloads etc.)
    expect(elapsed).toBeLessThan(30_000)
    console.log('[perf] 100-slide analyze:', elapsed, 'ms')
  })
})
