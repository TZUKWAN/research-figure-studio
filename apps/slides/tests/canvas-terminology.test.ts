import { describe, expect, it } from 'vitest'
import { strings } from '../src/renderer/i18n/strings'

const locales = Object.keys(strings) as Array<keyof typeof strings>
const referenceKeys = Object.keys(strings.zh).sort()

function placeholdersOf(template: string): string[] {
  return (template.match(/\{[a-zA-Z0-9]+\}/g) ?? []).sort()
}

describe('slides editor locale tables', () => {
  it('includes every supported editor locale', () => {
    expect(locales).toContain('zh')
    expect(locales).toContain('en')
    expect(locales).toContain('zh-TW')
    expect(locales).toHaveLength(19)
  })

  it.each(locales)('locale %s has the same keys as zh', (locale) => {
    expect(Object.keys(strings[locale]).sort()).toEqual(referenceKeys)
  })

  it.each(locales)('locale %s has populated values with matching placeholders', (locale) => {
    const table = strings[locale] as Record<string, string>
    const zh = strings.zh as Record<string, string>
    const empty = Object.entries(table)
      .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
      .map(([key]) => key)
    const placeholderMismatches = referenceKeys.filter(
      (key) => placeholdersOf(table[key]).join(',') !== placeholdersOf(zh[key]).join(','),
    )

    expect(empty).toEqual([])
    expect(placeholderMismatches).toEqual([])
  })

  it('uses canvas terminology for the product editing unit', () => {
    const zh = strings.zh as Record<string, string>
    const en = strings.en as Record<string, string>

    expect(zh.appStatusBarSlide).toBe('画布 {current} / {total}')
    expect(zh.appCtxNewSlide).toBe('新建画布')
    expect(zh.aiProgressDone).toContain('画布')
    expect(en.appStatusBarSlide).toBe('Canvas {current} of {total}')
    expect(en.appCtxNewSlide).toBe('New Canvas')
    expect(en.aiStagePages).toBe('Generating canvases')
  })

  it('retains PowerPoint and PPTX compatibility wording', () => {
    const zh = strings.zh as Record<string, string>
    const en = strings.en as Record<string, string>

    expect(zh.appStatusVideoInserted).toContain('pptx')
    expect(zh.appStatusVideoInserted).toContain('PowerPoint')
    expect(en.appStatusVideoInserted).toContain('.pptx')
    expect(en.appStatusVideoInserted).toContain('PowerPoint')
  })
})
