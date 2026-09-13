import { defineConfig } from '@playwright/test'

/**
 * E2E config for the Metis SD Electron shell.
 *
 * Tests launch the real built app (electron.launch), so they run serially —
 * parallel Electron instances fight over the GPU cache and dock on macOS.
 * Run with: `npm run test:e2e` (after `npm run build:all`).
 *
 * globalSetup regenerates the OWNED template fixtures (GOAL §42) so the
 * template-import E2E runs non-skipped on CI (GOAL §43).
 */
export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: '.',
  testIgnore: ['**/fixtures/**'],
  outputDir: './test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
})
