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
      /** immediate parent group's parse-time element id (group-child slots) */
      groupId?: string
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
   * GOAL section 9: full output page plan — the final deck as a sequence of
   * ORIGINAL slide numbers. An original may appear multiple times (clone)
   * and in any order (reorder); originals absent from the sequence are
   * deleted. Supersedes selectedSlides; requires slideIds.
   */
  outputSequence?: number[]
  /**
   * GOAL section 21-23: ops targeting an ELEMENT of a (possibly cloned) slide
   * instance — chart data updates, picture replacement, table cells. The
   * slide/instance/shapeId triple resolves exactly like a text edit; `build`
   * then receives the resolved {slide, el} target and returns the final op.
   * Emitted in the same late phase as text ops, so `$txn:<n>` references to
   * earlier duplicateSlide ops are valid.
   */
  elementOps?: Array<{
    slide: number
    instance?: number
    shapeId: number
    build: (target: { slide: string | number; el: string }) => Record<string, unknown>
  }>
}

export interface SlotEdit {
  /** 1-based ORIGINAL slide number */
  slide: number
  address: { shapeId: number; paragraph: number }
  newText: string
  /** optional sanity check against the template's current text */
  expectedText?: string
  /**
   * GOAL section 9: with outputSequence, which occurrence of `slide` in the final
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
    const valid = new Set(Array.from({ length: ctx.totalSlides }, (_, i) => i + 1))
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

  // ── section 9: arrange the exact output sequence (reorder + clone) ──
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
    // resolve a (slide, instance, shapeId) triple to a target — shared by
    // text edits and section 21-23 element ops
    const resolveTarget = (
      slideNumber: number,
      instance: number | undefined,
      shapeId: number,
    ): { slide: string | number; el: string; group?: string } | { error: string } => {
      let out0: string | number
      if (seq) {
        const occurrences = working.slice(0, seq.length).filter((t) => t.orig === slideNumber)
        const tok = occurrences[instance ?? 0]
        if (!tok) {
          return {
            error: `slide ${slideNumber}: no output occurrence ${instance ?? 0} in outputSequence`,
          }
        }
        out0 = tok.op !== undefined ? `$txn:${tok.op}` : slideTarget(slideNumber)
      } else {
        out0 = ctx.slideIds?.get(slideNumber) ?? prunedIndex.get(slideNumber)!
      }
      const el = byNvId.get(shapeId)
      if (!el) {
        return { error: `slide ${slideNumber}: no element with shape_id ${shapeId}` }
      }
      return {
        slide: out0,
        el: el.durableId ?? el.elementId,
        ...(el.groupId ? { group: el.groupId } : {}),
      }
    }

    for (const edit of editsBySlide.get(slideNumber) ?? []) {
      // resolve the target slide instance (section 9 occurrence semantics)
      const resolved = resolveTarget(slideNumber, edit.instance, edit.address.shapeId)
      if ('error' in resolved) {
        errors.push(resolved.error)
        continue
      }
      const { group, ...target } = resolved
      const out0 = target.slide
      const el = byNvId.get(edit.address.shapeId)!
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
        target,
        ...(group ? { group } : {}),
        paragraph: edit.address.paragraph,
        text: edit.newText,
      })
      summary.push(
        `slide ${slideNumber} → output ${typeof out0 === 'string' ? out0 : `#${out0}`}: shape ${edit.address.shapeId} p${edit.address.paragraph} ← "${edit.newText.slice(0, 24)}"`,
      )
    }

    // section 21-23 element ops on this slide
    for (const visual of ctx.elementOps ?? []) {
      if (visual.slide !== slideNumber) continue
      const resolved = resolveTarget(visual.slide, visual.instance, visual.shapeId)
      if ('error' in resolved) {
        errors.push(resolved.error)
        continue
      }
      const { group, ...target } = resolved
      const built = visual.build(target)
      ops.push(group ? { ...built, group } : built)
    }
  }

  return { ops, summary, errors }
}

/**
 * GOAL section 10: TemplateFillPlan → executor ops. THE production path — consumers
 * name template slots (slotId) and template pages (slideId); every physical
 * address (slide number, shape id, paragraph index) is resolved HERE against
 * the analyzed TemplateDefinition and never crosses the API boundary.
 *
 * outputOrder entries form the outputSequence (reorder + clone); an unknown
 * slotId or a non-editable slot is a compile ERROR, never silently skipped.
 */
export function compileFillPlan(
  def: import('./schema.js').TemplateDefinition,
  plan: import('./schema.js').TemplateFillPlan,
  ctx: {
    totalSlides: number
    slideIds?: Map<number, string>
    slideElements: FillOpContext['slideElements']
  },
): CompiledFill {
  const errors: string[] = []
  const summary: string[] = []
  const pagesBySlideId = new Map(def.pages.map((p) => [p.slideId, p]))
  const elementOps: NonNullable<FillOpContext['elementOps']> = []
  // GOAL section 24: strict (default) treats analysis↔deck text drift as a hard
  // stop; adaptive relaxes the expected-text gate for user-modified decks
  const strict = (plan.fidelity ?? 'preserve-template') === 'preserve-template'

  const ordered = [...plan.slides].sort((a, b) => a.outputOrder - b.outputOrder)
  const outputSequence: number[] = []
  const edits: SlotEdit[] = []
  const occurrenceBySource = new Map<string, number>()
  for (const entry of ordered) {
    const page = pagesBySlideId.get(entry.sourceSlideId)
    if (!page) {
      errors.push(`plan references unknown slide "${entry.sourceSlideId}"`)
      continue
    }
    // instance defaults to the running occurrence among same-source entries
    const instance = entry.instance ?? occurrenceBySource.get(entry.sourceSlideId) ?? 0
    occurrenceBySource.set(entry.sourceSlideId, instance + 1)
    outputSequence.push(page.originalSlideIndex)
    const allSlots = [...page.editableSlots, ...page.nonEditableSlots]
    const byId = new Map(allSlots.map((s) => [s.id, s]))
    for (const value of entry.slotValues) {
      const slot = byId.get(value.slotId)
      if (!slot) {
        errors.push(`unknown slotId "${value.slotId}" on ${entry.sourceSlideId}`)
        continue
      }
      if (!slot.editable) {
        errors.push(`slot "${value.slotId}" on ${entry.sourceSlideId} is not editable`)
        continue
      }
      edits.push({
        slide: page.originalSlideIndex,
        address: slot.address,
        newText: value.text,
        expectedText: strict ? slot.currentText || undefined : undefined,
        instance,
      })
    }
    for (const chart of entry.chartUpdates ?? []) {
      elementOps.push({
        slide: page.originalSlideIndex,
        instance,
        shapeId: chart.shapeId,
        build: (target) => ({
          op: 'updateChartData',
          target,
          data: { categories: chart.categories, series: chart.series },
        }),
      })
    }
    for (const image of entry.imageSlots ?? []) {
      const bytes = Buffer.from(image.imageBase64, 'base64')
      elementOps.push({
        slide: page.originalSlideIndex,
        instance,
        shapeId: image.shapeId,
        build: (target) => ({
          op: 'replacePicture',
          target,
          bytes,
          ext: image.ext,
          ...(image.keepSrcRect ? { keepSrcRect: true } : {}),
        }),
      })
    }
    for (const table of entry.tableUpdates ?? []) {
      for (const cell of table.cells) {
        elementOps.push({
          slide: page.originalSlideIndex,
          instance,
          shapeId: table.shapeId,
          build: (target) => ({
            op: 'setTableCell',
            target,
            row: cell.row,
            col: cell.col,
            paragraphs: cell.paragraphs.map((text) => ({ runs: [{ text }] })),
          }),
        })
      }
    }
  }
  if (errors.length > 0) return { ops: [], summary, errors }

  const compiled = compileFillOps(edits, { ...ctx, outputSequence, elementOps })
  summary.unshift(`plan ${plan.templateId}: ${outputSequence.length} output slides`)
  return { ...compiled, summary: [...summary, ...compiled.summary], errors: compiled.errors }
}
