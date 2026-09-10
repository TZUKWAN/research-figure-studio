# GordenPPTSkill Integration Audit

Date: 2026-09-11 · Reference: github.com/GordenSun/GordenPPTSkill @ HEAD (MIT)
Cloned to: `research-figure-studio/gorden-ppt-skill-ref` (reference only, gitignored)

## License Compliance (hard constraint)

- `LICENSE`: **MIT** — all code, references, scripts, schema freely usable,
  including commercial use, with attribution.
- `NOTICE.md`: **templates/<slug>/template.pptx + preview.png carry a separate
  non-commercial restriction** from the original template designers (sourced
  from Daoke/WPS public channels). MIT does NOT cover these third-party assets.
- Decision (product owner directive): all _capabilities_ are fully preserved
  and usable in Metis Diagram; the 21 bundled template decks ship as an
  optional **GordenTemplateProvider** loaded from a local directory
  (`metis-templates/gorden/`), never hard-required by the product build, with
  `THIRD_PARTY_NOTICES.md` recording the restriction. Users in compliant
  (personal/research/non-commercial, or author-licensed) contexts get the full
  21-template library; enterprise builds simply omit that directory.

## Current Capability (GenOffice — already exists, do not duplicate)

| Capability                                                                                | Where                                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Native PPTX parse/open/save/reopen                                                        | `packages/pptx-engine` (openPptx/savePptx/commitSaved)                |
| Atomic transactions with snapshot rollback                                                | `apps/slides/src/main/ops/executor.ts` (runTxn)                       |
| Full op vocabulary: setText/setTransform/addElement/deleteElement/groupElements/slide ops | `apps/slides/src/main/ops/*`                                          |
| Slide clone / cross-deck slide transfer                                                   | `slide-transfer.ts` (collectSlideBundle/materializeSlideBundle)       |
| Duplicate slide                                                                           | `index.ts` duplicateSlide                                             |
| Native chart model + chart update surface                                                 | `chart.ts`, `chart-insert.ts`, `setChart` op, `chartex.ts`            |
| Render slide → raster (Konva, browser)                                                    | `packages/pptx-render` + `apps/slides/src/renderer/export-render.tsx` |
| Text measurement (real font metrics + heuristic fallback)                                 | `packages/font-metrics`, `pptx-render/metrics.ts`                     |
| Theme system                                                                              | `packages/theme-engine`                                               |
| Semantic per-shape metadata persisting through save/reopen                                | `pptx-engine/identity.ts`, `research-metadata.ts`                     |
| AI agent tool registry + structured output + vision review                                | `apps/slides/src/renderer/ai/slides-skill.ts`, `packages/agent-core`  |
| Research figure compiler (kept separate)                                                  | `packages/research-harness`                                           |

## Gorden Capability

| Capability                                                          | Gorden implementation                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template = compiled structured model (`detail.json`) not raw slides | `ppt-template-detail/v1`: per-page role/layout/use_for/text_slots(address=shape_id+paragraph+run)/capacity(box_cm,font_pt,chars_per_line,max_lines,max_chars,wrap,autofit)/level/type_scale/page_roles/data_charts/editing_rules/skip_pages |
| 21 curated CJK template decks (16–59 pages, 1.4k slots/deck)        | `templates/*/template.pptx + detail.json + intro.md + preview.png`                                                                                                                                                                          |
| Page selection = role-driven, not sequential                        | `selected_slides` by role; skip template-promo; missing role → fewer pages, never fake one                                                                                                                                                  |
| Slot-addressed text fill preserving run-0 format                    | `edits.json` → `build_pptx.py` (address: shape_id/paragraph/run; expected_text sanity)                                                                                                                                                      |
| Capacity = geometry-accurate estimate, soft constraint              | `compute_capacity.py`: vw units (CJK=1.0, latin=0.5), chars_per_line, max_lines, 20% headroom; overflow check is advisory, `--strict` discouraged                                                                                           |
| No-truncation content policy                                        | rewrite > fewer bullets > switch layout > split page; ellipsis truncation forbidden                                                                                                                                                         |
| Type scale consistency                                              | same `level` keeps template font size; rewrite instead of shrink                                                                                                                                                                            |
| Unknown user template onboarding (mode B)                           | render each slide (LibreOffice) + python-pptx shape/paragraph/run walk → infer roles/slots                                                                                                                                                  |
| Chart editing (native charts only)                                  | `chart_data` → replace_data; decorative shape-charts flagged `shape_caution_pages`                                                                                                                                                          |
| Render review loop                                                  | `render_slides.py` (LibreOffice→pdftoppm) → human/AI inspect                                                                                                                                                                                |
| Original mode (no template)                                         | minimal native generation guide                                                                                                                                                                                                             |

## Overlap (reuse GenOffice, do not port code)

Text replacement, slide deletion/reorder/clone, chart data update, rendering,
font metrics, save/reopen, transactions, AI tool registry — GenOffice already
has all of these natively and better (atomic, typed, persisted).

## Missing Capability (what we must build)

1. **TemplateDefinition** compiled model + parser from an arbitrary pptx
   (role classifier, slot extractor, type-scale inference, capacity, density).
2. **Semantic Slot ↔ native element address** mapping that survives
   save/reopen (persist per-shape metadata: templateId/sourceSlideId/slotId).
3. **TemplateProvider** abstraction (user-upload / bundled-Gorden / licensed).
4. **Page-role driven selection + fill compiler** producing native txn ops
   (clone template slide → fill slots), never a second deck state.
5. **Content Fit strategy** (semantic compression order, no truncation) +
   capacity estimator reusing font-metrics.
6. **Placeholder audit** + **type-scale consistency audit**.
7. **Vision QA on final rendered slides** (we have render+raster already).
8. **PresentationIntent** + 3-mode routing (TEMPLATE / ORIGINAL / research-figure).

## Can Reuse Directly (from Gorden, MIT)

Concepts and schemas only (we re-express in TS against the GenOffice engine):
detail.json field semantics; page-role taxonomy; slot_id stability rules;
capacity vw-unit formula; no-truncation priority ladder; workflow structure;
chart capability taxonomy (native vs decorative vs image).

## Should Not Copy

`build_pptx.py`/`render_slides.py` as runtime code (python-pptx/LibreOffice =
second engine); `apply_update.py` runtime auto-update from remote; the
bundled template decks into the default product build (NOTICE restriction).

## Target Architecture

```
packages/ppt-template-intelligence/   (node-side, engine-backed)
  schema.ts      TemplateDefinition / TemplateSlot / PageRole / FillPlan / PresentationIntent
  analyzer.ts    pptx bytes → ObservedFacts (+ optional vision inference) → TemplateDefinition
  role-classifier.ts  heuristic role inference from observed facts
  capacity.ts    font-metrics-backed TextFitResult (vw units, wraps, pressure)
  provider.ts    TemplateProvider registry: GordenDirProvider / UserTemplateProvider
  fill.ts        TemplateFillPlan → native txn ops (clone+prune+slot fill)
  qa.ts          placeholder audit + type-scale audit + overflow audit
  cache.ts       analysis cache keyed by file hash + parser version
```

Runtime wiring: renderer tool `create_presentation` / `analyze_ppt_template` /
`list_available_templates` call main-process IPC which runs this package
against the real deck via the existing ops executor.

## Risk

- python-pptx shape_id ↔ GenOffice nvId/spid equivalence must be verified on
  real files (both derive from `<p:cNvPr id>`, so mapping is direct).
- Slide cloning across template decks must preserve masters/theme (existing
  collectSlideBundle handles part collection — reuse).
- Template decks are large (16–59 pages, 1.4k slots) — analyzer must stream,
  cache by hash.

## Test Strategy

- Fixtures: use Gorden decks from the local reference dir via env
  `GORDEN_TEMPLATES_DIR` (gitignored, not shipped); plus 2 tiny hand-made
  in-repo fixtures (MIT) for CI.
- Unit: schema parse, role classifier, capacity vs Gorden's own numbers.
- Integration: analyze → select → fill → save → reopen → verify text+bindings
  - metadata persistence on a real deck.
- E2E + real UI: covered by later phases with screenshot evidence.
