# Third-Party Notices

## GordenPPTSkill

- Source: https://github.com/GordenSun/GordenPPTSkill
- Code / references / schema license: **MIT** (© 2026 GordenSun). Concepts,
  workflows, schemas and algorithms from this project are re-expressed in
  TypeScript for this repository under the terms of that MIT license.
- **Templates restriction**: the PowerPoint decks and preview images under
  `templates/<slug>/template.pptx` and `templates/<slug>/preview.png` originate
  from third-party Chinese PPT-template designers (稻壳儿 / WPS Online Template
  / public-government channels). Per the project's `NOTICE.md` they are
  licensed for **personal study / research / non-commercial educational use
  only**; commercial use requires permission from the original template
  authors. This restriction is **not** covered by the MIT code license.
- Disposition in this product:
  - These decks are **never bundled** in the default product build.
  - They are loadable at runtime through the Gorden directory template
    provider, pointed at a local `metis-templates/gorden/` directory supplied
    by the user (gitignored). Users are shown the restriction notice when the
    provider is enabled.
- Template author attribution embedded inside the original template files is
  preserved untouched by the fill pipeline (template fidelity mode never
  rewrites `editable: false` decorative slots).

## Font policy for CJK fallback

The CJK fallback chains reference system-installed faces (Noto Sans CJK /
WenQuanYi / Microsoft YaHei / PingFang SC). The bundled Carlito fonts keep
their OFL license file in `apps/slides/src/renderer/fonts/OFL.txt`.
