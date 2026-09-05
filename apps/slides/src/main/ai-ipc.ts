/**
 * AI IPC for the slides main process, extracted from slides-main.ts:
 * settings persistence, the streaming proxy (main process does the networking
 * to avoid renderer CORS), search tools, and the slides-only ai:* channels
 * (image generation, media analysis, style templates).
 */
import { app, ipcMain, nativeImage, net } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  AiCreditsError,
  AiTimeoutError,
  classifyAiError,
  isAiNetworkError,
  assumedCapabilityProfile,
  chatForProvider,
  defaultAiSettings,
  probeModelCapabilities,
  cloudToolsEnabled,
  resolveAiSettings,
  setRescueFetch,
  streamForProvider,
  type AiChatRequest,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type LegacyAiSettings,
  type ModelCapabilityProfile,
} from '@genoffice/ai-provider'
import { fetchRemoteImage } from '@genoffice/electron-utils'
import {
  webSearch,
  imageSearch,
  gskApiKey,
  gskGenerateImage,
  gskAnalyzeMedia,
  hasGskAuth,
} from '@genoffice/ai-search'
import { addPicture, editPictureSrcRect, replacePictureBytes } from '@genoffice/pptx-engine'
import { matchesElementRef } from '@genoffice/pptx-engine/identity'
import { coverCropFractions } from '../shared/cover-crop'
import {
  AGENT_SYSTEM_PROMPT,
  QC_GEOMETRY_SYSTEM_PROMPT,
  QC_VISUAL_SYSTEM_PROMPT,
  RESEARCH_AGENT_SYSTEM_PROMPT,
  RESEARCH_COMPOSITION_DESIGNER_POLICY,
  RESEARCH_SEMANTIC_PLANNER_POLICY,
  PROMPT_DEFS,
  type PromptDef,
} from '../shared/prompt-defaults'
import {
  RESEARCH_PROMPT_POLICY_VERSION,
  normalizeStoredOverrides,
  type PromptOverrideRecord,
} from '../shared/prompt-protocol'
import type { AiRunFailure } from '../shared/ipc'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'
import { tm } from './i18n-main'
import { pushHistory, rebuildSlide, scheduleHistoryNotify, sessions } from './session-state'

// ---- AI settings + streaming proxy (the main process does the networking to avoid renderer CORS; implementation shared via @genoffice/ai-provider) ----

const AI_SETTINGS_PATH = () => join(app.getPath('userData'), 'ai-settings.json')

/** live read: the shell settings pane writes the file; every tool call re-checks */
function gskCloudToolsOn(): boolean {
  return cloudToolsEnabled(readJson<Partial<AiSettings>>(AI_SETTINGS_PATH(), {}))
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* Corrupted state file: fall back to defaults */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const activeAiStreams = new Map<string, AbortController>()

// ---- Post-mortem log for runs that produced no usable reply ----

const AI_RUN_FAILURES_PATH = () => join(app.getPath('userData'), 'ai-run-failures.jsonl')
/** Enough of a repetition blowup to recognize the pattern, without storing megabytes */
const RUN_FAILURE_TEXT_MAX = 20_000
/** Rotated (one generation kept) rather than grown without bound */
const RUN_FAILURES_MAX_BYTES = 2_000_000

function appendRunFailure(entry: AiRunFailure): void {
  const path = AI_RUN_FAILURES_PATH()
  try {
    if (existsSync(path) && statSync(path).size > RUN_FAILURES_MAX_BYTES) {
      renameSync(path, `${path}.1`)
    }
    const record = {
      ts: new Date().toISOString(),
      ...entry,
      instruction: entry.instruction.slice(0, RUN_FAILURE_TEXT_MAX),
      streamed: entry.streamed.slice(0, RUN_FAILURE_TEXT_MAX),
      streamedChars: entry.streamed.length,
    }
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    /* Diagnostics must never break a run */
  }
}

// ── ai:set-settings runtime validation (audit DESKTOP-P0-02) ─────────────
// The renderer's payload crosses the preload boundary untrusted: a corrupted
// or hostile settings object used to be written verbatim and replayed into
// every later provider request. Validators below keep the known shape,
// hard-cap every string, and enforce http(s) base URLs (plain http only for
// loopback hosts — local LLM servers — matching the BYOK URL policy).

const SETTINGS_STRING_MAX = 8_192
const SETTINGS_TOKEN_MAX = 10_000_000

function sanitizedProviderEntry(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['apiKey', 'model']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || raw[key].length > SETTINGS_STRING_MAX) return null
      out[key] = raw[key]
    }
  }
  if (raw.baseUrl !== undefined && raw.baseUrl !== '') {
    if (typeof raw.baseUrl !== 'string' || raw.baseUrl.length > 2048) return null
    try {
      const url = new URL(raw.baseUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) return null
    } catch {
      return null
    }
    out.baseUrl = raw.baseUrl
  }
  if (raw.vision !== undefined) {
    if (typeof raw.vision !== 'boolean') return null
    out.vision = raw.vision
  }
  for (const key of ['maxContextTokens', 'maxOutputTokens']) {
    if (raw[key] !== undefined) {
      if (
        typeof raw[key] !== 'number' ||
        !Number.isSafeInteger(raw[key]) ||
        raw[key] < 0 ||
        raw[key] > SETTINGS_TOKEN_MAX
      ) {
        return null
      }
      out[key] = raw[key]
    }
  }
  return out
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1' ||
    h.endsWith('.localhost')
  )
}

/** Returns a sanitized AiSettings-compatible object, or null when the payload is not acceptable. */
function validateAiSettings(raw: unknown): AiSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  if (typeof input.provider !== 'string' || input.provider.length > 64) return null
  if (
    typeof input.providers !== 'object' ||
    input.providers === null ||
    Array.isArray(input.providers)
  ) {
    return null
  }
  const providers: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(input.providers as Record<string, unknown>)) {
    if (id.length > 64) return null
    if (entry === undefined) continue
    const clean = sanitizedProviderEntry(entry)
    if (clean === null) return null
    providers[id] = clean
  }
  const out: Record<string, unknown> = { provider: input.provider, providers }
  if (input.gskToolsEnabled !== undefined) {
    if (typeof input.gskToolsEnabled !== 'boolean') return null
    out.gskToolsEnabled = input.gskToolsEnabled
  }
  return out as unknown as AiSettings
}

export function registerAiIpc(): void {
  // Node fetch (undici) direct connections get reset under VPN/tun setups; retry over Chromium's stack
  setRescueFetch((url, init) => net.fetch(url, init))

  ipcMain.handle('ai:get-settings', (): AiSettings => {
    const stored = readJson<Partial<AiSettings> & LegacyAiSettings>(AI_SETTINGS_PATH(), {})
    return resolveAiSettings(stored, defaultAiSettings())
  })

  ipcMain.handle('ai:set-settings', (_event, settings: unknown) => {
    // Runtime validation before persistence: the renderer side of the preload
    // boundary is untrusted data (audit DESKTOP-P0-02). Invalid payloads are
    // dropped, keeping the last known-good settings file.
    const clean = validateAiSettings(settings)
    if (!clean) return false
    writeJson(AI_SETTINGS_PATH(), clean)
    return true
  })

  // ── Standards (Settings): user-editable AI drawing prompts ──
  // Only prompt POLICY text is editable here; the machine protocol of the
  // research pipeline prompts is generated (prompt-protocol.ts) and always
  // re-appended, so an override can never delete it. Layout rules, the
  // Component Registry and QA thresholds stay code-owned. Overrides live in
  // userData/prompt-overrides.json as versioned records (legacy plain-string
  // entries are migrated on read).
  const PROMPT_OVERRIDES_PATH = () => join(app.getPath('userData'), 'prompt-overrides.json')

  const readPromptOverrides = (): Record<string, PromptOverrideRecord> =>
    normalizeStoredOverrides(readJson<Record<string, unknown>>(PROMPT_OVERRIDES_PATH(), {}))

  ipcMain.handle('prompts:defaults', () => ({
    agent: {
      'agent.presentation': AGENT_SYSTEM_PROMPT,
      'agent.research': RESEARCH_AGENT_SYSTEM_PROMPT,
      'qc.visual': QC_VISUAL_SYSTEM_PROMPT,
      'qc.geometry': QC_GEOMETRY_SYSTEM_PROMPT,
      // editable POLICY defaults; the machine protocol is generated at runtime
      'research.semantic-planner': RESEARCH_SEMANTIC_PLANNER_POLICY,
      'research.composition-designer': RESEARCH_COMPOSITION_DESIGNER_POLICY,
    },
    defs: PROMPT_DEFS,
  }))

  /** legacy-compatible view: plain id → content map (Shell Settings reads this) */
  ipcMain.handle('prompts:get-overrides', (): Record<string, string> => {
    const records = readPromptOverrides()
    const out: Record<string, string> = {}
    for (const [id, record] of Object.entries(records)) out[id] = record.content
    return out
  })

  /** versioned view: lets the renderer know which overrides predate the current policy version */
  ipcMain.handle('prompts:get-override-records', (): Record<string, PromptOverrideRecord> =>
    readPromptOverrides(),
  )

  ipcMain.handle('prompts:get-policy-version', (): number => RESEARCH_PROMPT_POLICY_VERSION)

  ipcMain.handle('prompts:set-override', (_event, id: unknown, text: unknown) => {
    if (typeof id !== 'string' || typeof text !== 'string') return false
    const def: PromptDef | undefined = PROMPT_DEFS.find((d) => d.id === id)
    if (!def) return false
    const records = readPromptOverrides()
    const existing = records[id]
    const now = new Date().toISOString()
    records[id] = {
      id,
      policyVersion: RESEARCH_PROMPT_POLICY_VERSION,
      content: text,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    writeJson(PROMPT_OVERRIDES_PATH(), records)
    return true
  })

  ipcMain.handle('prompts:clear-override', (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    const records = readPromptOverrides()
    delete records[id]
    writeJson(PROMPT_OVERRIDES_PATH(), records)
    return true
  })

  // ── Model capability profiles (AI-P0-06) ──
  // Probed once per configured model; the research pipeline consults the
  // profile instead of assuming "the model should support tools".
  const CAPABILITY_PROFILES_PATH = () =>
    join(app.getPath('userData'), 'ai-capability-profiles.json')

  const capabilityProfileKey = (provider: string, model: string): string => `${provider}::${model}`

  const readCapabilityProfiles = (): Record<string, ModelCapabilityProfile> =>
    readJson<Record<string, ModelCapabilityProfile>>(CAPABILITY_PROFILES_PATH(), {})

  ipcMain.handle(
    'ai:get-capability-profile',
    (_event, query: { provider: string; model: string }): ModelCapabilityProfile | null => {
      const key = capabilityProfileKey(String(query?.provider ?? ''), String(query?.model ?? ''))
      return readCapabilityProfiles()[key] ?? null
    },
  )

  ipcMain.handle(
    'ai:probe-capabilities',
    async (
      _event,
      query: {
        provider: string
        config: { apiKey: string; model: string; baseUrl?: string }
        vision: boolean
      },
    ): Promise<{ ok: boolean; profile?: ModelCapabilityProfile; error?: string }> => {
      const provider = String(
        query?.provider ?? '',
      ) as import('@genoffice/ai-provider').AiProviderId
      const config = query?.config
      if (!provider || !config?.model) return { ok: false, error: 'missing provider/model' }
      try {
        const profileResult = await probeModelCapabilities(provider, config, query.vision === true)
        const profiles = readCapabilityProfiles()
        profiles[capabilityProfileKey(provider, config.model)] = profileResult
        writeJson(CAPABILITY_PROFILES_PATH(), profiles)
        return { ok: true, profile: profileResult }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  /** assumed (unprobed) profile shape for UIs that only need the conservative default */
  ipcMain.handle('ai:assumed-capability-profile', (_event, vision: boolean) =>
    assumedCapabilityProfile(vision === true),
  )

  // Model discovery for custom OpenAI-compatible endpoints: GET {baseUrl}/models.
  // Returns model ids; when the listing carries metadata (OpenRouter-style
  // context_length / max_completion_tokens) it is passed through so the
  // settings UI can auto-fill context/output ceilings.
  ipcMain.handle(
    'ai:probe-models',
    async (
      _event,
      query: { baseUrl: string; apiKey: string },
    ): Promise<{
      ok: boolean
      models?: { id: string; contextLength?: number; maxOutputTokens?: number }[]
      error?: string
    }> => {
      const base = String(query?.baseUrl ?? '')
        .trim()
        .replace(/\/+$/, '')
      if (!base) return { ok: false, error: 'missing base URL' }
      // BYOK URL policy (audit DESKTOP-P1-07): http(s) only; plain http is
      // reserved for loopback endpoints (local LLM servers). file:, ftp: and
      // data: probes never reach net.fetch.
      try {
        const parsed = new URL(base)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return { ok: false, error: 'only http(s) base URLs are supported' }
        }
        if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
          return { ok: false, error: 'plain http is only supported for local endpoints' }
        }
      } catch {
        return { ok: false, error: 'invalid base URL' }
      }
      try {
        const res = await net.fetch(`${base}/models`, {
          headers: {
            Accept: 'application/json',
            ...(query.apiKey ? { Authorization: `Bearer ${query.apiKey}` } : {}),
          },
        })
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
        const body = (await res.json()) as {
          data?: Array<{
            id?: string
            context_length?: number
            max_completion_tokens?: number
            top_provider?: { context_length?: number; max_completion_tokens?: number }
          }>
        }
        const models = (body.data ?? [])
          .filter((m) => typeof m.id === 'string' && m.id && m.id.length <= 256)
          .slice(0, 500)
          .map((m) => ({
            id: m.id as string,
            contextLength: m.context_length ?? m.top_provider?.context_length,
            maxOutputTokens: m.max_completion_tokens ?? m.top_provider?.max_completion_tokens,
          }))
        return { ok: true, models }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('ai:log-run-failure', (_event, entry: AiRunFailure) => {
    appendRunFailure(entry)
  })

  // One-shot connectivity probe used by the Shell settings "Test connection" button.
  // Mirrors the input-validation + genspark key fallback from ai:stream but returns a
  // single AiChatResponse instead of streaming chunks.
  ipcMain.handle('ai:chat', async (_event, request: AiChatRequest) => {
    const provider = request?.settings?.provider
    let config = provider ? request.settings.providers?.[provider] : undefined
    if (provider === 'genspark' && config && !config.apiKey) {
      config = { ...config, apiKey: gskApiKey() }
    }
    if (!config?.apiKey) {
      return {
        ok: false,
        error: provider === 'genspark' ? tm('errGskNotLoggedIn') : tm('errNoApiKey', { provider }),
      }
    }
    if (!config.model) {
      return { ok: false, error: tm('errNoModel') }
    }
    try {
      const result = await chatForProvider(
        provider,
        config,
        String(request.system ?? ''),
        String(request.user ?? ''),
      )
      if (!result.ok) {
        console.error(`[ai-chat] (${provider}/${config.model}) failed:`, result.error)
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ai-chat] (${provider}/${config.model}) failed:`, msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('ai:stream', async (event, request: AiStreamRequest) => {
    const { requestId, settings, system, messages } = request
    const tools = request.tools ?? []
    const maxTokens = request.maxTokens ?? 8192
    const provider = settings.provider
    let config = settings.providers?.[provider]
    // The genspark key never enters the settings file; it is fetched from the gsk login state per request
    if (provider === 'genspark' && config && !config.apiKey) {
      config = { ...config, apiKey: gskApiKey() }
    }
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    if (!config?.apiKey) {
      send({
        requestId,
        type: 'error',
        error: provider === 'genspark' ? tm('errGskNotLoggedIn') : tm('errNoApiKey', { provider }),
      })
      return
    }
    if (!config.model) {
      send({ requestId, type: 'error', error: tm('errNoModel') })
      return
    }
    const controller = new AbortController()
    activeAiStreams.set(requestId, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      // jsonSchema (AI-P0-01): provider-native structured output enforcement
      // with a per-protocol plain retry on rejection. The renderer still
      // validates — the schema is a carrier, not a trust boundary.
      await streamForProvider(
        provider,
        config,
        system,
        messages,
        tools,
        maxTokens,
        {
          signal: controller.signal,
          onDelta: (text) => send({ requestId, type: 'delta', text }),
          onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
          onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
          onActivity: ping,
        },
        request.jsonSchema ? { jsonSchema: request.jsonSchema } : undefined,
      )
      send({ requestId, type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ai-stream] ${requestId} (${provider}/${config.model}) failed:`, msg)
        send({
          requestId,
          type: 'error',
          error: msg,
          ...(err instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : err instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : isAiNetworkError(err)
                ? { errorCode: 'network' as const }
                : {}),
          // unified taxonomy code (AI-P1-12): machine-readable beyond the localized message
          aiErrorCode: classifyAiError(err),
        })
      }
    } finally {
      activeAiStreams.delete(requestId)
    }
  })

  ipcMain.handle('ai:stream-cancel', (_event, requestId: string) => {
    activeAiStreams.get(requestId)?.abort()
  })

  // Search tools (content + images), Serper with DuckDuckGo fallback
  ipcMain.handle('ai:web-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await webSearch(
        String(query),
        typeof maxResults === 'number' ? maxResults : 6,
        gskCloudToolsOn(),
      )
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })

  ipcMain.handle('ai:image-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await imageSearch(
        String(query),
        typeof maxResults === 'number' ? maxResults : 8,
        gskCloudToolsOn(),
      )
    } catch (err) {
      return { images: [], method: 'error', error: String(err) }
    }
  })
}

// ── ai:* handlers unique to slides ──────────────────────────────────────
// Must be registered inside registerSlidesIpc (not registerAiIpc): in shell aggregate mode the
// generic ai:* channels are registered by the shell's registerSlidesAiIpc import, and slides'
// registerAiIpc is never called; these slides-only channels must stay here or Electron raises
// "No handler registered".
export function registerSlidesOnlyAiIpc(): void {
  // gsk (Genspark CLI) capabilities: AI image generation / media analysis. Returns an error prompt when not logged in.
  ipcMain.handle(
    'ai:generate-image',
    async (
      _event,
      op: {
        prompt: string
        model?: string
        referenceImageUrls?: string[]
        aspectRatio?: string
        imageSize?: string
      },
    ) => {
      if (!hasGskAuth()) return { error: tm('errGskCli') }
      if (!gskCloudToolsOn())
        return {
          error: 'Cloud tools are turned off in Settings (AI Model); enable them to use this tool',
        }
      try {
        const r = await gskGenerateImage({
          prompt: String(op.prompt),
          model: op.model ? String(op.model) : undefined,
          referenceImageUrls: Array.isArray(op.referenceImageUrls)
            ? op.referenceImageUrls.map(String)
            : undefined,
          aspectRatio: op.aspectRatio ? String(op.aspectRatio) : undefined,
          imageSize: op.imageSize ? String(op.imageSize) : undefined,
        })
        return { url: r.url }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    'ai:analyze-media',
    async (_event, op: { mediaUrls: string[]; requirements: string }) => {
      if (!hasGskAuth()) return { error: tm('errGskCli') }
      if (!gskCloudToolsOn())
        return {
          error: 'Cloud tools are turned off in Settings (AI Model); enable them to use this tool',
        }
      try {
        const text = await gskAnalyzeMedia({
          mediaUrls: (op.mediaUrls ?? []).map(String),
          requirements: String(op.requirements ?? ''),
        })
        return { text }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Download an image from a URL and insert it into the given page (image search -> insert in one step; download in the main process avoids CORS)
  ipcMain.handle(
    'ai:insert-image-url',
    async (
      e,
      op: {
        slideIndex: number
        url: string
        xPx: number
        yPx: number
        wPx: number
        hPx: number
        fitWidthPx: number
      },
    ) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      try {
        // the URL originates from AI tool calls (prompt-injectable via image
        // search results), so refuse non-http schemes and private/link-local
        // targets; redirects are followed manually so every hop is validated.
        // fetchRemoteImage adds CDN-friendly headers and transient-error retries.
        const resp = await fetchRemoteImage(String(op.url))
        if (!resp || !resp.ok) return null
        const buf = Buffer.from(await resp.arrayBuffer())
        const ct = resp.headers.get('content-type') ?? ''
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg'
        const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
        const scale = op.fitWidthPx / baseWidthPx
        const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
        pushHistory(session)
        const el = addPicture(session.opened, slide, {
          bytes: new Uint8Array(buf),
          ext,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
        })
        if (!el) {
          session.undoStack.pop()
          scheduleHistoryNotify(session)
          return null
        }
        // The requested frame rarely matches the image's aspect ratio; never
        // stretch — fill the frame and center-crop the overflow (object-fit:
        // cover) so the layout box stays exactly where the model placed it.
        const natural = nativeImage.createFromBuffer(buf).getSize()
        const crop = coverCropFractions(natural.width, natural.height, op.wPx, op.hPx)
        if (crop) editPictureSrcRect(slide, el.id, crop)
        session.fitWidthPx = op.fitWidthPx
        const rebuilt = rebuildSlide(session, op.slideIndex)
        return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
      } catch {
        return null
      }
    },
  )

  // Download an image from a URL and swap it into an existing picture in place
  // (frame/z-order/effects survive). Same URL hardening as ai:insert-image-url.
  ipcMain.handle(
    'ai:replace-picture-url',
    async (e, op: { slideIndex: number; sourceId: string; url: string; keepSrcRect?: boolean }) => {
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      // The AI layer may address the picture by its durable id — translate to the
      // parse-time id the engine matches
      const targetId =
        slide.elements.find((el) => matchesElementRef(el, String(op.sourceId)))?.id ??
        String(op.sourceId)
      try {
        const resp = await fetchRemoteImage(String(op.url))
        if (!resp || !resp.ok) return null
        const buf = Buffer.from(await resp.arrayBuffer())
        const ct = resp.headers.get('content-type') ?? ''
        const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg'
        pushHistory(session)
        const ok = replacePictureBytes(
          session.opened,
          slide,
          targetId,
          new Uint8Array(buf),
          ext,
          op.keepSrcRect ? { keepSrcRect: true } : undefined,
        )
        if (!ok) {
          session.undoStack.pop()
          scheduleHistoryNotify(session)
          return null
        }
        // A replacement with a different aspect ratio would be stretched into
        // the surviving frame — center-crop it to cover the frame instead.
        if (!op.keepSrcRect) {
          const pic = slide.elements.find((el) => el.id === targetId && el.type === 'picture')
          const frame = pic?.transform?.offset
          if (frame) {
            const natural = nativeImage.createFromBuffer(buf).getSize()
            const crop = coverCropFractions(natural.width, natural.height, frame.cx, frame.cy)
            if (crop) editPictureSrcRect(slide, targetId, crop)
          }
        }
        return rebuildSlide(session, op.slideIndex)
      } catch {
        return null
      }
    },
  )

  // ── Style Skill sidecar persistence: write a same-named .styleskill.json next to the draft (fail-open)
  ipcMain.handle(
    'ai:save-sidecar',
    async (
      event,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): Promise<{ ok: boolean }> => {
      try {
        const session = sessions.get(event.sender.id)
        const draftPath = session?.path
        if (!draftPath || !draftPath.endsWith('.pptx')) return { ok: false }
        const sidecarPath = draftPath.replace(/\.pptx$/i, '.styleskill.json')
        writeFileSync(sidecarPath, JSON.stringify(data, null, 2))
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  )

  // ── Style template save: stored in userData/style-templates/<name>.json
  const STYLE_TEMPLATES_DIR = () => join(app.getPath('userData'), 'style-templates')

  ipcMain.handle(
    'ai:save-style-template',
    (
      _event,
      name: string,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): { ok: boolean; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        mkdirSync(dir, { recursive: true })
        // Filename: replace illegal characters in the name with _ then truncate to 64 chars
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        if (!safeName) return { ok: false, error: tm('errTplNameInvalid') }
        writeJson(join(dir, `${safeName}.json`), { ...data, name: safeName })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // ── Style template list
  ipcMain.handle(
    'ai:list-style-templates',
    (): Array<{ name: string; topic: string; createdAt: string }> => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        if (!existsSync(dir)) return []
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
        return files
          .map((f) => {
            try {
              const raw = readJson<{
                name?: string
                topic?: string
                createdAt?: string
                styleSkill?: string
              }>(join(dir, f), {})
              return {
                name: raw.name ?? f.replace(/\.json$/, ''),
                topic: raw.topic ?? '',
                createdAt: raw.createdAt ?? '',
              }
            } catch {
              return null
            }
          })
          .filter(Boolean) as Array<{ name: string; topic: string; createdAt: string }>
      } catch {
        return []
      }
    },
  )

  // ── Style template load
  ipcMain.handle(
    'ai:load-style-template',
    (
      _event,
      name: string,
    ): { ok: boolean; styleSkill?: string; topic?: string; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        const filePath = join(dir, `${safeName}.json`)
        if (!existsSync(filePath)) return { ok: false, error: tm('errTplMissing', { name }) }
        const raw = readJson<{ styleSkill?: string; topic?: string }>(filePath, {})
        if (!raw.styleSkill) return { ok: false, error: tm('errTplNoSkill', { name }) }
        return { ok: true, styleSkill: raw.styleSkill, topic: raw.topic ?? '' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
