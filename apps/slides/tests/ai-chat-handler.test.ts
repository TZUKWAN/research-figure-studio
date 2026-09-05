/**
 * Regression for the Shell settings "Test connection" probe: a previous round
 * added HomeApi.testAiSettings, the Shell preload, and SettingsModal wiring
 * that all invoke 'ai:chat' — but the corresponding ipcMain.handle('ai:chat')
 * was never registered. The settings UI therefore raised
 *   Error: No handler registered for 'ai:chat'
 * These tests stand up a tiny ipcMain shim, call registerAiIpc(), then drive
 * the captured 'ai:chat' handler with the same AiChatRequest shape the
 * preload sends, asserting it routes through chatForProvider and returns the
 * expected AiChatResponse contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown> | unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  app: { getPath: () => '/tmp/metis-ai-chat-test' },
  net: { fetch: vi.fn() },
  nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  shell: { openExternal: vi.fn() },
}))

vi.mock('../src/main/i18n-main', () => ({
  tm: (key: string, vars?: Record<string, unknown>) => {
    if (key === 'errGskNotLoggedIn') return 'gsk-not-logged-in'
    if (key === 'errNoApiKey') return `no-api-key:${String(vars?.provider ?? '')}`
    if (key === 'errNoModel') return 'no-model'
    return key
  },
}))

const chatForProvider = vi.fn()
vi.mock('@genoffice/ai-provider', async () => {
  const actual =
    await vi.importActual<typeof import('@genoffice/ai-provider')>('@genoffice/ai-provider')
  return {
    ...actual,
    chatForProvider: (provider: unknown, config: unknown, system: string, user: string) =>
      chatForProvider(provider, config, system, user),
  }
})

vi.mock('@genoffice/ai-search', () => ({
  gskApiKey: () => 'gsk-from-cli',
  webSearch: vi.fn(),
  imageSearch: vi.fn(),
  ensureGenofficeLogin: vi.fn(),
  hasGskAuth: () => false,
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
}))

vi.mock('@genoffice/electron-utils', () => ({
  fetchRemoteImage: vi.fn(),
}))

vi.mock('@genoffice/pptx-engine', () => ({
  addPicture: vi.fn(),
  editPictureSrcRect: vi.fn(),
  replacePictureBytes: vi.fn(),
}))

vi.mock('@genoffice/pptx-engine/identity', () => ({
  matchesElementRef: () => false,
}))

vi.mock('../src/main/session-state', () => ({
  pushHistory: vi.fn(),
  rebuildSlide: vi.fn(),
  scheduleHistoryNotify: vi.fn(),
  sessions: new Map(),
}))

import { registerAiIpc } from '../src/main/ai-ipc'
import type { AiSettings } from '@genoffice/ai-provider'

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'anthropic',
    providers: {
      anthropic: { apiKey: 'sk-test', model: 'claude-sonnet-5' },
      genspark: { apiKey: '', model: 'gpt-5.2' },
    },
    ...over,
  } as AiSettings
}

beforeEach(() => {
  handlers.clear()
  chatForProvider.mockReset()
  // import the module once after vi.mock setup so it picks up the shim
  registerAiIpc()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ai:chat IPC handler', () => {
  it('is registered alongside the other generic ai:* channels', () => {
    expect(handlers.has('ai:chat')).toBe(true)
    expect(handlers.has('ai:stream')).toBe(true)
    expect(handlers.has('ai:get-settings')).toBe(true)
    expect(handlers.has('ai:set-settings')).toBe(true)
    expect(handlers.has('ai:probe-models')).toBe(true)
  })

  it('publishes built-in research prompts along with their editable defs', async () => {
    const handler = handlers.get('prompts:defaults')!
    const result = (await handler({}, {})) as {
      agent: Record<string, string>
      defs: Array<{ id: string }>
    }
    // AI-P0-03: defaults are the EDITABLE POLICY layer only — the machine
    // output schema is generated (prompt-protocol.ts) and never shipped as
    // user-editable text.
    expect(result.agent['research.semantic-planner']).toContain('expressionMode')
    expect(result.agent['research.semantic-planner']).toContain('Semantic Planner')
    expect(result.agent['research.semantic-planner']).not.toContain('OUTPUT SCHEMA')
    expect(result.agent['research.composition-designer']).toContain('Composition Designer')
    expect(result.agent['research.composition-designer']).not.toContain('OUTPUT SCHEMA')
    expect(result.defs.map((d) => d.id)).toContain('research.semantic-planner')
    expect(result.defs.map((d) => d.id)).toContain('research.composition-designer')
  })

  it('passes a successful chatForProvider result through to the caller', async () => {
    chatForProvider.mockResolvedValue({ ok: true, content: 'OK' })
    const handler = handlers.get('ai:chat')!
    const result = await handler(
      {},
      {
        settings: settings(),
        system: 'You are a connectivity test. Reply with the single word OK.',
        user: 'ping',
      },
    )
    expect(chatForProvider).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ apiKey: 'sk-test', model: 'claude-sonnet-5' }),
      'You are a connectivity test. Reply with the single word OK.',
      'ping',
    )
    expect(result).toEqual({ ok: true, content: 'OK' })
  })

  it('forwards a chatForProvider failure as a failed AiChatResponse', async () => {
    chatForProvider.mockResolvedValue({ ok: false, error: 'Claude HTTP 401' })
    const handler = handlers.get('ai:chat')!
    const result = await handler({}, { settings: settings(), system: 's', user: 'u' })
    expect(result).toEqual({ ok: false, error: 'Claude HTTP 401' })
  })

  it('reports the no-api-key error without calling chatForProvider', async () => {
    const handler = handlers.get('ai:chat')!
    const result = await handler(
      {},
      {
        settings: settings({
          provider: 'anthropic',
          providers: {
            anthropic: { apiKey: '', model: 'claude-sonnet-5' },
          } as AiSettings['providers'],
        }),
        system: 's',
        user: 'u',
      },
    )
    expect(chatForProvider).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'no-api-key:anthropic' })
  })

  it('reports the no-model error without calling chatForProvider', async () => {
    const handler = handlers.get('ai:chat')!
    const result = await handler(
      {},
      {
        settings: settings({
          providers: { anthropic: { apiKey: 'sk-test', model: '' } } as AiSettings['providers'],
        }),
        system: 's',
        user: 'u',
      },
    )
    expect(chatForProvider).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'no-model' })
  })

  it('falls back to gskApiKey when the active provider is genspark with no key', async () => {
    chatForProvider.mockResolvedValue({ ok: true, content: 'OK' })
    const handler = handlers.get('ai:chat')!
    await handler(
      {},
      {
        settings: settings({
          provider: 'genspark',
          providers: { genspark: { apiKey: '', model: 'gpt-5.2' } } as AiSettings['providers'],
        }),
        system: 's',
        user: 'u',
      },
    )
    expect(chatForProvider).toHaveBeenCalledWith(
      'genspark',
      expect.objectContaining({ apiKey: 'gsk-from-cli', model: 'gpt-5.2' }),
      's',
      'u',
    )
  })

  it('catches unexpected throwers and returns a failed AiChatResponse', async () => {
    chatForProvider.mockRejectedValue(new Error('boom'))
    const handler = handlers.get('ai:chat')!
    const result = await handler({}, { settings: settings(), system: 's', user: 'u' })
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})
