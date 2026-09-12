/**
 * Template Fill Compiler (P2): TemplateFillPlan → native txn ops.
 *
 * Produces ops for the existing atomic executor (slide clone/prune/reorder +
 * slot text replacement at the slot's address). The deck model stays the
 * single source of truth — this module only ever emits ops for the executor,
 * never a second deck state.
 */

export interface FillOpContext {
  /** 1-based original slide numbers to KEEP, in presentation order */
  selectedSlides?: number[]
  totalSlides: number
  /**
   * map: original slide number → element id + paragraph count, from the parsed deck.
   * `durableId` (elementDurableId form, `e_<guid8>`/`e_<cNvPr id>`) should be
   * supplied whenever available: it is byte-derived, so clones made by
   * duplicateSlide resolve to the same id as the source slide, while the
   * parse-time `elementId` only exists on the specific parse instance.
   */
  slideElements: Map<
    number,
    Array<{
      elementId: string
      durableId?: string
      nvId?: number
      paragraphCount: number
      text: string
    }>
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
  /**
   * GOAL §九: full output page plan — the final deck as a sequence of
   * ORIGINAL slide numbers. An original may appear multiple times (clone)
   * and in any order (reorder); originals absent from the sequence are
   * deleted. Supersedes selectedSlides; requires slideIds.
   */
  outputSequence?: number[]
}

export interface SlotEdit {
  /** 1-based ORIGINAL slide number */
  slide: number
  address: { shapeId: number; paragraph: number }
  newText: string
  /** optional sanity check against the template's current text */
  expectedText?: string
  /**
   * GOAL §九: with outputSequence, which occurrence of `slide` in the final
   * deck this edit applies to (0 = first). Defaults to 0; clones of the same
   * original can thus receive identical or per-instance text.
   */
  instance?: number
}

export interface CompiledFill {
  ops: Array<Record<string, unknown>>
  /** human-readable summary of what will happen */
  summary: string[]
  errors: string[]
}

/**
 * Compile slot edits + page plan into executor ops.
 *
 * Emission order makes references valid throughout:
 *  1. deleteSlide ops (unwanted originals — descending index, or durable ids
 *     when slideIds is supplied, which are order-independent);
 *  2. duplicateSlide + moveSlide ops arranging the exact outputSequence
 *     (only in outputSequence mode);
 *  3. text ops targeting durable slide ids (or `$txn:<n>` refs to a
 *     duplicateSlide op for clone instances), elements by nvId
 *     (== python-pptx shape_id == canonicalPptShapeId == <p:cNvPr id>).
 */
export function compileFillOps(edits: SlotEdit[], ctx: FillOpContext): CompiledFill {
  const errors: string[] = []
  const summary: string[] = []
  const ops: Array<Record<string, unknown>> = []

  const seq = ctx.outputSequence
  if (seq && !ctx.slideIds) {
    errors.push('outputSequence requires slideIds (durable slide ids from the live deck)')
    return { ops, summary, errors }
  }
  if (seq) {
    const valid = new Set(
      Array.from({ length: ctx.totalSlides }, (_, i) => i + 1),
    )
    for (const n of seq) {
      if (!valid.has(n)) {
        errors.push(`outputSequence references slide ${n}, outside 1-${ctx.totalSlides}`)
        return { ops, summary, errors }
      }
    }
  }

  const keep = new Set(seq ?? ctx.selectedSlides)
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
  const keptAsc = [...keep].sort((a, b) => a - b)
  keptAsc.forEach((n, i) => prunedIndex.set(n, i))

  // ── §九: arrange the exact output sequence (reorder + clone) ──
  // W mirrors the live deck after the deletes: kept originals ascending.
  // Each token is an instance; clones remember the duplicateSlide op index so
  // later ops can address them via the executor's `$txn:<n>` substitution.
  const working: Array<{ orig: number; op?: number }> = []
  if (seq) {
    working.push(...keptAsc.map((orig) => ({ orig })))
    for (let i = 0; i < seq.length; i++) {
      const desired = seq[i]!
      // an unconsumed instance already at or after position i: move it into place
      const j = working.findIndex((t, idx) => idx >= i && t.orig === desired)
      if (j >= 0) {
        if (j !== i) {
          ops.push({ op: 'moveSlide', target: { slide: j }, to: i })
          const [moved] = working.splice(j, 1)
          working.splice(i, 0, moved!)
        }
        continue
      }
      // no instance left unconsumed: clone the FIRST instance of the original
      const src = working.findIndex((t) => t.orig === desired)
      if (src < 0) continue // unreachable: outputSequence validity checked above
      const dupOp = ops.length
      ops.push({ op: 'duplicateSlide', target: { slide: slideTarget(desired) } })
      summary.push(`duplicate slide ${desired} (output position ${i})`)
      // duplicateSlide inserts the copy directly after the source
      const copy: { orig: number; op: number } = { orig: desired, op: dupOp }
      working.splice(src + 1, 0, copy)
      if (src + 1 !== i) {
        ops.push({ op: 'moveSlide', target: { slide: src + 1 }, to: i })
        working.splice(src + 1, 1)
        working.splice(i, 0, copy)
      }
    }
  }

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
    const elements = ctx.slideElements.get(slideNumber) ?? []
    const byNvId = new Map(elements.filter((e) => e.nvId != null).map((e) => [e.nvId!, e]))
    for (const edit of editsBySlide.get(slideNumber) ?? []) {
      // resolve the target slide instance (§九 occurrence semantics)
      let out0: string | number
      if (seq) {
        const occurrences = working
          .slice(0, seq.length)
          .filter((t) => t.orig === slideNumber)
        const tok = occurrences[edit.instance ?? 0]
        if (!tok) {
          errors.push(
            `slide ${slideNumber}: no output occurrence ${edit.instance ?? 0} in outputSequence`,
          )
          continue
        }
        out0 = tok.op !== undefined ? `$txn:${tok.op}` : slideTarget(slideNumber)
      } else {
        out0 = ctx.slideIds?.get(slideNumber) ?? prunedIndex.get(slideNumber)!
      }
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
        target: { slide: out0, el: el.durableId ?? el.elementId },
        paragraph: edit.address.paragraph,
        text: edit.newText,
      })
      summary.push(
        `slide ${slideNumber} → output ${typeof out0 === 'string' ? out0 : `#${out0}`}: shape ${edit.address.shapeId} p${edit.address.paragraph} ← "${edit.newText.slice(0, 24)}"`,
      )
    }
  }

  return { ops, summary, errors }
}
