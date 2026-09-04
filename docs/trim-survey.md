# Trim Survey Report (Task 2 Output, Historical)

> Historical audit record from 2026-08-26. The decisions and evidence below are
> retained for research traceability; paths, line numbers, and staged actions
> describe that earlier trim and are not current development instructions.

Date: 2026-08-26 · Branch: research-studio · Baseline: 0a2c25d

## 0. Decision Changes (Compared with Design Document v1.1 Section 5.2)

| Original removal item            | Verified decision | Evidence                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packages/docx-engine             | **Keep**          | `apps/slides/src/renderer/image-loader.ts:7` resolves `@genoffice/docx-engine/metafile` through the Vite/TypeScript aliases (`slides/electron.vite.config.ts:29`, `vitest.config.ts:34`, `tsconfig.json:17`). The attachment chain is `slides attachments-ipc.ts:12 -> file-parse(src/docx.ts:1) -> docx-engine`. `metafile.ts` is only 69 lines and depends on the local vendor `emf-converter`. |
| packages/pdf2docx                | Keep removed      | Used only by the shell PDF conversion toolchain below. PDF import is not a P0 research-figure requirement; removal must be synchronized with the shell surgery.                                                                                                                                                                                                                                   |
| apps/docs, sheets, pdf, markdown | Keep removed      | `shell/src/main/index.ts` is a six-editor host and must be edited in the staged sequence from Section 2.                                                                                                                                                                                                                                                                                          |

## 1. Historical Reference Inventory

### A. shell/src/main/index.ts (primary surgery target, approximately 4,000 lines)

- Lines 92-117 contain several multiline imports; confirm the docs/sheets symbols individually.
- Line 118 `../../../docs/src/main/docs-main` -> remove.
- Line 119 `../../../sheets/src/gateway/csv-import` (`blankXlsxBuffer`) -> remove.
- Line 120 `../../../pdf/src/main/blank-pdf` (`blankPdfBuffer`) -> remove.
- Lines 121-137: remove the `sheets-main` symbols.
- Lines 138-149: keep `slides-main`.
- Lines 150-160: remove `pdf-main`.
- Line 161: remove `pdf/src/shared/ipc` (`PDF_CHANNELS`).
- Lines 162-164: remove `./pdf2(docx|pptx|xlsx)-local` and the files.
- Line 165: `./pdf-password-dialog` is pending; it serves only the PDF password flow and can be removed with PDF support, including the preload/renderer password entry (`electron.vite.config.ts:18/32`).
- Lines 166-175: remove `markdown-main`.
- Usage sites: lines 3675/3749/3813/3864/3923/3974 contain three `convertPdf*` handlers; the `TabKind` case dispatch near lines 2343/2393/2961 still needs exact scoping.
- Lines 198-199 mention apps/docs/out in comments; rewrite those comments.

### B. electron-builder.cjs (506 lines)

- Line 78: remove `'../pdf/node_modules/harfbuzzjs/hb-subset.wasm'` from the assertion list.
- Lines 87-137: remove the OCR helper build block (`VISION_OCR_HELPER` / `WIN_OCR_HELPER` point to `pdf2docx/ocr-helper`). **On win32, line 127 throws when the file is missing, which blocks `dist:dir`.**
- Lines 179-195: remove `assertUniversalSidecar` (the sheets xlsx sidecar) and its call at line 474.
- Lines 197-211: reduce `assertModuleTreesPresent` from five directories to `../slides/out`.
- Lines 235-253: reduce the five `extraResources` module mappings to Slides only.
- Lines 256-263: remove the `pdfium.wasm` / `hb-subset.wasm` entries used by the PDF text engine.
- Lines 264-274: remove the two OCR helper `extraResources` entries.
- Lines 291-346: keep only the pptx file association.
- Lines 348-372, 373-386, and 393-438: remove xlsx-sidecar resources from macOS, Windows, and Linux.
- Lines 471-477: simplify `beforePack` accordingly.

### C. Other shell files

- Remove `src/main/pdf2docx-local.ts`, `pdf2pptx-local.ts`, `pdf2xlsx-local.ts`, and `pdf-password-dialog.ts` with the surgery.
- Remove `src/preload/pdf-password.ts` and `src/renderer/pdf-password.html`; synchronize the `electron.vite.config.ts` inputs at lines 18 and 32.
- Reduce `TabKind` in `src/shared/home-api.ts` and `tabs-api.ts` to Slides; reduce the Home renderer cards in Step B.
- Remove line 25 of `tsconfig.json`, which includes `../../packages/pdf2docx/src/bidi-js.d.ts`.
- Keep `@genoffice/docx-engine` at line 26 of `package.json` because docx-engine is retained.
- Keep `@genoffice/ai-search` from `cloud-projects.ts:3`; the dependency remains live.

### D. e2e/

- Remove the 11 `sheets-*.spec` files, `pdf-fit-zoom`, and `markdown-tab.spec` because their apps are removed. Re-evaluate whether `home/new-file-tab/onboarding` assert six editor entries after Step B; keep `slides-font-manager/theme-*`.
- Phase 1 does not use passing e2e tests as its completion gate; record the required adaptations.

### E. .github/workflows/ci.yml

- It contains docs/sheets/markdown/pdf2docx references. CI is not run locally; make the minimum cleanup by removing jobs and matrix entries that explicitly target deleted apps. Do not use this as a smoke-test gate.

### F. Safe-to-retain checks

- The root `package.json` uses `apps/*` and `packages/*` workspace globs, so directory removal is sufficient.
- Keep `fixtures/`; it does not affect the build.
- The `pptx-render -> pptx-engine` and `ai-provider -> agent-core` dependency directions are healthy.
- Keep `scripts/pagination-baseline*.mjs` and `tools/*.py`, which serve the Docs font tooling and are outside the build graph.

## 2. Historical Staged Execution (Task 3 Split into Independently Verified Waves)

- **Wave 3a**: remove `packages/pdf2docx` and `ee/`; remove the three `convertPdf*` handlers, related imports, and files from `shell/index.ts`; run `typecheck(slides+shell)`.
- **Wave 3b**: remove `apps/{docs,sheets,pdf,markdown}`; perform the import/initialization/case-branch surgery in `index.ts` and reduce the Home renderer `TabKind`; run typecheck, Vitest for Slides and pptx-engine, and the preflight dev smoke check.
- **Wave 3c**: clean `electron-builder.cjs` according to Section B; run `npm install` to regenerate the lockfile; run the `dist:dir` smoke check.
