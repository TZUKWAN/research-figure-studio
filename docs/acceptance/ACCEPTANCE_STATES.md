# Acceptance States (QA-P1-13)

## Purpose

The acceptance matrices must never collapse different kinds of evidence into
a single word "PASS". An equivalent-path shortcut — e.g. marking "Save As"
PASS because Ctrl+S plus a roundtrip worked, without ever opening the Save As
dialog — is **forbidden**. Every matrix row carries one explicit state from
the vocabulary below; summaries may aggregate, but the raw matrix never merges
them.

## State vocabulary

| State              | Meaning                                                                                                     | Evidence bar                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `PASS_REAL_UI`     | The exact user path was driven in the real UI (real Electron window, real input, real renderer)             | Recording/screenshot + artifact of the run                    |
| `PASS_INTEGRATION` | The real pipeline modules ran end-to-end, driven through code (IPC/preload/eval) instead of hand input      | Logged call + observable side effect (file written, XML diff) |
| `PASS_UNIT`        | Verified by deterministic unit/property tests at module level                                               | Test name + run output                                        |
| `BLOCKED`          | Attempted, but an external dependency prevented execution (env, model capability, native dialog automation) | The blocker, with the attempt log                             |
| `NOT_IMPLEMENTED`  | The capability does not exist in the codebase yet                                                           | Point to the tracking issue/section                           |
| `NOT_UI_EXPOSED`   | The capability exists and is verified, but no user-facing entry point exists                                | Code path reference                                           |
| `FAIL`             | Attempted and failed                                                                                        | Failure evidence, never omitted                               |

## Rules

1. A row may only be `PASS_REAL_UI` if the **named control** was actuated in
   the real UI. Any substitute path is at best `PASS_INTEGRATION`.
2. `PASS_INTEGRATION` rows must name the entry point used (which IPC, which
   function) so a reviewer can see what was NOT hand-driven.
3. Summaries may count `PASS_REAL_UI + PASS_INTEGRATION + PASS_UNIT` together
   as "covered", but must always report the three counts separately.
4. `BLOCKED` is not `FAIL` and neither is `NOT_IMPLEMENTED`; conflating them
   hides the difference between "broken" and "absent".
5. Skipped tests are not evidence of anything and never appear as PASS.

## Applied to

- `docs/acceptance/FUNCTION_ACCEPTANCE_MATRIX.md` — rows use this vocabulary.
- New research-figure E2E specs (`e2e/research-figure-*.spec.ts`) assert at
  the `PASS_REAL_UI` bar where they drive the real AI panel/canvas and at
  `PASS_INTEGRATION` where they invoke `slidesApi.save/exportPdf` directly;
  each spec documents which bar it asserts.
