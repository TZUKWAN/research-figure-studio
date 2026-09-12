/**
 * GOAL section 16-18: QA gates (placeholder/empty/unchanged + allowlist semantics),
 * layout-aware type scale and the two-level role classifier.
 */
import { describe, expect, it } from 'vitest'
import { auditPlaceholders } from '../src/qa.js'
import { inferTypeScale } from '../src/analyzer.js'
import { classifyPageRole, classifyPageRoleTwoLevel } from '../src/role-classifier.js'
import type { ObservedTemplateFacts } from '../src/schema.js'

const shape = (over: Partial<ObservedTemplateFacts['pages'][number]['shapes'][number]>) =>
  ({
    shapeId: 1,
    kind: 'text',
    hasChart: false,
    ...over,
  }) as ObservedTemplateFacts['pages'][number]['shapes'][number]

describe('auditPlaceholders (GOAL section 16)', () => {
  const slide = {
    slideIndex: 0,
    elements: [
      { elementId: 'a', text: '正式标题内容', editable: true },
      { elementId: 'b', text: '', editable: true },
      { elementId: 'c', text: '模板原文', editable: true, currentText: '模板原文' },
      { elementId: 'd', text: '点击此处', editable: true },
      { elementId: 'e', text: '© 2026 Metis Inc.', editable: true },
      { elementId: 'f', text: 'TODO', editable: true, explicitUnused: true },
    ],
  }

  it('flags empty editable slots, unchanged template text and placeholder patterns', () => {
    const r = auditPlaceholders([slide])
    expect(r.pass).toBe(false)
    const kinds = r.issues.map((i) => `${i.elementId}:${i.kind}`).sort()
    expect(kinds).toEqual(['b:EMPTY_EDITABLE', 'c:UNCHANGED_TEMPLATE_TEXT', 'd:PLACEHOLDER_TEXT'])
    expect(r.explicitlyUnused).toBe(1) // f counts as unused, never as an issue
  })

  it('allowlist suppresses intentionally kept text (precedence over extraForbidden)', () => {
    const slides = {
      ...slide,
      elements: [
        ...slide.elements,
        { elementId: 'g', text: 'internal draft copy', editable: true },
      ],
    }
    const r = auditPlaceholders([slides], {
      allowlist: [/© \d{4}/, /^正式/],
      extraForbidden: [/internal draft/, /Metis Inc\./],
    })
    // 'e' matches BOTH allowlist and extraForbidden — allowlist wins by design;
    // 'g' has no allowlist match and is caught by the extended pattern
    const ids = r.issues.map((i) => i.elementId).sort()
    expect(ids).toEqual(['b', 'c', 'd', 'g'])
  })
})

describe('layout-aware type scale (GOAL section 17)', () => {
  const factsWith = (cy: number, sizePt: number): ObservedTemplateFacts =>
    ({
      slideSizeEmu: { cx: 9144000, cy },
      pages: [
        {
          slideNumber: 1,
          shapes: [
            shape({
              paragraphs: [
                {
                  index: 0,
                  runs: [{ index: 0, text: 'T', fontSizePt: sizePt }],
                },
              ],
            }),
          ],
        },
      ],
    }) as unknown as ObservedTemplateFacts

  it('16:9 reference sizes keep their real value', () => {
    const scale = inferTypeScale(factsWith(6858000, 40))
    expect(scale[0]).toMatchObject({ sizePt: 40, level: 1 })
  })

  it('4:3 canvases normalize to the same level assignment', () => {
    // 9144000×6858000 is 4:3; k = 6858000/4572000 = 1.5 on a half-height deck
    const scale = inferTypeScale(factsWith(4572000, 40))
    expect(scale[0]!.sizePt).toBeCloseTo(60, 5) // 40 × 1.5 normalized
  })
})

describe('two-level role classifier (GOAL section 18)', () => {
  const ambiguousPage = {
    slideNumber: 3,
    shapes: [
      shape({ text: '杂项', paragraphs: [{ index: 0, runs: [{ index: 0, text: '杂项' }] }] }),
    ],
  } as ObservedTemplateFacts['pages'][number]
  const slideCount = 10

  it('skips vision when the deterministic result is confident', async () => {
    let called = 0
    const r = await classifyPageRoleTwoLevel(
      { slideNumber: 1, shapes: [shape({ text: '目录', paragraphs: [] })] },
      slideCount,
      {
        vision: async () => {
          called++
          return null
        },
      },
    )
    expect(r.role).toBe('agenda')
    expect(called).toBe(0)
  })

  it('upgrades via vision when deterministic confidence is below the threshold', async () => {
    const base = classifyPageRole(ambiguousPage, slideCount)
    expect(base.confidence).toBe(0.6)
    // a stricter threshold makes this page eligible for the vision fallback
    const r = await classifyPageRoleTwoLevel(ambiguousPage, slideCount, {
      threshold: 0.65,
      vision: async () => ({ role: 'timeline', confidence: 0.8 }),
    })
    expect(r.role).toBe('timeline')
    expect(r.warnings.join(' ')).toMatch(/vision/)
  })

  it('fails open to the deterministic role when vision errors', async () => {
    const base = classifyPageRole(ambiguousPage, slideCount)
    const r = await classifyPageRoleTwoLevel(ambiguousPage, slideCount, {
      threshold: 0.65,
      vision: async () => {
        throw new Error('vision unavailable')
      },
    })
    expect(r.role).toBe(base.role)
    expect(r.confidence).toBe(base.confidence)
  })

  it('rejects invalid vision roles', async () => {
    const r = await classifyPageRoleTwoLevel(ambiguousPage, slideCount, {
      threshold: 0.65,
      vision: async () => ({ role: 'president-of-the-universe' as never, confidence: 0.99 }),
    })
    expect(r.role).toBe(classifyPageRole(ambiguousPage, slideCount).role)
  })
})
