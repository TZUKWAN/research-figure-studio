#!/usr/bin/env node
/**
 * Security audit gate (production closure 2).
 *
 * Replaces bare `npm audit --audit-level=high` which would stay red forever
 * on upstream-blocked advisories. Policy:
 * - Runs npm audit --json
 * - Unapproved high/critical findings → exit 1 (FAIL)
 * - Documented exception in security-exceptions.json → WARN, exit 0
 * - Nothing hidden: every exception needs reason / exploitability /
 *   mitigation / expiry in security-exceptions.json
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exceptionsPath = join(root, 'security-exceptions.json')

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npmCmd, ['audit', '--json'], { encoding: 'utf8', cwd: root, shell: process.platform === 'win32' })
if (result.status !== 0 && !result.stdout) {
  console.error('[security-gate] npm audit failed to run')
  process.exit(1)
}

const audit = JSON.parse(result.stdout)

const exceptions = existsSync(exceptionsPath)
  ? JSON.parse(readFileSync(exceptionsPath, 'utf8'))
  : []
const approvedPackages = new Set(exceptions.map((e) => e.package))
const today = new Date().toISOString().slice(0, 10)

const findings = []
for (const [name, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  if (!['high', 'critical'].includes(vuln.severity)) continue
  const exception = exceptions.find((e) => e.package === name)
  const expired = exception ? exception.expiry && exception.expiry < today : false
  // via entries: string = an upstream package name (transitive advisory),
  // object = the advisory itself. A finding is approved when it has its own
  // exception OR every via-package chain resolves to an approved exception
  // (e.g. pptxgenjs flagged only because it depends on excepted image-size).
  const viaPackages = (vuln.via ?? []).filter((v) => typeof v === 'string')
  const viaAdvisories = (vuln.via ?? []).filter((v) => typeof v === 'object')
  const transitivelyApproved =
    exception === undefined &&
    viaPackages.length > 0 &&
    viaPackages.every((p) => {
      const e = exceptions.find((x) => x.package === p)
      return e && (!e.expiry || e.expiry >= today)
    })
  findings.push({
    name,
    severity: vuln.severity,
    approved: Boolean(exception) ? !expired : transitivelyApproved,
    expired: Boolean(exception) && Boolean(expired),
    via: viaAdvisories.map((v) => v.title?.slice(0, 60) ?? ''),
  })
}

const approved = findings.filter((f) => f.approved)
const expired = findings.filter((f) => f.expired)
const unapproved = findings.filter((f) => !f.approved)

console.log(
  `[security-gate] high/critical findings: ${findings.length} (${approved.length} approved, ${unapproved.length} unapproved)`,
)

for (const f of approved) {
  console.warn(`[security-gate] APPROVED EXCEPTION: ${f.name} [${f.severity}]`)
}

if (unapproved.length > 0) {
  console.error('[security-gate] FAIL: unapproved high/critical vulnerabilities:')
  for (const f of unapproved) {
    console.error(`  ${f.name} [${f.severity}] via: ${f.via.join(', ')}`)
  }
  console.error('\nTo approve: add an entry to security-exceptions.json with reason/mitigation/expiry.')
  process.exit(1)
}

console.log('[security-gate] OK')
