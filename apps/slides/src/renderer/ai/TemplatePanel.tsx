/**
 * Template Center (GOAL §7-§23): provider-aggregated template selection panel.
 *
 * - My Templates: user-imported decks — persistent registry, Import button,
 *   dedupe, works WITHOUT any template directory (GOAL §11 empty state).
 * - Local Reference: Gorden directory decks (user-supplied, license-limited).
 * - Previews render offscreen ONCE, cache in localStorage by source hash, and
 *   persist to the registry's previews store for user decks (GOAL §14).
 * - Cards lazy-load via IntersectionObserver (GOAL §15).
 * - Analysis: progress bar + Cancel by analysisId (GOAL §19); switching decks
 *   abandons stale results (GOAL §20).
 * - Detail view on the analyzed card: per-page previews + roles (GOAL §16).
 * - "Use in AI" sets the AI runtime template context (GOAL §23) — the input
 *    receives a LOCALIZED instruction, never a hardcoded Chinese prompt.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RenderSlide } from '@genoffice/pptx-render'
import { SlideThumb } from '../SlideThumb'
import { createImageLoader } from '../image-loader'
import { useI18n } from '../i18n/locale'
import { setPresentationSessionContext } from './template-context'

export interface TemplateLibraryEntry {
  id: string
  name: string
  origin: string
  sourceHash?: string | null
  analysisStatus?: 'not-analyzed' | 'analyzing' | 'ready' | 'error'
  pageCount?: number
  previewPath?: string
}

interface ThumbResult {
  renderSlide?: RenderSlide
  previewDataUrl?: string
  sourceHash?: string
  pageCount?: number
  error?: string
}

interface AnalyzeState {
  status: 'analyzing' | 'done' | 'canceled' | 'error'
  current: number
  total: number
  analysisId?: string
  error?: string
  summary?: { pages: number; roles: string }
}

const thumbKey = (hash: string): string => `ppt-thumb-${hash.slice(0, 16)}`

/** Cached bitmap for a hash (localStorage, instant paint). */
function cachedPreview(hash?: string | null): string | null {
  if (!hash) return null
  try {
    return localStorage.getItem(thumbKey(hash))
  } catch {
    return null
  }
}

/** GOAL §15: request expensive work only when the element nears the viewport. */
function useInView(): [(el: HTMLElement | null) => void, boolean] {
  const [inView, setInView] = useState(false)
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true)
            observer.disconnect()
          }
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
  }, [])
  return [ref, inView]
}

/** Preview for one (deck, page): persisted bitmap fast path → localStorage →
    offscreen Konva render (then cache + persist for user decks). */
function TemplatePreview({
  origin,
  slideIndex = 0,
  sourceHash,
  persist,
  width = 220,
}: {
  origin: string
  slideIndex?: number
  sourceHash?: string | null
  persist: boolean
  width?: number
}): React.ReactElement {
  const [inViewRef, inView] = useInView()
  const [thumb, setThumb] = useState<ThumbResult | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(
    slideIndex === 0 ? cachedPreview(sourceHash) : null,
  )
  const [pending, setPending] = useState(true)
  const stageRef = useRef<{ toDataURL: (opts: Record<string, unknown>) => string } | null>(null)
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const loaderRef = useRef<ReturnType<typeof createImageLoader> | null>(null)
  const model = thumb?.renderSlide
  const hash = thumb?.sourceHash ?? sourceHash ?? undefined

  useEffect(() => {
    if (!inView) return
    let disposed = false
    void window.slidesApi.templateThumb(origin, slideIndex).then((r) => {
      if (disposed) return
      if (r && 'previewDataUrl' in r) {
        setDataUrl(r.previewDataUrl)
        setPending(false)
        return
      }
      setThumb(r ?? { error: 'unavailable' })
      setPending(false)
    })
    return () => {
      disposed = true
      loaderRef.current?.dispose()
    }
  }, [inView, origin, slideIndex])

  // draw the fetched model once, cache + persist the bitmap (GOAL §14)
  useEffect(() => {
    if (!model || dataUrl) return
    let disposed = false
    if (!loaderRef.current) {
      loaderRef.current = createImageLoader((entries) => {
        for (const [k, v] of entries) imagesRef.current.set(k, v)
      })
    }
    const urls = new Set<string>()
    const walk = (nodes: RenderSlide['nodes']): void => {
      for (const n of nodes) {
        if (n.type === 'picture' && n.dataUrl) urls.add(n.dataUrl)
        if (n.type === 'group' && Array.isArray(n.children)) walk(n.children as never)
      }
    }
    walk(model.nodes)
    loaderRef.current.load(urls)
    const timer = setTimeout(() => {
      if (disposed) return
      const stage = stageRef.current
      if (!stage) return
      try {
        const url = stage.toDataURL({ pixelRatio: 1 })
        try {
          if (hash) localStorage.setItem(thumbKey(hash), url)
        } catch {
          // storage full: in-memory preview still works
        }
        if (persist && hash) {
          void window.slidesApi.templatePreviewSave(hash, url.slice(url.indexOf(',') + 1))
        }
        setDataUrl(url)
      } catch {
        // preview is best-effort; the card still shows the deck name
      }
    }, 400)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [model, dataUrl, hash, persist])

  return (
    <div ref={inViewRef} style={{ display: 'contents' }}>
      {dataUrl ? (
        <img src={dataUrl} alt="" loading="lazy" />
      ) : model ? (
        <div style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}>
          <SlideThumb
            slide={model}
            images={imagesRef.current}
            width={width}
            stageRef={(s) => {
              stageRef.current = s as unknown as {
                toDataURL: (o: Record<string, unknown>) => string
              }
            }}
          />
        </div>
      ) : (
        <span className="tpl-thumb-pending">{pending ? '…' : '—'}</span>
      )}
    </div>
  )
}

function TemplateCard({
  entry,
  section,
  selected,
  analyze,
  onSelect,
  onRenamed,
  onRemoved,
}: {
  entry: TemplateLibraryEntry
  section: 'user' | 'reference'
  selected: boolean
  analyze?: AnalyzeState
  onSelect: (entry: TemplateLibraryEntry) => void
  onRenamed?: (id: string, name: string) => void
  onRemoved?: (id: string) => void
}): React.ReactElement {
  const { t } = useI18n()
  const analyzing = analyze?.status === 'analyzing'
  const pct = analyze && analyze.total > 0 ? Math.round((analyze.current / analyze.total) * 100) : 0

  return (
    <div
      className="tpl-card"
      data-testid={`tpl-card-${entry.id}`}
      data-selected={selected || undefined}
    >
      <button className="tpl-thumb" onClick={() => onSelect(entry)} aria-label={entry.name}>
        <TemplatePreview
          origin={entry.origin}
          sourceHash={entry.sourceHash}
          persist={section === 'user'}
        />
      </button>
      <div className="tpl-card-meta">
        <span className="tpl-card-name" title={entry.origin}>
          {entry.name}
        </span>
        <span className="tpl-card-state">
          {section === 'user' && entry.id.startsWith('user-') && (
            <>
              <button
                className="tpl-cancel"
                data-tip={t('tplRename')}
                aria-label={t('tplRename')}
                onClick={() => {
                  // GOAL §36: rename the registry entry (library metadata only)
                  const name = window.prompt(t('tplRename'), entry.name)?.trim()
                  if (!name || name === entry.name) return
                  void window.slidesApi.templateUserRename(entry.id, name).then(() => {
                    onRenamed?.(entry.id, name)
                  })
                }}
              >
                ✎
              </button>
              <button
                className="tpl-cancel"
                data-tip={t('tplRemove')}
                aria-label={t('tplRemove')}
                onClick={() => {
                  void window.slidesApi.templateUserRemove(entry.id).then(() => {
                    onRemoved?.(entry.id)
                  })
                }}
              >
                ✕
              </button>
            </>
          )}
          {analyze && (
            <>
              {analyzing && (
                <>
                  <span
                    className="tpl-progress"
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span className="tpl-progress-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="tpl-progress-label">
                    {t('tplAnalyzing')
                      .replace('{current}', String(analyze.current))
                      .replace('{total}', String(analyze.total))}
                  </span>
                  <button
                    className="tpl-cancel"
                    onClick={() =>
                      analyze.analysisId &&
                      void window.slidesApi.templateAnalyzeCancel(analyze.analysisId)
                    }
                  >
                    {t('tplCancelBtn')}
                  </button>
                </>
              )}
              {analyze.status === 'done' && analyze.summary && (
                <span className="tpl-summary" title={analyze.summary.roles}>
                  {t('tplPages').replace('{n}', String(analyze.summary.pages))}
                </span>
              )}
              {analyze.status === 'canceled' && <span>{t('tplCanceled')}</span>}
              {analyze.status === 'error' && (
                <span className="tpl-error" title={analyze.error}>
                  {t('tplFailed')}
                </span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/** The Template Center section rendered inside the AI composer (GOAL §7). */
export function TemplatePanel({
  onUse,
}: {
  /** Receives the template context for the AI runtime (GOAL §23). */
  onUse: (ctx: { templateId: string; templatePath: string; templateName: string }) => void
}): React.ReactElement {
  const { t } = useI18n()
  const [userEntries, setUserEntries] = useState<TemplateLibraryEntry[]>([])
  const [referenceEntries, setReferenceEntries] = useState<TemplateLibraryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TemplateLibraryEntry | null>(null)
  const [analyze, setAnalyze] = useState<AnalyzeState | null>(null)
  // GOAL §20: selecting deck B abandons deck A's in-flight result
  const epochRef = useRef(0)
  const analysisIdRef = useRef<string | null>(null)

  const refreshLibrary = useCallback(() => {
    void window.slidesApi.templateLibraryList().then((r) => {
      setUserEntries((r?.user ?? []) as TemplateLibraryEntry[])
      setReferenceEntries((r?.reference ?? []) as TemplateLibraryEntry[])
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    refreshLibrary()
  }, [refreshLibrary])

  // GOAL §19: capture the analysisId the moment the analysis starts
  useEffect(
    () =>
      window.slidesApi.onTemplateAnalyzeStarted(({ filePath, analysisId }) => {
        if (selected && selected.origin === filePath) {
          analysisIdRef.current = analysisId
          setAnalyze((prev) => (prev ? { ...prev, analysisId } : prev))
        }
      }),
    [selected],
  )

  // GOAL §17: per-slide progress, filtered by the live epoch
  useEffect(
    () =>
      window.slidesApi.onTemplateAnalyzeProgress((p) => {
        setAnalyze((prev) =>
          prev && prev.status === 'analyzing'
            ? { ...prev, current: p.current, total: p.total }
            : prev,
        )
      }),
    [],
  )

  const select = useCallback(async (entry: TemplateLibraryEntry) => {
    setSelected(entry)
    const epoch = ++epochRef.current
    analysisIdRef.current = null
    setAnalyze({ status: 'analyzing', current: 0, total: 0 })
    const r = await window.slidesApi.templateAnalyze(entry.origin)
    if (epochRef.current !== epoch) return // GOAL §20: stale result dropped
    if (!r) {
      setAnalyze({ status: 'error', current: 0, total: 0, error: 'unavailable' })
      return
    }
    if ('canceled' in r) {
      setAnalyze({ status: 'canceled', current: 0, total: 0 })
      return
    }
    if ('error' in r) {
      setAnalyze({ status: 'error', current: 0, total: 0, error: r.error })
      return
    }
    if (!r.definition) {
      setAnalyze({ status: 'error', current: 0, total: 0, error: 'unavailable' })
      return
    }
    const d = r.definition
    const roles = Object.entries(d.pageRoles)
      .map(([role, ids]) => `${role}×${ids.length}`)
      .join(', ')
    setAnalyze({
      status: 'done',
      current: 1,
      total: 1,
      summary: { pages: d.pages.length, roles },
    })
  }, [])

  const importTemplate = useCallback(async () => {
    setImporting(true)
    setImportError(null)
    try {
      const r = await window.slidesApi.templateImport()
      if (!r) {
        setImportError('unavailable')
        return
      }
      if ('error' in r) {
        setImportError(r.error)
        return
      }
      if ('canceled' in r) return
      refreshLibrary()
      const entry: TemplateLibraryEntry = {
        id: r.entry.id,
        name: r.entry.name,
        origin: r.entry.managedSourcePath,
        sourceHash: r.entry.sourceHash,
        analysisStatus: 'not-analyzed',
      }
      await select(entry)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [refreshLibrary, select])

  const use = useCallback(() => {
    if (!selected) return
    // GOAL §23: first-class runtime context for the AI tools
    setPresentationSessionContext({
      selectedTemplateId: selected.id,
      selectedTemplatePath: selected.origin,
      selectedTemplateName: selected.name,
    })
    onUse({
      templateId: selected.id,
      templatePath: selected.origin,
      templateName: selected.name,
    })
  }, [selected, onUse])

  const detailPages =
    analyze?.status === 'done' && selected ? Math.min(analyze.summary?.pages ?? 0, 12) : 0

  if (loaded && userEntries.length === 0 && referenceEntries.length === 0) {
    // GOAL §11: an empty library is a usable state, never a hidden panel
    return (
      <div className="tpl-panel" data-testid="template-panel">
        <div className="tpl-panel-title">{t('tplPanelTitle')}</div>
        <div className="tpl-empty" data-testid="tpl-empty">
          <div className="tpl-empty-title">{t('tplEmptyTitle')}</div>
          <button className="tpl-use" onClick={() => void importTemplate()} disabled={importing}>
            {t('tplImportBtn')}
          </button>
          {importing && <span className="tpl-progress-label">{t('tplImporting')}</span>}
          {importError && (
            <span className="tpl-error" data-testid="tpl-import-error">
              {importError}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="tpl-panel" data-testid="template-panel">
      <div className="tpl-section-title">{t('tplMyTemplates')}</div>
      {userEntries.length === 0 ? (
        <div className="tpl-empty-inline">
          <button className="tpl-use" onClick={() => void importTemplate()} disabled={importing}>
            {t('tplImportBtn')}
          </button>
        </div>
      ) : (
        <div className="tpl-grid">
          {userEntries.map((entry) => (
            <TemplateCard
              key={entry.id}
              entry={entry}
              section="user"
              selected={selected?.id === entry.id}
              analyze={selected?.id === entry.id ? (analyze ?? undefined) : undefined}
              onSelect={(e) => void select(e)}
              onRenamed={(id, name) =>
                setUserEntries((entries) => entries.map((e) => (e.id === id ? { ...e, name } : e)))
              }
              onRemoved={(id) => {
                setUserEntries((entries) => entries.filter((e) => e.id !== id))
                if (selected?.id === id) {
                  setSelected(null)
                  setAnalyze(null)
                }
              }}
            />
          ))}
        </div>
      )}
      {referenceEntries.length > 0 && (
        <>
          <div className="tpl-section-title">{t('tplLocalReference')}</div>
          <div className="tpl-grid">
            {referenceEntries.map((entry) => (
              <TemplateCard
                key={entry.id}
                entry={entry}
                section="reference"
                selected={selected?.id === entry.id}
                analyze={selected?.id === entry.id ? (analyze ?? undefined) : undefined}
                onSelect={(e) => void select(e)}
              />
            ))}
          </div>
        </>
      )}
      {analyze?.status === 'done' && selected && (
        <div className="tpl-use-row">
          <span className="tpl-roles" title={analyze.summary?.roles}>
            {t('tplPages').replace('{n}', String(analyze.summary?.pages ?? 0))} ·{' '}
            {analyze.summary?.roles}
          </span>
          <button className="tpl-use" onClick={use}>
            {t('tplUseInAi')}
          </button>
        </div>
      )}
      {selected && analyze?.status === 'done' && detailPages > 0 && (
        // GOAL §16: template detail — per-page previews of the analyzed deck
        <div className="tpl-detail" data-testid="tpl-detail">
          {Array.from({ length: detailPages }, (_, i) => (
            <div className="tpl-detail-page" key={i}>
              <TemplatePreview
                origin={selected.origin}
                slideIndex={i}
                sourceHash={selected.sourceHash}
                persist={false}
                width={96}
              />
              <span className="tpl-detail-idx">{i + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
