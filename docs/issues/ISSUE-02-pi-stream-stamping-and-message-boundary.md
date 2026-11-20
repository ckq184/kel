# ISSUE-02 Pi 事件契约（一）：流式盖章与消息边界

| 字段          | 值                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                                                                               |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                    |
| 优先级        | P0                                                                                                                                                                                                                                                                                   |
| 类型          | 缺陷修复（掉线逻辑：消费端在，生产端随旧 runner 删除）                                                                                                                                                                                                                               |
| 依赖          | ISSUE-01（P0-1、P0-2 的结论）                                                                                                                                                                                                                                                        |
| 阻塞          | ISSUE-03（同一个事件映射函数，需串行）、ISSUE-10、ISSUE-12                                                                                                                                                                                                                           |
| 预计改动路径  | `container/agent-runner/src/pi-index.ts`、`container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`src/turn-output-coordinator.ts`；视方案可能涉及 `shared/stream-event.ts` 及三份同步副本、`src/web.ts`；以及相应的 `tests/**` |
| 需用户决策    | 部分：消息边界采用方案 (a) 还是 (b)，见下文                                                                                                                                                                                                                                          |
| 来源          | 审查报告 §3 P0-1、P0-2；§4.1                                                                                                                                                                                                                                                         |

## 背景

64d6d7b 删除旧 Claude runner 的同时，也删除了给流事件补 `turnId` 的 `decorateStreamEvent`，以及产出 `raw_sdk_event` 的 stream-processor。但下游的 run 栅栏和 `TurnOutputCoordinator` 仍然依赖这两样东西。

## 证据

**P0-1：流式事件缺少 turnId，被栅栏丢弃**

- `container/agent-runner/src/runtime/pi/pi-runner.ts:114` 的 `toStreamEvent` 不给事件加 `turnId`/`queryRunId`，只有 interrupted 状态（`:478-484`）例外。
- 宿主在 `src/index.ts:6904` 原样调用 `broadcastStreamEvent(chatJid, result.streamEvent)`，没有补这两个字段。
- 每次 query 开始，`src/web.ts:2774` 都会执行 `streamRunFence.start(jid, runId)`。
- `src/run-stream-fence.ts:45-48`：run 进行中、事件又没有 `turnId` 时，返回 `accepted:false`。`tests/run-stream-fence.test.ts:61` 锁定了这个 fail-closed 行为。

**P0-2：消息边界事件不存在，飞书卡片正文回滚**

- `src/turn-output-coordinator.ts:108-149` 依靠 `raw_sdk_event` 的 `message_start`/`message_stop` 切分消息，但 runner 中没有任何地方产出 `raw_sdk_event`。
- 没有 `message_stop` 时，第一次顶层 `tool_use_start` 会把唯一的隐式消息标记为 `hasTopLevelTool=true`。此后 `visibleAnswerText`（`:184-189`）一直返回空的 `answerCandidate`。
- 宿主在 `src/index.ts:6887-6898` 用这个结果覆盖 `streamingAccumulatedText`，所以卡片正文会被清空。

## 要做的事

1. **流式盖章**：给 Pi 产出的每个流事件补上两个字段：
   - `turnId`：取当前输入 turn，即 `pi-index.ts` 中的 `activeInputTurnId`；
   - `queryRunId`：取 `input.queryRunId`，它会随 IPC 消息在 `pi-index.ts:236` 更新。
     建议在 `pi-index.ts` 的 emit 包装处（约 `:370`）统一加，不要逐个事件构造。
2. **消息边界**：在以下两个方案中选一个，并在立项文档里写明理由（必要时请用户决定）：
   - (a) runner 在每条 Pi assistant 消息开始和结束时，发出与旧契约等价的边界事件。可以复用 `raw_sdk_event` 的 `message_start`/`message_stop`，也可以在 `shared/stream-event.ts` 新增一个明确的事件类型，然后执行 `make sync-types`；
   - (b) 改造 `TurnOutputCoordinator`，让它在没有边界事件时，也能正确区分“工具调用前的叙述”和“最终回答”。
3. **补测试**：用 Pi 实际产出的事件序列（不要用 `raw_sdk_event` 夹具）覆盖以下场景：
   - run 进行期间，Web 能收到流事件；
   - 工具调用之后，飞书卡片正文继续续写；
   - 中断时，`interrupt_partial` 不为空；
   - 已被替换的旧 run 发来的迟到事件仍然被拒绝。必须保留 fail-closed 语义，不能为了放行事件而放宽栅栏。

## 非目标

- 子代理和工具卡的修复属于 ISSUE-03。
- 不删除 `raw_sdk_event`、hook 等消费端。哪些保留、哪些删除，由 ISSUE-10 根据本 issue 的方案决定。

## 验收标准

- `npm run verify` 和 `node scripts/check-scope.mjs` 都通过。
- 实机验证：Web 在运行期间能看到实时流，重连后快照完整；飞书卡片在工具调用后继续续写。
- 用 ISSUE-01 的确认方法复测，P0-1 和 P0-2 都不再出现。

## 风险

- run 栅栏是防止新旧 run（A 被 B 替换时）互相串台的安全机制。盖章必须保证迟到的旧事件仍然带着旧的 `queryRunId`。
- `TurnOutputCoordinator` 在 `processGroupMessages` 和 `processAgentConversation` 里各被调用一次（`src/index.ts:6887` 一带和 `:14862` 一带），两处要同步验证。

## 交付记录

（领取后填写）
