import { describe, expect, it, vi } from 'vitest'
import { AgentLoop, type AgentTransport, type AgentStreamCallbacks } from '../src'

/**
 * AI-P0-10: context compaction summarizes (and thereby distorts) old
 * conversation. Research figure facts must NOT depend on that summary — the
 * skill's durableContext() is injected into the system prompt on every turn,
 * so a compacted history can never drop or rewrite them.
 */

interface FakeRequest {
  system: string
  messages: Array<{ role: string; text: string }>
}

function fakeTransport(script: Array<(cb: AgentStreamCallbacks) => void>): {
  transport: AgentTransport
  requests: FakeRequest[]
} {
  const requests: FakeRequest[] = []
  let step = 0
  return {
    requests,
    transport: {
      stream(_request, cb) {
        requests.push({
          system: _request.system,
          messages: _request.messages.map((m) =>
            m.role === 'tool'
              ? { role: m.role, text: '(tool results)' }
              : { role: m.role, text: m.text },
          ),
        })
        const fn = script[Math.min(step, script.length - 1)]
        step++
        fn(cb)
        return { cancel: () => {} }
      },
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('research context survives compaction (AI-P0-10)', () => {
  it('durableContext() is present in the system prompt of every turn, including after compaction', async () => {
    const durable = '<durable-figure-state>thesis: Yangtze trade; edges: 3</durable-figure-state>'
    const { transport, requests } = fakeTransport([
      (cb) => {
        cb.onDelta('working')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('still working')
        cb.onDone()
      },
      (cb) => {
        cb.onDelta('done')
        cb.onDone()
      },
    ])
    const loop = new AgentLoop({
      transport,
      // Tiny budgets so the second run compacts the first conversation away.
      compaction: { maxBytes: 200, keepRecentBytes: 100, disableLlmSummary: true },
      skill: {
        id: 'slides',
        systemPrompt: 'base system prompt',
        tools: [],
        durableContext: () => durable,
        executeTool: () => ({ output: 'ok', summary: 'ok' }),
      },
    })
    loop.run('build the figure from this thesis')
    await flush()
    await flush()
    // First turn carried the durable block
    expect(requests[0]?.system).toContain(durable)
    expect(requests[0]?.system).toContain('base system prompt')

    loop.run('now make the title larger')
    await flush()
    await flush()
    // Compaction replaced old user/assistant text with a digest, but the
    // durable block rides the system prompt verbatim on the new turn.
    const last = requests.at(-1)
    expect(last?.system).toContain(durable)
    expect(last?.messages.join('\n')).not.toContain('build the figure from this thesis')
  })

  it('runs without durableContext (plain skills unaffected)', async () => {
    const { transport, requests } = fakeTransport([
      (cb) => {
        cb.onDelta('hi')
        cb.onDone()
      },
    ])
    const loop = new AgentLoop({
      transport,
      skill: {
        id: 'x',
        systemPrompt: 'sys',
        tools: [],
        executeTool: () => ({ output: '', summary: '' }),
      },
    })
    loop.run('q')
    await flush()
    await flush()
    expect(requests[0]?.system).toBe('sys')
  })
})
