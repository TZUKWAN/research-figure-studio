/**
 * Template Fill Compiler (P2): TemplateFillPlan → native txn ops.
 *
 * Produces ops for the existing atomic executor (slide clone/prune + slot
 * text replacement at the slot's address). The deck model stays the single
 * source of truth — this module only ever emits ops for the executor, never
 * a second deck state.
 */

export interface FillOpContext {
  /** 1-based original slide numbers to KEEP, in presentation order */
  selectedSlides: number[]
  totalSlides: number
  /** map: original slide number → element id + paragraph count, from the parsed deck */
  slideElements: Map<
    number,
    Array<{ elementId: string; nvId?: number; paragraphCount: number; text: string }>
  >
}

export interface SlotEdit {
  /** 1-based ORIGINAL slide number */
  slide: number
  address: { shapeId: number; paragraph: number }
  newText: string
  /** optional sanity check against the template's current text */
  expectedText?: string
}

export interface CompiledFill {
  ops: Array<Record<string, unknown>>
  /** human-readable summary of what will happen */
  summary: string[]
  errors: string[]
}

/**
 * Compile slot edits + page selection into executor ops.
 *
 * - `duplicateSlide`-free approach: keep selected slides in order by pruning
 *   unselected slides, then reorder is implicit (selection order preserved by
 *   the caller building `selectedSlides` in presentation order).
 * - Text edits target the element owning the address (shape_id == nvId/cNvPr id).
 * - Paragraph-level replacement: setText with the full paragraph list, where
 *   only the addressed paragraph's text changes and every other paragraph is
 *   re-emitted with its CURRENT text (format-preserving behavior matches the
 *   engine's run-0 convention).
 */
export function compileFillOps(edits: SlotEdit[], ctx: FillOpContext): CompiledFill {
  const errors: string[] = []
  const summary: string[] = []
  const ops: Array<Record<string, unknown>> = []

  // 1) prune unselected slides (delete from the end so indices stay valid)
  const keep = new Set(ctx.selectedSlides)
  for (let n = ctx.totalSlides; n >= 1; n--) {
    if (!keep.has(n)) {
      ops.push({ op: 'deleteSlide', target: { slide: n - 1 } })
      summary.push(`drop slide ${n} (not selected)`)
    }
  }

  // 2) group edits per surviving slide, in presentation order
  const order = ctx.selectedSlides
  const editsBySlide = new Map<number, SlotEdit[]>()
  for (const edit of edits) {
    if (!keep.has(edit.slide)) {
      errors.push(`edit targets slide ${edit.slide} which is not in selectedSlides`)
      continue
    }
    const list = editsBySlide.get(edit.slide) ?? []
    list.push(edit)
    editsBySlide.set(edit.slide, list)
  }

  // after pruning, original slide n maps to output index = number of kept slides before it
  const outputIndex = new Map<number, number>()
  let out = 0
  for (const n of order) {
    outputIndex.set(n, out)
    out++
  }

  for (const slideNumber of order) {
    const slideEdits = editsBySlide.get(slideNumber) ?? []
    const elements = ctx.slideElements.get(slideNumber) ?? []
    const byNvId = new Map(elements.filter((e) => e.nvId != null).map((e) => [e.nvId!, e]))
    for (const edit of slideEdits) {
      const el =
        byNvId.get(edit.address.shapeId) ??
        elements.find((e) => e.text.includes(edit.expectedText ?? '\u0000'))
      if (!el) {
        errors.push(`slide ${slideNumber}: no element with shape_id ${edit.address.shapeId}`)
        continue
      }
      if (edit.address.paragraph >= el.paragraphCount) {
        errors.push(
          `slide ${slideNumber} shape ${edit.address.shapeId}: paragraph ${edit.address.paragraph} out of range (${el.paragraphCount} paragraphs)`,
        )
        continue
      }
      if (edit.expectedText && !el.text.includes(edit.expectedText)) {
        errors.push(`slide ${slideNumber} shape ${edit.address.shapeId}: expected_text mismatch`)
        continue
      }
      // Emit a targeted paragraph replacement: the engine's setText replaces
      // the whole text body, so we pass marker ops that the caller resolves
      // into full-paragraph lists from the live model (executor resolves at
      // apply time; the paragraph index rides op field `paragraph`).
      ops.push({
        op: 'setSlotParagraphText',
        target: { slide: outputIndex.get(slideNumber) ?? 0, el: el.elementId },
        paragraph: edit.address.paragraph,
        text: edit.newText,
      })
      summary.push(
        `slide ${slideNumber} → output ${outputIndex.get(slideNumber)}: shape ${edit.address.shapeId} p${edit.address.paragraph} ← "${edit.newText.slice(0, 24)}"`,
      )
    }
  }

  return { ops, summary, errors }
}
