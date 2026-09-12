/**
 * GOAL section 20 theme bridge + section 24 fidelity mode.
 */
import { describe, expect, it } from 'vitest'
import { bridgeTemplateTheme } from '../src/theme-bridge.js'
import { analyzeTemplateBytes, compileFillPlan } from '../src/index.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GORDEN_DIR = process.env.GORDEN_TEMPLATES_DIR
const HAS_GORDEN = Boolean(GORDEN_DIR && existsSync(join(GORDEN_DIR, 'minimal-business-summary')))

describe('bridgeTemplateTheme (GOAL section 20)', () => {
  it('assigns roles by luminance: dark → text, mids → structure, light → surface', () => {
    const bridge = bridgeTemplateTheme({
      style: {
        tags: [],
        colors: ['#1F3864', '#C55A11', '#F2F2F2', '#7F7F7F'],
        fonts: {},
        typeScale: [],
        density: 'medium',
      },
    })
    expect(bridge.roles.textPrimary).toBe('#1F3864') // darkest
    expect(bridge.roles.background === '#F2F2F2' || bridge.roles.background === '#7F7F7F').toBe(
      true,
    )
    expect(bridge.roles.primary).not.toBe(bridge.roles.textPrimary)
    expect(Object.values(bridge.roles).every((c) => /^#[0-9a-fA-F]{6}$/.test(c))).toBe(true)
  })

  it('degrades to defaults without throwing on an empty palette', () => {
    const bridge = bridgeTemplateTheme({
      style: { tags: [], colors: [], fonts: {}, typeScale: [], density: 'sparse' },
    })
    expect(Object.values(bridge.roles).every((c) => /^#[0-9a-fA-F]{6}$/.test(c))).toBe(true)
  })

  it.skipIf(!HAS_GORDEN)('bridges a real Gorden deck with its theme fonts', async () => {
    const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
    const def = await analyzeTemplateBytes(bytes, { type: 'gorden-local' })
    const bridge = bridgeTemplateTheme(def)
    expect(bridge.source.palette.length).toBeGreaterThan(0)
    expect(bridge.fonts?.latin ?? bridge.fonts?.cjk).toBeTruthy()
  })
})

describe('fidelity mode (GOAL section 24)', () => {
  const makeDef = (currentText: string) => ({
    id: 'tpl',
    schemaVersion: '1.1',
    name: 'T',
    source: { type: 'gorden-local' as const },
    slideSize: { widthPx: 1280, heightPx: 720, aspectRatio: 1.78 },
    style: { tags: [], colors: [], fonts: {}, typeScale: [], density: 'medium' as const },
    pageRoles: {},
    editingRules: [],
    pages: [
      {
        slideId: 'slide-1',
        originalSlideIndex: 1,
        role: 'cover' as const,
        roleConfidence: 0.9,
        layoutDescription: '',
        useFor: [],
        styleFeatures: [],
        density: 'sparse' as const,
        editableSlots: [
          {
            id: 's1_sh1_p0',
            slideId: 'slide-1',
            role: 'title' as const,
            address: { shapeId: 7, paragraph: 0 },
            currentText,
            editable: true,
            capacity: { tier: 'fast-estimate' as const, confidence: 0.7 },
            typography: {},
          },
        ],
        nonEditableSlots: [],
        chartShapeIds: [],
        cautionNotes: [],
      },
    ],
  })
  const planEntry = (fidelity?: 'preserve-template' | 'adaptive') => ({
    templateId: 'tpl',
    ...(fidelity ? { fidelity } : {}),
    slides: [
      {
        sourceSlideId: 'slide-1',
        outputOrder: 0,
        purpose: 'test',
        slotValues: [{ slotId: 's1_sh1_p0', text: 'new' }],
      },
    ],
  })
  const ctx = (liveText: string) => ({
    totalSlides: 1,
    slideIds: new Map([[1, 's_1']]),
    slideElements: new Map([
      [1, [{ elementId: 'el', durableId: 'e_7', nvId: 7, paragraphCount: 1, text: liveText }]],
    ]),
  })

  it('preserve-template (default) fails on drifted slot text', () => {
    const r = compileFillPlan(makeDef('template original'), planEntry(), ctx('user edited this'))
    expect(r.errors.join(' ')).toMatch(/expected_text mismatch/)
    expect(r.ops).toHaveLength(0)
  })

  it('adaptive tolerates drift and compiles the fill', () => {
    const r = compileFillPlan(
      makeDef('template original'),
      planEntry('adaptive'),
      ctx('user edited this'),
    )
    expect(r.errors).toEqual([])
    expect(r.ops.filter((o) => o.op === 'setSlotParagraphText')).toHaveLength(1)
  })

  it('strict passes when the deck matches the analysis', () => {
    const r = compileFillPlan(makeDef('template original'), planEntry(), ctx('template original'))
    expect(r.errors).toEqual([])
  })
})
