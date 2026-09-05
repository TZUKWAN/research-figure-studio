import { describe, expect, it, vi } from 'vitest'

/**
 * AI-P0-04: prompt overrides are stored as versioned records. New saves carry
 * the current policy version; legacy plain-string entries are migrated on
 * read and marked stale so the UI can offer reset/migrate while the runtime
 * keeps machine invariants safe regardless.
 */

vi.mock('electron', () => {
  const handlers = new Map<string, unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: unknown) => {
      handlers.set(channel, handler)
    }),
  }
  return {
    default: { ipcMain, app: { getPath: () => '/tmp' }, nativeImage: {}, net: {}, shell: {} },
    ipcMain,
    app: { getPath: () => '/tmp' },
  }
})

vi.mock('@genoffice/ai-provider', () => ({
  AiCreditsError: class {},
  AiTimeoutError: class {},
  classifyAiError: () => 'UNKNOWN',
  isAiNetworkError: () => false,
  chatForProvider: vi.fn(),
  defaultAiSettings: () => ({ provider: 'custom', providers: {} }),
  assumedCapabilityProfile: (vision: boolean) => ({
    streaming: true,
    toolCalling: true,
    multiTurnTools: true,
    structuredJson: false,
    vision,
    confidence: 'assumed',
    probedAt: '',
    failures: {},
  }),
  probeModelCapabilities: vi.fn(),
  cloudToolsEnabled: () => true,
  resolveAiSettings: () => ({ provider: 'custom', providers: {} }),
  setRescueFetch: vi.fn(),
  streamForProvider: vi.fn(),
}))

vi.mock('@genoffice/ai-search', () => ({
  webSearch: vi.fn(),
  imageSearch: vi.fn(),
  ensureGenofficeLogin: vi.fn(),
  gskApiKey: vi.fn(),
  gskGenerateImage: vi.fn(),
  gskAnalyzeMedia: vi.fn(),
  hasGskAuth: vi.fn(),
}))

vi.mock('@genoffice/electron-utils', () => ({ fetchRemoteImage: vi.fn() }))
vi.mock('@genoffice/pptx-engine', () => ({
  addPicture: vi.fn(),
  editPictureSrcRect: vi.fn(),
  replacePictureBytes: vi.fn(),
}))
vi.mock('@genoffice/pptx-engine/identity', () => ({ matchesElementRef: vi.fn() }))
vi.mock('@genoffice/pptx-render', () => ({ EMU_PER_PX_96: 9525 }))
vi.mock('../src/main/session-state', () => ({
  pushHistory: vi.fn(),
  rebuildSlide: vi.fn(),
  scheduleHistoryNotify: vi.fn(),
  sessions: new Map(),
}))

const overridesFile: { value: unknown } = { value: {} }
vi.mock('node:fs', () => {
  const fs = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify(overridesFile.value),
    writeFileSync: (_p: unknown, data: string) => {
      overridesFile.value = JSON.parse(data)
    },
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: () => [],
    renameSync: vi.fn(),
    statSync: () => ({ size: 0 }),
  }
  return { ...fs, default: fs }
})

vi.mock('./i18n-main', () => ({ tm: (k: string) => k }))
vi.mock('../src/main/i18n-main', () => ({ tm: (k: string) => k }))

async function register() {
  const mod = await import('../src/main/ai-ipc')
  mod.registerAiIpc()
  const { ipcMain } = await import('electron')
  return (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>
}

describe('prompt override storage migration (AI-P0-04)', () => {
  it('set-override stores a versioned record; get-override-records returns it; get-overrides stays legacy-compatible', async () => {
    overridesFile.value = {}
    const calls = await register()
    const handlers = new Map(calls)
    const setOverride = handlers.get('prompts:set-override') as (
      e: unknown,
      id: string,
      text: string,
    ) => Promise<boolean>
    const getRecords = handlers.get('prompts:get-override-records') as () => Promise<
      Record<
        string,
        { policyVersion: number; content: string; createdAt: string; updatedAt: string }
      >
    >
    const getLegacy = handlers.get('prompts:get-overrides') as () => Promise<Record<string, string>>
    const getPolicyVersion = handlers.get('prompts:get-policy-version') as () => Promise<number>

    expect(await setOverride({}, 'research.semantic-planner', 'my policy')).toBe(true)
    const records = await getRecords()
    expect(records['research.semantic-planner']?.policyVersion).toBe(await getPolicyVersion())
    expect(records['research.semantic-planner']?.content).toBe('my policy')
    expect(records['research.semantic-planner']?.createdAt).toBeTruthy()
    // legacy view: plain string (Shell Settings keeps working)
    expect(await getLegacy()).toEqual({ 'research.semantic-planner': 'my policy' })
  })

  it('legacy plain-string files are migrated on read and reported stale', async () => {
    overridesFile.value = {
      'research.composition-designer': 'old full prompt with OUTPUT SCHEMA inside',
    }
    const calls = await register()
    const handlers = new Map(calls)
    const getRecords = handlers.get('prompts:get-override-records') as () => Promise<
      Record<string, { policyVersion: number; content: string }>
    >
    const records = await getRecords()
    const record = records['research.composition-designer']
    expect(record?.content).toContain('old full prompt')
    expect(record?.policyVersion).toBeLessThan(
      await (handlers.get('prompts:get-policy-version') as () => Promise<number>)(),
    )
    // and normalizeStoredOverrides marks it stale (renderer offers reset/migrate)
    const { normalizeStoredOverrides, overrideIsStale } =
      await import('../src/shared/prompt-protocol')
    const normalized = normalizeStoredOverrides(await getRecords())
    expect(overrideIsStale(normalized['research.composition-designer']!)).toBe(true)
  })

  it('clear-override deletes the record', async () => {
    overridesFile.value = {
      'qc.visual': {
        id: 'qc.visual',
        policyVersion: 2,
        content: 'x',
        createdAt: '',
        updatedAt: '',
      },
    }
    const calls = await register()
    const handlers = new Map(calls)
    const clear = handlers.get('prompts:clear-override') as (
      e: unknown,
      id: string,
    ) => Promise<boolean>
    expect(await clear({}, 'qc.visual')).toBe(true)
    expect(overridesFile.value).toEqual({})
  })
})
