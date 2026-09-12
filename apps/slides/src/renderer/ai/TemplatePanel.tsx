/**
 * Template selection panel (GOAL §29): visual template library with cached
 * previews, analyzer progress bar and a cancel button.
 *
 * - Library entries come from the main process (GordenDirProvider listing —
 *   user-supplied directory, never bundled).
 * - Previews: the main process returns the FIRST SLIDE's render model; this
 *   panel draws it offscreen once, caches the bitmap in localStorage keyed by
 *   the deck's source hash, and never re-renders a cached deck.
 * - Analysis runs through the existing template-analyze IPC; per-slide
 *   progress streams over the progress event channel and the Cancel button
 *   aborts the in-flight analysis in the main process.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { RenderSlide } from '@genoffice/pptx-render'
import { SlideThumb } from '../SlideThumb'
import { createImageLoader } from '../image-loader'
import { useI18n } from '../i18n/locale'

interface LibraryEntry {
  id: string
  name: string
  origin: string
}

interface ThumbState {
  renderSlide?: RenderSlide
  sourceHash?: string
  error?: string
}

interface AnalyzeState {
  status: 'analyzing' | 'done' | 'canceled' | 'error'
  current: number
  total: number
  error?: string
  summary?: { pages: number; roles: string }
}

/** localStorage key for a deck's cached preview bitmap (by source hash). */
const thumbKey = (hash: string): string => `ppt-thumb-${hash.slice(0, 16)}`

/** One library card: cached bitmap preview (or first-paint offscreen render) + analyze/progress UI. */
function TemplateCard({
  entry,
  selected,
  analyze,
  onSelect,
}: {
  entry: LibraryEntry
  selected: boolean
  analyze?: AnalyzeState
  onSelect: (entry: LibraryEntry) => void
}): React.ReactElement {
  const { t } = useI18n()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [pending, setPending] = useState<boolean>(true)
  const [thumb, setThumb] = useState<ThumbState | null>(null)
  const stageRef = useRef<{ toDataURL: (opts: Record<string, unknown>) => string } | null>(null)
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const loaderRef = useRef<ReturnType<typeof createImageLoader> | null>(null)

  useEffect(() => {
    let disposed = false
    void window.slidesApi.templateThumb(entry.origin).then((r) => {
      if (disposed) return
      if (r && 'renderSlide' in r) {
        // hash known → the localStorage bitmap cache may already have the preview
        const cached = localStorage.getItem(thumbKey(r.sourceHash))
        if (cached) {
          setDataUrl(cached)
          setPending(false)
          return
        }
        setThumb(r)
      } else {
        setPending(false)
      }
    })
    return () => {
      disposed = true
      loaderRef.current?.dispose()
    }
  }, [entry.origin])

  // draw + cache once the model and its images are ready
  useEffect(() => {
    const model = thumb && 'renderSlide' in thumb ? thumb.renderSlide : undefined
    const hash = thumb && 'sourceHash' in thumb ? thumb.sourceHash : undefined
    if (!model || !hash) return
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
    // wait a beat for the batched image decode, then snapshot the offscreen stage
    const timer = setTimeout(() => {
      if (disposed) return
      const stage = stageRef.current
      if (!stage) return
      try {
        const url = stage.toDataURL({ pixelRatio: 1 })
        localStorage.setItem(thumbKey(hash), url)
        setDataUrl(url)
      } catch {
        // preview is best-effort; the card still shows the deck name
      }
      setPending(false)
    }, 400)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [thumb])

  const pct = analyze && analyze.total > 0 ? Math.round((analyze.current / analyze.total) * 100) : 0

  return (
    <div
      className="tpl-card"
      data-testid={`tpl-card-${entry.id}`}
      data-selected={selected || undefined}
    >
      <button className="tpl-thumb" onClick={() => onSelect(entry)} aria-label={entry.name}>
        {dataUrl ? (
          <img src={dataUrl} alt={entry.name} />
        ) : thumb && 'renderSlide' in thumb && thumb.renderSlide ? (
          <div
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
          >
            <SlideThumb
              slide={thumb.renderSlide}
              images={imagesRef.current}
              width={220}
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
      </button>
      <div className="tpl-card-meta">
        <span className="tpl-card-name" title={entry.origin}>
          {entry.name}
        </span>
        {analyze && (
          <span className="tpl-card-state">
            {analyze.status === 'analyzing' && (
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
                  onClick={() => void window.slidesApi.templateAnalyzeCancel(entry.origin)}
                >
                  {t('tplCancelBtn')}
                </button>
              </>
            )}
            {analyze.status === 'done' && analyze.summary && (
              <span className="tpl-summary" title={analyze.summary.roles}>
                {analyze.summary.pages} pages
              </span>
            )}
            {analyze.status === 'canceled' && <span>{t('tplCanceled')}</span>}
            {analyze.status === 'error' && (
              <span className="tpl-error" title={analyze.error}>
                {t('tplFailed')}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

/** Template library section rendered inside the AI panel above the input. */
export function TemplatePanel({
  onUse,
}: {
  /** Receives a ready-to-send AI instruction for the chosen template. */
  onUse: (instruction: string) => void
}): React.ReactElement {
  const { t } = useI18n()
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<LibraryEntry | null>(null)
  const [analyze, setAnalyze] = useState<AnalyzeState | null>(null)
  const analyzingRef = useRef<string | null>(null)

  useEffect(() => {
    let disposed = false
    void window.slidesApi.templateLibraryList().then((r) => {
      if (disposed) return
      setEntries((r?.entries ?? []) as LibraryEntry[])
      setLoaded(true)
    })
    return () => {
      disposed = true
    }
  }, [])

  // progress channel: single subscription, filtered to the selected deck
  useEffect(
    () =>
      window.slidesApi.onTemplateAnalyzeProgress((p) => {
        if (analyzingRef.current !== p.filePath) return
        setAnalyze((prev) =>
          prev && prev.status === 'analyzing'
            ? { ...prev, current: p.current, total: p.total }
            : prev,
        )
      }),
    [],
  )

  const select = useCallback(async (entry: LibraryEntry) => {
    setSelected(entry)
    analyzingRef.current = entry.origin
    setAnalyze({ status: 'analyzing', current: 0, total: 0 })
    const r = await window.slidesApi.templateAnalyze(entry.origin)
    if (analyzingRef.current !== entry.origin) return
    analyzingRef.current = null
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

  if (loaded && entries.length === 0) return <></>

  const use = (): void => {
    if (!selected) return
    onUse(
      `使用模板 "${selected.name}"（${selected.origin}）：先 analyze_ppt_template 分析它，再按其页面角色规划内容并用 create_presentation_from_template 填充，另存为新文件。`,
    )
  }

  return (
    <div className="tpl-panel" data-testid="template-panel">
      <div className="tpl-panel-title">{t('tplPanelTitle')}</div>
      <div className="tpl-grid">
        {entries.map((entry) => (
          <TemplateCard
            key={entry.id}
            entry={entry}
            selected={selected?.id === entry.id}
            analyze={selected?.id === entry.id ? (analyze ?? undefined) : undefined}
            onSelect={(e) => void select(e)}
          />
        ))}
      </div>
      {analyze?.status === 'done' && selected && (
        <div className="tpl-use-row">
          {analyze.summary && (
            <span className="tpl-roles" title={analyze.summary.roles}>
              {selected.name} · {analyze.summary.pages} pages · {analyze.summary.roles}
            </span>
          )}
          <button className="tpl-use" onClick={use}>
            {t('tplUseInAi')}
          </button>
        </div>
      )}
    </div>
  )
}
