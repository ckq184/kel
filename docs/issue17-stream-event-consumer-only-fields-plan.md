# 任务立项：ISSUE-17 StreamEvent 只有消费者的字段——逐字段补生产者或下线

> 立项日期：2026-11-23｜base：`023cae9`（本地 main tip，ISSUE-21 合并提交）｜分支：`claude/musing-chandrasekhar-c1aa7f`
> 来源：`docs/issues/ISSUE-17-stream-event-consumer-only-fields.md`（ISSUE-16 D5 全字段扫描）

## 0. 需求采访结论（2026-11-23）

- **目标**：`StreamEvent` 里“有消费者、没有生产者”的字段和“只有生产者、没有消费者”的 `isSynthetic` 逐项落地用户拍板，不留空转分支。
- **完成条件**：每个字段按拍板结果落地，并由测试锁定；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：修改 `shared/stream-event.ts` 后执行 `make sync-types`；删除前用 `git grep -w` 交叉核实（范围包括 `tests/`、`docs/`）；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 事实                                                                                                                                                                                                                         | 位置                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产方只有 runner `toStreamEvent` 和宿主 `status` 事件构造；`subagent` → `task_progress` 只转了 `taskId/taskStatus/taskDescription/taskSummary`                                                                              | `container/agent-runner/src/runtime/pi/pi-runner.ts:130-262`                                                                                                                                              |
| pi-subagents（0.22.0）的 `created/started/completed/failed` 广播都带 `type`（子代理类型）；完成或失败时还带 `toolUses/durationMs/tokens`；子代理内部的工具调用不会广播（“Owned children … report only through their owner”） | `node_modules/@tintinweb/pi-subagents/src/index.ts:534-640`                                                                                                                                               |
| `messageUuid` 有意不产出：注释写明 Pi 消息没有 uuid，宿主回退 `implicit-N`                                                                                                                                                   | `pi-runner.ts:139`、`src/turn-output-coordinator.ts:120,131,134,166`                                                                                                                                      |
| `usage.batchIndex/batchCount` 只在宿主两处用 `\|\|0/\|\|1` 兜底，并配合 `pendingLedgerUsageBatch`/`pendingAgentLedgerUsageBatch` + `mergeHeldUsage` 暂存合并；分片恒为 0/1，暂存后立刻发出                                   | `src/index.ts:980-1010`、`:5452`、`:6118-6132`、`:9482`、`:10053-10067`                                                                                                                                   |
| `isNested` 透传：feeder、Web store 三处、`ToolActivityCard` 缩进；飞书卡片内部 `ToolCallState.isNested` 与时间线缩进                                                                                                         | `src/stream-card-feeder.ts:60,64`、`src/feishu-streaming-card.ts:435,453,2109,2849`、`src/feishu-cards/sections.ts:393,446`、`web/src/stores/chat.ts:196,1160,1254,1349`、`ToolActivityCard.tsx:12,46,55` |
| `elapsedSeconds` 透传：Web store 三处；`ToolActivityCard` 取不到时用本地计时                                                                                                                                                 | `web/src/stores/chat.ts:194,1191,1323,1350`、`ToolActivityCard.tsx:10,45`                                                                                                                                 |
| 快照 `streamingSnapshots` 是进程内 `Map`，只在 WebSocket 重连时推送，不落库；`taskType/workflowName/usage` 在快照和 Web 任务状态里只存不展示                                                                                 | `src/web.ts:1789-1848`、`:1957-2005`、`:1200-1215`；`web/src/stores/chat.ts:132-145`、`:1089-1131`                                                                                                        |
| `subagentType` 被飞书卡片任务行与 Web `StreamingDisplay` 任务卡真正展示                                                                                                                                                      | `src/feishu-streaming-card.ts:582,2826`、`web/src/components/chat/StreamingDisplay.tsx:280`                                                                                                               |
| `lastToolName` 被飞书卡片任务行、`StreamingDisplay`、“Task 进度 [x]”标签展示                                                                                                                                                 | `src/feishu-streaming-card.ts:445,585,2194,2829`、`src/web.ts:2003,2157`、`web/src/stores/chat.ts:141,1153,1364`、`StreamingDisplay.tsx:297`                                                              |
| `isTeammate`：Web SDK Task 虚拟标签页的 `ensureSdkTask` 参数、stale 计时跳过、finalize 时保留标记                                                                                                                            | `web/src/stores/chat.ts:334,948,2441-2463,2504,2524,2569`                                                                                                                                                 |
| `isSynthetic`：宿主两处写 `true`，无任何读取方                                                                                                                                                                               | `src/index.ts:5519,9547`                                                                                                                                                                                  |

## 2. 用户决策（2026-11-23，全部按推荐）

| 字段                       | 决策                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `messageUuid`              | **保留并登记**为有意设计（Pi 无 uuid，回退 implicit-N），代码不动                                          |
| `usage.batchIndex/Count`   | **下线字段与分片暂存**：删两字段、两处兜底、两个 pending 暂存变量和 `mergeHeldUsage`，usage 直接入账       |
| `isNested`                 | **连消费分支下线**：信封字段、feeder/Web store/ToolActivityCard 透传与缩进、飞书卡片内部 `isNested` 一并删 |
| `elapsedSeconds`           | **连消费分支下线**：`ToolActivityCard` 只用本地计时                                                        |
| `subagentType`             | **runner 补生产者**：`subagent` → `task_progress` 映射取广播的 `type`                                      |
| `sdkTaskUsage`             | **连存储下线**：信封字段、快照与 Web 任务状态的 `usage` 属性                                               |
| `taskType`、`workflowName` | **连存储下线**                                                                                             |
| `lastToolName`             | **连消费分支下线**：“Task 进度”标签只保留不带工具名的分支；飞书卡片内部 `lastToolName` 一并删              |
| `isTeammate`               | **连消费分支下线**：所有 SDK Task 都走 stale 计时（与当前实际行为一致）                                    |
| `isSynthetic`              | **删除字段与两处写入**                                                                                     |

## 3. 实现方案

1. **T1 subagentType 补生产者**：`pi-runner.ts` 的 `subagent` 分支从 `details.type`（字符串且非空）取值写入 `subagentType`。先在 `tests/pi-subagent-tool-contract.test.ts` 补断言（created/completed 带 type、started 缺 type 时不写），红→绿。
2. **T2 宿主侧删除**：`isSynthetic` 两处写入；`usage` 分片暂存删除后 usage 原样入账（补测试：源码契约断言 `src/index.ts` 不再含分片字段与暂存，ledger 路径行为不变由现有测试覆盖）。
3. **T3 工具卡下线**：`isNested`、`elapsedSeconds` 从信封、feeder、飞书卡片、Web store、`ToolActivityCard` 删除；`tests/feishu-card.test.ts` 对应用例改写为不含 `isNested`。
4. **T4 任务字段下线**：`taskType/workflowName/sdkTaskUsage/lastToolName/isTeammate` 从信封、快照、feeder、飞书卡片、Web store、`StreamingDisplay` 删除。
5. 每步改 `shared/stream-event.ts` 后执行 `make sync-types`；新增 `tests/stream-event-consumer-only-fields.test.ts` 锁定：下线字段不再出现在信封与三侧源码中（防回潮），保留字段 `messageUuid` 仍在。

## 4. 任务拆分与回滚点

| 任务 | 内容                          | 验收                                            | 回滚点   |
| ---- | ----------------------------- | ----------------------------------------------- | -------- |
| T1   | subagentType 补生产者         | 广播 `type` 出现在 `task_progress.subagentType` | 立项提交 |
| T2   | isSynthetic、usage 分片下线   | 源码契约测试绿，ledger 相关测试不变             | T1 提交  |
| T3   | isNested、elapsedSeconds 下线 | 契约测试绿，飞书时间线与 Web 工具卡测试绿       | T2 提交  |
| T4   | 五个任务字段下线              | 契约测试绿，飞书任务行与 Web 任务卡测试绿       | T3 提交  |
| T5   | 门禁与交付落档                | verify 全绿、check-scope 通过、issue 已完成     | T4 提交  |

## 5. 非目标

- 不补 `isNested`、`lastToolName`、`elapsedSeconds` 的生产者（需要改上游 pi-subagents 或新增计时，已拍板下线）。
- 不新增任务用量展示 UI。
- 不改 `messageUuid` 与 turn-output-coordinator 的 implicit-N 回退。
- 不改 `parentToolUseId`（仍有 runner 生产者写 `null`，不在本 issue 清单内）。
