import { describe, expect, it } from 'vitest'
import {
  OUTPUT_CONTEXT_MIN_TEXT_PT,
  effectiveFontPt,
  parseFigureContract,
  publicationAudit,
  qualityThresholdFor,
} from '../src/contract/figure-contract.js'
import {
  DOMAIN_PROFILES,
  domainPresentationDefault,
  resolveDomain,
} from '../src/contract/domain-profile.js'
import { getComponentSpec, RESEARCH_COMPONENT_REGISTRY } from '../src/components/registry.js'
import { orchestrateFigure, type FigurePlanV2 } from '../src/index.js'

describe('P1 figure contract', () => {
  it('repairs a raw contract with safe defaults', () => {
    const contract = parseFigureContract({
      centralClaim: '共同注意提升协作效率',
      figureFamily: 'MECHANISM',
      domain: 'biomed',
      venue: 'Nature Communications',
      output: { context: 'paper-single-column' },
      evidenceMustShow: [
        { id: 'e1', description: 'activation path', source: 'document', required: true },
      ],
      evidenceOptional: [
        { id: 'e2', description: 'optional control', source: 'user', required: false },
      ],
      forbiddenClaims: ['accuracy 98%'],
      visibleTextPolicy: { allowed: ['A', 'B'], language: 'zh' },
      provenance: [{ claim: 'activation path', source: 'document', locator: 'fig3' }],
    })
    expect(contract?.figureFamily).toBe('mechanism')
    expect(contract?.output.context).toBe('paper-single-column')
    expect(contract?.evidenceMustShow).toHaveLength(1)
    expect(contract?.evidenceOptional).toHaveLength(1)
    expect(contract?.visibleTextPolicy.language).toBe('zh')
    expect(contract?.provenance[0]?.source).toBe('document')
  })

  it('rejects a contract without a central claim and defaults unknown enums', () => {
    expect(parseFigureContract({ figureFamily: 'mechanism' })).toBeNull()
    const fallback = parseFigureContract({
      centralClaim: 'x',
      figureFamily: 'teleport',
      output: { context: 'holodeck' },
    })
    expect(fallback?.figureFamily).toBe('freeform')
    expect(fallback?.output.context).toBe('presentation')
  })

  it('computes effective font at final physical width', () => {
    // 1280px canvas ≈ 338.7mm; 13pt printed at 85mm → 13 * 85 / 338.7 ≈ 3.3pt
    expect(effectiveFontPt(13, 1280, 85)).toBeCloseTo(3.26, 1)
    expect(effectiveFontPt(13, 1280, 338.7)).toBeCloseTo(13, 1)
  })

  it('publication audit gates tiny final text as a hard failure', () => {
    const contract = parseFigureContract({
      centralClaim: 'x',
      output: { context: 'paper-single-column' },
    })!
    const issues = publicationAudit({
      contract,
      canvasW: 1280,
      canvasH: 720,
      minFontPt: 10.5,
    })
    expect(issues.some((issue) => issue.gate === 'final-size-text-minimum')).toBe(true)
    // presentation context keeps the same font readable
    const presentation = parseFigureContract({
      centralClaim: 'x',
      output: { context: 'presentation' },
    })!
    expect(
      publicationAudit({ contract: presentation, canvasW: 1280, canvasH: 720, minFontPt: 10.5 }),
    ).toEqual([])
  })

  it('venue-driven thresholds escalate for journals', () => {
    expect(
      qualityThresholdFor({
        venue: 'Nature Microsystems',
        output: { context: 'presentation' } as never,
      }),
    ).toBe(8.5)
    expect(qualityThresholdFor(undefined)).toBe(7.5)
    expect(OUTPUT_CONTEXT_MIN_TEXT_PT['paper-double-column']).toBe(5.5)
  })
})

describe('P1 domain profiles', () => {
  it('resolves declared domains and falls back to general', () => {
    expect(resolveDomain('cs-ml')).toBe('cs-ml')
    expect(resolveDomain('astro-physics')).toBe('general')
    expect(resolveDomain()).toBe('general')
  })

  it('gives biomed inhibition a flat-ended marker, not a plain arrow', () => {
    expect(domainPresentationDefault('biomed', 'inhibition')).toBe('inhibition')
    expect(domainPresentationDefault('social-science', 'moderation')).toBe('dashed-arrow')
    expect(domainPresentationDefault('general', 'inhibition')).toBeNull()
  })

  it('carries renderer kind overrides for cs-ml and materials', () => {
    expect(DOMAIN_PROFILES['cs-ml'].kindOverrides?.['data-source']).toBe('data-store')
    expect(DOMAIN_PROFILES['materials-chemistry'].kindOverrides?.process).toBe('reaction-stage')
    expect(getComponentSpec('data-store').preset).toBe('can')
    expect(getComponentSpec('process-stage').preset).toBe('chevron')
  })
})

describe('P1 scientific primitive registry', () => {
  it('no longer collapses every component into roundRect', () => {
    const presets = new Set([...RESEARCH_COMPONENT_REGISTRY.values()].map((spec) => spec.preset))
    expect(presets.size).toBeGreaterThanOrEqual(8)
    expect(presets.has('can')).toBe(true)
    expect(presets.has('chevron')).toBe(true)
    expect(presets.has('diamond')).toBe(true)
    expect(presets.has('rect')).toBe(true)
  })
})

describe('P1 contract-driven orchestration', () => {
  const plan = {
    thesis: '多源输入经核心机制产生服务决策',
    figureType: 'input-core-output',
    nodes: [
      {
        id: 'in1',
        type: 'data-source',
        semanticLabel: '多源访谈数据',
        visible: { title: '访谈数据' },
        importance: 0.4,
        role: 'input',
      },
      {
        id: 'core',
        type: 'mechanism',
        semanticLabel: '核心机制',
        visible: { title: '核心机制' },
        importance: 0.9,
        role: 'core',
      },
      {
        id: 'out',
        type: 'outcome',
        semanticLabel: '服务决策',
        visible: { title: '服务决策' },
        importance: 0.7,
        role: 'output',
      },
    ],
    edges: [{ from: 'in1', to: 'core', role: 'main', relation: 'causal' }],
    groups: [],
    globalIntent: { emphasis: ['core'], secondary: [], optional: [] },
  } as unknown as FigurePlanV2

  it('scales canvas fonts forward so a journal contract clears its floor', async () => {
    const contract = parseFigureContract({
      centralClaim: plan.thesis,
      figureFamily: 'mechanism',
      output: { context: 'paper-single-column' },
    })!
    const result = await orchestrateFigure(
      { thesis: plan.thesis, canvasW: 1280, canvasH: 720, contract },
      { semanticPlan: async () => plan },
    )
    expect(result.ok, result.critic?.gateIssues.join('; ')).toBe(true)
    // floor 5.5pt at 85mm → canvas detail text must have been scaled ≥ ~21pt
    expect(result.critic?.verdict).toBe('PASS')
    expect(result.domain).toBe('general')
  })

  it('reports the resolved domain on the result', async () => {
    const result = await orchestrateFigure(
      { thesis: plan.thesis, canvasW: 1280, canvasH: 720, domainHint: 'cs-ml' },
      { semanticPlan: async () => plan },
    )
    expect(result.domain).toBe('cs-ml')
  })
})
