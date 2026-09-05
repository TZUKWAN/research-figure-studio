import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assumedCapabilityProfile,
  calibrationFromProfile,
  probeModelCapabilities,
  type ModelCapabilityProfile,
} from '../src/capability-probe'

/**
 * AI-P0-06: "the model should support tools" is not a contract. These tests
 * pin the probe semantics against mocked gateways, including the flaky local
 * OpenAI-compatible shapes that motivated the probe.
 */

const CONFIG = { apiKey: 'k', model: 'local-model', baseUrl: 'https://unit.test/v1' }

/** OpenAI-compatible SSE helper */
const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      },
    }),
    { status: 200 },
  )

const chatChunk = (content: string) => ({ choices: [{ delta: { content } }] })
const toolChunk = (name: string, args: string) => ({
  choices: [
    { delta: { tool_calls: [{ index: 0, id: 't1', function: { name, arguments: args } }] } },
  ],
})

afterEach(() => vi.unstubAllGlobals())

describe('probeModelCapabilities (AI-P0-06)', () => {
  it('full-featured endpoint: everything passes with probed confidence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        const wantsJson = !!body.response_format || !!body.tool_choice
        if (body.stream) {
          return sse(
            wantsJson
              ? [toolChunk('capability_echo', '{"answer":"ok"}')]
              : [toolChunk('capability_echo', '{"answer":"ok"}'), chatChunk('done')],
          )
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        })
      }),
    )
    const profile = await probeModelCapabilities('custom', CONFIG, false)
    expect(profile.confidence).toBe('probed')
    expect(profile.streaming).toBe(true)
    expect(profile.toolCalling).toBe(true)
    expect(profile.structuredJson).toBe(true)
    expect(profile.multiTurnTools).toBe(true)
    expect(profile.vision).toBe(false)
  })

  it('a gateway without tool support: toolCalling/multiTurnTools false, streaming may still work, failures recorded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        if (body.stream) {
          if (body.tools) {
            // tools were announced but the gateway ignores them: text-only reply
            return sse([chatChunk('I would say ok'), { choices: [{ finish_reason: 'stop' }] }])
          }
          return sse([chatChunk('ok'), { choices: [{ finish_reason: 'stop' }] }])
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        })
      }),
    )
    const profile = await probeModelCapabilities('custom', CONFIG, true)
    expect(profile.toolCalling).toBe(false)
    expect(profile.multiTurnTools).toBe(false)
    expect(profile.streaming).toBe(true)
    expect(profile.vision).toBe(true)
    const failure = profile.failures.toolCalling
    expect(failure).toBeTruthy()
  })

  it('a dead endpoint: plain completion failure short-circuits with PROVIDER_* recorded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    )
    const profile = await probeModelCapabilities('custom', CONFIG, false)
    expect(profile.streaming).toBe(false)
    expect(profile.toolCalling).toBe(false)
    expect(profile.failures.plain?.code).toBe('PROVIDER_AUTH')
  })

  it('structured JSON rejected by the gateway → structuredJson false with the failure recorded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        if (body.response_format) {
          return new Response('response_format is not supported', { status: 400 })
        }
        if (body.stream) {
          return sse([toolChunk('capability_echo', '{"answer":"ok"}'), chatChunk('done')])
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        })
      }),
    )
    const profile = await probeModelCapabilities('custom', CONFIG, false)
    expect(profile.toolCalling).toBe(true)
    expect(profile.structuredJson).toBe(false)
    expect(profile.failures.structuredJson).toBeTruthy()
  })
})

describe('calibrationFromProfile (AI-P1-14 determinism)', () => {
  const base: ModelCapabilityProfile = {
    ...assumedCapabilityProfile(false),
    confidence: 'probed',
  }

  it('probed weak structured/tool support → jsonReliability low (harness answers with the deterministic path)', () => {
    expect(calibrationFromProfile({ ...base, structuredJson: false }).jsonReliability).toBe('low')
    expect(
      calibrationFromProfile({ ...base, structuredJson: true, toolCalling: false }).jsonReliability,
    ).toBe('low')
  })

  it('unprobed (null) profile stays conservative medium/unknown', () => {
    expect(calibrationFromProfile(null)).toEqual({
      jsonReliability: 'medium',
      spatialPlanning: 'unknown',
    })
    expect(calibrationFromProfile(undefined)).toEqual({
      jsonReliability: 'medium',
      spatialPlanning: 'unknown',
    })
  })

  it('probed structured-capable model maps to medium', () => {
    expect(calibrationFromProfile({ ...base, structuredJson: true }).jsonReliability).toBe('medium')
  })

  it('assumed (never probed) profiles never claim high reliability', () => {
    expect(calibrationFromProfile(assumedCapabilityProfile(true)).jsonReliability).not.toBe('high')
  })
})
