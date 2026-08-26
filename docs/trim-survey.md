# 裁剪侦察报告（Task 2 产出）

日期：2026-08-26 · 分支 research-studio · 基线 0a2c25d

## 0. 结论变更（相对设计文档 v1.1 §5.2）

| 原删除清单项 | 实测裁决 | 依据 |
|---|---|---|
| packages/docx-engine | **改为保留** | `apps/slides/src/renderer/image-loader.ts:7` 经 vite/tsconfig alias 直连 `@genoffice/docx-engine/metafile`（slides/electron.vite.config.ts:29、vitest.config.ts:34、tsconfig.json:17）；附件链 `slides attachments-ipc.ts:12 → file-parse(src/docx.ts:1) → docx-engine`。metafile.ts 仅 69 行依赖本地 vendor emf-converter |
| packages/pdf2docx | 维持删除 | 仅 shell 的 PDF 转换工具链使用（见下），科研绘图 P0 无 PDF 导入需求；删除需同步手术 shell |
| apps/docs·sheets·pdf·markdown | 维持删除 | 但 shell/src/main/index.ts 是六合一宿主，需按 §2 分步手术 |

## 1. 引用点清单

### A. shell/src/main/index.ts（核心手术对象，~4000 行）
- L92-117 区间内含多段多行 import（docs/sheets 相关符号待逐段确认）
- L118 `../../../docs/src/main/docs-main` → 删
- L119 `../../../sheets/src/gateway/csv-import` (blankXlsxBuffer) → 删
- L120 `../../../pdf/src/main/blank-pdf` (blankPdfBuffer) → 删
- L121-137 `sheets-main` 多符号 → 删
- L138-149 `slides-main` → **保留**
- L150-160 `pdf-main` → 删
- L161 `pdf/src/shared/ipc` (PDF_CHANNELS) → 删
- L162-164 `./pdf2(docx|pptx|xlsx)-local` → 删（文件一并删）
- L165 `./pdf-password-dialog` → 待定：仅服务 PDF 打开密码流，随 pdf 删除一并移除（含 preload/renderer 的 pdf-password 入口，electron.vite.config.ts:18/32）
- L166-175 `markdown-main` → 删
- 使用点：L3675/3749/3813/3864/3923/3974 三个 convertPdf* handler；TabKind case 分发（2343/2393/2961 一带）待精确圈定
- L198-199 注释提及 apps/docs/out 等 → 改注释

### B. electron-builder.cjs（506 行）
- L78 断言数组 `'../pdf/node_modules/harfbuzzjs/hb-subset.wasm'` → 删条目
- L87-137 OCR helper 编译段（VISION_OCR_HELPER / WIN_OCR_HELPER 指向 pdf2docx/ocr-helper）→ 整段删；**win32 构建时 L127 会因文件缺失直接 throw，是 dist:dir 硬阻塞**
- L179-195 assertUniversalSidecar（sheets xlsx-sidecar）→ 函数删 + L474 调用点删
- L197-211 assertModuleTreesPresent 五目录 → 只留 `../slides/out`
- L235-253 extraResources modules 五映射 → 只留 slides
- L256-263 pdfium.wasm / hb-subset.wasm 条目 → 删（服务 pdf 文本引擎）
- L264-274 OCR helper 两条 extraResources → 删
- L291-346 fileAssociations → 只留 pptx
- L348-372 mac / L373-386 win / L393-438 linux 的 xlsx-sidecar extraResources → 删
- L471-477 beforePack 同步简化

### C. shell 其他文件
- src/main/pdf2docx-local.ts / pdf2pptx-local.ts / pdf2xlsx-local.ts / pdf-password-dialog.ts → 随手术删
- src/preload/pdf-password.ts、src/renderer/pdf-password.html → 删（electron.vite.config.ts L18/L32 input 同步删）
- src/shared/home-api.ts / tabs-api.ts 的 TabKind → 收缩为 slides（home renderer 卡片同步收缩，Step B 圈定）
- tsconfig.json include L25 `../../packages/pdf2docx/src/bidi-js.d.ts` → 删行
- package.json L26 `@genoffice/docx-engine` → **保留**（docx-engine 保留所致）
- cloud-projects.ts:3 依赖 @genoffice/ai-search → ai-search 保留 ✓

### D. e2e/
- playwright：11 个 sheets-*.spec、pdf-fit-zoom、markdown-tab.spec 随 app 失效 → 删除文件；home/new-file-tab/onboarding 可能断言六编辑器入口 → Step B 后实测裁定；slides-font-manager/theme-* 保留
- Phase 1 不以 e2e 通过为收口标准（记录待适配）

### E. .github/workflows/ci.yml
- 含 docs/sheets/markdown/pdf2docx 引用 → 本地无 CI 执行；做最小清理（删除明确指向被删 app 的 job/矩阵条目），不作为冒烟关卡

### F. 无碍确认
- 根 package.json workspaces 通配 apps/* packages/* → 删目录即可
- fixtures/ 保留（不影响构建）
- pptx-render→pptx-engine、ai-provider→agent-core 依赖方向全部健康
- scripts/ pagination-baseline*.msj、tools/*.py 服务 docs 字体工程 → 保留不动（不进构建图）

## 2. 分步执行序（Task 3 细化为三波，每波独立验证）

- **Wave 3a**：删 `packages/pdf2docx` + ee/ → shell/index.ts 移除三个 convertPdf* handler 与相关 import/文件 → typecheck(slides+shell)
- **Wave 3b**：删 `apps/{docs,sheets,pdf,markdown}` → index.ts 大手术（import/初始化/case 分支/Home renderer TabKind 收缩）→ typecheck + vitest(slides+pptx-engine) + dev 冒烟前置检查
- **Wave 3c**：electron-builder.cjs 按 §B 清理 → npm install 重生成 lockfile → dist:dir 冒烟
