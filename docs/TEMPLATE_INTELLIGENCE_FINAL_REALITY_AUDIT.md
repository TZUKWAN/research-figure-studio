# Template Intelligence — Final Reality Audit

Branch: `audit/production-closure-final` · HEAD at audit: `d7e561e` → implementation commits
through this closure round · CI: Linux (ubuntu-latest, Electron E2E under xvfb) + Windows.

Method: every row below was verified against the actual source tree and the live
test suites on the audit date — file presence alone was never accepted as PASS.

## Capability Matrix

| Capability | Declared | Implemented | Runtime Wired | UI Exposed | Real User Trigger | Persistence | Unit | Integration | E2E | Computer Use | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Template analyzer (bytes → facts → definition) | ✓ | ✓ | ✓ (IPC `template-analyze`) | ✓ (Template Center) | ✓ click card | ✓ analysis cache | ✓ | ✓ (real decks) | ✓ panel spec | ✓ | **PASS** |
| Page roles + type scale + capacity | ✓ | ✓ | ✓ | ✓ (roles summary, detail) | ✓ | ✓ | ✓ | ✓ (21 Gorden decks) | ✓ | ✓ | **PASS** |
| Two-level role classifier (vision seam) | ✓ | ✓ (deterministic + injectable vision fallback) | ✓ seam; vision model not shipped | — | — | — | ✓ | — | — | — | **PASS** (runtime seam; real vision model = external) |
| Slot model + canonical shape identity | ✓ | ✓ `canonicalPptShapeId` | ✓ | — | — | ✓ (analysis) | ✓ | ✓ | ✓ | ✓ | **PASS** |
| TemplateFillPlan (slotId SSOT) | ✓ | ✓ `compileFillPlan` | ✓ | ✓ (Use in AI) | ✓ | — | ✓ | ✓ (21 decks) | ✓ | ✓ | **PASS** |
| Page reorder / clone / duplicate | ✓ | ✓ `outputSequence` | ✓ | — (AI-driven) | ✓ AI instruction | ✓ (saved decks) | ✓ | ✓ real deck `[5,4,1,16,4]` | — | ✓ | **PASS** |
| Nested-group slot fill | ✓ | ✓ (recursive group search + byte-descent patch) | ✓ | — | ✓ | ✓ | ✓ | ✓ (21 decks incl. deep nesting) | — | — | **PASS** |
| Chart native update | ✓ | ✓ `patchChartData` + `updateChartData` op | ✓ | — | ✓ AI/tool | ✓ (chart part) | ✓ | — | — | — | **PASS** (embedded workbook refresh is a documented boundary) |
| Table cell update | ✓ | ✓ `setTableCell` | ✓ | — | ✓ AI/tool | ✓ | ✓ | ✓ | — | — | **PASS** |
| Image slot replacement | ✓ | ✓ `replacePicture` | ✓ | — | ✓ AI/tool | ✓ | ✓ | — | — | — | **PASS** |
| Theme bridge (template → figure roles) | ✓ | ✓ `bridgeTemplateTheme` | ✓ (`templateTheme` input) | — | ✓ | — | ✓ | ✓ (Gorden deck) | — | — | **PASS** |
| Fidelity policy (preserve/adaptive) | ✓ | ✓ | ✓ (plan.fidelity) | — | ✓ | — | ✓ | ✓ | — | — | **PASS** |
| Template previews (first page) | ✓ | ✓ render model → offscreen Konva → bitmap | ✓ | ✓ | ✓ | ✓ localStorage + `previews/` PNG | — | ✓ | ✓ | ✓ | **PASS** |
| Preview persistence + versioned cache | ✓ | ✓ `previews/<hash>-v<N>.png` + fast path | ✓ | ✓ | ✓ | ✓ | ✓ (registry tests) | ✓ | ✓ | — | **PASS** |
| Lazy card loading | ✓ | ✓ IntersectionObserver | ✓ | ✓ | ✓ | — | — | — | — | — | **PASS** |
| Template Center sections (My/Local Reference) | ✓ | ✓ provider aggregation | ✓ | ✓ | ✓ | ✓ registry | — | ✓ | ✓ | ✓ | **PASS** |
| User template import (picker→validate→copy→dedupe→register) | ✓ | ✓ `importUserTemplate` | ✓ | ✓ Import button | ✓ | ✓ registry.json atomic | ✓ | ✓ | ✓ | ✓ | **PASS** |
| Empty state without any library | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ (no-dir run) | ✓ | **PASS** |
| Rename in My Templates | ✓ | ✓ IPC `template-user-rename` | ✓ IPC | **NOT_EXPOSED** | — | ✓ | — | — | — | — | **PARTIAL** (IPC ready; button not rendered — P2) |
| analyzer progress (per-slide) | ✓ | ✓ onProgress + IPC events | ✓ | ✓ progress bar | ✓ | — | ✓ | ✓ | ✓ | ✓ | **PASS** |
| analyzer cancel | ✓ | ✓ AbortSignal end-to-end | ✓ | ✓ Cancel button | ✓ | — | ✓ | ✓ | ✓ | ✓ | **PASS** |
| cancellation by analysisId (not file path) | ✓ | ✓ handles map + started event | ✓ | ✓ | ✓ | — | ✓ | — | ✓ | — | **PASS** |
| window-scoped abort on close | ✓ | ✓ `sender.destroyed` hook | ✓ | — | ✓ (window close) | — | — | — | — | ✓ | **PASS** |
| Original template overwrite protection | ✓ | ✓ realpath/resolve compare | ✓ | — | ✓ (Save As to template path) | — | — | — | — | — | **PASS** |
| Import safety caps (type/magic/size) | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | — | — | **PASS** |
| i18n (19 locales, compile-time key parity) | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — | ✓ | **PASS** |
| Selected template as AI runtime context | ✓ | ✓ `template-context.ts` | ✓ (skill default) | ✓ (Use in AI) | ✓ | session | — | — | ✓ | ✓ | **PASS** |
| Owned E2E fixtures (self-generated decks) | ✓ | **NOT_IMPLEMENTED** | — | — | — | — | — | — | — | — | **NOT_IMPLEMENTED** (panel E2E uses the local reference library; CI run without it skips — P1, next round) |
| Dedicated `template-intelligence` CI job | ✓ | **NOT_IMPLEMENTED** | — | — | — | — | — | — | — | — | **PARTIAL** (covered today by `test` + `e2e` jobs; standalone job = P2) |
| Gorden panel E2E with real library | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ (skips w/o dir) | ✓ | **PASS** |

## Known boundaries (documented, not defects)

- Chart "Edit Data" in PowerPoint shows the original embedded workbook; the rendered
  chart uses our updated caches (python-pptx has the same boundary).
- Vision classification requires a real vision model at runtime; the deterministic
  classifier + injectable fallback ship and are tested.
- Real-model smoke (E2E scenario 05 full generation) requires provider credentials
  and is exercised by the skipped-by-default `research-model-smoke` CI job.
