/**
 * P0-3 (production closure 2): ONE runtime machine protocol.
 *
 * - figureFamilies are DERIVED from the family-strategy implementation, never
 *   hand-copied: supported ⇔ strategy composes ≥1 grammar; outreach (strict,
 *   empty) is declared unsupported instead of promised.
 * - Every schema-declarable relation presentation is renderer-realized
 *   (connector ∪ spatial); `junction` (no production renderer) stays out.
 * - The compiled protocol's schemas carry capability-constrained enums; the
 *   app prompt embeds the SAME compiled schema (no second hand-built copy).
 */
import { describe, expect, it } from 'vitest'
import {
  compileResearchRuntimeProtocol,
  FIGURE_PLAN_PROTOCOL_VERSION,
  renderJsonContract,
} from '../src/protocol/figure-plan-protocol.js'
import { RELATION_PRESENTATIONS } from '../src/semantic/schema.js'
import { RUNTIME_CAPABILITIES } from '../src/protocol/runtime-capabilities.js'
import { FAMILY_STRATEGIES } from '../src/composition/family-strategy.js'
import { FIGURE_FAMILIES } from '../src/contract/figure-contract.js'

describe('runtime protocol consistency (P0-3)', () => {
  it('every supported family has a strategy that composes ≥1 grammar', () => {
    for (const family of RUNTIME_CAPABILITIES.figureFamilies) {
      const strategy = FAMILY_STRATEGIES[family as keyof typeof FAMILY_STRATEGIES]
      expect(strategy, `family "${family}" has no strategy`).toBeTruthy()
      // supported ⇔ NOT (strict fallback AND nothing eligible): a relaxed
      // family with no preferred grammar genuinely composes from any prior.
      const composeable =
        strategy.eligibleGrammars.length > 0 || strategy.fallbackPolicy === 'relaxed'
      expect(composeable, `family "${family}" is marked supported but cannot compose`).toBe(true)
    }
  })

  it('supported families ⊆ declared FIGURE_FAMILIES vocabulary', () => {
    for (const family of RUNTIME_CAPABILITIES.figureFamilies) {
      expect(FIGURE_FAMILIES).toContain(family)
    }
  })

  it('outreach (strict fallback, no eligible grammar) is declared UNSUPPORTED', () => {
    expect(RUNTIME_CAPABILITIES.unsupportedFigureFamilies).toContain('outreach')
    expect(RUNTIME_CAPABILITIES.figureFamilies).not.toContain('outreach')
    const strategy = FAMILY_STRATEGIES.outreach
    expect(strategy.eligibleGrammars).toHaveLength(0)
    expect(strategy.fallbackPolicy).toBe('strict')
  })

  it('every schema-declarable presentation is renderer-realized', () => {
    const realized = new Set([
      ...RUNTIME_CAPABILITIES.connectorPresentations,
      ...RUNTIME_CAPABILITIES.spatialPresentations,
    ])
    for (const presentation of RUNTIME_CAPABILITIES.declarablePresentations) {
      expect(realized.has(presentation), `"${presentation}" not realized`).toBe(true)
    }
  })

  it('junction (no production renderer) is NOT declarable', () => {
    expect(RUNTIME_CAPABILITIES.declarablePresentations).not.toContain('junction')
  })

  it('withheld presentations are exactly the consciously-unrealized set', () => {
    const declarable = new Set(RUNTIME_CAPABILITIES.declarablePresentations as readonly string[])
    const withheld = RELATION_PRESENTATIONS.filter((p) => !declarable.has(p))
    expect(withheld).toEqual(['junction'])
  })

  it('the compiled protocol embeds the capability-constrained presentation enum', () => {
    const protocol = compileResearchRuntimeProtocol()
    const contract = renderJsonContract(protocol.figurePlanSchema)
    for (const presentation of RUNTIME_CAPABILITIES.declarablePresentations) {
      expect(contract, `contract must advertise "${presentation}"`).toContain(`"${presentation}"`)
    }
    expect(contract).not.toContain('"junction"')
  })

  it('protocol version stays pinned', () => {
    expect(FIGURE_PLAN_PROTOCOL_VERSION).toBe('2.1.0')
  })
})
