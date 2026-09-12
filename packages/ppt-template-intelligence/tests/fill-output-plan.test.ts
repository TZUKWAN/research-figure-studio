/**
 * GOAL section 9: outputSequence — page reorder + clone/duplicate in the fill plan.
 * Compiler emits delete/duplicate/move + per-instance text ops; the real
 * executor applies the whole plan as ONE atomic transaction on a real Gorden
 * deck and save→reopen preserves the arrangement.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTemplateBytes, compileFillOps, compileFillPlan } from '../src/index.js'
import {
  canonicalPptShapeId,
  commitSaved,
  elementDurableId,
  openPptx,
  savePptx,
  slideDurableId,
  type OpenedPptx,
} from '@genoffice/pptx-engine'

const GORDEN_DIR = process.env.GORDEN_TEMPLATES_DIR
const HAS_GORDEN = Boolean(GORDEN_DIR && existsSync(join(GORDEN_DIR, 'minimal-business-summary')))

function slideIdsOf(opened: Awaited<ReturnType<typeof openPptx>>): Map<number, string> {
  return new Map(opened.deck.slides.map((s, i) => [i + 1, slideDurableId(s as never)]))
}

function elementsOf(opened: OpenedPptx): Map<
  number,
  Array<{
    elementId: string
    durableId?: string
    nvId?: number
    paragraphCount: number
    text: string
  }>
> {
  const map = new Map<
    number,
    Array<{
      elementId: string
      durableId?: string
      nvId?: number
      paragraphCount: number
      text: string
    }>
  >()
  opened.deck.slides.forEach((slide, i) => {
    const out: Array<{
      elementId: string
      durableId?: string
      nvId?: number
      paragraphCount: number
      text: string
    }> = []
    for (const el of slide.elements) {
      const textObj = (
        el as unknown as { text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> } }
      ).text
      out.push({
        elementId: (el as unknown as { id: string }).id,
        durableId: elementDurableId(el as never) ?? undefined,
        nvId: canonicalPptShapeId(el as never) ?? undefined,
        paragraphCount: textObj?.paragraphs?.length ?? 0,
        text:
          textObj?.paragraphs?.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('\n') ??
          '',
      })
    }
    map.set(i + 1, out)
  })
  return map
}

describe('fill outputSequence (GOAL section 9)', () => {
  it('requires slideIds', () => {
    const compiled = compileFillOps([], {
      outputSequence: [1],
      totalSlides: 2,
      slideElements: new Map(),
    })
    expect(compiled.errors.join(' ')).toMatch(/slideIds/)
  })

  it('reorder [2,1]: one moveSlide, no structural deletes for kept slides', () => {
    const slideIds = new Map([
      [1, 's_1'],
      [2, 's_2'],
    ])
    const compiled = compileFillOps([], {
      outputSequence: [2, 1],
      totalSlides: 2,
      slideIds,
      slideElements: new Map(),
    })
    expect(compiled.errors).toEqual([])
    const moves = compiled.ops.filter((o) => o.op === 'moveSlide')
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ target: { slide: 1 }, to: 0 })
    expect(compiled.ops.filter((o) => o.op === 'deleteSlide')).toHaveLength(0)
  })

  it('clone [1,1]: duplicateSlide then instance edits via $txn ref', () => {
    const slideIds = new Map([
      [1, 's_1'],
      [2, 's_2'],
    ])
    const slideElements = new Map<
      number,
      Array<{
        elementId: string
        durableId?: string
        nvId?: number
        paragraphCount: number
        text: string
      }>
    >([[1, [{ elementId: 'elA', nvId: 5, paragraphCount: 2, text: 'hello' }]]])
    const compiled = compileFillOps(
      [
        { slide: 1, address: { shapeId: 5, paragraph: 0 }, newText: 'first' },
        { slide: 1, address: { shapeId: 5, paragraph: 0 }, newText: 'second', instance: 1 },
      ],
      { outputSequence: [1, 1], totalSlides: 2, slideIds, slideElements },
    )
    expect(compiled.errors).toEqual([])
    const dups = compiled.ops.filter((o) => o.op === 'duplicateSlide')
    expect(dups).toHaveLength(1)
    expect(dups[0]).toMatchObject({ target: { slide: 's_1' } })
    const fills = compiled.ops.filter((o) => o.op === 'setSlotParagraphText')
    expect(fills).toHaveLength(2)
    const dupIndex = compiled.ops.indexOf(dups[0]!)
    // instance 0 → the original slide; instance 1 → the $txn clone
    expect(fills[0]).toMatchObject({ target: { slide: 's_1' } })
    expect(fills[1]).toMatchObject({ target: { slide: `$txn:${dupIndex}` } })
  })

  it.skipIf(!HAS_GORDEN)(
    'real deck: reorder + duplicate + fill in ONE atomic txn, survives save→reopen',
    async () => {
      const templatePath = join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx')
      const bytes = readFileSync(templatePath)
      const def = await analyzeTemplateBytes(bytes, { type: 'gorden-local' })
      const live = await openPptx(bytes)
      const slideIds = slideIdsOf(live)
      const slideElements = elementsOf(live)

      // plan: [5, 4, 1, 16, clone-of-4] — reorder + one duplicate
      const outputSequence = [5, 4, 1, 16, 4]
      const edits = [
        {
          slide: 4,
          address: firstEditableAddress(def, 4),
          newText: 'ORIGINAL-INSTANCE',
        },
        {
          slide: 4,
          address: firstEditableAddress(def, 4),
          newText: 'CLONE-INSTANCE',
          instance: 1,
        },
      ]
      const compiled = compileFillOps(edits, {
        outputSequence,
        totalSlides: def.pages.length,
        slideIds,
        slideElements,
      })
      expect(compiled.errors).toEqual([])

      const { runTxn } = await import('../../../apps/slides/src/main/ops/executor.js')
      await import('../../../apps/slides/src/main/ops/core-ops')
      await import('../../../apps/slides/src/main/ops/element-ops')
      await import('../../../apps/slides/src/main/ops/insert-ops')
      await import('../../../apps/slides/src/main/ops/slide-ops')
      await import('../../../apps/slides/src/main/ops/text-ops')
      const result = runTxn(live as never, {
        ops: compiled.ops as never,
        isolation: 'atomic',
      })
      expect(result.applied, JSON.stringify(result.failures ?? [])).toBe(true)
      expect(live.deck.slides).toHaveLength(outputSequence.length)

      commitSaved(live as never)
      const reopened = await openPptx(await savePptx(live as never))
      expect(reopened.deck.slides).toHaveLength(outputSequence.length)
      const texts = reopened.deck.slides.flatMap((s) =>
        s.elements.flatMap((el) => {
          const t = (
            el as unknown as {
              text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
            }
          ).text
          return (t?.paragraphs ?? []).map((p) => p.runs?.map((r) => r.text).join('') ?? '')
        }),
      )
      expect(texts).toContain('ORIGINAL-INSTANCE')
      expect(texts).toContain('CLONE-INSTANCE')
    },
  )

  it.skipIf(!HAS_GORDEN)(
    'compileFillPlan: slotId-only plan compiles without physical addresses',
    async () => {
      const templatePath = join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx')
      const bytes = readFileSync(templatePath)
      const def = await analyzeTemplateBytes(bytes, { type: 'gorden-local' })
      const live = await openPptx(bytes)
      const slideIds = slideIdsOf(live)
      const slideElements = elementsOf(live)

      const coverPage = def.pages.find((p) => p.role === 'cover') ?? def.pages[0]!
      const endingPage =
        def.pages.find((p) => p.role === 'ending') ?? def.pages[def.pages.length - 1]!
      const coverSlot = coverPage.editableSlots[0]!
      const plan = {
        templateId: def.id,
        slides: [
          {
            sourceSlideId: endingPage.slideId,
            outputOrder: 0,
            purpose: 'reordered ending first proves reorder',
            slotValues: [],
          },
          {
            sourceSlideId: coverPage.slideId,
            outputOrder: 1,
            purpose: 'cover with filled title',
            slotValues: [{ slotId: coverSlot.id, text: 'PLAN-FILLED' }],
          },
        ],
      }
      const compiled = compileFillPlan(def, plan, {
        totalSlides: def.pages.length,
        slideIds,
        slideElements,
      })
      expect(compiled.errors).toEqual([])
      // one text op, addressed by durable element id — no physical addr leaked
      const fills = compiled.ops.filter((o) => o.op === 'setSlotParagraphText')
      expect(fills).toHaveLength(1)
      expect(String((fills[0]!.target as { el: string }).el)).toMatch(/^e_/)
      expect(String((fills[0]!.target as { slide: string }).slide)).toMatch(/^s_/)

      // unknown slotId → compile error, nothing emitted
      const bad = compileFillPlan(
        def,
        {
          templateId: def.id,
          slides: [
            {
              sourceSlideId: coverPage.slideId,
              outputOrder: 0,
              purpose: 'x',
              slotValues: [{ slotId: 'nope', text: 'x' }],
            },
          ],
        },
        { totalSlides: def.pages.length, slideIds, slideElements },
      )
      expect(bad.errors.join(' ')).toMatch(/unknown slotId/)
      expect(bad.ops).toHaveLength(0)
    },
  )
})

/** First editable slot address of an analyzed page, or a probe of the live deck. */
function firstEditableAddress(
  def: Awaited<ReturnType<typeof analyzeTemplateBytes>>,
  slideNumber: number,
): { shapeId: number; paragraph: number } {
  const page = def.pages.find((p) => p.originalSlideIndex === slideNumber)
  const slot = page?.editableSlots[0]
  return { shapeId: slot!.address.shapeId, paragraph: slot!.address.paragraph }
}
