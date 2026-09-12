/**
 * GOAL section 12-15 + section 19: analyzer facts expansion verified against a real
 * Gorden deck — extended per-shape facts, theme font scheme, geometry-accurate
 * capacity, figure slots, and the real-layout measurement tier.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeTemplateBytes, measureTextFitReal, observeTemplateFacts } from '../src/index.js'

const GORDEN_DIR = process.env.GORDEN_TEMPLATES_DIR
const HAS_GORDEN = Boolean(GORDEN_DIR && existsSync(join(GORDEN_DIR, 'minimal-business-summary')))

describe('analyzer observed-facts expansion (GOAL section 12-15)', () => {
  it.skipIf(!HAS_GORDEN)('extracts fonts, layout parts and extended shape facts', async () => {
    const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
    const { facts } = await observeTemplateFacts(bytes)
    // section 13: theme font scheme read from theme1.xml
    expect(facts.themeFonts.majorLatin || facts.themeFonts.minorLatin).toBeTruthy()
    // section 12: layout parts observed for slides
    expect(facts.pages.some((p) => p.layoutPart && p.layoutPart.includes('slideLayout'))).toBe(true)
    // section 12: z-order + rotation + anchor facts present on at least one shape
    expect(facts.pages.some((p) => p.shapes.some((s) => s.zOrder !== undefined))).toBe(true)
    expect(
      facts.pages.some((p) =>
        p.shapes.some((s) => s.verticalAnchor !== undefined || s.fillColor !== undefined),
      ),
    ).toBe(true)
  })

  it.skipIf(!HAS_GORDEN)('builds geometry-accurate capacity and figure slots', async () => {
    const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
    const def = await analyzeTemplateBytes(bytes, { type: 'gorden-local' })
    const slots = def.pages.flatMap((p) => p.editableSlots)
    // section 14: capacity carries box geometry + derived line stats
    const withGeometry = slots.filter((s) => s.capacity.boxEmu != null)
    expect(withGeometry.length).toBeGreaterThan(0)
    for (const slot of withGeometry.slice(0, 5)) {
      expect(slot.capacity.tier).toBe('fast-estimate')
      expect(slot.capacity.charsPerLine ?? 0).toBeGreaterThan(0)
      expect(slot.capacity.maxLines ?? 0).toBeGreaterThan(0)
      expect(slot.capacity.boxWidthPx ?? 0).toBeGreaterThan(0)
    }
    // section 13: observed font profile
    expect(def.style.fontProfile).toBeDefined()
    expect(
      def.style.fontProfile!.theme.majorLatin ?? def.style.fontProfile!.theme.minorLatin,
    ).toBeTruthy()
    // section 19: figure slots exist for EVERY observed picture/chart shape
    const visualCount = def.pages
      .flatMap((p) => p.nonEditableSlots)
      .filter((s) => s.role === 'figure').length
    const visuals = (await observeTemplateFacts(bytes)).facts.pages
      .flatMap((p) => p.shapes)
      .filter((s) => s.kind === 'picture' || s.kind === 'chart')
    expect(visualCount).toBe(visuals.length)
    if (visualCount > 0) {
      const figures = def.pages
        .flatMap((p) => [...p.editableSlots, ...p.nonEditableSlots])
        .filter((s) => s.role === 'figure')
      expect(figures.every((f) => f.id.endsWith('_fig'))).toBe(true)
    }
  })

  it.skipIf(!HAS_GORDEN)(
    'real-layout measure upgrades confidence when the family is installed',
    async () => {
      const bytes = readFileSync(join(GORDEN_DIR!, 'minimal-business-summary', 'template.pptx'))
      const def = await analyzeTemplateBytes(bytes, { type: 'gorden-local' })
      const slot = def.pages
        .flatMap((p) => p.editableSlots)
        .find((s) => s.capacity.boxEmu != null && s.typography.fontFamily)
      if (!slot) return // deck without named families: nothing to measure
      const result = await measureTextFitReal('长文本测量样本 sample text for measurement', slot, {
        boxEmu: slot.capacity.boxEmu,
        insetsEmu: slot.capacity.textInsetsEmu,
        fontPt: slot.typography.fontSizePt,
        family: slot.typography.fontFamily,
      })
      // null is acceptable only when the family isn't installed on this machine;
      // a result MUST carry the measured tier markers (high confidence, wrapped)
      if (result) {
        expect(result.confidence).toBeGreaterThan(0.9)
        expect(result.estimatedLines).toBeGreaterThan(0)
        expect(result.maxLines).toBeGreaterThan(0)
      }
    },
  )
})
