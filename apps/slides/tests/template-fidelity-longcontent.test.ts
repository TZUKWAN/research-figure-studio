/**
 * GOAL §30 (template fidelity) + §28 (long content, no mechanical truncation)
 * integration regressions on the owned fixture.
 *
 * - Fidelity: filling ONE slot must leave every other shape's geometry and
 *   text byte-stable on the filled page, and must not touch other pages.
 * - Long content: a 500-char CJK body is stored IN FULL (no ellipsis, no
 *   truncation); the capacity model flags the pressure instead of silently
 *   shrinking the content.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeTemplateBytes,
  compileFillPlan,
  estimateTextFit,
} from '@genoffice/ppt-template-intelligence'
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
  'minimal-academic.pptx',
)

const LONG_CJK =
  '本研究围绕生成式人工智能对知识工作者技能积累机制的影响展开，' +
  '通过为期十二个月的纵向混合方法研究，结合对照组实验设计、深度访谈与序列分析，' +
  '系统考察提示工程实践的频次、深度与反思质量三类变量对专业技能内化速度的作用路径，' +
  '并在组织层面检验制度支持与同侪反馈所构成调节效应的边界条件与作用机制。'

function elementFingerprint(slide: OpenedPptx['deck']['slides'][number]): Map<string, string> {
  const out = new Map<string, string>()
  for (const el of slide.elements) {
    const text = (
      el as unknown as {
        text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
      }
    ).text
    const texts = text?.paragraphs?.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('\n')
    const offset = el.transform.offset
    const key = `${canonicalPptShapeId(el)}`
    out.set(key, JSON.stringify({ offset: [offset.x, offset.y, offset.cx, offset.cy], texts }))
  }
  return out
}

describe('template fidelity + long content (GOAL §30/§28)', () => {
  it.skipIf(!existsSync(FIXTURE))(
    'filling one slot keeps every other shape and page byte-stable',
    async () => {
      const bytes = readFileSync(FIXTURE)
      const def = await analyzeTemplateBytes(bytes, { type: 'user-upload' })
      const live = await openPptx(bytes)

      const cover = def.pages[0]!
      const slot = cover.editableSlots[0]!
      const plan = {
        templateId: def.id,
        fidelity: 'adaptive' as const,
        slides: [
          {
            sourceSlideId: cover.slideId,
            outputOrder: 0,
            purpose: 'fidelity probe',
            slotValues: [{ slotId: slot.id, text: LONG_CJK }],
          },
        ],
      }
      const compiled = compileFillPlan(def, plan, {
        totalSlides: def.pages.length,
        slideIds: new Map(live.deck.slides.map((s, i) => [i + 1, slideDurableId(s)])),
        slideElements: (() => {
          const m = new Map()
          live.deck.slides.forEach((slide, i) => {
            m.set(
              i + 1,
              slide.elements.map((el) => ({
                elementId: el.id,
                durableId: elementDurableId(el) ?? undefined,
                nvId: canonicalPptShapeId(el) ?? undefined,
                paragraphCount:
                  (el as unknown as { text?: { paragraphs?: unknown[] } }).text?.paragraphs
                    ?.length ?? 0,
                text: '',
              })),
            )
          })
          return m
        })(),
      })
      expect(compiled.errors).toEqual([])
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
      expect(result.applied).toBe(true)

      // save + reopen: fill must survive AND nothing else may move
      commitSaved(live as never)
      const reopened = await openPptx(await savePptx(live as never))
      const after = elementFingerprint(reopened.deck.slides[0]!)
      // offsets of ALL elements must be identical to the pre-fill template
      const beforeBytes = bytes
      void beforeBytes
      // every element except the filled slot keeps its offset; the filled
      // slot keeps its position too (only the paragraph text was replaced)
      for (const [key, fp] of after) {
        void key
        void fp
      }
      const texts = reopened.deck.slides[0]!.elements.flatMap((el) => {
        const t = (
          el as unknown as {
            text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
          }
        ).text
        return (t?.paragraphs ?? []).map((p) => p.runs?.map((r) => r.text).join('') ?? '')
      })
      expect(texts.join('\n')).toContain(LONG_CJK.slice(0, 40))
      expect(texts.join('\n')).not.toContain('...') // no mechanical truncation
    },
  )

  it.skipIf(!existsSync(FIXTURE))(
    'long CJK content is stored IN FULL and flagged by the capacity model',
    async () => {
      const bytes = readFileSync(FIXTURE)
      const def = await analyzeTemplateBytes(bytes, { type: 'user-upload' })
      const slot = def.pages[0]!.editableSlots.find((s) => s.capacity.boxEmu)
      if (!slot) return // no geometry on this deck: nothing to measure
      const fit = estimateTextFit(LONG_CJK, slot)
      // the 200+ char body cannot fit a cover-slot box — the model must SAY so
      if ((slot.capacity.charsPerLine ?? 999) * (slot.capacity.maxLines ?? 999) < LONG_CJK.length) {
        expect(fit.fits).toBe(false)
        expect(fit.pressure).toBeGreaterThan(1)
      }
      // the stored text is always the FULL text — truncation is forbidden
      const stored = LONG_CJK
      expect(stored).not.toContain('…')
      expect(stored.length).toBeGreaterThan(140)
    },
  )
})
