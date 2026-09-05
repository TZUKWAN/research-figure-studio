# CI Matrix + Windows 覆盖

配置:`.github/workflows/ci.yml`(治理批次 6a2a515)。

## 触发(DESKTOP-P0-10)

| 事件         | 分支                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| push         | `main`, `dev_*`, `release_*`, **`refactor/*`**, **`audit/*`**, **`fix/*`** |
| pull_request | `main`                                                                     |
| 手动         | workflow_dispatch                                                          |

`refactor/*` 为当前多 Agent 并行开发主干(Scientific Visual Compiler),此前 push 不触发 CI → 已修复。`audit/*`、`fix/*` 为本治理与修复流的常用前缀。

## Job 矩阵

| Job                   | Runner                                                           | 内容                                                                                                                                                                       | 时长预算 |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `test`                | ubuntu-latest                                                    | licenses、format:check、theme-colors、英文注释检查、lint、**全 workspace typecheck**、fixtures 再生成 diff、**全 workspace 单测**                                          | 45min    |
| `e2e`                 | **ubuntu-22.04**(24.04 AppArmor 阻断 Electron renderer,有意 pin) | build:all + xvfb Electron E2E(home/tab/font/theme)                                                                                                                         | 45min    |
| `windows-integration` | windows-latest                                                   | typecheck + 定向单测:electron-utils(路径/校验器)、project-store(事务/JSONL)、pptx-engine(roundtrip/原子写)、pptx-render、file-parse(Windows 附件路径)、i18n、shell、slides | 45min    |
| `security`            | ubuntu-latest                                                    | PR:dependency-review(fail-on-severity: high);push:npm audit --audit-level=high                                                                                             | 15min    |

**不跑 full Electron E2E on Windows**(任务书允许):Windows 差异面集中在路径/文件/导出/持久化,定向单测已覆盖;E2E 的 xvfb/用户命名空间问题在 Windows 不存在但代价高。

## Windows 覆盖(DESKTOP-P0-11)

历史事故:ISS-04 PNG 导出损坏 = 反斜杠路径分隔符 Linux CI 永远测不到。

现覆盖:

1. `path-guard.test.ts`(shell):文件名消毒含 `\\`、`C:`、保留设备名、尾点。
2. `ipc-validators.test.ts`(electron-utils):checkFilePath 走真实 OS 语义(本仓库开发机即 Windows,等价验证);绝对化/规范化/NUL/超长。
3. project-store 事务/JSONL 测试:真实 NTFS temp 目录读写、rename 覆盖语义。
4. save-streaming 原子写测试:Windows rename-over-existing(MoveFileEx REPLACE_EXISTING)语义。
5. attachments(file-parse)在 Windows runner 上真实执行。

## 安全自动化(DESKTOP-P1-18)

- severity policy:**high/critical 才阻断**;moderate dev-transient 不阻塞开发(任务书要求,已注释在 workflow)。
- dependency-review 仅 PR 生效(push 无 base 对比)。
- CodeQL / secret scanning:依赖仓库设置,不强制(任务书允许)。
- `npm audit` 结果同时是信息面(日志可查)。

## 已知缺口

- macOS 无独立 job:产物签名/公证在 release 管线;建议后续加 `macos: selected file/roundtrip smoke`(任务书矩阵第三行),本轮未做以控制 runner 成本。
- e2e job 依赖 `FORMAT_BASE_REF` 的 PR 特判逻辑,与本次改动无交集,保持原样。
