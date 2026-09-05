# IPC Channel Audit Matrix

盘点基线:c207be2 + 6a2a515。全仓 main 进程 `ipcMain.handle/on` 共 **173 + 24(shell 常量通道)= 197 个注册点**,分布:

| 模块                                             | 注册点                                                                     | 验证状态                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/shell/src/main/ipc/home-file-ipc.ts`       | 14(home:*)                                                                 | ✅ HARDENED(6a2a515)                                                          |
| `apps/shell/src/main/ipc/project-ipc.ts`         | 8(project:list/create/rename/delete/moveFile/importFiles/timeline/files)   | ✅ HARDENED(6a2a515)                                                          |
| `apps/shell/src/main/ipc/preferences-ipc.ts`     | 9(language/update-channel/theme/save-dir/get-app-version)+ 'app:get-theme' | ✅ HARDENED(6a2a515)                                                          |
| `apps/shell/src/main/index.ts`                   | tabs:*(5)                                                                  | args-lite(reorder 校验 id+integer;showMenu x/y 数字检查)— 既有                |
| `apps/slides/src/main/slides-main.ts`(project:*) | 4(resolveChat/appendChat/loadChat/rebindChat)                              | ✅ assert*Args(project-store ipc.ts,既有)                                     |
| `apps/slides/src/main/ai-ipc.ts`                 | ai:_/prompts:_(17)                                                         | set-settings/probe-models ✅ NEW;其余 args-lite(String() 包裹 + 失败兜底返回) |
| `apps/slides/src/main/slides-main.ts`(slides:*)  | ~120                                                                       | ⚠️ TRUSTED-OP(见下)                                                           |
| `apps/slides/src/main/attachments-ipc.ts`        | 5                                                                          | ✅ 既有(ext 白名单/大小上限/48k clamp)                                        |
| `apps/slides/src/main/presenter-show.ts`         | 7                                                                          | ⚠️ TRUSTED-OP                                                                 |

## 状态定义

- **HARDENED**:sender 验证(assertTrustedIpcSender)+ 参数运行时校验 + 路径规范化,破坏性动作 fail-closed。
- **VALIDATED-ARGS**:参数有强运行时校验(无文件副作用或副作用受限)。
- **TRUSTED-OP**:handler 假定 preload 传入形状正确(TS 类型),main 侧以 `sessions.get(e.sender.id)` 键控 + try/catch 兜底。风险=崩溃面(DoS)而非持久化完整性;因为 sender 校验已由 app 级 navigation guard + preload allowlist + 主进程无远程内容加载兜底。**分阶段收编,不一次性重写**(任务书 P1-20 红线)。

## HOME_FILE_IPC 通道明细(全部 HARDENED)

| 通道                                                                          | sender | 参数/路径校验                                                                 | 备注                           |
| ----------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | ------------------------------ |
| home:toggle-star                                                              | ✅     | checkFilePath(.pptx+mustExist+isFile)                                         |                                |
| home:open-path                                                                | ✅     | checkFilePath(mustExist) → 路由器内再分流                                     | 保留"不支持格式"警告行为       |
| home:reveal-path                                                              | ✅     | checkFilePath(mustExist+isFile)                                               | 目录 reveal 有意收紧           |
| home:rename-file                                                              | ✅     | sanitizeFileName(Windows 保留名/非法字符/尾点) + checkFilePath + 目标存在检查 | 同目录 rename,无跨目录移动     |
| home:duplicate-file                                                           | ✅     | checkFilePath(.pptx)                                                          |                                |
| home:delete-files                                                             | ✅     | 列表逐项 checkFilePath(.pptx+isFile)                                          | 目录名为 x.pptx 无法再被 trash |
| home:browse                                                                   | ✅     | 无参(对话框)                                                                  |                                |
| home:new-slide                                                                | ✅     | projectId 存在性弱校验(默认白名单外即记录)                                    |                                |
| home:removeRecent / recents / starred / statPaths / openTrash / getAppVersion | — / 弱 | 只读或应用自持状态                                                            |                                |

## PROJECT 通道明细(全部 HARDENED)

| 通道                                               | sender | 校验                                                                                                                                           |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| project:create/rename                              | ✅     | assertBoundedString(name ≤200)                                                                                                                 |
| project/delete/files/timeline/moveFile/importFiles | ✅     | assertStorageId(id: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)/timeline limit ∈[1,1000]/moveFile 路径绝对+.pptx(允许先映射后存在,与历史记录模型一致) |

## AI 通道策略表

| 通道                                                                       | URL policy                              | 备注                                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ai:set-settings                                                            | —                                       | validateAiSettings:全字符串有界、baseUrl http(s) 且纯 http 仅 loopback、token 上限;失败**丢弃不落盘** |
| ai:probe-models                                                            | https(远程)/ http 仅 loopback           | file:, ftp: 拒绝;models ≤500 条、id ≤256                                                              |
| ai:generate-image / analyze-media / insert-image-url / replace-picture-url | 公网取图 = **fetchWithSsrfGuard**(逐跳) | 与 BYOK baseURL 宽松策略**有意区分**(P1-06)                                                           |
| ai:stream / ai:chat                                                        | provider 协议层                         | BYOK baseURL 由 ai-provider 消费;用户显式配置信任                                                     |

## 遗留收编计划(TRUSTED-OP → VALIDATED)

按风险排序,随 slides-main IPC 域拆分(modularization-plan.md 批次 2)逐域收编:

1. `slides:open-path` / `slides:master-open(partPath 为 zip entry key,非 fs 路径)` — open-path 加 checkFilePath。
2. presenter:*(audience-nav/ink 为广播型,加数值/枚举 clamp)。
3. 编辑 op 族(edit-_/set-_/add-*)统一 `assertEditOp` 家族(数字有界、枚举、字符串上限),先覆盖带 bytes 的(add-image-bytes / replace-picture-bytes / add-media-bytes,已有大小上限需确认后文档化)。
4. ~~ai:save-style-template / load-style-template~~ — 复核结论:**既有消毒已足够**(非法路径字符替换为 `_`、名称截断 64、固定落在 userData/style-templates 下,无穿越面)。
