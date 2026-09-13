/**
 * CLI runner for the owned fixture generator (GOAL §42): `npx tsx
 * e2e/fixtures/run-generator.ts`. Kept free of import.meta / top-level await
 * so it also loads under Playwright's CJS transform when imported transitively.
 */
import { ensureOwnedFixtures } from './generate-fixtures'

async function main(): Promise<void> {
  const dir = await ensureOwnedFixtures()
  console.log('fixtures ready at', dir)
}

void main()
