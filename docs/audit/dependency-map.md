# Whole-Repo Dependency Map(reachability)

方法:以"被 shell/slides 运行时 import → 进入 electron-builder 包体"为准;workspace 成员关系与 dev/test 引用单独标注。基线 c207be2,扫描于 2026-09-06。

## 可达性分级

### RUNTIME-USER-VISIBLE(打包产物核心)

| 节点          | 说明                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/shell`  | 宿主:单实例锁、文件路由、Home、TabManager、updater、project-store 宿主                                               |
| `apps/slides` | 编辑器模块:main/preload/renderer,打包为 `resources/modules/slides`(electron-builder.cjs extraResources 仅此一个 app) |

### RUNTIME-LIBRARY(slides/shell 运行时 import,进包)

| 包               | 被谁引用                                                    | 备注                                           |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| i18n             | shell、slides、全部 UI                                      | 19 locale                                      |
| electron-utils   | shell、slides main(菜单/守卫/SSRF/对话框记忆/新 IPC 校验器) |                                                |
| project-store    | shell main、slides main(project:* IPC)                      |                                                |
| ai-provider      | slides(ai-ipc)、shell devDep(ai:chat 转发)                  | 依赖 agent-core                                |
| ai-search        | shell(proxy/gsk)、slides main                               | gsk CLI 子进程树打包(internal compat)          |
| pptx-engine      | slides main、shell(经 slides 转出 savePptxToFile)           | 解析/写回核心                                  |
| pptx-render      | slides main/renderer(渲染树、text-layout、chart 渲染)       |                                                |
| agent-core       | ai-provider、slides renderer(AI 工具循环)                   |                                                |
| research-harness | slides renderer(slides-skill/research-action-ui)            | Scientific Visual Compiler                     |
| theme-engine     | slides renderer(slides-skill 风格链)                        |                                                |
| docx-engine      | slides renderer `image-loader.ts`、file-parse               | **仍是运行时依赖**(附件/图片链),不可当死代码删 |
| file-parse       | slides main `attachments-ipc.ts`                            | 附件文本抽取                                   |
| ui               | shell/slides renderer 组件库                                |                                                |
| font-metrics     | **无 src 运行时引用**(仅各自内置 font 代码与测试引用)       | 见 INHERITED                                   |

### DEV/TEST-ONLY / INHERITED-UNUSED

| 节点                        | 现状                                            | 建议                                                                                                         |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@genoffice/font-metrics`   | 运行时未被 import(root test 脚本仍在跑它的测试) | 不删;下轮把 root `npm test` 中该 workspace 保留(测试仍有价值),从任何生产依赖声明中剔除(检查结果:无)          |
| `apps/markdown`、`apps/pdf` | **空壳**(仅 node_modules,无 src)                | workspace 成员但无代码;不进包体。建议:从 root workspaces 移除或补 README 说明占位意图(单独批次,涉及安装体积) |

### PACKAGED-EXTRA(internal compat,既有决策)

- `@genspark/cli` + `ws` 子进程树 → `resources/native`(gsk 登录/图像生成 legacy 路径)。
- root `ws` dependency 为其存在。

## 依赖方向(无环)

```
shell ──▶ slides(main+preload+renderer 经相对路径跨包,历史设计)
        ─▶ project-store, electron-utils, i18n, ai-search
slides ─▶ pptx-engine ─▶ (jszip)
       ─▶ pptx-render ─▶ font-metrics(仅类型?无运行时)
       ─▶ ai-provider ─▶ agent-core
       ─▶ ai-search, research-harness, theme-engine, file-parse, docx-engine(附件/图片)
       ─▶ project-store, electron-utils, i18n, ui
```

已知架构债:shell↔slides 以**相对路径跨 app import**(`apps/shell/src/main/index.ts → ../../../slides/src/main/slides-main`)聚合 IPC 与菜单;这正是 slides-main 无法独立构建/测试的原因之一,收敛方案见 modularization-plan.md 批次 2。

## CVE / 体积面

- 空壳 apps/markdown、apps/pdf 的 node_modules 参与 npm install(安装体积/CI 时长),不进包体 → 剔除收益=安装与 CI 时长,非包体。
- docx-engine(317KB parse.ts)为运行时附件链所需,不可剔除;其 CVE 面随 npm audit job(security)监控。
