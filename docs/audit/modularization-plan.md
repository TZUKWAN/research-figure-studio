# Modularization Plan(God File 拆分,DESKTOP-P0-01 / P1-20)

原则:behavior-preserving、tests unchanged/pass、每批可独立验证、**禁止一次性重写**、不改组件命名、不做全仓格式化。

## 批次 1(本轮已落地,commit 6a2a515)——Shell main

`apps/shell/src/main/index.ts`:**2344 行 → 714 行**(−70%)。

| 新模块                      | 内容                                                                                                            | 验证                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `home-strings.ts`(~1380 行) | 主进程 i18n 词典逐字迁移,`homeI18n` + `HomeStringKey`                                                           | typecheck + strings.test        |
| `file-routing.ts`           | PPTX_RE/UNSUPPORTED_FILE_RE/OPEN_DIALOG_EXTENSIONS、argv 纯函数、initFileRouting(路由 + 不支持格式警告依赖注入) | tab-manager.test 源断言迁移     |
| `recent-state.ts`           | recent/starred JSON 状态族(纯 app-state,无 handler)                                                             | 既有 home-counts.test 语义      |
| `ipc/home-file-ipc.ts`      | 14 个 home:file 通道 + 加固(P0-03/04)                                                                           | path-guard.test + e2e home.spec |
| `ipc/project-ipc.ts`        | 8 个 project:* 通道 + 加固                                                                                      | persistence-integrity.test      |
| `ipc/preferences-ipc.ts`    | language/theme/update-channel/save-dir 通道 + sender 检查                                                       | 既有 shell 131 测试全绿         |

index.ts 保留:窗口生命周期、TabManager 装配、菜单、proxy、单实例、whenReady(与 Electron 生命周期强耦合,拆出收益低、回归面大)。

## 批次 2(下一批)——Slides main 按 IPC 域

`slides-main.ts` 4739 行,按任务书建议的 IPC domain 切:

```
ipc/file      slides:open*/new-blank/save*/autosave/recent
ipc/export    slides:pick-export*/export-images/export-pdf/print/append-export-diag
ipc/elements  edit-*/set-*/add-*/delete-*/group*/clipboard 族(~120 通道)
ipc/fonts     fonts.ts/font-store.ts/font-catalog.ts 已基本独立,收编 4 个通道
ipc/ai        ai-ipc.ts(已独立)+ registerSlidesOnlyAiIpc 收编
ipc/media     insert-image/media/model3d/attachments(已独立)
```

手法:每域一个 `register<Domain>Ipc(ctx)`(ctx 携带 sessions、tm、dialogParent),slides-main 只留装配 + Session 类型 + 窗口生命周期。**每域一个 commit**,全量 slides 测试 + e2e tab/font/theme 守门。同时在该批次完成 TRUSTED-OP → assert* 收编(见 ipc-audit-matrix 遗留)。

## 批次 3——Renderer:research-specific 与 generic Office UI 分离

- `AiPanel.tsx`(134KB)、`slides-skill.ts`(221KB)中 research 图谱链(DeckAccess、create_research_figure、critic 渲染)抽 `renderer/research/`;
- Ribbon(87KB)/FormatPane(112KB)按 RibbonHomeTab 模式继续按 tab/域拆分;
- App.tsx 状态机未深拆(既有决策,维持)。

## 批次 4——跨包边界治理

- shell↔slides 相对路径跨包 import(`../../../slides/...`):收敛为显式配置注入(configureSlidesRuntime 已有雏形),解开后 slides 才能独立构建/打包。
- i18n 词典(单文件 701KB):见 feature-surface-audit.md 的收敛方案。

## 红线(任务书 §38 对应)

不为 modularization 一次重写;不动 scientific composition/critic 算法(Agent 2 域);每批测试不退化。
