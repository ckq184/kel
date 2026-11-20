# ISSUE-02 Pi 事件契约（一）：流式盖章与消息边界

| 字段          | 值                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成（实机复测项待用户验收，见交付记录）                                                                                                                                                                                                                                           |
| 领取人 / 分支 | issue-02-pi-stream-stamping-and-message-boundary（ZCode 会话，2026-11-20 领取）                                                                                                                                                                                                      |
| 优先级        | P0                                                                                                                                                                                                                                                                                   |
| 类型          | 缺陷修复（掉线逻辑：消费端在，生产端随旧 runner 删除）                                                                                                                                                                                                                               |
| 依赖          | ISSUE-01（已完成：分支 issue-01-p0-runtime-confirmation 提交 0a35a47，P0-1/P0-2 均成立，未合入 main；本 issue 范围无需缩改）                                                                                                                                                         |
| 阻塞          | ISSUE-03（同一个事件映射函数，需串行）、ISSUE-10、ISSUE-12                                                                                                                                                                                                                           |
| 预计改动路径  | `container/agent-runner/src/pi-index.ts`、`container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`src/turn-output-coordinator.ts`；视方案可能涉及 `shared/stream-event.ts` 及三份同步副本、`src/web.ts`；以及相应的 `tests/**` |
| 需用户决策    | 已决策（2026-11-20）：消息边界采用方案 **(a1) 复用 raw_sdk_event**（与旧契约逐字段等价，宿主零改动），理由与备选方案对比见 `docs/issue02-pi-stream-stamping-and-message-boundary-plan.md` §2                                                                                         |
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

- **提交**：立项 `6f58824`（领取登记 + 计划与范围声明落档，base=`4e9dd61`）、实现 `ea49a9c`（本收尾提交前）。
- **方案**：消息边界按用户决策 (a1)——runner 复活与旧 stream-processor 逐字段等价的 `raw_sdk_event` 边界事件，宿主零改动；流式盖章在 `pi-index.ts` emit 包装处经新增 `stream-stamp.ts` 统一补 `turnId`/`queryRunId`（`??` 语义，interrupted 事件自带身份不覆盖）。
- **验证**：`npm run verify` 六步全绿（320 测试文件 / 2602 用例通过，含新增 `tests/pi-stream-stamping-and-boundary.test.ts` 12 用例）；`node scripts/check-scope.mjs` 通过（10 路径全在声明内）。12 用例全部以 Pi 原生事件序列驱动真实映射链（fake AgentSession → 真实 `PiRuntimeSession` → 真实 `runPiQueryAttempt`），覆盖 issue 要求的四场景：run 进行期盖章事件全过栅栏（observeExact）、工具调用后宿主协调器 `visibleAnswerText` 恢复续写、中断时投影非空（interrupt_partial 前提）、旧 run 迟到事件被拒且 fail-closed 未放宽；另锁定 pi-index 接线源码契约与非 assistant 角色不产边界。
- **独立规格审查**（实现会话之外的代理执行）：**通过、零阻塞**。非阻塞建议 4 条已登记：①场景③为"投影非空 + 中断事件身份"两测合成，无单测在中断时刻联合断言（宿主读链 `index.ts:6859-6861→7022-7036` 使合成成立）；②场景①止步于栅栏 dispatch 表达式（栅栏是唯一丢弃点，WS 全链由实机验收兜底）；③interrupted 事件 warm 场景 turnId 语义为既有例外（`containerInput.turnId` ≠ `activeInputTurnId`），ISSUE-03/10 清理时留意；④测试夹具 `as never` 豁免不随 Pi SDK 事件面升级自动报警。
- **偏差（相对 issue 描述）**：①改动路径比"预计改动路径"窄——`src/turn-output-coordinator.ts`、`shared/stream-event.ts` 及三副本、`src/web.ts` 均零改动（方案 a1 宿主零改动使然，plan §4 已声明为非目标）；②边界事件 `messageUuid` 不设——Pi `AssistantMessage` 无 uuid/id 字段，宿主协调器本就有 `implicit-N` 回退（旧契约 uuid 缺失时同样走该回退），plan §3.2 已声明；③ISSUE-01 结论以引用方式采纳（其分支 `issue-01-p0-runtime-confirmation` 提交 `0a35a47` 未合入 main）。
- **下游登记**：`raw_sdk_event` 的 `message_start/stop` 切片因本方案存活——ISSUE-10 清理消费端时保留该分支；ISSUE-03 需在同一事件映射函数上串行开工（本 issue 已把 `mapPiEvent`/`toStreamEvent` 扩出 `message_boundary` 分支）。
- **待用户实机验收**（issue 验收标准的实机部分，需运行中服务与已绑定飞书群）：Web 运行期实时流、重连后快照完整、飞书卡片工具调用后继续续写、按 ISSUE-01 确认方法复测 P0-1/P0-2 不再出现。机制级与事件级行为已由上述 12 用例真实链锁定。
