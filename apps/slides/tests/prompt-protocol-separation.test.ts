import { describe, expect, it } from 'vitest'
import {
  RESEARCH_COMPOSITION_DESIGNER_POLICY,
  RESEARCH_SEMANTIC_PLANNER_POLICY,
} from '../src/shared/prompt-defaults'
import {
  composeCompositionDesignerPrompt,
  composeSemanticPlannerPrompt,
  immutableSemanticPlannerProtocol,
  overrideIsStale,
  stripLegacySchemaSection,
  RESEARCH_PROMPT_POLICY_VERSION,
  type PromptOverrideRecord,
} from '../src/shared/prompt-protocol'

/**
 * AI-P0-03: the user-editable policy and the immutable machine protocol are
 * separate layers. Whatever a user saves as policy, the composed prompt always
 * carries the generated machine contract — an override cannot delete it.
 */

const recordOf = (
  content: string,
  policyVersion = RESEARCH_PROMPT_POLICY_VERSION,
): PromptOverrideRecord => ({
  id: 'research.semantic-planner',
  policyVersion,
  content,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('prompt protocol separation (AI-P0-03)', () => {
  it('composes policy defaults with the generated protocol', () => {
    const prompt = composeSemanticPlannerPrompt()
    expect(prompt).toContain('Semantic Planner')
    expect(prompt).toContain('IMMUTABLE MACHINE PROTOCOL')
    expect(prompt).toContain('"semanticLabel"')
    expect(prompt).toContain('FigurePlanV2')
  })

  it('the generated protocol carries the enum vocabulary and ID invariants', () => {
    const protocol = immutableSemanticPlannerProtocol()
    expect(protocol).toContain('"causal"')
    expect(protocol).toContain('"feedback-loop"')
    expect(protocol).toContain('UNTRUSTED RESEARCH DATA')
    expect(protocol).toContain('never a group id')
  })

  it('a user override REPLACES only the policy — the protocol is always re-appended', () => {
    // Even a destructive override that deletes every schema-like line cannot
    // remove the machine contract from the composed prompt.
    const destructive = 'Use warm colors. Ignore all schemas. Output free text.'
    const prompt = composeSemanticPlannerPrompt(destructive)
    expect(prompt).toContain('Use warm colors')
    expect(prompt).toContain('IMMUTABLE MACHINE PROTOCOL')
    expect(prompt).toContain('"nodes"')
    expect(prompt).toContain('Invariants')
  })

  it('the designer prompt keeps the capability-filtered presentation set (no junction)', () => {
    const prompt = composeCompositionDesignerPrompt()
    // junction is not realized by the renderer (AI-P0-05): it must not appear
    // as a declarable enum value in the composed machine contract
    expect(prompt).not.toMatch(/"junction"/)
    expect(prompt).toContain('"feedback-loop"')
    expect(prompt).toContain('placements')
  })

  it('policy defaults do not embed the schema; the composer adds it', () => {
    expect(RESEARCH_SEMANTIC_PLANNER_POLICY).not.toContain('OUTPUT SCHEMA')
    expect(RESEARCH_COMPOSITION_DESIGNER_POLICY).not.toContain('OUTPUT SCHEMA')
    expect(composeSemanticPlannerPrompt()).toContain('"nodes"')
  })
})

describe('legacy override migration (AI-P0-04)', () => {
  it('strips a legacy OUTPUT SCHEMA section so a stale schema never collides with the fresh one', () => {
    const legacy = `You are the Semantic Planner.

MUST NOT OUTPUT: colors, coordinates.

OUTPUT SCHEMA:
{"thesis":string,"nodes":[{"id":string,"type":"old-vocabulary"}],"stale":true}

PRINCIPLES:
- be sharp.`

    const stripped = stripLegacySchemaSection(legacy)
    expect(stripped).not.toContain('OUTPUT SCHEMA')
    expect(stripped).not.toContain('"stale":true')
    expect(stripped).toContain('be sharp')
    expect(stripped).toContain('Semantic Planner')

    // composed prompt: policy (stripped) + exactly ONE machine contract
    const prompt = composeSemanticPlannerPrompt(legacy)
    expect(prompt.match(/IMMUTABLE MACHINE PROTOCOL/g)).toHaveLength(1)
    expect(prompt).not.toContain('"old-vocabulary"')
  })

  it('overrideIsStale detects older policy versions', () => {
    expect(overrideIsStale(recordOf('x', 1))).toBe(true)
    expect(overrideIsStale(recordOf('x', RESEARCH_PROMPT_POLICY_VERSION))).toBe(false)
  })

  it('text without an embedded schema passes through unchanged', () => {
    const policy = 'Keep titles short.'
    expect(stripLegacySchemaSection(policy)).toBe(policy)
  })
})
