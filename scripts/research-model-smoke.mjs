// Research model smoke — REPLACED (P1-4, production closure 2).
// The smoke now lives in packages/research-harness/tests/research-model-smoke.test.ts
// and reuses the PRODUCTION protocol chain (compiled runtime protocol schema,
// requestStructured truncation/repair engine, parseFigurePlanV2WithDiagnostics).
// Run: npx vitest run packages/research-harness/tests/research-model-smoke.test.ts
// Config via env: METIS_SMOKE_BASE_URL, METIS_SMOKE_API_KEY, METIS_SMOKE_MODEL.
// Without credentials the suite clean-skips; with credentials it executes for real.
console.error('[research-model-smoke] Moved to vitest: packages/research-harness/tests/research-model-smoke.test.ts')
console.error('[research-model-smoke] Run: npx vitest run packages/research-harness/tests/research-model-smoke.test.ts')
process.exit(0)
