# Product Identity Migration Plan(DESKTOP-P0-12 / P0-13 / P1-16 / P1-17)

产品现状:**Metis Diagram**(产品)/ **Metis Copilot**(助手);前身 GenOffice,更前身 "AI Office"。

## 1. 已统一(用户可见,含本轮)

| 层                                                             | 值                                                                                | 状态                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| productName(Mac dock/Win 快捷方式/安装器显示)                  | `Metis Diagram`(apps/shell/package.json + electron-builder.cjs)                   | 既有                                                       |
| appId                                                          | `com.metissd.app`                                                                 | 既有(与 Metis SD 品牌一致,维持)                            |
| 窗口/标签/wordmark/设置内名称                                  | Metis Diagram                                                                     | 既有轮次完成                                               |
| root package.json description                                  | "Metis Diagram: AI-native research figure and presentation canvas"                | **本轮**                                                   |
| root repository.url                                            | `git+https://github.com/TZUKWAN/research-figure-studio.git`                       | **本轮**                                                   |
| shell homepage                                                 | 同上                                                                              | **本轮**                                                   |
| 应用内仓库常量 GITHUB_REPO_URL(CTA 目标)                       | 同上                                                                              | **本轮**                                                   |
| SECURITY.md / CODE_OF_CONDUCT.md / issue template 安全报告链接 | 指向新仓库                                                                        | **本轮**                                                   |
| 第三方声明标题 / README / 隐私说明                             | Metis Diagram                                                                     | 既有轮次完成                                               |
| userData 迁移链                                                | 见 §3                                                                             | **本轮实现 GenOffice→当前**                                |
| updater(DESKTOP-P1-16)                                         | feed URL 构建期注入(GENOFFICE_UPDATE_URL env,不提交);stable 默认渠道;渠道 UI 已删 | 既有决策;appId/productName 一致,不存在"读旧产品 channel"面 |

## 2. 有意保留的内部兼容(不改,防大面积 break)

| 项                                                   | 值                                                       | 理由                          |
| ---------------------------------------------------- | -------------------------------------------------------- | ----------------------------- |
| npm scope                                            | `@genoffice/*` 全部 workspace                            | 任务书红线:不一次性改 scope   |
| root package name                                    | `genoffice`(private,不发布)                              | 改名需 lockfile 根同步,收益≈0 |
| userData(dev)                                        | `GenOffice Dev` / `GENOFFICE_USER_DATA` env              | 测试驱动契约                  |
| `GENOFFICE_*` env 前缀                               | UPDATE_URL / LANG / FAKE_UPDATE / FONT_CDN_URL / MAC_X64 | 构建管线契约                  |
| Linux executableName / desktopName                   | `genoffice` / `genoffice.desktop`                        | fpm/deb 升级链不破(注释已述)  |
| `GenSparkAccountStatus` 等内部类型、genspark adapter | 内部兼容旧配置迁移                                       | 既有决策                      |

遗留的 `genspark-ai/genoffice#N` 注释引用 = **历史溯源文档**(P1-17:改名不删 attribution),保留。

## 3. userData 迁移(DESKTOP-P0-13,本轮实现)

位置:`apps/shell/src/main/index.ts`(app 模块加载期,packaged only)。

```
新目录(userData, = productName = "Metis Diagram")为空时:
  优先复制  appData/GenOffice   ← 上一代产品
  其次复制  appData/AI Office   ← 更早一代
  cpSync 递归,一次性;非空不迁移(幂等)
```

- **idempotent**:仅在目标为空时执行;迁移后旧目录保留(= backup,不 move)。
- **versioned**:覆盖 settings(app-settings.json/ai-settings.json/prompt-overrides.json)、recent/starred 列表、projects/(含全部聊天 JSONL)、drafts。
- 失败面:cpSync 中途失败 → 目标非空 → 下次启动跳过迁移。残留半份会被用户数据"污染"。收尾方案(遗留 LOW):迁移改为 temp 目录 + rename 提交,失败清 temp。

## 4. 收尾清单(不阻塞本轮)

1. 应用图标重绘(既有未收口项,非本 Agent 任务)。
2. `desktopName`/`executableName` 与新品牌的 Linux 侧统一:需发布管线确认升级兼容后一次性做。
3. 迁移 temp+rename 化(上述)。
4. 日志文件夹命名(userData 内文件名均中性,无需改)。
