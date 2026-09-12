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
  /**
   * map: original slide number → durable slide id (`s_<n>`). When present,
   * every emitted op targets the durable id instead of a computed index:
   * the executor validates the whole plan against PRE-transaction state, so
   * fill ops addressing post-prune indices would fail validation (the deck
   * still has the original slides at those positions). Durable ids resolve
   * identically before and after the deletes.
   */
  slideIds?: Map<number, string>
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
 * Emission order makes indices valid throughout:
 *  1. deleteSlide ops in DESCENDING original index (deleting from the end
 *     never shifts lower indices);
 *  2. text ops target the slide's PRUNED 0-based index (original minus the
 *     number of deleted slides before it), and the slide's elements are
 *     addressed by nvId (== python-pptx shape_id == <p:cNvPr id>).
 *
 * When ctx.slideIds is supplied, BOTH kinds target durable slide ids
 * (`s_<n>`) instead: the executor's plan phase validates against the
 * pre-transaction deck, where pruned indices do not exist yet.
 */
export function compileFillOps(edits: SlotEdit[], ctx: FillOpContext): CompiledFill {
  const errors: string[] = []
  const summary: string[] = []
  const ops: Array<Record<string, unknown>> = []

  const keep = new Set(ctx.selectedSlides)
  const slideTarget = (originalSlideNumber: number): string | number =>
    ctx.slideIds?.get(originalSlideNumber) ?? originalSlideNumber - 1
  const deletedDesc: number[] = []
  for (let n = ctx.totalSlides; n >= 1; n--) {
    if (!keep.has(n)) deletedDesc.push(n)
  }
  for (const n of deletedDesc) {
    ops.push({ op: 'deleteSlide', target: { slide: slideTarget(n) } })
    summary.push(`drop slide ${n} (not selected)`)
  }
  // pruned 0-based index of a kept original slide number (fallback addressing)
  const prunedIndex = new Map<number, number>()
  const keptAsc = [...ctx.selectedSlides].sort((a, b) => a - b)
  keptAsc.forEach((n, i) => prunedIndex.set(n, i))

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

  for (const slideNumber of keptAsc) {
    const out0 = ctx.slideIds?.get(slideNumber) ?? prunedIndex.get(slideNumber)!
    const elements = ctx.slideElements.get(slideNumber) ?? []
    const byNvId = new Map(elements.filter((e) => e.nvId != null).map((e) => [e.nvId!, e]))
    for (const edit of editsBySlide.get(slideNumber) ?? []) {
      const el = byNvId.get(edit.address.shapeId)
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
      ops.push({
        op: 'setSlotParagraphText',
        target: { slide: out0, el: el.elementId },
        paragraph: edit.address.paragraph,
        text: edit.newText,
      })
      summary.push(
        `slide ${slideNumber} → output ${out0}: shape ${edit.address.shapeId} p${edit.address.paragraph} ← "${edit.newText.slice(0, 24)}"`,
      )
    }
  }

  return { ops, summary, errors }
}
