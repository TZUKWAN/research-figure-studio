/**
 * Figure Contract runtime audit (P0.5, GOAL §七/§八/§九).
 *
 * Checks the FINAL render intent — every string that will actually be written
 * onto the canvas (macro titles/details, micro-unit labels, edge labels) —
 * against the contract's visible-text policy, evidence requirements and
 * provenance rules. Normalization is deliberately conservative: NFKC + trim +
 * whitespace collapse + case-fold. No fuzzy matching.
 */
import type { FigureContract } from './figure-contract.js'

export interface RenderedText {
  /** owning semantic node / unit / edge id */
  id: string
  kind: 'title' | 'detail' | 'micro' | 'label'
  text: string
}

export interface ContractAuditIssue {
  kind:
    | 'FORBIDDEN'
    | 'ALLOWED_VIOLATION'
    | 'REQUIRED_TEXT_MISSING'
    | 'EVIDENCE_MISSING'
    | 'PROVENANCE_MISSING'
  message: string
  affectedIds: string[]
}

const QUANTITATIVE_CLAIM =
  /(\d+(\.\d+)?\s*%|准确率|精度|召回|speedup|acceleration|\b\d+(\.\d+)?\s*(x|倍)\b|\b\d+(\.\d+)?\s*(ms|fps|gpa|mpa|kg|mm|nm)\b)/i

const SAMPLE_MARKER = /(示例|样例|illustrative|sample data)/i

export function normalizeVisibleText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export interface ContractAuditInput {
  contract: FigureContract
  /** semantic node ids that actually have a placement on canvas */
  placedNodeIds: string[]
  /** every string that will be written onto the canvas */
  renderedTexts: RenderedText[]
  /** semantic node id → contract evidence ids it claims to carry */
  evidenceRefs?: Map<string, string[]>
}

export function auditFigureContract(input: ContractAuditInput): ContractAuditIssue[] {
  const issues: ContractAuditIssue[] = []
  const contract = input.contract
  const norm = normalizeVisibleText
  const texts = input.renderedTexts.map((entry) => ({ ...entry, n: norm(entry.text) }))

  // ── forbidden: must never appear anywhere on the canvas ──
  for (const term of contract.visibleTextPolicy?.forbidden ?? []) {
    const needle = norm(term)
    if (!needle) continue
    const hits = texts.filter((t) => t.n.includes(needle))
    if (hits.length > 0) {
      issues.push({
        kind: 'FORBIDDEN',
        message: `forbidden visible text "${term}" appears on canvas`,
        affectedIds: [...new Set(hits.map((t) => t.id))],
      })
    }
  }
  for (const claim of contract.forbiddenClaims ?? []) {
    const needle = norm(claim)
    if (!needle) continue
    const hits = texts.filter((t) => t.n.includes(needle))
    if (hits.length > 0) {
      issues.push({
        kind: 'FORBIDDEN',
        message: `forbidden claim "${claim}" reached the canvas`,
        affectedIds: [...new Set(hits.map((t) => t.id))],
      })
    }
  }

  // ── allowed whitelist: only enforced when explicitly non-empty ──
  const allowed = (contract.visibleTextPolicy?.allowed ?? []).map(norm).filter(Boolean)
  if (allowed.length > 0) {
    const violators = texts.filter((t) => !t.n || !allowed.some((a) => t.n.includes(a)))
    if (violators.length > 0) {
      issues.push({
        kind: 'ALLOWED_VIOLATION',
        message: `${violators.length} visible text(s) outside the allowed whitelist`,
        affectedIds: [...new Set(violators.map((t) => t.id))],
      })
    }
  }

  // ── required text: must appear somewhere ──
  for (const term of contract.visibleTextPolicy?.required ?? []) {
    const needle = norm(term)
    if (!needle) continue
    if (!texts.some((t) => t.n.includes(needle))) {
      issues.push({
        kind: 'REQUIRED_TEXT_MISSING',
        message: `required visible text "${term}" is missing from the canvas`,
        affectedIds: [],
      })
    }
  }

  // ── evidence: every required evidence id must be carried by a placed node ──
  const placed = new Set(input.placedNodeIds)
  for (const evidence of contract.evidenceMustShow ?? []) {
    const carried = placed.has(evidence.id)
      ? true
      : [...(input.evidenceRefs?.entries() ?? [])].some(
            ([nodeId, refs]) => placed.has(nodeId) && refs.map(norm).includes(norm(evidence.id)),
          )
        ? true
        : evidence.description
          ? texts.some((t) => t.n.includes(norm(evidence.description)))
          : false
    if (!carried) {
      issues.push({
        kind: 'EVIDENCE_MISSING',
        message: `required evidence "${evidence.id}" is not carried by any placed node`,
        affectedIds: [evidence.id],
      })
    }
  }

  // ── provenance: quantitative claims need a source; sample markers exempt ──
  for (const t of texts) {
    if (t.kind === 'micro' && SAMPLE_MARKER.test(t.text)) continue
    if (!QUANTITATIVE_CLAIM.test(t.text)) continue
    const refs = input.evidenceRefs?.get(t.id) ?? []
    void refs
    // provenance refs ride the same SemanticNode refs map, keyed by node id
    const hasProvenance =
      (input.evidenceRefs?.get(t.id)?.length ?? 0) > 0 ||
      (contract.provenance ?? []).some((p) => t.n.includes(norm(p.claim)))
    if (!hasProvenance) {
      issues.push({
        kind: 'PROVENANCE_MISSING',
        message: `quantitative claim in "${t.id}" ("${t.text.slice(0, 40)}") has no provenance`,
        affectedIds: [t.id],
      })
    }
  }

  return issues
}
