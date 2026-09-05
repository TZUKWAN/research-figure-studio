# Feature Surface Audit(遗留/未用能力盘点)+ i18n 收敛方案

DESKTOP-P1-01 / P1-02 / P1-03。原则:先减用户可见 surface,不删底层引擎能力。

## 1. Slides Office 能力分类(DESKTOP-P1-01)

基于代码现实(slides-main IPC 面 + Ribbon/Home UI)与既有产品决策(只保留 文件/开始):

| 能力                                              | 引擎/IPC           | 用户 UI 入口                                                                                      | 分类                     |
| ------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------ |
| 画布增删/版式尺寸/文本/表格/形状/图片/连线        | 有                 | 开始 tab                                                                                          | **CORE**                 |
| 科研图 AI 链(create_research_figure/orchestrator) | 有                 | AI 面板                                                                                           | **CORE**(产品身份)       |
| 字体目录/私有字体/下载                            | 有                 | 设置/开始                                                                                         | CORE                     |
| 主题/母版色/背景                                  | 有                 | 开始                                                                                              | CORE                     |
| 导出 PNG/PDF、打印                                | 有                 | 开始/文件                                                                                         | CORE                     |
| 备注数据与打印                                    | 有(状态栏入口已删) | F5 放映、打印布局                                                                                 | **HIDDEN_BUT_PRESERVED** |
| 放映(presenter/audience/ink)                      | presenter-show.ts  | 快捷键/F5                                                                                         | HIDDEN_BUT_PRESERVED     |
| 动画(get/set/transitions/advance)                 | 有                 | 无(渲染管线保留)                                                                                  | HIDDEN_BUT_PRESERVED     |
| 批注 comments                                     | 有                 | CommentsPane 半死                                                                                 | HIDDEN_BUT_PRESERVED     |
| 章节 sections                                     | 有                 | 无 UI 入口(词表保留)                                                                              | HIDDEN_BUT_PRESERVED     |
| SmartArt/3D 模型/图表编辑对话框                   | 有                 | 半死/对话框                                                                                       | **DEPRECATED**(引擎保留) |
| custom show / 阅读视图                            | 有                 | 无                                                                                                | DEPRECATED               |
| docx 导出(菜单"导出为 Word")                      | shell 菜单残留     | **REVIEW**:Research Figure Studio 无 Docs 概念,建议 REMOVE_LATER(下轮产品确认后删菜单项,引擎不动) |
| 云转换/OCR/Excel 导出菜单词表                     | i18n 词表          | 无入口                                                                                            | REMOVE_LATER(仅删词表)   |

## 2. Workspace 包盘点(DESKTOP-P1-02)

详见 dependency-map.md。行动项:

- `apps/markdown`、`apps/pdf` 空壳:不进包体;建议移出 workspaces 或标注占位(安装体积/CI 时长收益)。
- `@genoffice/font-metrics`:运行时无 import;测试有价值,保留测试、剔除一切生产声明(现无)。
- docx-engine:**不可剔除**(slides 附件/图片链运行时依赖)。

## 3. i18n 巨型文件收敛方案(DESKTOP-P1-03,规划,未执行)

现状:`strings-ribbon.ts` 701KB、`strings-app.ts` 272KB、`strings-ai.ts` 266KB、`strings-panes.ts` 246KB、shell `strings.ts` 165KB、main 内联词典已迁 `home-strings.ts`(~84KB)。问题:duplication、改名漏改、bundle 大、review 困难。

**方案(保持编译期 key safety,不手抄语言):**

1. **结构不变、按 key 域拆文件**:`strings-ribbon.ts` → `i18n/ribbon/{tab-start,tab-file,dialogs}.ts`,每文件仍导出全 19 locale 的同一 key 形状;`strings-ribbon.ts` 变成 re-export 聚合。编译期类型不丢(现 createI18n 推导基于聚合形状),review 粒度变小。
2. **key 域去重**:跨文件重复条目(如 errUnsupportedExt 在 shell/slides/panes 各一份)统一到 `i18n/common.ts`;迁移用现有 locale 一致性测试守门(新增 key 集断言)。
3. **非当前 locale lazy load**:renderer 按 `strings-*` 域改 `import()` 分包,vite 自动 chunk;首屏只带当前语言(预计 bundle −60%~70%)。风险:chunk 闪烁 → 预加载默认语言。
4. **死键清理批次**:删 UI 入口的词表(§1 REMOVE_LATER)单独 PR,配"key 无引用即删"脚本(AST 扫描 t() 调用面)。

规模:每步独立可回滚,建议 4 个 PR,不与功能批次混合。

## 4. 性能相关 surface 备忘

- Ribbon 大精简(既有轮次)已完成用户面收敛;§1 REMOVE_LATER 项是剩余尾巴。
- `styles.css` 185KB 单文件:随批次 3 renderer 拆分做 CSS module 化(不阻塞)。
