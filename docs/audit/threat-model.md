# Electron 威胁模型 — Metis Diagram(桌面)

基线:c207be2 + 治理批次 6a2a515。范围:shell(宿主窗口)+ slides(编辑器模块)。

## 1. 资产

| 资产                           | 位置                                    | 影响面          |
| ------------------------------ | --------------------------------------- | --------------- |
| 用户文档(.pptx 草稿/成品)      | 任意用户目录                            | 机密性 + 完整性 |
| 项目元数据与 AI 聊天历史       | `userData/projects/`(ProjectStore)      | 完整性          |
| AI provider 凭据(BYOK api key) | `userData/ai-settings.json`             | 机密性          |
| 自动更新通道                   | resources/app-update.yml(构建期注入)    | 完整性(供应链)  |
| 诊断日志                       | export-diag.log / ai-run-failures.jsonl | 隐私(路径泄露)  |

## 2. 信任边界与对手能力

**R = 渲染进程(被视作不可信)。** 依据:slides 渲染 AI 生成内容、解析不可信 PPTX(第三方文件)、AI 工具结果注入 DOM。XSS 或依赖漏洞导致 renderer 沦陷是**设计内假设**,不是超出模型的场景。

对手能力(R 沦陷后):任意调用 preload 暴露的全部 IPC 通道;读写 renderer 自身 DOM;发起 renderer 侧 fetch。

**Main 进程 = TCB。** 主要防线:contextIsolation=true、nodeIntegration=false、sandbox=true(shell + slides + 打印/导出临时窗口均确认)、全局 navigation guard(app 级 will-navigate deny + window.open deny,`packages/electron-utils/src/navigation-guard.ts`)、preload 逐通道 allowlist(无 generic invoke)。

**OS/文件系统**:恶意 PPTX(zip bomb、XML 炸弹、超长媒体)在 main 进程被解析——解析器DoS = 可用性风险。

## 3. 攻击面 × 缓解现状

### 3.1 IPC 能力滥用(R → main)

| 能力                                                         | 治理前                                               | 治理后(6a2a515)                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 任意路径 rename/duplicate/trash("main = 文件系统能力服务器") | 仅扩展名正则 + existsSync;目录名为 x.pptx 可被 trash | `checkFilePath`:绝对化、规范化、扩展名白名单、**stat 验证为常规文件**;目录拒绝                              |
| sender 伪装/降级                                             | 无检查                                               | `assertTrustedIpcSender`(sender 存活 + frame URL 为 file:// 或未打包时 dev origin)覆盖全部 shell 破坏性通道 |
| 参数注入(超长串/NaN/负索引)                                  | TypeScript 类型即"验证"                              | assert* 原语 + 项目 id 存储白名单 + 有界限制                                                                |
| AI settings 写入污染                                         | 原样落盘                                             | validateAiSettings 清洗 + 失败丢弃                                                                          |

### 3.2 SSRF / 网络取数

- AI 图片插入/替换走 `fetchRemoteImage` → `fetchWithSsrfGuard`(DNS 解析全地址校验、BlockList 私网段、**逐跳重定向复验**)— 既有,确认有效。
- `ai:probe-models`(BYOK):治理后仅 http(s);纯 http 仅限 loopback(本地模型服务器);响应条目 ≤500、id ≤256。
- `ai:generate-image`/`ai:analyze-media` 的 URL 入参同样必须经 SSRF guard 通道(已确认走 fetchRemoteImage)。
- URL policy 分层(文档化于 ipc-audit-matrix):provider baseURL(用户显式配置)宽松于"内容取图"(公网 https only)。

### 3.3 供应链 / 更新

- 更新:electron-updater,feed URL 构建期注入(resources/app-update.yml),不提交仓库;失败路径仅提供可信源安装包链接(既有)。
- 遗留风险:postinstall `install-electron`、@genspark/cli 子进程树打包(internal compat,保留决策);建议后续 pin + provenance(见遗留清单)。

### 3.4 资源耗尽(可用性)

- 附件:文本抽取 48k 字符上限、图片字节数上限、扩展名白名单 — 既有。
- PPTX(zip):**上限未实施**(最大解压字节/条目数/单文件维度)——遗留 HIGH,建议 pptx-engine parse 入口加预算检查。
- 导出/诊断日志:治理后有界轮转(256KB,尾保留)。

### 3.5 隐私

- 诊断日志含文件路径(dir=/path JSON)——有界化后仍含路径;风险可接受(本机日志,不上传),已文档化;后续可加路径脱敏选项。
- 匿名统计/账号体系:已拔除(既有决策)。

## 4. 遗留(优先级排序)

1. **HIGH** PPTX 解压预算(zip bomb / decompression bomb)— pptx-engine `openPptx` 入口加全局字节/条目上限。
2. **MED** slides 编辑类 op(slides:edit-* / set-* / add-_)运行时 shape 验证:逐通道 assert_ 化(现依赖 TS 类型 + main 侧 try/catch;崩溃面=DoS,非完整性)。建议随 slides-main IPC 域拆分批次做。
3. **MED** `slides:files-add` 的任意路径读(附件):建议引入 capability token(先 pick 后引用 handle)。
4. **LOW** 打印/导出 PDF 临时 BrowserWindow 均已 sandbox;保持审查新窗口创建点。
5. **LOW** CodeQL/secret scanning:依赖 GitHub 仓库设置(任务书允许策略化)。

## 5. image-size transitive DoS (production closure 2 disposition)

`image-size@1.2.1` (ICNS/JXL/HEIF parse loops, GHSA-w3rx-r6r6-pgpr /
GHSA-5p2g-fcmc-qvqq) enters only via `pptxgenjs@4.0.1` inside
`@genoffice/pptx-engine`. npm's suggested fix is `pptxgenjs@1.1.5`, a 2020-era
downgrade that breaks the pptx-engine writer API; an npm override to
`image-size@^2.0.2` violates pptxgenjs's declared range and is ignored by the
installer. Disposition: **BLOCKED_EXTERNAL** on upstream pptxgenjs adopting
image-size v2. Attack surface note: image-size only parses image files the
user explicitly picks locally for insertion (insert picture / image fill);
the research-figure pipeline never feeds remote bytes into it, so the DoS
surface is self-inflicted-input only, not remotely triggerable.
