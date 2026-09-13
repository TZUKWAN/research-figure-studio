/**
 * GOAL §25 regression (owned business-report fixture): outputSequence
 * [3,1,2,2,5] must produce exactly [3, 1, 2A, 2B, 5] — reorder + clone with
 * the two clones independently editable — through the REAL analyzer,
 * compiler, executor, and a save→reopen roundtrip.
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
  'business-report.pptx',
)

function slideTexts(opened: OpenedPptx): string[] {
  return opened.deck.slides.map((slide) =>
    slide.elements
      .map((el) => {
        const text = (
          el as unknown as {
            text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
          }
        ).text
        if (!text?.paragraphs) return ''
        return text.paragraphs.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('')
      })
      .join(' | '),
  )
}

describe('page reorder + clone regression (GOAL §25, owned fixture)', () => {
  it.skipIf(!existsSync(FIXTURE))(
    '[3,1,2,2,5] → [3, 1, 2A, 2B, 5] with independent clones',
    async () => {
      const bytes = readFileSync(FIXTURE)
      const def = await analyzeTemplateBytes(bytes, { type: 'user-upload' })
      expect(def.pages).toHaveLength(5)

      // pick one text slot per source page for identification
      const slotOf = (slideNumber: number) => {
        const page = def.pages.find((p) => p.originalSlideIndex === slideNumber)!
        const slot = page.editableSlots[0] ?? page.nonEditableSlots[0]
        expect(slot, `page ${slideNumber} has a text slot`).toBeTruthy()
        return slot!
      }

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
            paragraphCount:
              (el as unknown as { text?: { paragraphs?: unknown[] } }).text?.paragraphs?.length ??
              0,
            text: '',
          })),
        )
      })

      // final deck: [3, 1, 2, 2, 5] — reordered with page 2 cloned
      const plan = {
        templateId: def.id,
        fidelity: 'adaptive' as const,
        slides: [
          { sourceSlideId: 'slide-3', outputOrder: 0, purpose: 'moved first', slotValues: [] },
          { sourceSlideId: 'slide-1', outputOrder: 1, purpose: 'cover', slotValues: [] },
          {
            sourceSlideId: 'slide-2',
            outputOrder: 2,
            purpose: 'clone A',
            slotValues: [{ slotId: slotOf(2).id, text: 'CLONE-A-MARKER' }],
            instance: 0,
          },
          {
            sourceSlideId: 'slide-2',
            outputOrder: 3,
            purpose: 'clone B',
            slotValues: [{ slotId: slotOf(2).id, text: 'CLONE-B-MARKER' }],
            instance: 1,
          },
          { sourceSlideId: 'slide-5', outputOrder: 4, purpose: 'appendix', slotValues: [] },
        ],
      }
      const compiled = compileFillPlan(def, plan, {
        totalSlides: def.pages.length,
        slideIds,
        slideElements: slideElements as never,
      })
      expect(compiled.errors, compiled.errors.join('; ')).toEqual([])

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
      expect(live.deck.slides).toHaveLength(5)

      // exact final order, identified by content
      const texts = slideTexts(live)
      expect(texts[0]).toContain('Risks for the business review fixture')
      expect(texts[1]).toContain('Business Report')
      expect(texts[2]).toContain('CLONE-A-MARKER')
      expect(texts[2]).toContain('Highlights for the business review fixture')
      expect(texts[3]).toContain('CLONE-B-MARKER')
      expect(texts[3]).toContain('Highlights for the business review fixture')
      expect(texts[4]).toContain('Appendix for the business review fixture')

      // clones are independent: A keeps its marker after B's fill (already
      // asserted above), and both survive save → reopen
      commitSaved(live as never)
      const reopened = await openPptx(await savePptx(live as never))
      const reopenedTexts = reopened.deck.slides.flatMap((s) =>
        s.elements.flatMap((el) => {
          const t = (
            el as unknown as { text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> } }
          ).text
          return (t?.paragraphs ?? []).map((p) => p.runs?.map((r) => r.text).join('') ?? '')
        }),
      )
      expect(reopenedTexts).toContain('CLONE-A-MARKER')
      expect(reopenedTexts).toContain('CLONE-B-MARKER')
      expect(reopened.deck.slides).toHaveLength(5)
    },
  )
})
