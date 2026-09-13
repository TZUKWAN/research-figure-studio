# Gorden Capability Parity — METIS Diagram vs GordenPPTSkill

Scope: every capability absorbed from GordenPPTSkill must exist natively in
METIS Diagram (no Python runtime, no re-import of external decks). Verified
against the source tree and the live suites on the closure date
(`audit/production-closure-final` @ `258396d`).

| Gorden capability | METIS implementation | Parity | Evidence |
|---|---|---|---|
| Template discovery (skill `templates/` dir) | `GordenDirProvider` (user-supplied dir, license-clean) | **PASS** | `template-library-list` IPC + Template Center "Local reference" |
| Template understanding (roles, layouts, slots) | `analyzeTemplateBytes` → ObservedTemplateFacts → TemplateDefinition | **PASS** | analyzer suites + all-decks smoke |
| shape_id addressing (python-pptx parity) | `canonicalPptShapeId` (cNvPr id, cross-parse stable) | **PASS** | canonical-shape-id suite |
| Slot capacity (vw-unit concept) | `capacity.ts` geometry model + `measureTextFitReal` (real font advances) | **EXCEEDS** | capacity/analyzer-facts suites |
| Page selection / prune | `compileFillOps` selectedSlides | **PASS** | roundtrip-gorden + 21-deck smoke |
| Page reorder / duplicate (§25) | `outputSequence` + `$txn` clone addressing | **PASS** | fill-output-plan + owned reorder regression |
| Slot fill preserving run-0 format | `setSlotParagraphText` (single paragraph, byte-stable siblings) | **PASS** | text-ops suite + real-deck roundtrips |
| Group-internal slot fill | `op.group` + nested-aware byte patching | **PASS** (exceeds: arbitrary depth) | all-decks smoke |
| Native chart data update | `patchChartData`/`updateChartPart` + `updateChartData` op | **PASS** | chart-update suites |
| Table cell update | `setTableCell` op | **PASS** | ops suite |
| Image slot replacement | `replacePicture` op (frame/crop preserved) | **PASS** | insert-ops suite |
| Placeholder QA (no silent placeholders) | `auditPlaceholders` 3 gates | **PASS** | qa suites |
| Type-scale consistency | `auditTypeScaleConsistency` + layout-aware scale | **PASS** | qa-two-level suite |
| Content fit (no mechanical truncation) | geometry fit + real-layout tier; repair ladder, never "…" | **PASS** | capacity/qa suites |
| Theme application to generated content | `bridgeTemplateTheme` → figure pipeline | **PASS** | theme-bridge suite |
| Analysis cache by file hash | `cache.ts` + registry analysis store | **PASS** | cache/registry suites |
| previews (per template) | first-slide render model → persisted PNG (`hash+vN`) | **PASS** | template-import-owned E2E |
| Template registry persistence | `userData/templates/registry.json` (atomic writes) | **PASS** (exceeds: Gorden had none — filesystem scan only) | registry suite |
| Duplicate detection on re-import | hash dedupe + `lastUsedAt` touch | **PASS** | registry suite |
| User template management (remove keeps original) | `removeRegistryEntry` | **PASS** | registry suite + owned E2E relaunch |
| Corrupt input safety | ZIP-magic/size validation; corrupt registry tolerated | **PASS** | registry suite; broken-fixture E2E |
| Analyzer progress + cancel | per-slide progress events; analysisId AbortSignal | **PASS** (exceeds: Gorden ran synchronously) | progress suite + panel E2E |
| AI tools surface (`list/analyze/create_from_template`) | slides-skill delegation to main IPC | **PASS** | skill suite |
| Non-commercial license boundary | Gorden decks never bundled; user-supplied dir only; owned fixtures for tests | **PASS** | repo tree + fixture generator |

## Gorden capabilities intentionally NOT carried

- Python runtime / python-pptx execution — replaced by the native engine.
- Bundled `templates/*.pptx` distribution — license forbids; replaced by the
  user-supplied Local Reference provider + owned fixtures.
- `INDEX.md`-based listing remains as the provider's availability check only.
