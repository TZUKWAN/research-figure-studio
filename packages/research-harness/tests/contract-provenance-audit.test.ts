/**
 * P0-7 (production closure): FigureContract / provenance / visible-text.
 *
 * - evidenceOptional entries default to optional (placement decides, the
 *   caller never repeats required:false)
 * - evidenceRefs NEVER satisfy a quantitative provenance requirement
 * - the allowed whitelist is exact: an authorized phrase cannot whitewash an
 *   appended fabricated number
 * - structured claimType:'quantitative' nodes require provenance even when
 *   the regex misses
 */
import { describe, expect, it } from 'vitest'
import { parseFigureContract } from '../src/contract/figure-contract.js'
import {
  auditFigureContract,
  type ContractAuditInput,
  type RenderedText,
} from '../src/contract/contract-audit.js'

const CONTRACT = parseFigureContract({
  centralClaim: 'A improves B',
  forbiddenClaims: ['世界领先'],
  visibleTextPolicy: {
    allowed: ['模型性能提升', '消融结果*'],
    required: ['A improves B'],
    forbidden: ['零成本'],
  },
  evidenceMustShow: [{ id: 'ev-1', description: 'benchmark table' }],
  evidenceOptional: [{ id: 'ev-opt-1', description: 'extra ablation' }],
  provenance: [],
})!

describe('evidenceOptional default (P0-7.1)', () => {
  it('keeps optional entries without an explicit required:false', () => {
    expect(CONTRACT.evidenceMustShow.map((e) => e.id)).toEqual(['ev-1'])
    expect(CONTRACT.evidenceOptional.map((e) => e.id)).toEqual(['ev-opt-1'])
  })

  it('an explicit flag wins within its section (contradictory entries are dropped, never relocated)', () => {
    const explicit = parseFigureContract({
      centralClaim: 'x',
      evidenceMustShow: [{ id: 'a', required: false }],
      evidenceOptional: [{ id: 'b', required: true }],
    })!
    expect(explicit.evidenceMustShow).toEqual([])
    expect(explicit.evidenceOptional).toEqual([])
  })
})

function baseInput(
  texts: RenderedText[],
  extra: Partial<ContractAuditInput> = {},
): ContractAuditInput {
  return {
    contract: CONTRACT,
    placedNodeIds: ['n1'],
    renderedTexts: texts,
    evidenceRefs: new Map([['n1', ['ev-1']]]),
    ...extra,
  }
}

describe('provenance channel separation (P0-7.2)', () => {
  const claim: RenderedText[] = [{ id: 'n1', kind: 'title', text: '准确率提升 37.8% 的结果' }]

  it('a quantitative claim with only evidenceRefs FAILS provenance', () => {
    const issues = auditFigureContract(baseInput(claim))
    expect(issues.some((i) => i.kind === 'PROVENANCE_MISSING')).toBe(true)
  })

  it('a quantitative claim with provenanceRefs passes', () => {
    const issues = auditFigureContract(
      baseInput(claim, { provenanceRefs: new Map([['n1', ['doi:10.1/x']]]) }),
    )
    expect(issues.some((i) => i.kind === 'PROVENANCE_MISSING')).toBe(false)
  })

  it('a quantitative claim with NO refs at all fails', () => {
    const issues = auditFigureContract(baseInput(claim, { evidenceRefs: new Map() }))
    expect(issues.some((i) => i.kind === 'PROVENANCE_MISSING')).toBe(true)
  })

  it('sample-marked micro text is exempt', () => {
    const issues = auditFigureContract(
      baseInput([{ id: 'm1', kind: 'micro', text: '示例：准确率 90%（sample data）' }]),
    )
    expect(issues.some((i) => i.kind === 'PROVENANCE_MISSING')).toBe(false)
  })

  it('a claimType:quantitative node requires provenance even without a regex hit', () => {
    const issues = auditFigureContract(
      baseInput([{ id: 'n1', kind: 'title', text: '显著优于基线方法' }], {
        quantitativeNodeIds: new Set(['n1']),
      }),
    )
    expect(issues.some((i) => i.kind === 'PROVENANCE_MISSING')).toBe(true)
  })
})

describe('visible-text whitelist exactness (P0-7.3)', () => {
  it('an allowed phrase does NOT whitewash an appended fabricated number', () => {
    const issues = auditFigureContract(
      baseInput([{ id: 'n1', kind: 'title', text: '模型性能提升 37.8%，达到世界领先水平' }], {
        provenanceRefs: new Map([['n1', ['doi:10.1/x']]]),
      }),
    )
    expect(issues.some((i) => i.kind === 'ALLOWED_VIOLATION')).toBe(true)
    // and the forbidden claim detector fires independently
    expect(issues.some((i) => i.kind === 'FORBIDDEN')).toBe(true)
  })

  it('an exact allowlist entry passes', () => {
    const issues = auditFigureContract(
      baseInput([{ id: 'n1', kind: 'title', text: '模型性能提升' }]),
    )
    expect(issues.some((i) => i.kind === 'ALLOWED_VIOLATION')).toBe(false)
  })

  it('a * stem allows prefix composition but never appended quantitative claims', () => {
    const okText = auditFigureContract(
      baseInput([{ id: 'n1', kind: 'title', text: '消融结果汇总' }]),
    )
    expect(okText.some((i) => i.kind === 'ALLOWED_VIOLATION')).toBe(false)
    const badText = auditFigureContract(
      baseInput([{ id: 'n1', kind: 'title', text: '消融结果：提升 12.5%' }], {
        provenanceRefs: new Map([['n1', ['doi:10.1/x']]]),
      }),
    )
    expect(badText.some((i) => i.kind === 'ALLOWED_VIOLATION')).toBe(true)
  })

  it('forbidden claims and missing required text are reported', () => {
    const issues = auditFigureContract(
      baseInput([
        { id: 'n1', kind: 'title', text: '零成本加速方案' },
        { id: 'n2', kind: 'detail', text: 'A improves B' },
      ]),
    )
    expect(issues.some((i) => i.kind === 'FORBIDDEN')).toBe(true)
    expect(issues.filter((i) => i.kind === 'REQUIRED_TEXT_MISSING')).toHaveLength(0)
  })

  it('required text missing from the canvas fails', () => {
    const issues = auditFigureContract(baseInput([{ id: 'n1', kind: 'title', text: '无关标题' }]))
    expect(issues.some((i) => i.kind === 'REQUIRED_TEXT_MISSING')).toBe(true)
  })
})
