/**
 * GOAL §31: native chart lifecycle on an OWNED template — import (analyze) →
 * updateChartData through the REAL executor → save → reopen → the chart part
 * still parses as a NATIVE chart with the updated cached data (not an image,
 * not stripped), and the update survives the roundtrip.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTemplateBytes, compileFillPlan } from '@genoffice/ppt-template-intelligence'
import {
  canonicalPptShapeId,
  commitSaved,
  elementDurableId,
  openPptx,
  savePptx,
  slideDurableId,
  type OpenedPptx,
} from '@genoffice/pptx-engine'

const FIXTURE = join(
  process.cwd(),
  '..',
  '..',
  'e2e',
  'fixtures',
  'templates',
  'chart-template.pptx',
)

function chartOf(opened: OpenedPptx): string | null {
  for (const slide of opened.deck.slides) {
    for (const el of slide.elements) {
      const xml = (el as unknown as { anchor?: { originalXml?: string } }).anchor?.originalXml
      if (xml && xml.includes('<c:chart')) return xml
    }
  }
  return null
}

describe('native chart lifecycle (GOAL §31, owned fixture)', () => {
  it.skipIf(!existsSync(FIXTURE))(
    'update → save → reopen keeps a NATIVE chart with new cached data',
    async () => {
      const bytes = readFileSync(FIXTURE)
      const def = await analyzeTemplateBytes(bytes, { type: 'user-upload' })
      const chartPage = def.pages.find((p) => p.chartShapeIds.length > 0)
      expect(chartPage, 'fixture has a chart page').toBeTruthy()
      const chartShapeId = chartPage!.chartShapeIds[0]!

      const live = await openPptx(bytes)
      const slideIds = new Map(live.deck.slides.map((s, i) => [i + 1, slideDurableId(s)]))
      const slideElements = new Map()
      live.deck.slides.forEach((slide, i) => {
        slideElements.set(
          i + 1,
          slide.elements.map((el) => ({
            elementId: el.id,
            durableId: elementDurableId(el) ?? undefined,
            nvId: canonicalPptShapeId(el) ?? undefined,
            paragraphCount: 0,
            text: '',
          })),
        )
      })

      // GOAL §21/§22: the plan carries chart data by slotId-shape reference
      const plan = {
        templateId: def.id,
        fidelity: 'adaptive' as const,
        slides: [
          {
            sourceSlideId: chartPage!.slideId,
            outputOrder: 0,
            purpose: 'chart update',
            slotValues: [],
            chartUpdates: [
              {
                shapeId: chartShapeId,
                categories: ['H1', 'H2'],
                series: [{ name: 'Updated', values: [30, 40] }],
              },
            ],
          },
        ],
      }
      const compiled = compileFillPlan(def, plan, {
        totalSlides: def.pages.length,
        slideIds,
        slideElements,
      })
      expect(compiled.errors, compiled.errors.join('; ')).toEqual([])
      const updateOp = compiled.ops.find((o) => o.op === 'updateChartData')
      expect(updateOp, 'chart update op compiled').toBeTruthy()

      const { runTxn } = await import('../src/main/ops/executor.js')
      await import('../src/main/ops/core-ops')
      await import('../src/main/ops/element-ops')
      await import('../src/main/ops/insert-ops')
      await import('../src/main/ops/slide-ops')
      await import('../src/main/ops/table-ops')
      await import('../src/main/ops/text-ops')
      const result = runTxn(live as never, {
        ops: compiled.ops as never,
        isolation: 'atomic',
      })
      expect(result.applied, JSON.stringify((result.failures ?? []).slice(0, 2))).toBe(true)

      // the saved package must still carry a NATIVE chart part with the new data
      commitSaved(live as never)
      const savedBytes = await savePptx(live as never)
      const reopened = await openPptx(savedBytes)
      const xml = chartOf(reopened)
      expect(xml, 'native chart xml survives the roundtrip').toBeTruthy()
      const chartPart = [...(reopened.archive.entries as Map<string, Uint8Array>).entries()].find(
        ([path]) => /^ppt\/charts\/chart\d+\.xml$/.test(path),
      )
      expect(chartPart, 'chart part present in the package').toBeTruthy()
      const content = new TextDecoder().decode(chartPart![1])
      expect(content).toContain('<c:chartSpace')
      expect(content).toContain('Updated') // new series name in the cache
      expect(content).toContain('>40<') // updated value
      expect(content).toContain('H1') // updated category
    },
  )
})
