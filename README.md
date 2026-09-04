# Metis Diagram

**An open-source, AI-native scientific canvas editor with PowerPoint-compatible `.pptx` support.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Privacy](PRIVACY.md)

Metis Diagram is a free, open-source scientific canvas editor for macOS, Windows, and
Linux. It puts AI-assisted figure creation and editing alongside a local-first canvas
that opens and saves native PowerPoint (`.pptx`) files.

## Features

- **PowerPoint-compatible presentations** — in-house `.pptx` engine with masters, layouts, smart guides, non-destructive crop, and element-level editing.
- **Research figure workflows** — planning recipes, academic theme presets, and guided slide generation for research presentations.
- **AI that edits slides** — element-level edits with snapshots, diffs, and presentation-aware agents.
- **Bring your own key (BYOK)** — run the AI on your own API key: Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Qwen, Doubao, MiniMax, Grok, Mistral, OpenRouter, or any OpenAI-compatible endpoint.
- **Agent tools built in** — web/image search, image generation, media analysis.
- **Light / dark / system themes.**
- **macOS, Windows, Linux.**
- **Free & open-source (Apache-2.0).**

## Distribution

Release downloads are published through the configured Metis Diagram update channel. The application checks that trusted channel directly; no third-party release page is used as a fallback.

### Installing on Linux

The deb installs with apt — it pulls in the dependencies and adds Metis Diagram
to the applications menu:

```bash
sudo apt install ./genoffice_<version>_amd64.deb
```

On Fedora / RHEL-family / openSUSE, install the rpm instead:

```bash
sudo dnf install ./genoffice-<version>.x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./genoffice-<version>.x86_64.rpm  # openSUSE
```

The AppImage instead runs in place: install the FUSE 2 runtime
(`sudo apt install libfuse2`; on Ubuntu 24.04 the package is `libfuse2t64`),
make the file executable, then run it:

```bash
chmod +x GenOffice-<version>.AppImage
./GenOffice-<version>.AppImage
```

## Apps

| App           | Product           | What it is                                                                                                              |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/slides` | **Metis Diagram** | `.pptx` canvas editor with in-house parsing, rendering, element-level editing, charts, cropping, ink, and text shaping. |
| `apps/shell`  | **Metis Diagram** | The Electron shell: home screen, canvas hosting, tab and file lifecycle, themes, and auto-update.                       |

The Slides editor embeds the AI panel: element-granular editing with version
snapshots and diffs, plus a tool-calling agent over presentation state.

The application ships light / dark / system UI themes built on shared design
tokens (`packages/ui`), with a CI guard that keeps chrome colors on the token
system. Slide surfaces stay stable in dark mode, so files render and export
identically in both themes.

**AI backends — bring your own key (BYOK).** Configure Claude, OpenAI, Gemini,
DeepSeek, Kimi, GLM, Qwen, Doubao, MiniMax, Grok, Mistral, OpenRouter, or any
OpenAI-compatible endpoint (base URL + key), including local servers. API keys
remain on the local device. The canvas assistant supports configured model calls
and web/image-search workflows without requiring an application account.

## Engine packages

All pure TypeScript, no Electron dependency, unit-tested (except the UI kit):

- `packages/pptx-engine` / `packages/pptx-render` — pptx model, element
  patching, and high-fidelity rendering.
- `packages/research-harness` — research-figure planning, layout recipes, and
  component registry.
- `packages/file-parse` / `packages/docx-engine` — shared attachment and
  metafile parsing used by Slides AI workflows.
- `packages/agent-core` — the AI agent loop and skill composition shared by the
  shell and Slides.
- `packages/ai-provider` — provider abstraction and streaming for the model
  backends.
- `packages/ai-search` — web and image-search tool integration.
- `packages/i18n`, `packages/ui`, `packages/project-store`, `packages/theme-engine`,
  `packages/font-metrics`, `packages/electron-utils` — shared i18n, UI,
  project storage, theme, font, and Electron main-process helpers.

## Development

```bash
npm install
npm run dev          # Slides renderer + shell against the Vite dev server
npm run dev:slides   # run the standalone Slides app
npm run build        # build the Slides app
npm run build:all    # build Slides and the shell
npm run shell        # build both apps, then launch the shell
npm test             # unit tests for current packages and apps
npm run typecheck    # tsc --noEmit across current workspaces
npm run dist:mac     # package the shell with the Slides module (dmg + zip)
npm run dist:win     # package the shell with the Slides module (nsis)
npm run dist:linux   # package the shell with the Slides module (AppImage + deb + rpm)
```

Run these commands from the repository root. `npm run build:all` is required
before `npm run shell` and before the root packaging commands because the shell
embeds the built Slides module.

Local UI/e2e driver scripts (Playwright + Electron, for local acceptance, not
committed by default) live in [`scripts/drivers/`](scripts/drivers/README.md).

## Architecture notes (pptx editing)

```
open pptx ─► pptx-engine parses the package into a slide/element model
           ─► source anchors and inheritance are retained for targeted edits
           ─► pptx-render builds the high-fidelity render tree for the editor
edit      ─► manual and AI actions produce narrow element operations
save      ─► changed elements become OOXML fragments and are patched into the package
           ─► untouched package entries remain unchanged
```

The original presentation remains the source of truth: edits are applied as
narrow patches, and content the editor did not touch survives the round trip.

## FAQ

**Is Metis Diagram free?**
Yes. Metis Diagram is free and open-source under the Apache-2.0 license — no
trial, no paid tier for the apps themselves.

**Can Metis Diagram open and save PowerPoint files?**
Yes. Metis Diagram opens and saves native `.pptx` files. Saving applies targeted
content patches so content the editor did not touch survives the round trip.

**Does Metis Diagram work offline?**
Yes. Canvas editing is fully local — files never leave your machine to be
opened, edited, or saved. AI features require a network connection and a model
API key that you configure (BYOK).

**Can I use my own AI model or API key?**
Yes. Metis Diagram supports bring your own key (BYOK) for Claude, OpenAI,
Gemini, DeepSeek, Kimi, GLM, Qwen, Doubao, MiniMax, Grok, Mistral, and
OpenRouter, plus any OpenAI-compatible endpoint — including local model servers.

**Does Metis Diagram collect any data?**
Metis Diagram does not require an account. See [Privacy](PRIVACY.md) for the
current data-handling disclosures.

## Security

See [SECURITY.md](SECURITY.md) for the process security posture (renderer
sandboxing, IPC validation, external-link gating) and the threat models for
AI-generated content.

## Acknowledgements

Metis Diagram would not be possible without these open-source projects:

- [Electron](https://www.electronjs.org/) — the desktop runtime for every app.
- [Konva](https://konvajs.org/) — canvas rendering for Slides charts and
  content.
- [HarfBuzz](https://github.com/harfbuzz/harfbuzz) (wasm) — text-shaping
  metrics for complex scripts.
- [opentype.js](https://github.com/opentypejs/opentype.js) — font metrics for
  slide text layout.
- [Acorn](https://github.com/acornjs/acorn) — parsing for the constrained
  Slides layout-script syntax.

## Third-party notices

`npm run notices` regenerates the bundled third-party license summary
(`tools/gen-third-party-notices.mjs`); all runtime dependencies are
MIT/Apache-2.0/BSD-3-Clause/OFL, and the bundled Carlito fonts are licensed
under the SIL Open Font License.

## License

Metis Diagram is licensed under the [Apache License 2.0](LICENSE).
