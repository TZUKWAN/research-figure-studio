/**
 * Save-target safety (GOAL §10): the user's original template file must NEVER
 * be overwritten by a generated deck. Comparison is canonical (realpath) so
 * relative paths, symlinks, junctions and UNC aliases cannot smuggle a
 * same-file save through string equality.
 *
 * Windows file systems are case-insensitive: `Template.PPTX` and
 * `template.pptx` are the SAME file, and fs.realpath preserves the input's
 * letter case instead of normalizing it — so canonical comparisons must fold
 * case on win32, or a case-variant saveTo bypasses the protection and
 * overwrites the user's template.
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const CASE_INSENSITIVE = process.platform === 'win32'

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function isSameRealFile(a: string, b: string): boolean {
  try {
    return samePath(realpathSync(a), realpathSync(b))
  } catch {
    // one or both paths do not exist yet (first save of a new deck) — fall
    // back to resolved-path comparison
    try {
      return samePath(resolve(a), resolve(b))
    } catch {
      return false
    }
  }
}
