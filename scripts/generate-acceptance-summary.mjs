#!/usr/bin/env node
/**
 * Acceptance summary generator (P1-6, production closure 2).
 *
 * Parses docs/acceptance/*.matrix.md tables (| Feature | ... | State |) and
 * computes the coverage statistics — no hand-written percentages anywhere.
 * State vocabulary is fixed (see ACCEPTANCE_STATES.md); only PASS_REAL_UI and
 * PASS_E2E count toward "Real User Execution Coverage".
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const STATES = [
  'PASS_REAL_UI',
  'PASS_E2E',
  'PASS_INTEGRATION',
  'PASS_UNIT',
  'BLOCKED_EXTERNAL',
  'NOT_IMPLEMENTED',
  'NOT_UI_EXPOSED',
  'FAIL',
]
const REAL_USER_STATES = new Set(['PASS_REAL_UI', 'PASS_E2E'])

const files = process.argv.slice(2)
const root = process.cwd()
const rows = []
for (const file of files) {
  const path = join(root, file)
  if (!existsSync(path)) {
    console.error(`[acceptance] missing matrix file: ${file}`)
    process.exit(1)
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    const state = cells.find((c) => STATES.includes(c))
    if (state) rows.push({ file, feature: cells[1], state })
  }
}

const count = (state) => rows.filter((r) => r.state === state).length
const total = rows.length
const realUi = rows.filter((r) => REAL_USER_STATES.has(r.state)).length
const lines = [
  '## Acceptance Summary (generated — do not edit)',
  '',
  `Source matrices: ${files.join(', ')}`,
  '',
  `| Metric | Count |`,
  `| --- | --- |`,
  `| Total acceptance items | ${total} |`,
  ...STATES.map((s) => `| ${s} | ${count(s)} |`),
  `| Real User Execution Coverage (PASS_REAL_UI + PASS_E2E) | ${realUi}/${total} (${total ? Math.round((realUi / total) * 100) : 0}%) |`,
  '',
]
console.log(lines.join('\n'))
