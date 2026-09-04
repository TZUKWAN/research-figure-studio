import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Dropdown } from '@genoffice/ui'
import type { AiSettings } from '@genoffice/ai-provider'
import { useI18n } from './locale'
import type { StringKey, TFunc } from './locale'
import type { AiCatalogEntry, UiTheme } from '../../shared/home-api'
import { ProviderLogo } from './provider-logos'
import './settings.css'

// ── Settings modal (opened from the settings entry) ───────
// Two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

// GenMail's option order: follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

const CHANNEL_OPTIONS = [
  { value: 'stable', labelKey: 'channelStable' },
  { value: 'beta', labelKey: 'channelBeta' },
] as const satisfies readonly { value: 'stable' | 'beta'; labelKey: StringKey }[]

type SectionId = 'aiModel' | 'standards' | 'general'

const SECTIONS: readonly { id: SectionId; labelKey: StringKey }[] = [
  { id: 'aiModel', labelKey: 'setSecAiModel' },
  { id: 'standards', labelKey: 'setSecStandards' },
  { id: 'general', labelKey: 'setSecGeneral' },
]

function SectionIcon({ id }: { id: SectionId }) {
  if (id === 'aiModel') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M12.8 11.2v3M11.3 12.7h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'standards') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3 3.5h10M3 3.5v9M3 12.5h6M13 3.5V9a1.5 1.5 0 0 1-1.5 1.5H8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  return null
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/** Standards pane: view / edit / reset the AI drawing prompt text. Only prompt
 * TEXT is editable 鈥?layout rules, the Component Registry and QA thresholds stay code-owned. */
function StandardsPane({ t, lang }: { t: TFunc; lang: string }) {
  const [defs, setDefs] = useState<
    { id: string; titleZh: string; titleEn: string; descZh: string; descEn: string }[]
  >([])
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.aiOffice.getPromptDefaults?.(),
      window.aiOffice.getPromptOverrides?.(),
    ])
      .then(([defaultsResult, overrideResult]) => {
        if (!alive) return
        setDefs(defaultsResult?.defs ?? [])
        setDefaults(defaultsResult?.agent ?? {})
        setOverrides(overrideResult ?? {})
        const first = defaultsResult?.defs?.[0]?.id ?? null
        setActiveId((cur) => cur ?? first)
      })
      .catch(() => setLoadError(true))
    return () => {
      alive = false
    }
  }, [])

  const active = defs.find((d) => d.id === activeId) ?? null
  const title = (d: { titleZh: string; titleEn: string }) => (lang === 'zh' ? d.titleZh : d.titleEn)
  const desc = (d: { descZh: string; descEn: string }) => (lang === 'zh' ? d.descZh : d.descEn)
  const isOverridden = active != null && overrides[active.id] != null

  const pick = (id: string) => {
    setActiveId(id)
    setDraft('')
    setSavedFlash(false)
  }
  const saveOverride = async () => {
    if (!active) return
    await window.aiOffice.setPromptOverride(active.id, draft)
    setOverrides((prev) => ({ ...prev, [active.id]: draft }))
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 2000)
  }
  const resetOverride = async () => {
    if (!active) return
    await window.aiOffice.clearPromptOverride(active.id)
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[active.id]
      return next
    })
    setDraft('')
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 2000)
  }

  if (loadError) {
    return (
      <>
        <h3 className="set-pane-title">{t('setSecStandards')}</h3>
        <p className="set-field-desc">{t('setStandardsLoadError')}</p>
      </>
    )
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecStandards')}</h3>
      <div className="set-field-desc set-ai-note">{t('setStandardsNote')}</div>
      <div className="set-standards">
        <nav className="set-standards-list" aria-label={t('setSecStandards')}>
          {defs.map((d) => (
            <button
              key={d.id}
              className={`set-nav-item${activeId === d.id ? ' active' : ''}`}
              aria-current={activeId === d.id}
              onClick={() => pick(d.id)}
            >
              {title(d)}
              {overrides[d.id] != null && <span className="set-standards-modified">✎</span>}
            </button>
          ))}
        </nav>
        <div className="set-standards-editor">
          {active && (
            <>
              <div className="set-field-text">
                <div className="set-field-label">{title(active)}</div>
                <div className="set-field-desc">{desc(active)}</div>
              </div>
              <textarea
                className="set-prompt-editor"
                value={draft || overrides[active.id] || defaults[active.id] || ''}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
              <div className="set-pane-footer">
                {savedFlash && <span className="set-ai-status ok">{t('setAiSaved')}</span>}
                {isOverridden ? (
                  <button
                    className="set-btn"
                    onClick={() => {
                      void resetOverride()
                      setDraft('')
                    }}
                  >
                    {t('setStandardsReset')}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  className="set-btn primary"
                  disabled={
                    !draft.trim() || draft === (overrides[active.id] ?? defaults[active.id])
                  }
                  onClick={() => void saveOverride()}
                >
                  {t('setStandardsSave')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/** AI model pane: provider / model / key / base URL, saved to userData/ai-settings.json */
function AiModelPane({ t }: { t: TFunc }) {
  // presets were removed: the only offered provider is the user's own OpenAI-compatible endpoint
  const [catalog] = useState<AiCatalogEntry[]>(() =>
    (window.aiOffice.getAiProviders?.() ?? []).filter((c) => c.id === 'custom'),
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  // model discovery for custom endpoints
  const [probing, setProbing] = useState(false)
  const [probedModels, setProbedModels] = useState<
    { id: string; contextLength?: number; maxOutputTokens?: number }[]
  >([])

  useEffect(() => {
    let alive = true
    void window.aiOffice.getAiSettings?.().then((s) => {
      if (!alive || !s) return
      const provider = catalog.some((entry) => entry.id === s.provider) ? s.provider : 'custom'
      setSettings(provider === s.provider ? s : { ...s, provider })
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings) return null
  const provider = catalog.some((c) => c.id === settings.provider) ? settings.provider : 'custom'
  const meta = catalog.find((c) => c.id === provider)
  const config = settings.providers[provider] ?? {
    apiKey: '',
    model: meta?.defaultModel ?? '',
  }
  // effective base URL: unsaved input wins so probing works before saving
  const effectiveBaseUrl = config.baseUrl?.trim() || meta?.defaultBaseUrl || ''
  const modelOptions = Array.from(
    new Set([...(probedModels.map((m) => m.id) ?? []), ...(meta?.models ?? [])]),
  )

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResult(null)
  }
  const updateConfig = (patch: Partial<typeof config>) => {
    setSettings({
      ...settings,
      providers: { ...settings.providers, [provider]: { ...config, ...patch } },
    })
    touch()
  }
  const selectProvider = (id: AiSettings['provider']) => {
    setSettings({ ...settings, provider: id })
    setProbedModels([])
    touch()
  }
  const probe = async () => {
    setProbing(true)
    setTestResult(null)
    try {
      const r = await window.aiOffice.probeModels?.({
        baseUrl: effectiveBaseUrl,
        apiKey: config.apiKey,
      })
      if (r?.ok && r.models) {
        setProbedModels(r.models)
        const found = r.models.find((m) => m.id === config.model)
        if (found) {
          updateConfig({
            ...(found.contextLength ? { maxContextTokens: found.contextLength } : {}),
            ...(found.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}),
          })
        }
      } else {
        setTestResult({ ok: false, error: r?.error ?? 'Model discovery failed' })
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }
  const pickModel = (id: string) => {
    const found = probedModels.find((m) => m.id === id)
    updateConfig({
      model: id,
      ...(found?.contextLength ? { maxContextTokens: found.contextLength } : {}),
      ...(found?.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}),
    })
  }
  const save = () => {
    window.aiOffice
      .setAiSettings?.(settings)
      .then(() => {
        setDirty(false)
        setSaved(true)
      })
      .catch((error) => {
        window.alert(error instanceof Error ? error.message : String(error))
      })
  }
  const test = () => {
    setTesting(true)
    setTestResult(null)
    window.aiOffice
      .testAiSettings?.(settings)
      .then((r) => setTestResult(r ?? { ok: false }))
      .catch((error) =>
        setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setTesting(false))
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecAiModel')}</h3>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiProvider')}</label>
        </div>
        <Dropdown
          className="set-dd"
          value={provider}
          ariaLabel={t('setAiProvider')}
          options={catalog.map((c) => ({
            value: c.id,
            label: c.label,
            render: (
              <>
                <ProviderLogo id={c.id} />
                {c.label}
              </>
            ),
          }))}
          onPick={(v) => selectProvider(v as AiSettings['provider'])}
        />
      </div>
      <div className="set-field-desc set-ai-note">{t('setAiByokNote')}</div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiModelId')}</label>
        </div>
        <div className="set-model-row">
          <Dropdown
            className="set-dd"
            value={config.model || meta?.defaultModel || ''}
            ariaLabel={t('setAiModelId')}
            options={modelOptions.map((m) => ({ value: m, label: m }))}
            onPick={(m) => pickModel(String(m))}
          />
          <button
            className="set-btn"
            disabled={probing || !effectiveBaseUrl}
            onClick={() => void probe()}
          >
            {probing ? t('setAiProbing') : t('setAiProbe')}
          </button>
        </div>
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-ctx">
              {t('setAiMaxContext')}
            </label>
            <div className="set-field-desc">{t('setAiMaxContextHint')}</div>
          </div>
        </div>
        <input
          id="set-ai-ctx"
          className="set-input"
          type="number"
          min={512}
          step={512}
          value={config.maxContextTokens ?? ''}
          placeholder={t('setAiUnknown')}
          onChange={(e) =>
            updateConfig({
              maxContextTokens: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-maxout">
              {t('setAiMaxOutput')}
            </label>
            <div className="set-field-desc">{t('setAiMaxOutputHint')}</div>
          </div>
        </div>
        <input
          id="set-ai-maxout"
          className="set-input"
          type="number"
          min={128}
          step={128}
          value={config.maxOutputTokens ?? ''}
          placeholder={t('setAiUnknown')}
          onChange={(e) =>
            updateConfig({
              maxOutputTokens: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('setAiVision')}</div>
            <div className="set-field-desc">{t('setAiVisionHint')}</div>
          </div>
        </div>
        <button
          className="set-switch"
          role="switch"
          aria-checked={config.vision === true}
          aria-label={t('setAiVision')}
          onClick={() => updateConfig({ vision: config.vision !== true })}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-key">
              {t('setAiApiKey')}
            </label>
            <div className="set-field-desc">{t('setAiKeyHint')}</div>
          </div>
        </div>
        <input
          id="set-ai-key"
          className="set-input"
          type="password"
          value={config.apiKey}
          placeholder={meta?.keyPlaceholder ?? 'API Key'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => updateConfig({ apiKey: e.target.value.trim() })}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-base-url">
              {t('setAiBaseUrl')}
            </label>
            {!meta?.needsBaseUrl && <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>}
          </div>
        </div>
        <input
          id="set-ai-base-url"
          className="set-input"
          type="text"
          value={config.baseUrl ?? ''}
          placeholder={meta?.needsBaseUrl ? 'https://…/v1' : meta?.defaultBaseUrl}
          spellCheck={false}
          onChange={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
        />
      </div>
      <div className="set-pane-footer">
        <AiStatusPill
          status={
            testing
              ? { kind: 'testing', text: t('setAiTesting') }
              : testResult
                ? testResult.ok
                  ? { kind: 'ok', text: t('setAiTestOk') }
                  : { kind: 'err', text: testResult.error || t('setAiTestFail') }
                : saved
                  ? { kind: 'ok', text: t('setAiSaved') }
                  : null
          }
        />
        <button className="set-btn" disabled={testing} onClick={test}>
          {t('setAiTest')}
        </button>
        <button className="set-btn primary" disabled={!dirty} onClick={save}>
          {t('setAiSave')}
        </button>
      </div>
    </>
  )
}

interface AiStatus {
  kind: 'testing' | 'ok' | 'err'
  text: string
}

/** colored feedback pill in the AI pane footer: spinner while testing, then success/error */
function AiStatusPill({ status }: { status: AiStatus | null }) {
  if (!status) return null
  return (
    <span
      className={`set-ai-status ${status.kind}`}
      role="status"
      // error text (HTTP body, network message) can be long — full text via native tooltip
      title={status.kind === 'err' ? status.text : undefined}
    >
      {status.kind === 'testing' ? (
        <span className="set-ai-spin" aria-hidden="true" />
      ) : status.kind === 'ok' ? (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path
            d="M4.2 7.3l1.9 1.9 3.7-4.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path d="M7 3.8v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="1" fill="currentColor" />
        </svg>
      )}
      <span className="set-ai-status-text">{status.text}</span>
    </span>
  )
}

export interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { lang, setLang, t } = useI18n()
  const [section, setSection] = useState<SectionId>('aiModel')
  const [theme, setTheme] = useState<UiTheme>('system')
  const [saveDir, setSaveDir] = useState('')
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  return (
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="set-dialog" role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className="set-header">
          <h2 className="set-title">{t('settings')}</h2>
          <button className="set-close" onClick={onClose} aria-label={t('cancel')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label={t('settings')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav-item${section === s.id ? ' active' : ''}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                <SectionIcon id={s.id} />
                {t(s.labelKey)}
              </button>
            ))}
          </nav>
          <div className="set-pane">
            {section === 'aiModel' && <AiModelPane t={t} />}
            {section === 'standards' && <StandardsPane t={t} lang={lang} />}
            {section === 'general' && (
              <>
                <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('language')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={lang}
                    ariaLabel={t('language')}
                    options={LANG_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                    onPick={(v) => setLang(v as typeof lang)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('theme')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={theme}
                    ariaLabel={t('theme')}
                    options={THEME_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => applyTheme(v as UiTheme)}
                  />
                </div>
                <Field
                  label={t('saveLocation')}
                  value={saveDir || '—'}
                  valueTitle={saveDir}
                  action={
                    <button className="set-btn" onClick={changeSaveDir}>
                      {t('setChange')}
                    </button>
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
