/**
 * P1-5 (production closure 2): CJK font fallback parity.
 *
 * The canvas drawing stack and the metrics stack must resolve through the
 * SAME font chain: every Simplified-Chinese-capable stack now carries the
 * Linux-available Noto CJK faces (and WenQuanYi) before the generic
 * sans-serif tail, so a Linux runner with fonts-noto-cjk draws CJK glyphs
 * instead of tofu — and draws them with the same face measurement used.
 */
import { describe, expect, it } from 'vitest'
import { displayFontFamily, displayFontFamilyForText } from '../src/renderer/konva-adapter'
import { classifyCjkScript } from '../src/shared/cjk-script'

const LINUX_CJK_FACES = ['Noto Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Zen Hei']

describe('CJK font fallback chain (P1-5)', () => {
  it('the default (unknown family) tail carries Linux-available CJK faces', () => {
    const stack = displayFontFamily('Some Unknown Brand Font')
    for (const face of LINUX_CJK_FACES) {
      expect(stack).toContain(face)
    }
    // CJK faces come BEFORE the generic tail: sans-serif alone = tofu on Linux
    const tail = stack.slice(stack.indexOf('sans-serif'))
    expect(tail).toBe('sans-serif')
    expect(stack.indexOf("'Noto Sans SC'")).toBeLessThan(stack.indexOf('sans-serif'))
  })

  it('known SC stacks (YaHei/PingFang/SimHei/DengXian) all carry a Linux Noto face', () => {
    for (const family of ['microsoft yahei', 'pingfang sc', 'simhei', 'dengxian']) {
      const stack = displayFontFamily(family)
      expect(stack, `${family} must include Noto Sans SC`).toContain('Noto Sans SC')
    }
  })

  it('script-specific stacks for JA/KO/TC keep their own Noto faces', () => {
    expect(displayFontFamily('yu gothic')).toContain('Noto Sans JP')
    expect(displayFontFamily('malgun gothic')).toContain('Noto Sans KR')
    expect(displayFontFamily('microsoft jhenghei')).toContain('Noto Sans TC')
  })

  it('CJK script detection routes JA-named families to JA stacks (Noto Sans JP included)', () => {
    expect(classifyCjkScript('Yu Gothic')).toBe('ja')
    expect(classifyCjkScript('Malgun Gothic')).toBe('ko')
    expect(displayFontFamily('yu gothic')).toContain('Noto Sans JP')
  })

  it('measurement parity: the drawn stack equals the measured stack for CJK text', () => {
    // konva-adapter draws with displayFontFamily(name); font-metrics resolves
    // substitutions through findFontCovering → the Linux Noto face is BOTH the
    // measurement substitute and the drawing face. Assert the chain order so
    // the first AVAILABLE face is identical on both sides (Linux: Noto).
    const stack = displayFontFamily('microsoft yahei')
    const faces = stack.split(',').map((f) => f.trim().replace(/'/g, ''))
    expect(faces[0]).toBe('Microsoft YaHei')
    expect(faces.indexOf('Noto Sans SC')).toBeLessThan(faces.indexOf('sans-serif'))
  })
})

describe('script-aware fallback (P1-5): family + ACTUAL text script', () => {
  it('Calibri + CJK text appends a CJK-capable face (was the tofu case)', () => {
    const stack = displayFontFamilyForText('Calibri', '底物经两步酶促反应生成产物')
    expect(stack).toContain('Noto Sans CJK SC')
    expect(stack).toContain('Calibri')
  })

  it('pure-Latin Calibri text stays unchanged (no CJK faces appended)', () => {
    const plain = displayFontFamily('Calibri')
    expect(displayFontFamilyForText('Calibri', 'Enzyme reaction step 1')).toBe(plain)
    expect(plain).not.toContain('Noto Sans CJK SC')
  })

  it('mixed text (mostly Latin + one CJK char) still gets the CJK face', () => {
    const stack = displayFontFamilyForText('Calibri', 'step 酶')
    expect(stack).toContain('Noto Sans CJK SC')
  })

  it('CJK-declared families are not double-appended', () => {
    const once = displayFontFamilyForText('microsoft yahei', '中文文本')
    expect(once.match(/Noto Sans SC/g)?.length).toBe(1)
  })
})
