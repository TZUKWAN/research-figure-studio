import { describe, expect, it } from 'vitest'
import { extractJsonObject, requestStructured } from '../src/structured-output'

describe('extractJsonObject (AI-P0-01: no more first{-last} slicing)', () => {
  it('recovers the object from prose before and after', () => {
    const text = 'Here is the JSON:\n{"a":1}\n\nNote: some explanation with {braces} inside.'
    expect(extractJsonObject(text).value).toEqual({ a: 1 })
  })

  it('skips a fenced label and trailing commentary objects', () => {
    const text = '```json\n{"thesis":"x","nodes":[]}\n```\nAnother note: {"not":"the plan"}'
    expect(extractJsonObject(text).value).toEqual({ thesis: 'x', nodes: [] })
  })

  it('respects braces inside strings and escaped quotes', () => {
    const text = '{"label":"set {n} to \\"x\\"","ok":true}'
    expect(extractJsonObject(text).value).toEqual({ label: 'set {n} to "x"', ok: true })
  })

  it('repairs a truncated tail and reports TRUNCATED_JSON', () => {
    const text = '{"a":{"b":[1,2],"c":"unfinished str'
    const res = extractJsonObject(text)
    expect(res.value).toEqual({ a: { b: [1, 2], c: 'unfinished str' } })
    expect(res.diagnostic?.code).toBe('TRUNCATED_JSON')
  })

  it('reports NO_JSON_OBJECT when there is nothing to recover', () => {
    expect(extractJsonObject('no object here').diagnostic?.code).toBe('NO_JSON_OBJECT')
  })

  it('keeps nested objects intact instead of stopping at the first closing brace', () => {
    const text = '{"outer":{"inner":1},"tail":2} trailing }'
    expect(extractJsonObject(text).value).toEqual({ outer: { inner: 1 }, tail: 2 })
  })
})

describe('requestStructured', () => {
  const okTransport =
    (text: string, mode = 'native-json' as const) =>
    async () => ({
      ok: true,
      text,
      mode,
    })

  it('returns the validated value with diagnostics and provider mode', async () => {
    const result = await requestStructured(okTransport('{"answer":42}'), {
      schemaId: 'test',
      system: 's',
      user: 'u',
      validate: (v) => (typeof v === 'object' && v !== null ? v : null),
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ answer: 42 })
    expect(result.providerMode).toBe('native-json')
    expect(result.attempts).toBe(1)
  })

  it('repairs once with schema feedback when the first attempt is not JSON', async () => {
    const requests: string[] = []
    const result = await requestStructured(
      async (options) => {
        requests.push(options.user)
        return { ok: true, text: requests.length === 1 ? 'I cannot do that.' : '{"ok":true}' }
      },
      {
        schemaId: 'test',
        system: 's',
        user: 'produce json',
        validate: (v) => (typeof v === 'object' && v !== null ? v : null),
      },
      { maxRepairs: 1 },
    )
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ ok: true })
    expect(result.attempts).toBe(2)
    expect(requests[1]).toContain('not parseable JSON')
    expect(requests[1]).toContain('produce json')
  })

  it('feeds validator failures back with the specific issue and exhausts repairs', async () => {
    let calls = 0
    const result = await requestStructured(
      async () => {
        calls++
        return { ok: true, text: '{"a":1,"nodes":[]}' }
      },
      {
        schemaId: 'test',
        system: 's',
        user: 'u',
        validate: (v) => {
          const o = v as { nodes?: unknown }
          return Array.isArray(o.nodes) && o.nodes.length > 0 ? v : null
        },
      },
      { maxRepairs: 1 },
    )
    expect(result.ok).toBe(false)
    expect(calls).toBe(2)
    expect(result.diagnostics.some((d) => d.code === 'SCHEMA_VALIDATION_FAILED')).toBe(true)
  })

  it('surfaces provider failures as EMPTY_RESPONSE diagnostics, not throws', async () => {
    const result = await requestStructured(
      async () => ({ ok: false, error: 'HTTP 502: bad gateway' }),
      { schemaId: 'test', system: 's', user: 'u', validate: () => null },
    )
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('EMPTY_RESPONSE')
    expect(result.diagnostics[0]?.message).toContain('502')
  })

  it('stops immediately on an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = 0
    const result = await requestStructured(
      async () => {
        called++
        return { ok: true, text: '{}' }
      },
      {
        schemaId: 'test',
        system: 's',
        user: 'u',
        validate: (v) => (typeof v === 'object' ? v : null),
      },
      { signal: controller.signal },
    )
    expect(called).toBe(0)
    expect(result.ok).toBe(false)
  })
})
