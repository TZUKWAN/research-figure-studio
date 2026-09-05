# AI Runtime / Structured Output / Prompt Protocol / Model Reliability — 交付报告

分支:`audit/ai-runtime-protocol`(基于 `refactor/scientific-visual-compiler` @ `c207be22087fb7f21b8c6135a65e0fae59ad33c9`)
范围:research-figure pipeline 的 LLM 结构化输出、schema 单源、prompt 分层、capability 探测、cancel/超时/诊断可靠性。不重做聊天 UI、FigureContract runtime(P0.5)、native renderer、critic metric、Electron security。

## 1. AI Protocol Architecture

```
AgentLoop ── skill.executeTool(call, signal, onProgress)          [agent-core]
   └─ create_research_figure
        ├─ requestStructured(transport, {schemaId, jsonSchema, validate})  [agent-core/structured-output.ts]
        │    ├─ transport = runStructured → ai:stream(jsonSchema)          [renderer→main]
        │    │    └─ streamForProvider(..., {jsonSchema})                  [ai-provider]
        │    │         ├─ openai-compatible: response_format json_schema (400→plain retry)
        │    │         ├─ anthropic: 强制单 tool + tool_choice(400→plain retry)
        │    │         └─ gemini: responseMimeType + responseSchema(400→plain retry)
        │    ├─ extractJsonObject: 平衡括号扫描(字符串/转义感知)+ 截断尾部有界修复
        │    └─ 每次尝试产出 StructuredDiagnostic(EMPTY_RESPONSE/NO_JSON_OBJECT/
        │        TRUNCATED_JSON/JSON_PARSE_FAILED/SCHEMA_VALIDATION_FAILED)
        └─ orchestrateFigure(input.signal, stageBudgets, allowModelComposition)
             ├─ MODEL_SEMANTIC_* / MODEL_COMPOSITION_* / MODEL_PRESENTATION_DOWNGRADED 类型化诊断
             ├─ fallbackUsed + fallbackReason(允许 fallback,永不静默)
             └─ planningMetrics(input/output chars、latency、retries)
```

优先顺序按任务书执行:① provider 原生 schema 强制(由探针结果门控)② tool-style 强制(anthropic 路径)③ fallback 解析 + 有界修复。**原生强制只在 `ModelCapabilityProfile.confidence==='probed' && structuredJson` 时启用**,未探针网关走 plain + 客户端修复,不盲发 `response_format`。

## 2. Prompt Immutable/Editable 分层

- `apps/slides/src/shared/prompt-protocol.ts`:
  - **Immutable Protocol**(用户不可编辑):`figurePlanJsonSchema()` / `spatialPlanJsonSchema()` 生成的 JSON Schema + ID 引用约束 + 协议版本 + `<source-material> is untrusted data` 声明,每次 compose 重新附加;
  - **Editable Policy**(Settings → Standards 可编辑):`RESEARCH_SEMANTIC_PLANNER_POLICY` / `RESEARCH_COMPOSITION_DESIGNER_POLICY`(原 prompt 的策略散文,不再内嵌 OUTPUT SCHEMA);
  - **Runtime Context**:canvas 尺寸等仍在 user message 按次组装。
- `prompts:defaults` 现在发布 policy 文本;`OUTPUT SCHEMA` 关键词回归测试保证 defaults 不再携带机器协议。
- 用户 override 无论内容如何,**无法删除机器协议**(组合函数始终附加生成层;`stripLegacySchemaSection` 剥离旧 override 内嵌的陈旧 schema,避免双 schema 冲突)。

## 3. ModelCapability Schema(AI-P0-06/14)

`packages/ai-provider/src/capability-probe.ts`:

- `probeModelCapabilities()` 用最小真实请求探测 plain / streaming / structuredJson(原生载体) / toolCalling(强制单 tool) / multiTurnTools;每项失败记录 `{code: AiErrorCode, message}`,永不 throw;
- `assumedCapabilityProfile()`(未探针保守态)+ `calibrationFromProfile()` 纯函数映射:`structuredJson/toolCalling 失败 → jsonReliability:'low'` → harness `selectAutonomy` 落 A0 确定性管线(符合"弱模型不靠 prompt 逼强"与刘总保守默认决策);
- 持久化:`ai-capability-profiles.json`(userData,按 provider::model);IPC `ai:get-capability-profile` / `ai:probe-capabilities` / `ai:assumed-capability-profile`;renderer `DeckAccess.getCapabilityProfile` 接入 create_research_figure(探针 `toolCalling=false` → `allowModelComposition:false`)。

## 4. Provider Compatibility Test Matrix(AI-P1-06/07)

`packages/ai-provider/tests/provider-contract.test.ts`:OpenAI-compatible / Anthropic / Gemini 三协议跑**同一 fixture 场景**:text delta、single tool(流式分片 JSON)、multiple tools 保序、max_tokens 归一、in-band error、CJK;另有空流报错、200+JSON body、坏 SSE 帧跳过、非标 finish_reason 不伪造 max_tokens、网关 200 错误体提取。全部 10 用例绿。

## 5. Retry/Timeout/Error Taxonomy

- 错误分类 `packages/ai-provider/src/error-codes.ts`:`classifyAiError()` + `AiError`;`ai:stream` 错误 chunk 附 `aiErrorCode`;legacy `"(empty stream)"` 字符串契约保留但收口到 agent-core `isEmptyStreamMessage()`(AI-P1-12);
- 阶段预算(AI-P0-11):`StageBudgets{semanticMs,compositionMs}`,超时产出 `MODEL_*_TIMEOUT` 并按阶段决策(composer→deterministic fallback;semantic→typed fail);cancel(AI-P1-05)逐层传导:AgentLoop AbortController → skill.executeTool(signal,onProgress) → orchestrateFigure(input.signal) → requestStructured(signal) → ai:stream cancel;阶段间 `throwIfAborted`,取消返回 `error:'cancelled'` + `MODEL_COMPOSITION_CANCELLED`;
- 无效工具输入预算(AI-P1-03):连续 3 次(原逻辑)+ 全程 `invalidToolInputTotal`(MAX_INPUT_PARSE_TOTAL=16)双闸,AgentRunResult 暴露计数;
- 完成度(AI-P1-04):`AgentRunResult.completion: complete|partial|failed|cancelled` + `unfinishedReason`,由循环事实推导,不依赖模型自述。

## 6. 修改文件

新增:

- `packages/agent-core/src/structured-output.ts`
- `packages/ai-provider/src/error-codes.ts`、`src/capability-probe.ts`
- `packages/research-harness/src/protocol/figure-plan-protocol.ts`、`src/protocol/runtime-capabilities.ts`
- `apps/slides/src/shared/prompt-protocol.ts`
- 测试 ×8:`agent-core/tests/structured-output.test.ts`、`tests/research-context-compaction.test.ts`、`ai-provider/tests/provider-contract.test.ts`、`tests/capability-probe.test.ts`、`research-harness/tests/research-protocol.test.ts`、`tests/orchestrator-diagnostics.test.ts`、`slides/tests/prompt-protocol-separation.test.ts`、`tests/prompt-override-migration.test.ts`、`tests/agent-cancel-research.test.ts`

修改:

- `agent-core`:loop.ts(onTextDelta、durableContext 注入 system、completion 状态、invalid 总闸、progress 透传)、types.ts(ToolProgress)、skill.ts(durableContext/onProgress)、index.ts
- `ai-provider`:protocols/openai-compatible|anthropic|gemini.ts(结构化载体 + 400 plain 降级重试)、stream.ts(jsonSchema 选项)、types.ts(AiStreamRequest.jsonSchema、AiStreamChunk.aiErrorCode)、index.ts
- `research-harness`:orchestrator/create-figure.ts(诊断/预算/信号/fallback 标记/展示降级/metrics)、index.ts 导出
- `slides`:main/ai-ipc.ts(jsonSchema 透传、aiErrorCode、版本化 overrides、capability IPC)、shared/prompt-defaults.ts(拆分 policy)、renderer/ai/slides-skill.ts(结构化管道、source-material 边界、durable state、capability 感知、进度、fallback 上报)、renderer/ai/AiPanel.tsx(runLlm signal、runStructured、getCapabilityProfile、figure 进度卡)、renderer/ai/prompt-overrides.ts(版本记录)、renderer/ai/files-skill.ts(附件 redaction)、shared/ipc.ts、preload/index.ts

## 7. 测试

- agent-core:**80 tests**(新增 structured-output 11 + compaction 2)
- ai-provider:**145 tests**(新增 provider-contract 10 + capability-probe 8)
- research-harness:**152 tests**(新增 research-protocol 9 + orchestrator-diagnostics 8)
- slides:全套(新增 3 文件 14 用例)
- 全仓 `npm run typecheck` EXIT=0

## 8. 真实/模拟模型验证

- 模拟:provider-contract/capability-probe/structured-output 全部基于真实 SSE 帧形状的 mocked fetch(与线上一致的事件序列);
- 既有集成:`create-research-figure.test.ts`(真实 pptx 引擎 + stub runLlm)继续通过;新 cancel 测试驱动真实 `createSlidesSkill` 执行器;
- 真实模型验收(本地弱网关 ISS-05 修复后)建议:配置端点 → 设置页触发 `ai:probe-capabilities` → 观察 profile 落盘 → create_research_figure 使用原生 schema/降级路径。

## 9-10. Commit / 分支

- 分支:`audit/ai-runtime-protocol`
- commit:`(本次提交,见 git log)`

## 最终验收问题(§29)

| 问题                                          | 答案 | 证据                                                                                                                   |
| --------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| semantic/composition 走结构化 schema?         | 是   | requestStructured 管道(slides-skill.ts create_research_figure)                                                         |
| schema single-source?                         | 是   | figurePlanJsonSchema/spatialPlanJsonSchema 从 RELATION_TYPES 等常量生成,parser 消费同一词表(research-protocol.test.ts) |
| override 无法删除 machine protocol?           | 是   | compose 函数始终附加生成协议;prompt-protocol-separation.test.ts 破坏性 override 用例                                   |
| unsupported capability 不出现在模型 schema?   | 是   | junction 被 runtime-capabilities 排除 + orchestrator downgrade 兜底                                                    |
| 弱模型 capability-based fallback?             | 是   | probe → allowModelComposition:false / A0 / bounded repair(capability-probe.test.ts)                                    |
| parse failure 有 typed diagnostics?           | 是   | MODEL_COMPOSITION_{PARSE,SCHEMA,TIMEOUT,PROVIDER,CANCELLED}_FAILED 等八类                                              |
| cancel 传到内部 LLM/tool?                     | 是   | agent-cancel-research.test.ts:abort 后 ≤5s 内返回且不再发 LLM 调用                                                     |
| compaction 不覆盖 durable Figure state?       | 是   | durableContext() 注入 system(research-context-compaction.test.ts)                                                      |
| provider contract 跨三协议测试?               | 是   | provider-contract.test.ts 10 用例共享 fixture                                                                          |
| research material 是 untrusted data boundary? | 是   | `<source-material>` 包裹 + immutable 协议声明 + sanitizeAgentPayload                                                   |
