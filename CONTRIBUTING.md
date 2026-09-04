# Contributing to Metis Diagram

Thanks for your interest in contributing. This document covers the local
setup, the checks a change must pass, and the conventions used in this
repository.

## How changes land here

This GitHub repository is a mirror: development happens in a private tree,
and `main` here advances through single squashed snapshot commits
(`Sync snapshot (<date>)`). That is why every file in a sync shows the same
last-commit message, and why nobody — maintainers included — pushes to
`main` directly.

External pull requests are welcome and are reviewed here. Once a change is
accepted, a maintainer imports it into the private tree with your authorship
preserved as a `Co-authored-by:` trailer, and it ships to `main` in the next
snapshot; your PR is then closed with a note pointing at the snapshot that
carried it. GitHub will show the PR as "closed" rather than "merged" — the
code and the attribution still land. Issues and feature requests are handled
directly on this repository as usual.

## Repository layout

- `apps/slides` — the PowerPoint-compatible Slides editor, with its Electron
  main process, React renderer, and tests.
- `apps/shell` — the Electron shell that hosts Slides and owns the home screen,
  tabs, file routing, and updates.
- `packages/*` — pure TypeScript engine and shared packages (no Electron
  dependency, unit-tested): pptx engine/rendering, research-figure planning,
  AI agent/provider/search layers, and shared UI and infrastructure.

## Getting started

Prerequisites: Node 22+ and npm 10+.

```bash
npm install
npm run dev          # Slides renderer + shell against the Vite dev server
npm run dev:slides   # run the standalone Slides app
npm run build:all    # build Slides and the shell
```

## Checks every change must pass

CI runs these on every PR; please run them locally first:

```bash
npm run format:check # Prettier check for uncommitted changed/new files
npm run lint         # ESLint across the repo (0 errors required; warnings allowed)
npm run typecheck    # tsc --noEmit across every workspace
npm test             # unit tests for current packages and apps
npm run licenses     # production dependency licenses within the permissive allowlist
npm run check:english-comments # English-only guard for code comments and docs
```

Formatting is intentionally incremental: existing files are not reformatted
unless they are part of your change. Run these exact commands before committing:

```bash
npm run format                              # format uncommitted changed/new files
npm run format:check                        # verify uncommitted changed/new files
npm run format:check -- --base origin/main  # verify committed files on your branch
```

CI supplies the PR or push base automatically and checks only files changed from
that base. This keeps the formatter gate useful without creating a repository-wide
formatting diff.

## Building installers

Run these from the repository root. Each command regenerates the third-party
notices, builds Slides and the shell, and packages the shell with the Slides
module embedded:

```bash
npm run dist:mac   # macOS dmg + zip
npm run dist:win   # Windows nsis installer
npm run dist:linux # Linux AppImage + deb + rpm
```

Without Apple or Windows signing credentials in the environment these produce
unsigned artifacts: code signing and notarization are skipped with a warning
rather than failing. That is the expected result for a contributor build.

## Environment variables

None are required — the apps run with all of these unset. They exist for
testing and local overrides:

| Variable                                              | Effect                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `GENOFFICE_USER_DATA`                                 | Override the Electron userData directory (test isolation)               |
| `GENOFFICE_LANG`                                      | Force the UI language instead of following the OS locale                |
| `GENOFFICE_FAKE_UPDATE`                               | Exercise the updater UI without a real release feed                     |
| `GENOFFICE_CLOUD_SLIDE`, `GENOFFICE_CLOUD_SLIDE_TIER` | Route slide generation through the cloud endpoint                       |
| `GSK_API_KEY`, `GSK_CLI_PATH`                         | Legacy hosted-tool credential / CLI location retained for compatibility |
| `AI_SEARCH_DISABLE_GSK`, `SERPER_API_KEY`             | Disable the legacy hosted search backend / supply a Serper key instead  |
| `SLIDES_DEV_PORT`, `SHELL_DEV_PORT`                   | Override the Slides and shell Vite dev server ports                     |
| `SLIDES_RENDERER_URL`, `ELECTRON_RENDERER_URL`        | Override the renderer URLs used by the shell and update window          |

AI features require a configured BYOK provider. Web search falls back to a
keyless backend when available.

## Coding conventions

- **English only** in code, comments, commit messages, and docs. User-facing
  strings go through the i18n resources (`src/renderer/i18n/`, plus the inline
  main-process dictionaries in `src/main/`), which are the only places
  non-English text belongs (plus test fixture text).
- TypeScript everywhere; avoid adding new `any` surfaces where a precise type
  is cheap.
- Tests live in `apps/*/tests` and `packages/*/tests` (vitest). New engine
  behavior needs a unit test; renderer-only UI tweaks generally don't.
- Local Playwright/Electron acceptance drivers belong in `scripts/drivers/`
  (gitignored, excluded from CI) — see `scripts/drivers/README.md`.
- Keep files from growing without bound: if you are adding a substantial new
  concern to an already-large file, prefer a new module.

## Commit and PR guidelines

- Small, focused commits with imperative English subject lines
  (e.g. `fix pptx table border round-trip`, `add slides chart legend parsing`).
- A PR should explain _why_ the change is needed, and mention which of the
  checks above you ran.
- File format fidelity is the core product promise: for changes touching
  `.pptx` open/save paths, include a round-trip test proving untouched content
  survives byte-for-byte.

## Reporting bugs and requesting features

Use the issue templates. For suspected security issues, do **not** open a
public issue — follow [SECURITY.md](SECURITY.md).

## Code of conduct

All community spaces follow the
[Contributor Covenant](CODE_OF_CONDUCT.md); participation implies acceptance.

## License and CLA

There is no CLA (contributor license agreement), and we do not plan to add
one. By contributing, you agree that your contributions are licensed under
the [Apache License 2.0](LICENSE) that covers this project — inbound =
outbound, per Apache-2.0 §5. Because community contributions keep their
Apache-2.0 terms, the open-source core cannot be retroactively relicensed.
