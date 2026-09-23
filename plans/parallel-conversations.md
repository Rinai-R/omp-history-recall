# 多会话并行索引 — 执行计划

## 目标
`index-all` 多个会话**真正并行**：读文件/内容分析/主题初选/修复子代理取证全部并发，只在 publish（落库）时串行加锁归类。

**用户决策（2026-09-23）：单会话内部取消并发，改为串行**——`DEFAULT_INDEX_CONCURRENCY` 已设为 1（commit 后生效），分析分块、初选分页、修复原文读取逐个执行；并行度全部投入到多会话维度。多会话并行时单会话内部保持串行，避免两层并发叠加导致请求风暴。

## 核心改动（按依赖顺序）

### 1. protocol 去除执行期 revision 绑定（src/repair.ts）
- 现状：`revision()` 在每次工具调用时断言 `snapshot.revision` 未变（`repairCards(this.snapshot.revision)` 等多处）。多会话并行 publish 后，其余 child 的下一次工具调用立即 `topic_state_changed`。这是上次并行化尝试 14 个会话中 9 个失败的根因。
- 改法：工具阶段改为**乐观读取**——memberPage/audit/repairCards 等每次读取用当前 revision（keyset 分页本身保证单次读取一致性），不再断言等于捕获值。删除/降级 `revision()`、`assertRevision` 调用点（保留取消、scope、活动会话等真正致命检查）。
- publish 前最后一次 host 侧 source guard 新鲜核验保留（那是对文件的检查，与 DB revision 无关）。

### 2. assertRepairPlan 改为"当前状态验证"（src/topic-registry.ts）
- 现状：`assertRepairPlan(..., expectedRevision)` 在 `readAt(expectedRevision)` 内，严格等于捕获 revision，重放 coverage digest。
- 改法：publish 事务内（`db.immediate()`）针对**当前 revision** 验证：
  - 引用有效性：updates/merge 的 topicId 仍存在且无 active 成员；moves 的 facet 仍归属 fromTopicRef 且 sourceHash 匹配；draft 引用不冲突。
  - coverage：用当前成员集合重算每个 target 的成员数与 digest（`startCoverageDigest`/`extendCoverageDigest` 纯函数直接复用，receipts 来自 protocol 已核验的原文）。
  - 若并行 sibling 改动了同一主题导致成员集合变化 → digest 不匹配 → `topic_state_changed` 失败保留队列（正确行为，下次重试）。
  - 若 sibling 只是新增了别的主题/成员，本 proposal 前提仍成立 → 验证通过正常发布。
- `memberPage` 同理：增加一个 `verifyAtCurrentRevision` 用法或在 assert 内直接走当前状态查询；`readAt(expectedRevision)` 保留给单会话路径。

### 3. store.work 并行化（src/store.ts）
- 现结构（已验证的全队列版本）：claim 全部 → 串行 for 循环逐个 prepare+publish。
- 改法：claim 全部 → `mapConcurrent(claimedJobs, concurrency, pipeline)`，每个 job 独立 heartbeat lease。pipeline 内：读文件 → analysis（缓存绑定 fingerprint，天然安全并行）→ selectTopics（读各自开始时的 catalog，选择只决定 proposal 内容不影响安全性）→ protocol.prepare → repair child（多个 child 进程天然并行）→ **publish 经一个进程内 async mutex 串行**（SQLite 单写者本身串行，mutex 减少无效冲突重试）。
- publish 冲突（revision 变了且结构前提不成立）：不重试整个 pipeline，直接记 `topic_state_changed` 保留队列。大部分冲突属于"sibling 新增不相关主题"，assert 在当前状态下仍会通过。
- IndexResult 聚合、进度事件（`totals` 对象）、错误收集全部线程安全化（JS 单线程，只需注意 await 点交错）。

### 4. 进度面板多会话展示（src/progress.ts）
- 现在显示单个当前文件。并行后改为：`并行 N · 已提交 X · 队列 Y`，当前文件列表最多显示 3 个 + "+K"。
- `WorkProgress` 增加 `active` 字段（当前并行数），或 progress 聚合多文件阶段。

## 测试
- 新增：两/多会话并发索引（gated 模型控制时序），断言全部提交、成员归属正确、事件与 revision 连续。
- 新增：并行中一个会话 repair 改动主题 A 结构，另一个会话 proposal 依赖同一主题 → 后者 `topic_state_changed` 保留，其余成功。
- 保留全部现有 197 项契约测试（CAS/证据/取消语义不变）。
- 现有 `topic_state_changed` 竞争测试（store.test.ts:799）语义不变：那是外部 competitor 改 revision 的场景。

## 关键文件锚点
- `src/repair.ts`：`revision()` 私有方法及全部调用点（`healthy`、`members`、`coverage`、`deferredTopicIds`、`propose`、工具 execute 包装）。
- `src/topic-registry.ts`：`assertRepairPlan`、`readAt`、`memberPage`、`repairCards`。
- `src/store.ts`：`work()` 的 for 循环 → mapConcurrent；`publish` 已是 immediate 事务。
- `test/store.test.ts`：并发回归；`test/progress.test.ts`：多文件展示。

## 已验证基线
commit `006cdb6`：197 项测试全绿，全队列处理、无调用上限、并发默认 32、进度面板自动收起。SDK settlement 补丁正常。多会话并行在此基线上叠加。

## 风险
- protocol 工具阶段的乐观读取必须保持"单次读取一致性"（keyset 分页内 revision 固定），否则 coverage 会漏成员。memberPage 单次调用已在 readAt 事务内，逐次调用跟随当前 revision 是安全的。
- publish mutex 内不得 await 子代理或文件 I/O（只做事务），否则退化串行。
- hr_jobs 的 lease 心跳已是每 job 独立 interval，无需改。
