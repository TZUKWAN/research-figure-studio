/**
 * Playwright globalSetup (GOAL §42/§43): regenerate the OWNED template
 * fixtures before the suite so the template-import E2E never depends on an
 * external, license-restricted directory and never skips on CI.
 */
import { ensureOwnedFixtures } from './fixtures/generate-fixtures'

export default async function globalSetup(): Promise<void> {
  await ensureOwnedFixtures()
}
