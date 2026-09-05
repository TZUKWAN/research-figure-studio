/**
 * Model capability probe (AI-P0-06).
 *
 * "It should support tools" is not a contract — local OpenAI-compatible
 * gateways routinely ship streaming without tool calls, or tool calls without
 * multi-turn continuity. On first configuration (or on demand) a set of tiny,
 * cheap, real requests establishes what the endpoint can actually do; the
 * research pipeline reads the resulting profile instead of hoping.
 */
import type { AgentMessage } from '@genoffice/agent-core'
import { chatForProvider } from './chat'
import { streamForProvider } from './stream'
import { classifyAiError, type AiErrorCode } from './error-codes'
import type { AiProviderConfig, AiProviderId } from './types'
import { createStreamWatchdog } from './watchdog'

export interface ModelCapabilityProfile {
  streaming: boolean
  toolCalling: boolean
  multiTurnTools: boolean
  structuredJson: boolean
  /** declared only (user toggle / provider metadata), not probed */
  vision: boolean
  confidence: 'probed' | 'assumed'
  probedAt: string
  /** taxonomy code of the first failing probe — why a capability is off */
  failures: Partial<Record<CapabilityProbeKind, { code: AiErrorCode; message: string }>>
}

export type CapabilityProbeKind =
  'plain' | 'streaming' | 'structuredJson' | 'toolCalling' | 'multiTurnTools'

/** Tiny budgets: a probe must never cost real latency or tokens */
const PROBE_MAX_TOKENS = 256
const PROBE_TIMEOUT_MS = 30_000

const PROBE_TOOL_NAME = 'capability_echo'

function profile(vision: boolean): ModelCapabilityProfile {
  return {
    streaming: false,
    toolCalling: false,
    multiTurnTools: false,
    structuredJson: false,
    vision,
    confidence: 'probed',
    probedAt: new Date().toISOString(),
    failures: {},
  }
}

function record(profile: ModelCapabilityProfile, kind: CapabilityProbeKind, error: unknown): void {
  profile.failures[kind] = {
    code: classifyAiError(error),
    message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
  }
}

function textMessage(text: string): AgentMessage {
  return { role: 'user', text }
}

/** Probe-default callbacks: aggregate nothing, fail on stream errors. */
function probeCallbacks(
  signal: AbortSignal,
  onDelta?: () => void,
): import('./protocols/shared').StreamCallbacks {
  return {
    signal,
    onDelta: () => onDelta?.(),
    onToolCall: () => {},
    onActivity: () => {},
  }
}

/** Run one streaming probe turn to completion; throws on stream errors. */
async function runStreamTurn(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[],
  onDelta?: () => void,
  structured?: { name: string; schema: Record<string, unknown> },
  firstToolInput?: { current: Record<string, unknown> | null },
): Promise<void> {
  const controller = new AbortController()
  const wd = createStreamWatchdog(controller.signal, PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS)
  await wd.guard(() =>
    streamForProvider(
      provider,
      config,
      system,
      messages,
      tools.map((t) => ({
        ...t,
        inputSchema: t.inputSchema as import('@genoffice/agent-core').AgentToolDef['inputSchema'],
      })),
      PROBE_MAX_TOKENS,
      {
        ...probeCallbacks(wd.signal, onDelta),
        onToolCall: (call) => {
          if (firstToolInput && firstToolInput.current === null) firstToolInput.current = call.input
        },
      },
      structured ? { jsonSchema: structured } : undefined,
    ),
  )
}

/**
 * One streaming turn with a forced single tool. Resolves the tool input when
 * the model called it; throws when the turn produced no call.
 */
async function forcedToolTurn(
  provider: AiProviderId,
  config: AiProviderConfig,
  messages: AgentMessage[],
  withSchemaEnforcement: boolean,
): Promise<Record<string, unknown>> {
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  } as Record<string, unknown>
  const firstToolInput: { current: Record<string, unknown> | null } = { current: null }
  await runStreamTurn(
    provider,
    config,
    'You must answer by calling the capability_echo tool.',
    messages,
    [
      {
        name: PROBE_TOOL_NAME,
        description: 'Report the answer by calling this tool.',
        inputSchema: schema,
      },
    ],
    undefined,
    // The probe doubles as the structuredJson probe when the schema rides
    // the provider-native carrier (OpenAI response_format / Gemini schema).
    withSchemaEnforcement ? { name: PROBE_TOOL_NAME, schema } : undefined,
    firstToolInput,
  )
  if (!firstToolInput.current) throw new Error('model produced no tool call')
  return firstToolInput.current
}

/**
 * Probe what the configured endpoint can do, using minimal real requests.
 * Never throws — every failed probe lands in `failures` with a taxonomy code.
 */
export async function probeModelCapabilities(
  provider: AiProviderId,
  config: AiProviderConfig,
  visionDeclared: boolean,
): Promise<ModelCapabilityProfile> {
  const result = profile(visionDeclared)

  // 1. plain non-streaming completion
  const chat = await chatForProvider(
    provider,
    config,
    'Reply with the single word: ok',
    'ok',
  ).catch((e) => ({ ok: false as const, error: String(e) }))
  if (!chat.ok) {
    record(result, 'plain', chat.error ?? 'plain completion failed')
    // Without a working plain completion the rest cannot run meaningfully
    return result
  }

  // 2. streaming + 4. single tool call in one turn
  try {
    await forcedToolTurn(provider, config, [textMessage('Say "ok" via the tool.')], false)
    result.streaming = true
    result.toolCalling = true
  } catch (e) {
    record(result, 'toolCalling', e)
    // Maybe tools are broken but streaming works — check plain streaming
    try {
      let got = false
      await runStreamTurn(
        provider,
        config,
        'Reply with the single word: ok',
        [textMessage('ok?')],
        [],
        () => {
          got = true
        },
      )
      result.streaming = got
    } catch (e2) {
      result.streaming = false
      record(result, 'streaming', e2)
    }
  }

  // 3. structured JSON via the provider-native carrier
  try {
    const input = await forcedToolTurn(
      provider,
      config,
      [textMessage('Report ok via the tool.')],
      true,
    )
    result.structuredJson = typeof input.answer === 'string'
  } catch (e) {
    record(result, 'structuredJson', e)
  }

  // 5. multi-turn: feed a tool result back and expect a normal completion
  if (result.toolCalling) {
    try {
      let got = false
      await runStreamTurn(
        provider,
        config,
        'Continue after the tool result.',
        [
          textMessage('Call the tool.'),
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'probe1', name: PROBE_TOOL_NAME, input: { answer: 'ok' } }],
          },
          { role: 'tool', results: [{ id: 'probe1', name: PROBE_TOOL_NAME, output: 'ok' }] },
        ],
        [
          {
            name: PROBE_TOOL_NAME,
            description: 'Report the answer by calling this tool.',
            inputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
        ],
        () => {
          got = true
        },
      )
      result.multiTurnTools = got
    } catch (e) {
      record(result, 'multiTurnTools', e)
    }
  }

  return result
}

/**
 * Default profile when nothing has been probed: conservative-but-usable
 * (assumed streaming/tools, no structured guarantee). Consumers must treat
 * `confidence: 'assumed'` as "verify at runtime, repair on failure".
 */
export function assumedCapabilityProfile(vision: boolean): ModelCapabilityProfile {
  return {
    streaming: true,
    toolCalling: true,
    multiTurnTools: true,
    structuredJson: false,
    vision,
    confidence: 'assumed',
    probedAt: new Date().toISOString(),
    failures: {},
  }
}

/**
 * Determinism contract (AI-P1-14): the research pipeline maps the profile onto
 * the harness capability calibration with pure, tested rules:
 * - structuredJson false / toolCalling false → jsonReliability 'low'
 *   (harness answers with A0 deterministic composition + bounded repair),
 * - spatialPlanning calibration stays 'unknown' unless a benchmark overrode it
 *   (conservative default per product decision).
 */
export function calibrationFromProfile(profile: ModelCapabilityProfile | null | undefined): {
  jsonReliability: 'low' | 'medium' | 'high'
  spatialPlanning: 'unknown' | 'weak' | 'medium' | 'strong'
} {
  if (!profile) return { jsonReliability: 'medium', spatialPlanning: 'unknown' }
  const jsonReliability =
    profile.confidence === 'probed' && (!profile.structuredJson || !profile.toolCalling)
      ? 'low'
      : profile.structuredJson
        ? 'medium'
        : 'low'
  return { jsonReliability, spatialPlanning: 'unknown' }
}
