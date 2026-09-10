/**
 * Role classifier (P1) — infer a template page's role from OBSERVED facts.
 *
 * Heuristics run first (text hints, shape counts, geometry); anything the
 * heuristics cannot decide stays `unknown` with a low confidence — never a
 * fabricated certainty (GOAL §三十二/§三十三).
 */
import type { ObservedTemplateFacts, PageRole } from './schema.js'

interface PageFacts {
  slideNumber: number
  shapes: ObservedTemplateFacts['pages'][number]['shapes']
}

export interface RoleInference {
  role: PageRole
  confidence: number
  useFor: string[]
  warnings: string[]
}

const TEXT = (facts: PageFacts): string =>
  facts.shapes
    .filter((s) => s.kind === 'text' && s.text)
    .map((s) => s.text!)
    .join(' ')

const HINTS: Array<{ re: RegExp; role: PageRole; confidence: number; useFor: string[] }> = [
  { re: /目录|contents|agenda/i, role: 'agenda', confidence: 0.8, useFor: ['目录页'] },
  {
    re: /thank|thanks|感谢聆听|感谢观看|致谢|谢谢观看/i,
    role: 'ending',
    confidence: 0.85,
    useFor: ['结束页'],
  },
  {
    // STRONG signals only: a title merely CONTAINING 模板 (e.g. 「工作计划模板」)
    // is a legitimate cover — promo pages say things like 模板下载/使用说明/稻壳
    re: /稻壳|模板下载|模板使用说明|感谢下载|本模板由|template by|download this template/i,
    role: 'template-promo',
    confidence: 0.9,
    useFor: [],
  },
  { re: /总结|summary|小结/i, role: 'summary', confidence: 0.5, useFor: ['总结页'] },
  { re: /timeline|时间轴|历程|路线图/i, role: 'timeline', confidence: 0.5, useFor: ['时间轴'] },
  {
    re: /comparison|对比|vs\.?|优势|劣势/i,
    role: 'comparison',
    confidence: 0.5,
    useFor: ['对比页'],
  },
]

export function classifyPageRole(facts: PageFacts, slideCount: number): RoleInference {
  const warnings: string[] = []
  const textShapeCount = facts.shapes.filter(
    (s) => s.kind === 'text' && (s.text?.trim().length ?? 0) > 0,
  ).length
  const pictureCount = facts.shapes.filter((s) => s.kind === 'picture').length
  const allText = TEXT(facts)

  // template promo wins over everything (skip pages)
  for (const hint of HINTS.slice(0, 3)) {
    if (hint.re.test(allText)) {
      return { role: hint.role, confidence: hint.confidence, useFor: hint.useFor, warnings }
    }
  }

  // cover: first slide of the deck with a big title-ish text and few shapes
  if (facts.slideNumber === 1 && textShapeCount <= 4 && pictureCount >= 0) {
    const big = facts.shapes.some((s) => (s.paragraphs?.[0]?.fontSizePt ?? 0) >= 28)
    if (big || textShapeCount <= 3) {
      return {
        role: 'cover',
        confidence: 0.75,
        useFor: ['封面'],
        warnings,
      }
    }
  }

  // ending: last slide, thank-you hints
  if (facts.slideNumber === slideCount) {
    const hint = HINTS.find((h) => h.role === 'ending')
    if (hint && hint.re.test(allText)) {
      return { role: hint.role, confidence: 0.85, useFor: hint.useFor, warnings }
    }
    return {
      role: 'content',
      confidence: 0.45,
      useFor: ['收尾内容页'],
      warnings: ['last slide without ending hints'],
    }
  }

  // section divider: very little text, 1-2 dominant short lines
  if (textShapeCount <= 3 && allText.trim().length > 0 && allText.trim().length <= 30) {
    return {
      role: 'section-divider',
      confidence: 0.6,
      useFor: ['章节扉页'],
      warnings,
    }
  }

  // content hints by keyword
  for (const hint of HINTS.slice(3)) {
    if (hint.re.test(allText)) {
      return { role: hint.role, confidence: hint.confidence, useFor: hint.useFor, warnings }
    }
  }

  // data slide: native chart present
  if (facts.shapes.some((s) => s.hasChart)) {
    return { role: 'data', confidence: 0.85, useFor: ['数据图表页'], warnings }
  }

  // dense text → body content
  if (textShapeCount >= 2) {
    return { role: 'content', confidence: 0.55, useFor: ['正文内容页'], warnings }
  }

  warnings.push('insufficient signal for role classification')
  return { role: 'unknown', confidence: 0.2, useFor: [], warnings }
}
