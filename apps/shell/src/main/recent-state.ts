/**
 * Home-screen recent-files and starred-list state (userData JSON lists) —
 * extracted from index.ts (audit DESKTOP-P0-01). Persistence is best-effort:
 * a failing home-list write must never break file operations.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import type { RecentEntry, RecentPage } from '../shared/home-api'
import { normalizeRecentQuery, statExistingPaths } from './recent-files'
import { PPTX_RE } from './file-routing'

const slidesRecentPath = () => join(app.getPath('userData'), 'slides-recent.json')
const starredPath = () => join(app.getPath('userData'), 'starred.json')

function readPathList(filePath: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return Array.isArray(value)
      ? value.filter((path): path is string => typeof path === 'string')
      : []
  } catch {
    return []
  }
}

function writePathList(filePath: string, paths: readonly string[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(paths))
  } catch {
    // Home list persistence is best-effort and must not break file operations.
  }
}

function slidesPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => PPTX_RE.test(path)))]
}

function readSlidesRecentFiles(): string[] {
  return slidesPaths(readPathList(slidesRecentPath())).filter((path) => existsSync(path))
}

function readStarredSlides(): string[] {
  return slidesPaths(readPathList(starredPath())).filter((path) => existsSync(path))
}

function statSlidesEntries(paths: readonly string[]): RecentEntry[] {
  return statExistingPaths(slidesPaths(paths), new Set(readStarredSlides()))
}

function slidesQuery(raw: unknown): ReturnType<typeof normalizeRecentQuery> {
  return { ...normalizeRecentQuery(raw), ext: 'pptx' }
}

function pageStarredSlides(raw: unknown): RecentPage {
  const { offset, limit } = slidesQuery(raw)
  const all = statSlidesEntries(readStarredSlides()).sort((a, b) => b.mtimeMs - a.mtimeMs)
  return {
    entries: limit === 0 ? [] : all.slice(offset, offset + limit),
    total: all.length,
    totalAll: all.length,
  }
}

function recordSlidesRecentFile(filePath: string): void {
  if (!PPTX_RE.test(filePath)) return
  writePathList(slidesRecentPath(), [filePath, ...readSlidesRecentFiles()].slice(0, 10))
}

function removeSlidesRecentFiles(paths: readonly string[]): void {
  const drop = new Set(paths)
  writePathList(
    slidesRecentPath(),
    readPathList(slidesRecentPath()).filter((path) => !drop.has(path)),
  )
}

function replaceSlidesPath(oldPath: string, newPath: string): void {
  const replace = (path: string) => (path === oldPath ? newPath : path)
  writePathList(slidesRecentPath(), readPathList(slidesRecentPath()).map(replace))
  writePathList(starredPath(), readPathList(starredPath()).map(replace))
}

export {
  slidesRecentPath,
  starredPath,
  readPathList,
  writePathList,
  slidesPaths,
  readSlidesRecentFiles,
  readStarredSlides,
  statSlidesEntries,
  slidesQuery,
  pageStarredSlides,
  recordSlidesRecentFile,
  removeSlidesRecentFiles,
  replaceSlidesPath,
}
