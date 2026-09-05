/**
 * Deterministic stub AI provider for Research Figure E2E (QA-P1-12).
 *
 * Implements the slice of the OpenAI-compatible wire protocol the app
 * actually consumes (POST /chat/completions, SSE frames, tool_calls) so the
 * REAL Electron app, REAL agent loop, REAL orchestrator and REAL renderer run
 * end-to-end while the model is replaced by canned, schema-valid responses.
 *
 * Call classification (by request body, no prompt-text heuristics beyond two
 * system-prompt keywords owned by the pipeline itself):
 *   - body.tools present, no tool result yet  → tool_call create_research_figure
 *   - body.tools present, tool result present → plain text (loop epilogue)
 *   - system contains "SpatialPlan"           → canned composition JSON
 *   - otherwise                               → canned FigurePlanV2 JSON
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const FIGURE_PLAN = {
  thesis: 'E2E: 底物经两步酶促反应生成产物',
  figureType: 'input-core-output',
  narrative: {
    expressionMode: 'mechanism',
    complexity: 'compact',
    centralMessage: '两步酶促反应生成产物',
    visualCenter: 'e1',
    mustShow: ['sub', 'e1', 'e2', 'out'],
    mayMerge: [],
    omitFromCanvas: [],
  },
  primarySpine: ['sub', 'e1', 'e2', 'out'],
  nodes: [
    {
      id: 'sub',
      type: 'data-source',
      semanticLabel: '底物',
      visible: { title: '底物' },
      importance: 0.4,
      role: 'input',
    },
    {
      id: 'e1',
      type: 'mechanism',
      semanticLabel: '酶促反应一',
      visible: { title: '酶促反应一' },
      importance: 0.9,
      role: 'core',
    },
    {
      id: 'e2',
      type: 'mechanism',
      semanticLabel: '酶促反应二',
      visible: { title: '酶促反应二' },
      importance: 0.7,
      role: 'core',
    },
    {
      id: 'out',
      type: 'outcome',
      semanticLabel: '产物',
      visible: { title: '产物' },
      importance: 0.6,
      role: 'output',
    },
  ],
  edges: [
    { id: 'r1', from: 'sub', to: 'e1', role: 'main', relation: 'process' },
    { id: 'r2', from: 'e1', to: 'e2', role: 'main', relation: 'process' },
    { id: 'r3', from: 'e2', to: 'out', role: 'main', relation: 'transformation' },
  ],
  groups: [],
  globalIntent: { emphasis: ['e1'], secondary: [], optional: [] },
  readingIntent: { preferredDirection: 'LR' },
}

const SPATIAL_PLAN = {
  composition: {
    readingFlow: 'LR',
    balance: 'asymmetric',
    density: 'medium',
    visualCenter: 'e1',
    whitespaceStrategy: 'balanced',
  },
  placements: [
    { id: 'sub', boxHint: { x: 0.05, y: 0.38, w: 0.17, h: 0.24 }, visualRole: 'primary' },
    { id: 'e1', boxHint: { x: 0.32, y: 0.32, w: 0.24, h: 0.36 }, visualRole: 'dominant' },
    { id: 'e2', boxHint: { x: 0.63, y: 0.34, w: 0.2, h: 0.3 }, visualRole: 'primary' },
    { id: 'out', boxHint: { x: 0.86, y: 0.4, w: 0.12, h: 0.2 }, visualRole: 'secondary' },
  ],
}

interface ChatMessage {
  role?: string
  content?: string | Array<Record<string, unknown>>
  tool_call_id?: string
}

function sse(res: import('node:http').ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function textFrames(res: import('node:http').ServerResponse, text: string): void {
  sse(res, { id: 'stub', choices: [{ delta: { role: 'assistant', content: text } }] })
  sse(res, { id: 'stub', choices: [{ delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

function toolCallFrames(
  res: import('node:http').ServerResponse,
  name: string,
  args: unknown,
): void {
  sse(res, {
    id: 'stub',
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'stub_call_1', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })
  sse(res, { id: 'stub', choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join(' ')
      if (text.trim()) return text
    }
  }
  return '两步酶促反应'
}

export interface StubProvider {
  server: Server
  /** base URL to seed into ai-settings.json providers.custom.baseUrl */
  baseUrl: string
  requests: Array<{ hasTools: boolean; systemSnippet: string }>
  close(): Promise<void>
}

export async function startStubProvider(): Promise<StubProvider> {
  const requests: StubProvider['requests'] = []
  const server = createServer((req, res) => {
    if (!(req.url ?? '').includes('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      let parsed: { messages?: ChatMessage[]; tools?: unknown[] }
      try {
        parsed = JSON.parse(body)
      } catch {
        textFrames(res, '{}')
        return
      }
      const messages = parsed.messages ?? []
      const system = messages.find((message) => message.role === 'system')
      const systemText =
        typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? '')
      requests.push({
        hasTools: (parsed.tools?.length ?? 0) > 0,
        systemSnippet: systemText.slice(0, 120),
      })
      const hasTools = (parsed.tools?.length ?? 0) > 0
      const hasToolResult = messages.some((message) => message.role === 'tool')
      if (hasTools) {
        if (hasToolResult) {
          textFrames(res, '研究图已通过 create_research_figure 生成完毕。')
        } else {
          toolCallFrames(res, 'create_research_figure', {
            thesis: lastUserText(messages).slice(0, 200),
            figureFamily: 'mechanism',
            domain: 'biomed',
            // deterministic stub = a well-calibrated spatial planner; unlocks the
            // A1 model-authored composition path so the declared boxHints drive
            // the solved geometry (and the edit spec can aim its dblclick)
            capability: {
              calibration: { spatialPlanning: 'medium', jsonReliability: 'high' },
            },
          })
        }
        return
      }
      if (systemText.includes('SpatialPlan') || systemText.includes('Composition Designer')) {
        textFrames(res, `\`\`\`json\n${JSON.stringify(SPATIAL_PLAN)}\n\`\`\``)
        return
      }
      textFrames(res, `\`\`\`json\n${JSON.stringify(FIGURE_PLAN)}\n\`\`\``)
    })
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  }
}

export function aiSettingsJson(baseUrl: string): string {
  return JSON.stringify({
    provider: 'custom',
    providers: {
      custom: { apiKey: 'stub-key', model: 'stub-model', baseUrl },
    },
  })
}
