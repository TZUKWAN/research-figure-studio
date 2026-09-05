import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamAnthropic } from '../src/protocols/anthropic'
import { streamGemini } from '../src/protocols/gemini'
import { streamOpenAiCompatible } from '../src/protocols/openai-compatible'
import type { AgentMessage } from '@genoffice/agent-core'
import type { StreamCallbacks } from '../src/protocols/shared'
import { okResponse, sseStream, jsonResponse } from './test-utils'

/**
 * AI-P1-06/07: the three wire protocols must convert identical fixture
 * scenarios into the identical AgentStream contract. All providers run the
 * SAME scenario list; a protocol that diverges fails here — not in production
 * against one user's gateway.
 */

type Scenario = {
  name: string
  /** per-protocol SSE body */
  openai?: string[]
  anthropic?: string[]
  gemini?: string[]
  expect: {
    text?: string
    toolName?: string
    toolArgs?: Record<string, unknown>
    stopReason?: string
    errorContains?: string
  }
}

const MESSAGES: AgentMessage[] = [{ role: 'user', text: 'hello' }]

const BASE_CB = (record: {
  text: string
  tools: Array<{ name: string; input: Record<string, unknown> }>
  stop?: string
  error?: string
}): StreamCallbacks => ({
  signal: new AbortController().signal,
  onDelta: (t) => {
    record.text += t
  },
  onToolCall: (c) => {
    record.tools.push({ name: c.name, input: c.input })
  },
  onStopReason: (r) => {
    record.stop = r
  },
  onReasoningDelta: () => {},
  onActivity: () => {},
})

const CONFIG = { apiKey: 'k', model: 'm' }

const SCENARIOS: Scenario[] = [
  {
    name: 'text delta',
    openai: [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
      'data: [DONE]',
    ],
    anthropic: [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ],
    gemini: [
      'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}',
      'data: {"candidates":[{"finishReason":"STOP"}]}',
    ],
    expect: { text: '你好' },
  },
  {
    name: 'single tool call with JSON args',
    openai: [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"probe","arguments":"{\\"x\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ],
    anthropic: [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"probe"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ],
    gemini: [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"probe","args":{"x":1}}}]}}]}',
      'data: {"candidates":[{"finishReason":"STOP"}]}',
    ],
    expect: { toolName: 'probe', toolArgs: { x: 1 } },
  },
  {
    name: 'multiple tool calls keep their order and payloads',
    openai: [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"f","arguments":"{\\"i\\":0}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"g","arguments":"{\\"i\\":1}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ],
    anthropic: [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"f"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"i\\":0}"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"b","name":"g"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"i\\":1}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    ],
    gemini: [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"i":0}}},{"functionCall":{"name":"g","args":{"i":1}}}]}}]}',
      'data: {"candidates":[{"finishReason":"STOP"}]}',
    ],
    expect: { toolName: 'f', toolArgs: { i: 0 } },
  },
  {
    name: 'max_tokens stop reason is normalized',
    openai: [
      'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}',
      'data: {"choices":[{"finish_reason":"length"}]}',
      'data: [DONE]',
    ],
    anthropic: [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"par"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
    ],
    gemini: [
      'data: {"candidates":[{"content":{"parts":[{"text":"par"}]},"finishReason":"MAX_TOKENS"}]}',
    ],
    expect: { text: 'par', stopReason: 'max_tokens' },
  },
  {
    name: 'in-band gateway error surfaces as a stream error',
    openai: ['data: {"error":{"message":"upstream exploded"}}'],
    anthropic: ['data: {"type":"error","error":{"message":"upstream exploded"}}'],
    gemini: ['data: {"error":{"message":"upstream exploded"}}'],
    expect: { errorContains: 'upstream exploded' },
  },
  {
    name: 'CJK content survives unchanged',
    openai: [
      'data: {"choices":[{"delta":{"content":"研究图"}}]}',
      'data: {"choices":[{"finish_reason":"stop"}]}',
      'data: [DONE]',
    ],
    anthropic: [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"研究图"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ],
    gemini: [
      'data: {"candidates":[{"content":{"parts":[{"text":"研究图"}]}}]}',
      'data: {"candidates":[{"finishReason":"STOP"}]}',
    ],
    expect: { text: '研究图' },
  },
]

const WIRE: Record<string, (s: Scenario) => string[] | undefined> = {
  openai: (s) => s.openai,
  anthropic: (s) => s.anthropic,
  gemini: (s) => s.gemini,
}

const RUNNERS: Record<string, (body: string[], cb: StreamCallbacks) => Promise<void>> = {
  openai: (body, cb) =>
    streamOpenAiCompatible(
      'https://unit.test/v1',
      CONFIG,
      'sys',
      MESSAGES,
      [],
      1024,
      cb,
      {},
      undefined as never,
    ).then(() => undefined),
  anthropic: (body, cb) =>
    streamAnthropic(CONFIG, 'sys', MESSAGES, [], 1024, cb, 'https://unit.test', undefined as never),
  gemini: (body, cb) =>
    streamGemini(CONFIG, 'sys', MESSAGES, [], 1024, cb, 'https://unit.test', undefined as never),
}

describe('provider contract: identical fixtures across OpenAI-compatible / Anthropic / Gemini', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const scenario of SCENARIOS) {
    it(`[${scenario.name}]`, async () => {
      for (const protocol of ['openai', 'anthropic', 'gemini']) {
        const body = WIRE[protocol](scenario)
        if (!body) continue
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => okResponse(sseStream(body))),
        )
        const record = {
          text: '',
          tools: [] as Array<{ name: string; input: Record<string, unknown> }>,
          stop: undefined as string | undefined,
          error: undefined as string | undefined,
        }
        const cb = BASE_CB(record)
        const callbacks: StreamCallbacks = {
          ...cb,
          onDelta: cb.onDelta,
          onToolCall: cb.onToolCall,
        }
        if (scenario.expect.errorContains) {
          await expect(RUNNERS[protocol](body, callbacks)).rejects.toThrow(
            scenario.expect.errorContains,
          )
        } else {
          await RUNNERS[protocol](body, callbacks)
          if (scenario.expect.text !== undefined) {
            expect(record.text, `${protocol} text`).toBe(scenario.expect.text)
          }
          if (scenario.expect.toolName) {
            expect(record.tools[0]?.name, `${protocol} tool name`).toBe(scenario.expect.toolName)
            expect(record.tools[0]?.input, `${protocol} tool args`).toEqual(
              scenario.expect.toolArgs,
            )
          }
          if (scenario.expect.stopReason) {
            expect(record.stop, `${protocol} stop reason`).toBe(scenario.expect.stopReason)
          }
        }
        vi.unstubAllGlobals()
      }
    })
  }

  it('empty stream (no content, no framing) errors on every protocol', async () => {
    for (const protocol of ['openai', 'anthropic', 'gemini'] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => okResponse(sseStream(['data: [DONE]']))),
      )
      const record = { text: '', tools: [] as unknown[][] }
      const cb = BASE_CB(record as never)
      await expect(RUNNERS[protocol](['data: [DONE]'], cb)).rejects.toThrow(
        /empty stream|no content/,
      )
      vi.unstubAllGlobals()
    }
  })

  it('a 200 JSON body instead of SSE is surfaced, not dissolved (gateway quirk)', async () => {
    // OpenAI-compatible: JSON body with an error object → error
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'quota exhausted by gateway' } })),
    )
    const record = { text: '', tools: [] as unknown[] }
    await expect(
      streamOpenAiCompatible(
        'https://unit.test/v1',
        CONFIG,
        'sys',
        MESSAGES,
        [],
        1024,
        BASE_CB(record as never),
      ),
    ).rejects.toThrow('quota exhausted by gateway')
    vi.unstubAllGlobals()
  })

  it('malformed SSE frames are skipped without killing the turn (openai-compatible)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(
          sseStream([
            'data: not-json-at-all',
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: {"choices":[{"finish_reason":"stop"}]}',
            'data: [DONE]',
          ]),
        ),
      ),
    )
    const record = { text: '', tools: [] as unknown[] }
    await streamOpenAiCompatible(
      'https://unit.test/v1',
      CONFIG,
      'sys',
      MESSAGES,
      [],
      1024,
      BASE_CB(record as never),
    )
    expect(record.text).toBe('ok')
    vi.unstubAllGlobals()
  })

  it('nonstandard stop reasons do not fabricate max_tokens (openai-compatible)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse(
          sseStream([
            'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}',
            'data: [DONE]',
          ]),
        ),
      ),
    )
    const record = { text: 'x', tools: [] as unknown[], stop: undefined as string | undefined }
    await streamOpenAiCompatible(
      'https://unit.test/v1',
      CONFIG,
      'sys',
      MESSAGES,
      [],
      1024,
      BASE_CB(record as never),
    )
    expect(record.stop).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
