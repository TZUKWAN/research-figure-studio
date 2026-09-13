/**
 * Owned E2E fixture generator (GOAL §42): builds the project's OWN legal
 * template decks with the project's own engine — copyright fully ours, so the
 * Template-panel E2E can run NON-SKIPPED on GitHub CI (GOAL §43).
 *
 * Invoked from the Playwright globalSetup; idempotent (regenerates only when
 * a fixture is missing or this script's version bumps).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addChart,
  addElement,
  addTable,
  appendRawElements,
  createBlankPptx,
  duplicateSlide,
  openPptx,
  savePptx,
  type OpenedPptx,
} from '@genoffice/pptx-engine'

const FIXTURES_DIR = join(__dirname, 'templates')
const GENERATOR_VERSION = '1'

function textbox(
  opened: OpenedPptx,
  slideIndex: number,
  text: string,
  opts: { x: number; y: number; cx: number; cy: number; size?: number; bold?: boolean },
): string {
  const el = addElement(opened.deck.slides[slideIndex]!, {
    kind: 'textbox',
    offset: { x: opts.x, y: opts.y, cx: opts.cx, cy: opts.cy },
    paragraphs: [{ runs: [{ text, bold: opts.bold, fontSize: opts.size ?? 18 }] }],
  })
  return el.id
}

function titlePage(opened: OpenedPptx, title: string, subtitle: string): void {
  textbox(opened, 0, title, {
    x: 914400,
    y: 1828800,
    cx: 9906000,
    cy: 1371600,
    size: 36,
    bold: true,
  })
  textbox(opened, 0, subtitle, { x: 914400, y: 3200400, cx: 9906000, cy: 914400, size: 18 })
}

function contentPage(opened: OpenedPptx, heading: string, body: string): void {
  addElement(opened.deck.slides[0]!, {
    kind: 'textbox',
    offset: { x: 914400, y: 457200, cx: 9906000, cy: 914400 },
    paragraphs: [{ runs: [{ text: heading, bold: true, fontSize: 24 }] }],
  })
  textbox(opened, 0, body, { x: 914400, y: 1371600, cx: 9906000, cy: 4572000, size: 14 })
}

async function minimalAcademic(): Promise<Buffer> {
  const opened = await openPptx(await createBlankPptx())
  titlePage(opened, 'Minimal Academic', 'A thesis-defense style owned fixture')
  duplicateSlide(opened, 0)
  contentPage(opened, 'Research Method', 'Mixed-method design with a controlled study.')
  duplicateSlide(opened, 1)
  contentPage(opened, 'Conclusion', 'The owned fixture closes the E2E loop.')
  return savePptx(opened)
}

async function businessReport(): Promise<Buffer> {
  const opened = await openPptx(await createBlankPptx())
  titlePage(opened, 'Business Report', 'Quarterly review deck')
  for (const heading of ['Highlights', 'Risks', 'Outlook', 'Appendix']) {
    duplicateSlide(opened, 1)
    contentPage(opened, heading, `${heading} for the business review fixture.`)
  }
  return savePptx(opened)
}

async function chartTemplate(): Promise<Buffer> {
  const opened = await openPptx(await createBlankPptx())
  titlePage(opened, 'Data Review', 'Native chart + table fixture')
  const chart = addChart(opened, 0, {
    kind: 'bar',
    categories: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: 'Revenue', values: [12, 18, 15, 21] }],
    offset: { x: 914400, y: 1828800, cx: 5486400, cy: 3200400 },
  })
  if (!chart) throw new Error('fixture chart failed')
  const table = addTable(opened, 0, {
    rows: 3,
    cols: 2,
    offset: { x: 6858000, y: 1828800, cx: 3657600, cy: 1828800 },
  })
  if (!table) throw new Error('fixture table failed')
  return savePptx(opened)
}

/** Two-level nested grpSp, written as raw XML: groupElements() cannot nest a
    group inside another group, and this fixture exists to exercise exactly
    that nesting through the real analyzer + fill pipeline. */
function nestedGroupXml(): string {
  const shape = (id: number, name: string, y: number, text: string): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="914400" y="${y}"/><a:ext cx="2743200" cy="609600"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en" sz="1400"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  const innerGroup =
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="31" name="inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="914400" y="1371600"/><a:ext cx="6400800" cy="1371600"/>` +
    `<a:chOff x="914400" y="1371600"/><a:chExt cx="6400800" cy="1371600"/></a:xfrm></p:grpSpPr>` +
    shape(32, 'inner-a', 1371600, 'Mechanism A') +
    shape(33, 'inner-b', 1981200, 'Mechanism B') +
    `</p:grpSp>`
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="30" name="outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="914400" y="1371600"/><a:ext cx="6400800" cy="2286000"/>` +
    `<a:chOff x="914400" y="1371600"/><a:chExt cx="6400800" cy="2286000"/></a:xfrm></p:grpSpPr>` +
    innerGroup +
    shape(34, 'caption', 2743200, 'Figure caption') +
    `</p:grpSp>`
  )
}

async function complexGroupTemplate(): Promise<Buffer> {
  const opened = await openPptx(await createBlankPptx())
  titlePage(opened, 'Complex Groups', 'Nested-group fill fixture')
  const r = appendRawElements(opened, 0, [nestedGroupXml()])
  if (!r) throw new Error('fixture nested group failed')
  return savePptx(opened)
}

const FIXTURES: Record<string, () => Promise<Buffer>> = {
  'minimal-academic.pptx': minimalAcademic,
  'business-report.pptx': businessReport,
  'chart-template.pptx': chartTemplate,
  'complex-group-template.pptx': complexGroupTemplate,
}

export async function ensureOwnedFixtures(): Promise<string> {
  mkdirSync(FIXTURES_DIR, { recursive: true })
  const versionFile = join(FIXTURES_DIR, '.generator-version')
  const upToDate =
    existsSync(versionFile) &&
    readFileSync(versionFile, 'utf8').trim() === GENERATOR_VERSION &&
    Object.keys(FIXTURES).every((name) => existsSync(join(FIXTURES_DIR, name)))
  if (!upToDate) {
    for (const [name, generate] of Object.entries(FIXTURES)) {
      const target = join(FIXTURES_DIR, name)
      if (existsSync(target) && existsSync(versionFile)) continue
      const bytes = await generate()
      writeFileSync(target, bytes)
    }
    writeFileSync(versionFile, GENERATOR_VERSION)
  }
  return FIXTURES_DIR
}
