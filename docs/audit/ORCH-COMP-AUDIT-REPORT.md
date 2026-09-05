# Audit Delivery — Semantic / Composition / Orchestration 深度修复

- 分支：`audit/semantic-orchestration`（基于 `refactor/scientific-visual-compiler` @ `c207be2`，与远端 `tzukwan/refactor/scientific-visual-compiler` HEAD 一致）
- 审计依据：Agent 1 任务书（ORCH-P0-01..05 / COMP-P0-01..08 / COMP-P1-01..12 / trace / fuzz）
- 工作方式：独立 git worktree（`vendor/genoffice-orch`），未触碰主工作树中 P0.5 Agent 的未提交修改

## 1. 修复问题清单与 Root Cause

### ORCH 层（编排状态机）

| 编号 | 问题 | Root Cause | 修复 |
|---|---|---|---|
| ORCH-P0-01 | SEMANTIC_REPLAN 只清空候选集，plan 从未替换 | 主循环内无任何重新调用 planner 的路径；`L6` 只是字符串标签 | 真正的有界 semantic replan：语义失败（hardGate semantic / semantic decision / forbidden hits）→ `compileSemanticReplanFeedback` → `planSemanticFigure`（再次调用模型）→ 新 plan 经 `compileSemanticAttempt` 全量重建派生状态 → 候选集/预算全部重置。预算 `maxSemanticReplans`（默认 1），耗尽后诚实降级为 `L5 RECOMPOSE (semantic replan budget exhausted)` 或 `L6 SEMANTIC_REPLAN (replan failed)`，绝不虚报 |
| ORCH-P0-02 | schema invalid 直接失败，"repair" 名不副实 | `parseFigurePlanV2` 返回 null 无原因，编排器首败即返 | 新增独立 parse/repair 层：初次 1 次 + schema repair 2 次；每次反馈给模型的都是具体错误（如 `edge xxx: to references missing node "x9"`、`node "a": type "foo" unsupported`）。`MODEL_OUTPUT_PARSE_ERROR` / `FIGURE_PLAN_SCHEMA_ERROR` / `PLANNER_TRANSPORT_ERROR` 三类分开记录，暴露于 `result.semanticDiagnostics` |
| ORCH-P0-03 | plan 派生变量散落主函数，replan 后必然 stale | measured/edges/signals/meta/importance/groupIds/edgePriority/collisionClasses/forbiddenHits 全部在循环外一次性构造 | 唯一编译函数 `compileSemanticAttempt(plan, …) → SemanticAttemptState`；任何新 plan 必须经它重建。内置 `assertSemanticAttemptConsistency`：measured ids == plan nodes、importance ids == plan nodes、meta ids == plan nodes、groupIds ⊆ plan nodes、所有 edge endpoint ∈ plan nodes、group members ⊆ plan nodes |
| ORCH-P0-04 | visualPlan 跨 recompose 泄漏 | 循环外可变量 `visualPlan` 一旦被某次 compose 写入即存活到最终结果（最后一次非空即生效） | decomposition 只挂在本 attempt 的 modelPlan 上（`SpatialPlan.visualPlan`）；spatial plan 不可用时 decomposition 与之同亡。最终结果只读 `best.plan.visualPlan ?? { modules: [] }`。回归测试：模型 spatial 非法 + 携带 visualPlan → winner 为 prior → 结果 visualPlan 必为空 |
| ORCH-P0-05 | `routeRetried` 是整个 run 的全局布尔 | 预算变量在循环外声明 | `CandidateAttemptBudget { routeFixes }` 每 candidate 每轮新建，`MAX_ROUTE_FIXES_PER_CANDIDATE = 1`。回归测试：12 节点 DAG 一次 run 出现 ≥2 次 `L2 ROUTE_FIX`（旧实现最多 1 次） |

### COMP 层（构图语法）

| 编号 | 问题 | Root Cause | 修复 |
|---|---|---|---|
| COMP-P0-01 | mediation 的 Y 选取用了全局 `outAdj` 布尔，任意非 X/M 节点都可能被选 | `topo.ids.find(id => id !== x && id !== m && outAdj)` 与该节点无关 | Topology 暴露真实邻接（`successors/predecessors/edgesBetween`）；Y 从 M 的后继中按（是否 sink → importance → id）确定性选取；无法构成 X→M→Y 三元组时 grammar 返回 null 拒绝该构图（降级到其他 grammar，绝不伪造）。测试含"M 有两个后继、正确 Y 位于非字典序首位" |
| COMP-P0-02 | moderation 只能表达 M→Y 节点边，指向 effect 的语义失真 | schema 无 edge 级 qualification，composition 层完全忽略 | schema 新增 `SemanticEdge.qualifiedBy?: string[]` + `targetEdge` 引用校验（必须指向存在的 edge id）；grammar 解析 targetEdge/qualifiedBy 把 moderator 放在被 qualify effect 的中点正上方（dashed drop 语义），cause 取进入 target 的 primary 边；无显式结构时 fallback 推断，无法识别则拒绝 |
| COMP-P0-03 | parallel 用弱连通分量 + round-robin chunk 分道 | 无 path decomposition | 新增 `decomposeParallelTracks`：branch/join 识别 + 从分支点沿真实路径泛洪到汇合点生成 `ParallelTrack{nodeIds, source?, sink?}`；共享源/汇锚定在两端列；无真实并行结构时 grammar 拒绝（删除了 `chunk()`）。测试：三分支路径各自保持 lane、input/output 锚在轨道之外；链图拒绝 parallel |
| COMP-P0-04 | diverging 把所有 inDeg>0 的节点都推到右侧输出列 | 未区分 branch source / intermediates / terminal sinks | 重写：terminal = 非反馈出度 0 的 sink（无 sink 时用最深层的节点），intermediates 按层级放在 source 与输出列之间的中间列，每条 branch 保持层级顺序 |
| COMP-P0-05 | feedback grammar 只是 `linearGrammar(topBand)`，corridor 几何不归它管 | 未预留不可占用区 | feedback grammar 亲自负责：主链压入上带（bandCenter bias）、`feedbackLane` bias 定义 corridor 起点、任何节点一律不得落入 corridor；feedback 端点（链首/链尾）被钉到两端列，保证外围 lane 从第一次 solve 就有锚位 |
| COMP-P0-06 | causal `moderatorsAbove` 按初始 y 值反推"谁在上面" | 坐标驱动而非语义驱动 | 专用 `causalGrammar`：主链（weightedMainChain）走主带；`role === 'moderator'` 的节点按语义角色上浮到顶部带；context/support 下沉；intermediate 不在主链时排第二行。初始坐标不再参与语义判定 |
| COMP-P0-07 | tree `assignLeaves` 无环防护，non-feedback cycle 可无限递归 | 递归前未验证 acyclic | 进入 tree grammar 先对 hierarchy 子图跑 DFS-color `detectCycle`（迭代栈实现），有环直接返回 null（不修几何）；`assignLeaves` 内再保留 `visiting` guard 双保险 |
| COMP-P0-08 | tree 只认单 root，root 之外的节点落入默认 x | 无 forest 支持 | `forestRoots` 找出全部根并按子树规模分配叶位（多根共享叶 span）；childless roots 与不可达节点作为 context island 进入独立底部带 |
| COMP-P1-01 | signature 缺 cycle/isolate/multi-edge 等信号 | 字段不足 | `CompositionSignature` 新增 `hasCycle / isolatedCount / sourceCount / sinkCount / branchCount / joinCount / multiEdgePairCount / centralitySkew / chainCoverage / hasTimeOrder / hasMatrixAxes`，全部由真实图统计计算，并接入 priorFitScore |
| COMP-P1-02 | FigureFamily 无运行时约束力，任意 family 都落到 generic grammar | contract 声明与 grammar 选择完全解耦 | 新模块 `family-strategy.ts`：15 个 family 各有 `eligibleGrammars / preferredGrammars / forbiddenGrammars / requiredSignals / fallbackPolicy`；generateCandidates 按 strategy 过滤与排序 prior 池；strict family 无候选时显式失败 |
| COMP-P1-03 | timeline 无时间语义（字典序/层级 ≠ 时间） | schema 不能表达 temporal order | FigurePlan v2 新增 `timeOrder?: string[]` + 节点 `phase/timePoint`；timeline grammar 只按 timeOrder 排列（缺失则拒绝）；family strategy 强制 `hasTimeOrder` 信号，缺失报 `FIGURE_FAMILY_SIGNAL_MISSING` |
| COMP-P1-04 | matrix 只是"把节点排成网格" | 无 row/column 语义 | FigurePlan v2 新增 `matrix?: { rowGroupIds, columnGroupIds, cellRelation }`（引用已声明 groups）；matrix grammar 按 row group 定 y 带、column group 定 x 列，cells 双轴对齐；无 axes 声明则 family 失败 |
| COMP-P1-05 | network = radial，无 network 语义 | 无专用 layout | 新增 `network` grammar：确定性 degree 排序 hub-ring（无 force simulation，同输入同输出）；真二部图（两个分区各 ≥2 节点，星形不算）用双列 degree 排序布局 |
| COMP-P1-06 | comparison 无 shared-anchor/mirror | 无专用 grammar | 新增 `comparison` grammar：前两组互为镜像，行 i 左右两侧共享同一 y（aligned anchor），未分组节点落在中缝；不足两组则拒绝 |
| COMP-P1-07 | defaultBias/allowedRange 是摆设 | grammar 硬编码 0.12/0.48/0.84 | 新增 `biasValue(prior, key, fallback)`（defaultBias 经 allowedRange 钳制），linear/converging/diverging/ice/parallel/radial/network/timeline/comparison/feedback/causal/mediation/moderation 全部接入；测试：改 mediation 的 `defaultBias.y` → Y 节点位移 |
| COMP-P1-08 | mainChain 字典序贪心 | 从字典序首个 source 出发选第一个后继 | `weightedMainChain`：① `primarySpine`/`readingPath`（合法 id）直接采用 → ② DAG 上 importance 加权 + primary-relation 加权的最长路径 → ③ 环图退化为 visited-guard 贪心；字典序仅作最后 tie-break。测试：spine [c,d] 压过 a→b 链 |
| COMP-P1-09 | radial core 只看 importance | 高 importance 叶节点可成为中心 | 核心评分 = declared visualCenter(+4) + role core(+2.5) + degree×1.2 + importance×1.5；测试：degree 4 的 hub 压过 importance 0.95 的叶节点；声明 visualCenter 后反转 |
| COMP-P1-10 | 固定 fraction 先行，solver 事后救火 | grammar 不看测量尺寸 | `distributeAlong(ids, sizes, axis, start, end, minGutter)`：用测量尺寸 + 最小 gutter 先算容量，放不下返回 null → linear 换 packed column、parallel/comparison/tree 换 lane 或拒绝；linear 在层宽超出均分列宽时改为按实测宽度装箱 |
| COMP-P1-11 | multi-edge 用 `${from}\0${to}` 覆盖 | endpoint key 单值 Map | `edgePriorityById`（稳定 edge.id）为主 + `edgePriorityByPair`（pair → 数组）为 fallback index；critic（metric/scientific）匹配改为 semanticEdgeId 精确匹配 + pair 数组回退。测试：A→B 三条不同 relation 的边 id 全部保留、priority 不被覆盖、双 critic 均无漏报 |
| COMP-P1-12 | MeasuredNode.title 复用为 semantic id | 测量结构无 id 字段 | `MeasuredNode` 新增 `id`（语义身份），`title` 回归为可见标题；solver/candidate/orchestrator 全部改用 `.id`。测试：id `node-1` + 标题 `完全不同的标题` 双字段并存，几何键控只认 id；fuzz duplicate-labels 形状验证同名标题下身份不丢 |

### Trace（§28）

| 问题 | 修复 |
|---|---|
| `semantic.plan` 在模型完成前就 emit ok:true | 拆分为 `semantic.plan.started / completed / failed`（replan 同理 `semantic.replan.*`），新增 `critic.started`；started 不再冒充成功 |
| 事件无 attempt/candidate/时间信息 | `OrchestrationEvent` 新增 `timestamp`（真实时刻）、`attemptId`（语义 attempt 序号）、`candidateId`（priorId / 'model'） |

## 2. 新增 schema

- `SemanticEdge.qualifiedBy?: string[]`（被某节点 qualify 的 effect 边）
- `SemanticEdge.targetEdge` 引用校验（必须命中已声明的 edge id）
- `SemanticNode.phase?: string`、`SemanticNode.timePoint?: string`
- `FigurePlanV2.timeOrder?: string[]`
- `FigurePlanV2.matrix?: { rowGroupIds: string[]; columnGroupIds: string[]; cellRelation?: string }`
- `parseFigurePlanV2WithDiagnostics(raw) → { plan, errors[] }`（全量收集具体错误；`parseFigurePlanV2` 保持兼容为薄包装）
- `MeasuredNode.id: string`
- `NodeMeta.role?: string`；`FigureEdgesInput.targetEdge/qualifiedBy`
- `CompositionSignature` 11 个新信号字段（见 COMP-P1-01）
- 新 grammar 枚举：`network | timeline | matrix | comparison` + 对应 4 个新 prior（`network-graph` / `temporal-timeline` / `matrix-grid` / `comparison-mirror`）

## 3. FigureFamily 支持矩阵

| Family | eligible | preferred | forbidden | requiredSignals | 状态 |
|---|---|---|---|---|---|
| framework | input-core-output, layered, parallel, diverging | input-core-output, layered | moderation | — | 支持 |
| architecture | layered, parallel, input-core-output | layered | mediation | — | 支持 |
| pipeline | linear, parallel, layered | linear | radial | — | 支持 |
| mechanism | input-core-output, causal, mediation, layered | input-core-output | timeline | — | 支持 |
| causal-model | causal, mediation, moderation, input-core-output | causal | matrix | — | 支持 |
| hierarchy | tree, layered | tree | moderation | 无环（hasCycle=false, strict） | 支持 |
| network | network, radial, parallel | network | linear | — | 支持 |
| timeline | timeline, linear | timeline | radial, matrix | hasTimeOrder（strict） | 支持 |
| matrix | matrix | matrix | radial | hasMatrixAxes（strict） | 支持 |
| multi-panel-data | parallel, layered | parallel | — | — | 支持 |
| graphical-abstract | input-core-output, radial, network, causal | input-core-output | — | — | 支持 |
| experimental-setup | linear, input-core-output, comparison, layered | linear | — | — | 支持 |
| comparison | comparison, parallel, linear | comparison | — | — | 支持 |
| outreach | — | — | — | — | **UNSUPPORTED（显式报错）** |
| freeform | 全部 prior 不受限 | — | — | — | 支持（透传） |

- 未声明 family（无 contract 或 freeform/auto）→ 通用 prior 池，行为与旧版兼容。
- `outreach` 与未知 family 名 → `UNSUPPORTED_FIGURE_FAMILY` 显式失败，绝不静默 fallback 到 freeform。
- strict family（timeline/matrix/hierarchy）信号缺失 → `FIGURE_FAMILY_SIGNAL_MISSING: … requires … remedy`。

## 4. 新增/修改文件

新增：
- `packages/research-harness/src/composition/paths.ts`（邻接/环检测/加权主链/并行路径分解/森林根）
- `packages/research-harness/src/composition/family-strategy.ts`
- `packages/research-harness/src/orchestrator/semantic-attempt.ts`
- `packages/research-harness/tests/semantic-replan.test.ts`（10 tests）
- `packages/research-harness/tests/composition-family.test.ts`（11 tests）
- `packages/research-harness/tests/composition-edge-cases.test.ts`（13 tests）
- `packages/research-harness/tests/multi-edge.test.ts`（5 tests）
- `packages/research-harness/tests/composition-fuzz.test.ts`（14 tests）
- `docs/audit/ORCH-COMP-AUDIT-REPORT.md`（本文）

修改：
- `semantic/schema.ts`、`semantic/figure-plan.ts`、`measurement/measure.ts`
- `composition/priors.ts`、`composition/candidate.ts`（grammars 全量重写）
- `constraints/solver.ts`（measured 键 id 化）
- `critic/metric-critic.ts`、`critic/scientific-critic.ts`（multi-edge 匹配）
- `orchestrator/create-figure.ts`（状态机重构）
- `tests/adaptive-pipeline.test.ts`（事件契约更新）、`tests/p0-quality-core.test.ts`（可空候选）
- `apps/slides/src/shared/prompt-defaults.ts`（planner prompt 记录 timeOrder/phase/qualifiedBy/targetEdge/matrix）

## 5. Fuzz / Property Test 结果（§29）

`composition-fuzz.test.ts`（deterministic mulberry32 seeded generator）覆盖：DAG、chain、fan-in、fan-out、disconnected、multi-root tree、cycle、feedback cycle、multi-edge、duplicate labels、1 node、30 nodes。

全部通过的不变量：
- 终止性：所有 shape 走完整 orchestrator（含修复阶梯），无死循环
- 无 NaN/Infinity：boxHint、solved geometry、measured bounds、critic scores 全部有限
- 无零/负尺寸
- 不丢节点：每个 plan 节点都被 placement 覆盖
- 路由只指向已知节点
- 同种子确定性：两次完整 run 的 best.plan 与 routes 完全相等

## 6. 测试结果（真实重跑）

- `npm run test -w @genoffice/research-harness`：**16 files / 189 tests passed**（原 135 + 新增 54，含 ORCH-P0-05 预算回归）
- `npm run test -w @genoffice/slides`：**69 files passed / 1 skipped；662 passed / 8 skipped**（无退化）
- `npm run typecheck -w @genoffice/research-harness`：EXIT=0
- `npm run typecheck -w @genoffice/slides`：EXIT=0
- `npm run typecheck`（全 workspace）：EXIT=0
- `npm test`（全 workspace，15 个 workspace 顺序执行）：EXIT=0（含 research-harness 188、slides 662、shell 126，其余 workspace 全绿）
- 改动文件已过 Prettier

## 7. 与 P0.5 Agent 共享文件的处理

P0.5 Agent 在主工作树（分支 `fix/runtime-closure-visual-qa`，同一 HEAD c207be2）有未提交修改：`orchestrator/create-figure.ts`、`semantic/figure-plan.ts`、`critic/metric-critic.ts`、`tests/adaptive-pipeline.test.ts` 及新文件 `delivery/`、`render/`、`contract/contract-audit.ts`（Delivery Gate、Typography SSOT、contract audit、Spearman 修复）。

处理方式：
1. 本任务在**独立 worktree**（`vendor/genoffice-orch`）从干净的 c207be2 切出 `audit/semantic-orchestration`，主工作树的未提交修改一字未动、未被提交、未被覆盖。
2. 已通读对方 diff 并遵守边界：Spearman/visualHierarchy、Delivery Gate、publication typography、off-screen rendering、screenshot critic 等 P0.5 条目本任务完全未实现、未重复实现；本分支的 metric-critic 只改 endpoint 匹配（COMP-P1-11），visualHierarchy 评分保持 c207be2 原样留给对方。
3. 预期的合并冲突点：`create-figure.ts`（我在同一修复阶梯里加了 L6 真执行与预算/trace；对方在 critic 段加 contract audit 与 delivery gate——两者位于不同代码区域，语义正交）与 `figure-plan.ts`（对方加 evidenceRefs/provenanceRefs/claimType，为加性字段）、`metric-critic.ts`（对方改 visualHierarchy/spearman，我改 route bookkeeping——不同函数）。合并策略：以双方 hunk 为单位保留，冲突时对方改动优先级不低于本任务；合并后需重跑双方全部测试（本分支 188 harness + 对方 delivery/contract 套件）。
4. 本任务在 semantic 层新增的 `qualifiedBy/targetEdge 校验` 与对方的 contract audit 无耦合：`parseSemanticEdgesDetailed` 只增不改既有解析语义，`parseSemanticEdges` 行为兼容。

## 8. 遗留与诚实声明

- `outreach` family 无真实构图语义，保持 UNSUPPORTED（显式失败），后续如需支持应给出专用 grammar 而非 fallback。
- matrix/timeline 的 grammar 是"有限但真实"的实现：依赖 planner 显式声明 axes/timeOrder；没有这些声明的图会显式失败而不是假装支持。
- L3 阶梯对 `candidateIdx < 2` 的既有上限保持不变（非本任务条目）。
- `routeableInputs` 密度护栏、presentation 语义、P3 publication QA 均保持 c207be2 行为。
