# Performance Budget & Baseline(DESKTOP-P1-19 / P1-14 / P1-15)

## 1. 预算指标(可测定义)

| 指标                     | 测量点                                       | 预算(初始目标)                      |
| ------------------------ | -------------------------------------------- | ----------------------------------- |
| cold launch              | shell main `whenReady` → Home 首帧(e2e 计时) | ≤ 3.0s(dev)/ ≤ 1.8s(packaged)       |
| open 5MB pptx            | `slides:open-path` invoke 往返               | ≤ 2.5s                              |
| open 50-slide pptx       | 同上                                         | ≤ 4.0s                              |
| save(无编辑)             | `slides:save` 往返                           | ≤ 600ms                             |
| save(编辑 10 页)         | 同上                                         | ≤ 1.5s                              |
| export PNG(10 页 @2x)    | renderer 离屏渲染 + `slides:export-images`   | ≤ 6.0s                              |
| render 1 slide(交互刷新) | buildAllRenderSlides 单页                    | ≤ 120ms                             |
| AI figure 落盘           | applyTxn → save 端到端                       | ≤ 2.0s                              |
| renderer heap 稳态       | 30 次生成+导出循环后 delta                   | +≤ 150MB 且 GC 后回落               |
| main process 同步阻塞    | 任何单次 IPC handler                         | ≤ 200ms(例外:大 chat load,见 P1-04) |

先记录 baseline 数量级,不做微优化(任务书要求)。

## 2. Baseline 方法(未在本轮执行,工具已具备)

- 计时:main 侧 `appendExportDiag` 通道已存在,扩展为 structured 行(`stage=...,ms=...`);renderer 侧 performance.mark 经现有 e2e 采集。
- 执行环境:仓库根 `npm run shell`(打包语义需 `dist:win` 后本机实测);每指标 5 次取中位。
- 产物:本文件追加"Baseline 2026-Q3"表 + `userData/export-diag.log` 样本。
- 差异化:首轮先在开发机(Windows 11,本机)采集;CI 不跑性能门(避免 runner 噪声),只存档。

## 3. 已知数量级事实(代码审计推断,非实测)

- save 走 `savePptxToFile` 流式(zip streamFiles + DEFLATE L6)+ 本轮起 temp+rename:大 deck 的 save 峰值内存显著低于 savePptx 缓冲路径(引擎注释已证),rename 开销可忽略。
- 大 chat load(P1-04):`scanChatFile` 全量 sync 读 — 10k 条 ≈ 2-6MB,主进程毫秒~十毫秒级,不构成阻塞;>10MB 场景列入 async 化遗留。
- `listProjectsSummary` 每项目 statSync×chats:项目数 ×(1+chats) 次 stat;百项目级 <10ms,可接受。

## 4. 长时运行 memory(P1-14)

测试脚本(手动/半自动,列入下轮):

1. 连续生成 30 张科研图(真实 UI,SLIDES_RENDERER_URL dev 实例);
2. 每张导出 PNG;
3. 期间打开/关闭 3 个文件 tab;
4. 观察点:renderer heap(devtools + `process.getProcessMemoryInfo`)、detached Konva nodes(现有 konva-adapter 引用计数)、image bitmap、IPC listener 计数(`webContents.listenerCount`)。
5. 通过标准:file/tab close 后上述计数回落到开文件前 ±5%。

## 5. Multi-tab 状态隔离(P1-15)

现状设计确认(代码审计):

- 每 tab = 独立 WebContentsView + 独立 renderer 进程;slides 侧一切状态按 `sessions.get(e.sender.id)` 键控;AI provider run/cancel 按 requestId + ownerToken;ProjectStore 会话按 wc.id attach(attachedIds)。
- tab close 钩子链:requestSlidesClose → dirty 保存守卫 → 销毁。
- 待补:multi-tab stress E2E(`A生成→切B→B编辑→切A→保存A→关B→重开B`)。e2e/ 目录已有 home/tab 基建,新增用例约 1 天工作量,列入下轮(与 E2E 扩充同一 PR)。

## 6. E2E 扩充清单(DESKTOP-P0 补充,任务书 §35)

| spec                        | 状态                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| home/tab/font/theme         | 既有 7 passed                                                                                |
| windows-path                | 已由单测覆盖(path-guard / ipc-validators / project-store),CI windows job 执行 — 不再单列 e2e |
| file-save-crashsafe.spec.ts | 规划:save 中 kill main → 重开文件完整性(依赖 pptx 原子写,已具备实现基础)                     |
| project-persistence.spec.ts | 规划:create/rename/move/delete→trash/重开恢复(repairConsistency 已实现)                      |
| ipc-negative.spec.ts        | 规划:渲染侧模拟越权 invoke(webContents.executeJavaScript 注入)断言 fail-closed               |
| multi-tab.spec.ts           | 规划(见 §5)                                                                                  |
