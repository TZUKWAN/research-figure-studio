# Persistence Transaction Design + ProjectStore 一致性报告

实现:`packages/project-store/src/store.ts`(commit 6a2a515)。测试:`tests/persistence-integrity.test.ts`。

## 1. 写分类原则(替代"write failures warn silently, never throw")

| 类别                  | 操作                                                                                                    | 失败语义                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Best-effort 遥测/历史 | appendChatMessage、flushPending                                                                         | **typed result**(`{ok:false,error}`)+ console.warn;不抛、不阻塞对话流                                                               |
| 用户可见状态变更      | createProject / renameProject / deleteProject / moveFileToProject / fileRenamed / resolveProjectForFile | **事务**:全提交或全回滚,失败抛 `ProjectStoreError{code: io\|not-found\|invalid}` → IPC reject → UI 报错;**绝不再"warn 后返回成功"** |
| 可恢复的伴生数据      | chat JSONL 跨项目移动(moveFileToProject 第 4 步)                                                        | 元数据事务提交**之后** best-effort;失败仅留旧位置文件(下一次移动重试),映射不损坏                                                    |

## 2. 多文件事务(commitTransaction)

```
writes = [{path, data}, ...]
Phase 0  snapshot:记录每项目标是否存在 + 原始全文
Phase 1  stage:逐个写 <path>.tx.tmp(任一序列化失败 → 清理已 stage,中止,零副作用)
Phase 2  rename:逐个 tmp → target(记录已换入集合)
Phase 3  任一 rename 失败 → 已换入者从快照恢复(原不存在则删除)+ 清理残余 tmp
         → throw ProjectStoreError('io')
```

单文件写仍走 `writeJson`(tmp+rename);`<path>.tx.tmp` 残留会被后续事务同名覆盖,不积累。

覆盖操作对:resolveProjectForFile(index+default project.json)、fileRenamed(index+project.json)、createProject(project.json+index)、renameProject、deleteProject(index+default project.json)、moveFileToProject(index+from+target 三个文件)。

## 3. Chat JSONL 恢复(DESKTOP-P0-08)

- `scanChatFile`:全量容忍解析,返回 `{records, maxSeq, corrupted}`;**缺 seq 的合法记录在内存中补序**,不再静默丢弃。
- `loadChat` 首次遇损坏行:`copyFileSync` 备份为 `<chat>.jsonl.corrupt-<ts>.bak`(每会话一次),计数缓存。
- `chatRecoveryStats(projectId, chatId)` 公开 `{corruptedLines, backupPath?}` — UI 可提示"恢复 N 条,M 行损坏,备份于 X"。
- 坏行不再导致全文件打不开(tolerant load 既有,保留)。

## 4. seq 与消息身份(DESKTOP-P0-07/09)

- `nextSeq` 初始化改为**全文件扫描** max seq(原实现读"最近 10k 条"窗口:超过 10k 的 chat 重启后续号从窗口内 max+1 开始,与旧记录冲突)。
- `renameOrMergeChat` merge 改为双侧全量扫描:target.maxSeq+1 起对 source 全部记录重编 seq 后 append,然后 unlink source。**append-先、unlink-后**:崩溃最坏=重复段(下次 merge 幂等重建),绝不丢历史。
- 每条新消息获得 `id: randomUUID()`;seq 降级为显示排序提示。存量无 id 记录兼容读取。
- 多实例:userData 级 single-instance lock 已有;并发 async append 在同一 main 进程内串行(sync fs),无交叉写。

## 5. 崩溃一致性修复(DESKTOP-P0-06)

`repairConsistency()`(幂等,返回修复日志):

1. index.projects 中项目目录已空/缺失 → 删除条目;目录在但 project.json 缺(崩溃中态)→ 保留观察。
2. 孤儿项目目录(有 project.json、不在 index)→ 重新注册。
3. fileMap 指向已死项目 → 重指 default。

调用点:`listProjectsSummary()`(首页项目列表 UI 入口)。修复不可达的场景:事务已覆盖元数据三件套;chat 文件与元数据之间不保证原子(设计取:元数据一致 > 聊天文件位置精确)。

## 6. ProjectStore 一致性报告(现状评估)

| 场景                       | 治理前                                                          | 治理后                                                                |
| -------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| moveFileToProject 中途失败 | index 先写,from/target project.json 后写 → 文件可同时挂两个项目 | 事务三文件全或无(测试:project.json 变目录致 rename 失败 → index 回滚) |
| deleteProject trash 失败   | 仅 warn,index 照删 → 项目目录成孤儿、UI 消失                    | 抛 ProjectStoreError,条目保留(测试覆盖)                               |
| >10k chat merge            | 丢窗口外全部历史                                                | 全量保留(测试:10_400+9_800=20_200 条)                                 |
| 重启后 append              | seq 冲突风险                                                    | 全扫描续号(测试:10_050 条后续 10_051)                                 |
| JSONL 部分损坏             | 静默跳行,无痕迹                                                 | 计数+备份+可查(测试覆盖)                                              |
| index 与项目目录漂移       | 永不修复                                                        | listProjectsSummary 前自动 repair(测试覆盖)                           |

## 7. 遗留

- **P1-04 异步化**:scanChatFile/事务仍为 sync fs。单文件 ≤ 数 MB、写盘微秒级,主进程可感卡顿风险低;大 chat(>10MB)场景建议迁移 `fs/promises` + `readline` 流式(独立批次,保持事务语义)。
- `loadChat(limit≤0)` 语义保持原样(slice(-0) 返回全部)。
- deleteProject 的"先 trash 后元数据":元数据提交失败时项目已入 .trash 但 index 仍在 → 下次启动 repair 判定"目录在但无 project.json"保留条目,UI 显示但打开为空;后续可加 .trash 反向恢复入口。
