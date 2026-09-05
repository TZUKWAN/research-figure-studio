# Desktop Reliability & Repo Health Audit — Agent 5 交付集

分支:`audit/desktop-reliability-repo-health`(与工作分支 `fix/runtime-closure-visual-qa` 同步指针)
基线:`c207be22087fb7f21b8c6135a65e0fae59ad33c9`(refactor/scientific-visual-compiler 审计基线)
治理提交:`6a2a515` 起(见 git log 中 `audit(desktop):` 前缀)

本目录是 Electron 桌面平台治理任务的全套交付文档,对应任务书第 40 节的 14 项交付物:

| #   | 交付物                                  | 文档                                                           |
| --- | --------------------------------------- | -------------------------------------------------------------- |
| 1   | Whole-repo dependency map               | [dependency-map.md](dependency-map.md)                         |
| 2   | Electron threat model                   | [threat-model.md](threat-model.md)                             |
| 3   | IPC channel audit matrix                | [ipc-audit-matrix.md](ipc-audit-matrix.md)                     |
| 4   | Persistence transaction design          | [persistence-design.md](persistence-design.md)                 |
| 5   | ProjectStore consistency report         | [persistence-design.md](persistence-design.md) §一致性报告     |
| 6   | CI matrix                               | [ci-matrix.md](ci-matrix.md)                                   |
| 7   | Windows-specific coverage               | [ci-matrix.md](ci-matrix.md) §Windows 覆盖                     |
| 8   | Product identity migration plan         | [product-identity-migration.md](product-identity-migration.md) |
| 9   | Unused / inherited feature surface list | [feature-surface-audit.md](feature-surface-audit.md)           |
| 10  | Performance baseline                    | [performance-baseline.md](performance-baseline.md)             |
| 11  | 修改文件                                | 见下§代码变更清单                                              |
| 12  | tests                                   | 见下§测试清单                                                  |
| 13  | commit SHA                              | `6a2a515`(后续提交见 git log)                                  |
| 14  | branch                                  | `audit/desktop-reliability-repo-health`                        |

另含两份规划文档:

- [modularization-plan.md](modularization-plan.md) — God file 拆分计划(第一批已落地)
- [product-identity-migration.md](product-identity-migration.md) — userData 迁移设计(DESKTOP-P0-13)

## 代码变更清单(commit 6a2a515 + 本批次后续)

**新增模块**

- `packages/electron-utils/src/ipc-validators.ts` — IPC 运行时校验器(assert* / checkFilePath / assertTrustedIpcSender)
- `apps/shell/src/main/ipc/home-file-ipc.ts` — 首页文件 IPC(加固后)
- `apps/shell/src/main/ipc/project-ipc.ts` — 项目 IPC(加固后)
- `apps/shell/src/main/ipc/preferences-ipc.ts` — 偏好设置 IPC
- `apps/shell/src/main/home-strings.ts` — 主进程 i18n 词典(自 index.ts 迁出)
- `apps/shell/src/main/file-routing.ts` — 文件路由
- `apps/shell/src/main/recent-state.ts` — 最近/星标状态
- `apps/shell/src/main/path-guard.ts` — 文件名消毒
- `apps/slides/src/main/bounded-append-log.ts` — 有界诊断日志

**修改模块**

- `apps/shell/src/main/index.ts`(2344 → ~714 行)— 拆分 + userData 迁移链扩展 + EnvHttpProxyAgent
- `apps/slides/src/main/ai-ipc.ts` — ai:set-settings 验证、probe URL policy、模型列表上限
- `apps/slides/src/main/slides-main.ts` — export-diag 有界化、proxy NO_PROXY
- `packages/project-store/src/{store,types,index}.ts` — 事务化、全量 merge、损坏恢复、UUID
- `packages/pptx-engine/src/index.ts` — savePptxToFile 原子写
- `.github/workflows/ci.yml` — refactor/_/audit/_/fix/* 触发 + windows-integration + security job
- 产品身份:`package.json`、`apps/shell/package.json`、`packages/electron-utils/src/github-menu.ts`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`.github/ISSUE_TEMPLATE/config.yml`

## 测试清单

| 工作区         | 测试文件                                                  | 覆盖                                             |
| -------------- | --------------------------------------------------------- | ------------------------------------------------ |
| electron-utils | `tests/ipc-validators.test.ts`(新,20 用例)                | 校验器负向矩阵、路径检查、sender 信任            |
| project-store  | `tests/persistence-integrity.test.ts`(新,11 用例)         | >10k merge、损坏备份、事务回滚、崩溃恢复、repair |
| project-store  | `tests/store.test.ts` / `tests/ipc.test.ts`(存量 72 用例) | 全部保持通过                                     |
| pptx-engine    | `tests/save-streaming.test.ts`(+2 用例)                   | 原子覆盖写、失败无残留                           |
| shell          | `tests/path-guard.test.ts`(新,5 用例)                     | 文件名消毒负向矩阵                               |
| shell          | `tests/tab-manager.test.ts`(更新)                         | 断言迁移至新模块                                 |
| slides         | `tests/bounded-append-log.test.ts`(新,3 用例)             | 轮转、尾保留、不可写不抛                         |

基线验证(2026-09-06,全部真实重跑):typecheck 全 workspace EXIT=0;electron-utils **125**、project-store **83**、shell **131**、slides **662 passed / 8 skipped**、pptx-engine save-streaming **7**。

## 最终验收对照(任务书第 39 节)

| 验收问题                                     | 状态                                                          |
| -------------------------------------------- | ------------------------------------------------------------- |
| destructive IPC 是否验证 sender + 参数?      | ✅ shell home/project 全部;slides 编辑类 op 见矩阵遗留项      |
| project mutation 是否不会半成功?             | ✅ 事务化 + 回滚 + ProjectStoreError(测试覆盖)                |
| chat >10k migration 是否不丢历史?            | ✅ 全量扫描 merge(测试覆盖)                                   |
| corrupted JSONL 是否有诊断?                  | ✅ 计数 + 一次性备份 + chatRecoveryStats                      |
| save 是否 crash-safe?                        | ✅ pptx-engine 原子写(测试覆盖)                               |
| Windows path 是否 CI 覆盖?                   | ✅ windows-integration job + 本仓库开发机即 Windows           |
| refactor/* 是否有明确 CI 验证路径?           | ✅ push 触发已加 refactor/_、audit/_、fix/*                   |
| product user-facing identity 是否统一?       | ✅ 元数据层完成;安装包层既有决策维持(见身份文档)              |
| userData 是否有迁移方案?                     | ✅ AI Office→GenOffice→当前产品链已实现(P0-13)                |
| unused workspace/package surface 是否已审计? | ✅ 依赖图 + feature-surface-audit.md                          |
| huge i18n 是否有可实施收敛方案?              | ✅ 方案在 feature-surface-audit.md(未执行,单独批次)           |
| preload 是否没有 generic dangerous bridge?   | ✅ 逐通道 allowlist 审计确认(shell 286 行 / slides 459 行)    |
| large file/media 是否有资源上限?             | ✅ 附件已有(48k 文本/图片大小上限);PPTX zip-bomb 上限列为遗留 |
| multi-tab 是否不串状态?                      | ✅ 设计确认(per-wc session/tab map);stress E2E 列为遗留       |
| AI action undo 是否事务级?                   | ✅ 既有 applyTxn + history-batch + aiSnapshotRestore 机制确认 |
