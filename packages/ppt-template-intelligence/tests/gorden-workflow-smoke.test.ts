/**
 * REAL USAGE SMOKE (production closure): the full Gorden workflow end-to-end
 * against EVERY real Gorden template deck —
 *   analyze → slotId-based plan → compileFillPlan → ONE atomic executor
 *   transaction → placeholder QA → save → reopen → verify.
 *
 * Usage: GORDEN_TEMPLATES_DIR=... npx vitest run tests/gorden-workflow-smoke.test.ts
 * Clean-skips without GORDEN_TEMPLATES_DIR.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  analyzeTemplateBytes,
  auditPlaceholders,
  bridgeTemplateTheme,
  compileFillPlan,
  type PageRole,
} from '../src/index.js'
import {
  commitSaved,
  elementDurableId,
  openPptx,
  savePptx,
  slideDurableId,
  canonicalPptShapeId,
  type OpenedPptx,
} from '@genoffice/pptx-engine'

const GORDEN_DIR = process.env.GORDEN_TEMPLATES_DIR
const HAS_GORDEN = Boolean(GORDEN_DIR && existsSync(GORDEN_DIR))

function deckContext(opened: OpenedPptx) {
  const slideIds = new Map(opened.deck.slides.map((s, i) => [i + 1, slideDurableId(s)]))
  const slideElements = new Map()
  opened.deck.slides.forEach((slide, i) => {
    const out: Array<{
      elementId: string
      durableId?: string
      nvId?: number
      paragraphCount: number
      text: string
      groupId?: string
    }> = []
    // mirrors the analyzer's walk: group-internal text slots are fillable,
    // addressed via op.group + the child's durable element id
    const walk = (elements: OpenedPptx['deck']['slides'][number]['elements'], groupId?: string) => {
      for (const el of elements) {
        if (el.type === 'group') {
          walk(
            (el as unknown as { children: typeof elements }).children,
            elementDurableId(el) ?? el.id,
          )
          continue
        }
        const textObj = (
          el as unknown as {
            text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
          }
        ).text
        out.push({
          elementId: el.id,
          durableId: elementDurableId(el) ?? undefined,
          nvId: canonicalPptShapeId(el) ?? undefined,
          paragraphCount: textObj?.paragraphs?.length ?? 0,
          text:
            textObj?.paragraphs?.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('\n') ??
            '',
          ...(groupId ? { groupId } : {}),
        })
      }
    }
    walk(slide.elements)
    slideElements.set(i + 1, out)
  })
  return { slideIds, slideElements }
}

const slideTexts = (opened: OpenedPptx): string[] =>
  opened.deck.slides.flatMap((s) => slideTextsOf(s).map(([, text]) => text))

/** [elementId, text] pairs of every text element, descending into groups. */
function slideTextsOf(slide: OpenedPptx['deck']['slides'][number]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (elements: OpenedPptx['deck']['slides'][number]['elements']) => {
    for (const el of elements) {
      if (el.type === 'group') {
        walk((el as unknown as { children: typeof elements }).children)
        continue
      }
      const textObj = (
        el as unknown as {
          text?: { paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
        }
      ).text
      if (!textObj) continue // non-text elements (connectors/pictures) are not auditable
      out.push([
        el.id,
        textObj.paragraphs?.map((p) => p.runs?.map((r) => r.text).join('') ?? '').join('\n') ?? '',
      ])
    }
  }
  walk(slide.elements)
  return out
}

const allDecks = HAS_GORDEN
  ? readdirSync(GORDEN_DIR!, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(GORDEN_DIR!, d.name, 'template.pptx')))
      .map((d) => d.name)
  : []

describe('gorden full-workflow smoke across ALL decks', () => {
  it.skipIf(!HAS_GORDEN)(
    'every deck: analyze → plan → fill → QA → save → reopen',
    async () => {
      expect(allDecks.length).toBeGreaterThanOrEqual(20)
      const failures: string[] = []

      for (const deck of allDecks) {
        try {
          const bytes = readFileSync(join(GORDEN_DIR!, deck, 'template.pptx'))
          const def = await analyzeTemplateBytes(bytes, {
            type: 'gorden-local',
            sourceFile: deck,
          })

          // ── plan: cover + first content + ending, slotId-based ──
          const pick = (role: PageRole): string | undefined => {
            const ids = def.pageRoles[role]
            return ids && ids.length > 0 ? ids[0] : undefined
          }
          const sources = [
            pick('cover') ?? def.pages[0]!.slideId,
            pick('content') ?? def.pages[Math.min(1, def.pages.length - 1)]!.slideId,
            pick('ending') ?? def.pages[def.pages.length - 1]!.slideId,
          ]
          const plan = {
            templateId: def.id,
            fidelity: 'adaptive' as const,
            slides: sources.map((sourceSlideId, outputOrder) => {
              const page = def.pages.find((p) => p.slideId === sourceSlideId)!
              return {
                sourceSlideId,
                outputOrder,
                purpose: 'smoke',
                slotValues: page.editableSlots.slice(0, 3).map((slot) => ({
                  slotId: slot.id,
                  text: `冒烟 ${deck} ${slot.id}`,
                })),
              }
            }),
          }

          // ── theme bridge (section 20) runs as part of the flow ──
          const bridge = bridgeTemplateTheme(def)
          expect(bridge.roles.primary).toMatch(/^#[0-9a-fA-F]{6}$/)

          // ── compile + apply as ONE atomic transaction ──
          const opened = await openPptx(bytes)
          const { slideIds, slideElements } = deckContext(opened)
          const compiled = compileFillPlan(def, plan, {
            totalSlides: opened.deck.slides.length,
            slideIds,
            slideElements,
          })
          expect(compiled.errors, `${deck}: ${compiled.errors.join('; ')}`).toEqual([])
          const { runTxn } = await import('../../../apps/slides/src/main/ops/executor.js')
          await import('../../../apps/slides/src/main/ops/core-ops')
          await import('../../../apps/slides/src/main/ops/element-ops')
          await import('../../../apps/slides/src/main/ops/insert-ops')
          await import('../../../apps/slides/src/main/ops/slide-ops')
          await import('../../../apps/slides/src/main/ops/table-ops')
          await import('../../../apps/slides/src/main/ops/text-ops')
          const result = runTxn(opened as never, {
            ops: compiled.ops as never,
            isolation: 'atomic',
          })
          expect(
            result.applied,
            `${deck}: ${JSON.stringify((result.failures ?? []).slice(0, 2))}`,
          ).toBe(true)
          expect(opened.deck.slides).toHaveLength(plan.slides.length)

          // ── QA: the FILLED texts contain no placeholder patterns and none
          // of them still equals the template's currentText ──
          const filledTexts = plan.slides.flatMap((s) => s.slotValues.map((v) => v.text))
          const qa = auditPlaceholders([
            {
              slideIndex: 0,
              elements: filledTexts.map((text, i) => ({
                elementId: `filled-${i}`,
                text,
                editable: true,
                currentText: def.pages
                  .flatMap((p) => p.editableSlots.map((s) => s.currentText))
                  .includes(text)
                  ? text
                  : undefined,
              })),
            },
          ])
          expect(qa.pass, `${deck}: ${JSON.stringify(qa.issues.slice(0, 3))}`).toBe(true)

          // ── save → reopen ──
          commitSaved(opened as never)
          const reopened = await openPptx(await savePptx(opened as never))
          expect(reopened.deck.slides).toHaveLength(plan.slides.length)
          const texts = slideTexts(reopened)
          expect(
            texts.some((t) => t.startsWith('冒烟 ')),
            `${deck}: filled text lost after save→reopen`,
          ).toBe(true)
        } catch (err) {
          failures.push(`${deck}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      expect(failures, failures.join('\n')).toEqual([])
    },
    600_000,
  )
})
