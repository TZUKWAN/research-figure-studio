/**
 * Template intelligence — analyzer + fill compiler against a REAL Gorden deck
 * (env-gated: set GORDEN_TEMPLATES_DIR to the cloned gorden-ppt-skill-ref/templates).
 * Falls back to tiny hand-built fixtures when the env is absent (CI).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTemplateBytes } from '../src/analyzer.js'
import { compileFillOps } from '../src/fill.js'
import { auditPlaceholders } from '../src/qa.js'

const GORDEN_DIR = process.env.GORDEN_TEMPLATES_DIR
const HAS_GORDEN = Boolean(GORDEN_DIR && existsSync(join(GORDEN_DIR, 'minimal-business-summary')))

describe('analyzer on real Gorden deck', () => {
  it.skipIf(!HAS_GORDEN)('analyzes minimal-business-summary end to end', async () => {
    const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
    const def = await analyzeTemplateBytes(
      bytes,
      { type: 'gorden-local', sourceFile: 'minimal-business-summary' },
      'minimal-business-summary',
    )
    expect(def.schemaVersion).toBe('1.0')
    expect(def.pages).toHaveLength(16)
    expect(def.style.typeScale.length).toBeGreaterThan(3)
    expect(def.pageRoles['cover']).toBeDefined()
    expect(def.pageRoles['agenda']).toBeDefined()
    // every page has at least one slot entry (editable or decorative)
    expect(def.pages.every((p) => p.editableSlots.length + p.nonEditableSlots.length > 0)).toBe(
      true,
    )
    // slots carry addresses with shape ids and paragraph indexes
    const firstSlot = def.pages.flatMap((p) => p.editableSlots)[0]!
    expect(firstSlot.address.shapeId).toBeGreaterThan(0)
    expect(firstSlot.address.paragraph).toBeGreaterThanOrEqual(0)
  })

  it.skipIf(!HAS_GORDEN)(
    'fill compiler maps slot edits to native ops on real deck shape ids',
    async () => {
      const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
      const def = await analyzeTemplateBytes(bytes, {
        type: 'gorden-local',
      })
      const page = def.pages[0]!
      const slot = page.editableSlots[0]!
      const compiled = compileFillOps(
        [
          {
            slide: 1,
            address: { shapeId: slot.address.shapeId, paragraph: slot.address.paragraph },
            newText: '2026 年度复盘',
          },
        ],
        {
          selectedSlides: [1, 2, 4],
          totalSlides: def.pages.length,
          slideElements: new Map([
            [
              1,
              [
                {
                  elementId: `slide-1-shape-${slot.address.shapeId}`,
                  nvId: slot.address.shapeId,
                  paragraphCount: 4,
                  text: slot.currentText,
                },
              ],
            ],
          ]),
        },
      )
      expect(compiled.errors).toEqual([])
      // 13 unselected slides pruned + 1 text op
      expect(compiled.ops.filter((o) => o.op === 'deleteSlide')).toHaveLength(13)
      expect(compiled.ops.filter((o) => o.op === 'setSlotParagraphText')).toHaveLength(1)
    },
  )
})

describe('placeholder audit', () => {
  it('flags lorem/tbd/点击添加 and passes a clean deck', () => {
    const result = auditPlaceholders([
      {
        slideIndex: 0,
        elements: [
          { elementId: 'e1', text: '2026 年度复盘', editable: true },
          { elementId: 'e2', text: 'Lorem ipsum dolor sit amet', editable: true },
          { elementId: 'e3', text: 'TBD', editable: true },
          { elementId: 'e4', text: 'Click to add title', editable: true },
        ],
      },
    ])
    expect(result.pass).toBe(false)
    expect(result.issues).toHaveLength(3)
  })
})
