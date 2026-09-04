/**
 * E6 lab tool: generate and inspect the three candidate semantic metadata
 * carriers without changing the production parser or save path.
 *
 * Usage:
 *   npx tsx packages/pptx-engine/tools/e6-metadata-matrix.ts write <file.pptx>
 *   npx tsx packages/pptx-engine/tools/e6-metadata-matrix.ts inspect <file.pptx>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { addElement, createBlankPptx, openPptx, savePptx } from '../src/index.ts'

type Variant = 'A' | 'B' | 'C'

const SEMANTIC = {
  role: 'mechanism-primary',
  themeFill: 'primary.100',
  themeStroke: 'primary.700',
  themeText: 'text.primary',
  componentType: 'research-module',
}

const XML_NS = 'urn:research-figure-studio:semantic'
const EXT_URI = '{D3D44A5A-8B5A-4E22-A4C1-9E6A9B8F0E61}'

function attr(name: string, value: string): string {
  return `${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
}

function semanticMarker(variant: Variant): string {
  return (
    `RFS-${variant}|role=${SEMANTIC.role}|themeFill=${SEMANTIC.themeFill}|` +
    `themeStroke=${SEMANTIC.themeStroke}|themeText=${SEMANTIC.themeText}|` +
    `componentType=${SEMANTIC.componentType}`
  )
}

function patchVariant(xml: string, variant: Variant): string {
  const open = /<p:cNvPr\b[^>]*?(\/?)>/.exec(xml)
  if (!open) throw new Error(`Generated element has no p:cNvPr: ${xml.slice(0, 100)}`)
  const marker = semanticMarker(variant)
  let out = xml
  if (variant === 'A') {
    out = out.replace(/(<p:cNvPr\b[^>]*\bname=")[^"]*(")/, `$1${marker}$2`)
    if (out === xml) throw new Error('Unable to patch route A name')
    return out
  }

  if (variant === 'B') {
    const attrs = ` ${attr('descr', marker)} ${attr('title', marker)}`
    return (
      out.slice(0, open.index + open[0].length - 1) +
      attrs +
      out.slice(open.index + open[0].length - 1)
    )
  }

  const metadata =
    `<rfs:metadata xmlns:rfs="${XML_NS}" ${attr('role', SEMANTIC.role)} ` +
    `${attr('themeFill', SEMANTIC.themeFill)} ${attr('themeStroke', SEMANTIC.themeStroke)} ` +
    `${attr('themeText', SEMANTIC.themeText)} ${attr('componentType', SEMANTIC.componentType)}/>`
  const extension = `<a:ext uri="${EXT_URI}">${metadata}</a:ext>`
  const close = out.indexOf('</a:extLst>', open.index)
  if (close >= 0) return out.slice(0, close) + extension + out.slice(close)
  const cNvClose = out.indexOf('</p:cNvPr>', open.index)
  if (cNvClose < 0) throw new Error('Unable to locate cNvPr close tag for route C')
  return out.slice(0, cNvClose) + `<a:extLst>${extension}</a:extLst>` + out.slice(cNvClose)
}

function firstTag(xml: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*?(?:/>|>[^]*?</${tag}>)`).exec(xml)?.[0] ?? ''
}

function getAttribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null
}

function inspectElement(xml: string): Record<string, unknown> {
  const cnvpr = firstTag(xml, 'p:cNvPr')
  const extMetadata = /<(?:[A-Za-z_][\w.-]*:)?metadata\b[^>]*\/>/.exec(xml)?.[0] ?? null
  const joined = [
    getAttribute(cnvpr, 'name'),
    getAttribute(cnvpr, 'descr'),
    getAttribute(cnvpr, 'title'),
    extMetadata,
  ]
    .filter(Boolean)
    .join(' ')
  const variant = (['A', 'B', 'C'] as const).find((v) => joined.includes(`RFS-${v}`)) ?? null
  return {
    variant,
    cNvPr: {
      name: getAttribute(cnvpr, 'name'),
      descr: getAttribute(cnvpr, 'descr'),
      title: getAttribute(cnvpr, 'title'),
    },
    customMetadata: extMetadata,
  }
}

async function writeFixture(file: string): Promise<void> {
  const opened = await openPptx(await createBlankPptx())
  const slide = opened.deck.slides[0]
  if (!slide) throw new Error('Blank presentation has no first slide')
  const variants: Variant[] = ['A', 'B', 'C']
  variants.forEach((variant, i) => {
    const element = addElement(slide, {
      kind: 'roundRect',
      offset: { x: 914400 + i * 1828800, y: 1828800, cx: 1524000, cy: 914400 },
      paragraphs: [{ runs: [{ text: `E6 route ${variant}` }] }],
      fillColor: ['#D9EAF7', '#E2F0D9', '#FCE4D6'][i],
    })
    element.anchor.originalXml = patchVariant(element.anchor.originalXml, variant)
  })
  writeFileSync(file, Buffer.from(await savePptx(opened)))
  console.log(JSON.stringify({ action: 'write', file, variants }, null, 2))
}

async function inspectFixture(file: string): Promise<void> {
  const opened = await openPptx(readFileSync(file))
  const elements = opened.deck.slides.flatMap((slide, slideIndex) =>
    slide.elements
      .filter(
        (el) =>
          el.anchor.originalXml.includes('RFS-') || el.anchor.originalXml.includes('rfs:metadata'),
      )
      .map((el) => {
        const model = el as typeof el & {
          text?: { paragraphs?: Array<{ runs?: Array<{ text?: string }> }> }
          fill?: { type?: string; color?: string }
        }
        return {
          slideIndex,
          elementId: el.id,
          text:
            model.text?.paragraphs
              ?.flatMap((p) => p.runs ?? [])
              .map((r) => r.text ?? '')
              .join('') ?? null,
          fill: model.fill?.type === 'solid' ? (model.fill.color ?? null) : null,
          ...inspectElement(el.anchor.originalXml),
        }
      }),
  )
  console.log(JSON.stringify({ action: 'inspect', file, elements }, null, 2))
}

const [action, file] = process.argv.slice(2)
if (!action || !file || !['write', 'inspect'].includes(action)) {
  throw new Error('Usage: ... e6-metadata-matrix.ts write|inspect <file.pptx>')
}
if (action === 'write') await writeFixture(file)
else await inspectFixture(file)
