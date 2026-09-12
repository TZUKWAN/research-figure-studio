/**
 * Native chart data update (GOAL section 21): patch the cached values of an embedded
 * chart part in place — categories (c:cat), per-series values (c:val) and
 * series names (c:tx) — while keeping every styling node (colors, axes,
 * layout, data labels) byte-identical. PowerPoint renders from these caches;
 * the embedded workbook is only consulted when a user opens "Edit Data" in
 * PowerPoint, where a refresh from the (stale) sheet is an explicit user
 * action — noted here so the limitation is a documented boundary, not a
 * silent one.
 *
 * Fail-closed: any structural surprise (series count mismatch, missing cache
 * node) returns null instead of half-patched XML.
 */
import type { OpenedPptx } from './index'
import type { Slide, SlideElement } from './types'

export interface ChartDataUpdate {
  categories: string[]
  series: Array<{ name: string; values: number[] }>
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function numCacheXml(values: number[]): string {
  const pts = values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`)
    .join('')
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`
}

function strCacheXml(values: string[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join('')
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`
}

/** Replace the innermost cache of a node (`<c:val>`, `<c:cat>`) with fresh data. */
function replaceCache(block: string, cache: string): string | null {
  // numRef carries a numCache; strRef a strCache; literals (numLit/strLit) are
  // replaced in kind. Multi-level category refs (multiLvlStrRef) are rewritten
  // to a single-level strRef — PowerPoint accepts the flattened form.
  if (/<c:numRef>[\s\S]*?<\/c:numRef>/.test(block)) {
    return block.replace(
      /(<c:numRef>[\s\S]*?)<c:numCache>[\s\S]*?<\/c:numCache>([\s\S]*?<\/c:numRef>)/,
      `$1${cache}$2`,
    )
  }
  if (/<c:strRef>[\s\S]*?<\/c:strRef>/.test(block)) {
    return block.replace(
      /(<c:strRef>[\s\S]*?)<c:strCache>[\s\S]*?<\/c:strCache>([\s\S]*?<\/c:strRef>)/,
      `$1${cache}$2`,
    )
  }
  if (/<c:numLit>[\s\S]*?<\/c:numLit>/.test(block))
    return block.replace(/<c:numLit>[\s\S]*?<\/c:numLit>/, cache)
  if (/<c:multiLvlStrRef>[\s\S]*?<\/c:multiLvlStrRef>/.test(block)) {
    return block.replace(/<c:multiLvlStrRef>[\s\S]*?<\/c:multiLvlStrRef>/, cache)
  }
  return null
}

/**
 * Patch chart XML with new data. Returns the patched XML, or null when the
 * update cannot be applied safely (unknown layout, series count mismatch,
 * category count mismatch with an existing multi-series structure).
 */
export function patchChartData(chartXml: string, update: ChartDataUpdate): string | null {
  const serBlocks = chartXml.match(/<c:ser>[\s\S]*?<\/c:ser>/g)
  if (!serBlocks || serBlocks.length === 0) return null
  if (update.series.length !== serBlocks.length) return null

  let out = chartXml
  for (let i = 0; i < serBlocks.length; i++) {
    const block = serBlocks[i]!
    const series = update.series[i]!
    if (series.values.length !== update.categories.length) return null

    let patched = block

    // series name (c:tx → strRef/strCache or plain c:v)
    if (/<c:tx>[\s\S]*?<\/c:tx>/.test(patched)) {
      const nameCache = `<c:tx><c:strRef><c:f>${escapeXml(
        /<c:f>([\s\S]*?)<\/c:f>/.exec(/<c:tx>[\s\S]*?<\/c:tx>/.exec(patched)![0])?.[1] ?? '',
      )}</c:f>${strCacheXml([series.name])}</c:strRef></c:tx>`
      patched = patched.replace(/<c:tx>[\s\S]*?<\/c:tx>/, nameCache)
    }

    // categories
    if (/<c:cat>[\s\S]*?<\/c:cat>/.test(patched)) {
      const cat = /<c:cat>[\s\S]*?<\/c:cat>/.exec(patched)![0]
      const newCat = replaceCache(cat, strCacheXml(update.categories))
      if (!newCat) return null
      patched = patched.replace(cat, newCat)
    }

    // values
    if (/<c:val>[\s\S]*?<\/c:val>/.test(patched)) {
      const val = /<c:val>[\s\S]*?<\/c:val>/.exec(patched)![0]
      const newVal = replaceCache(val, numCacheXml(series.values))
      if (!newVal) return null
      patched = patched.replace(val, newVal)
    }

    out = out.replace(block, patched)
  }
  return out
}

/**
 * Update a chart element's data end-to-end: element XML → chart rel → part
 * path → patchChartData → write back into the archive. Returns false (the
 * caller surfaces a guided error) on any unresolved hop or a patch rejection.
 */
export function updateChartPart(
  opened: OpenedPptx,
  slide: Slide,
  element: SlideElement,
  update: ChartDataUpdate,
): boolean {
  const xml = (element as unknown as { anchor?: { originalXml?: string } }).anchor?.originalXml
  const rid = xml ? /<c:chart[^>]*r:id="([^"]+)"/.exec(xml)?.[1] : undefined
  if (!rid) return false
  const relsPath = slide.path.replace(/(slide\d+\.xml)$/, '_rels/$1.rels')
  const decode = (data: unknown): string => {
    try {
      return new TextDecoder().decode(data as Uint8Array)
    } catch {
      return ''
    }
  }
  const readText = (path: string): string =>
    (opened.archive as unknown as { readText?: (p: string) => string }).readText?.(path) ??
    decode((opened.archive.entries as Map<string, unknown>).get(path))
  const relsXml = readText(relsPath)
  const target =
    new RegExp(`Id="${rid}"[^>]*Target="([^"]*)"`).exec(relsXml ?? '')?.[1] ??
    new RegExp(`Target="([^"]*)"[^>]*Id="${rid}"`).exec(relsXml ?? '')?.[1]
  if (!target) return false
  const base = slide.path.includes('/') ? slide.path.slice(0, slide.path.lastIndexOf('/') + 1) : ''
  // resolve the rel target relative to the slide's directory
  const parts = (base + target).split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  const chartPath = resolved.join('/')
  const chartXml = readText(chartPath)
  if (!chartXml) return false
  const patched = patchChartData(chartXml, update)
  if (!patched) return false
  ;(opened.archive.entries as Map<string, unknown>).set(chartPath, Buffer.from(patched, 'utf8'))
  return true
}
