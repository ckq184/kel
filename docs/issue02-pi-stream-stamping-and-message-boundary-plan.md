# 任务立项：ISSUE-02 Pi 事件契约（一）：流式盖章与消息边界

> 立项日期：2026-11-20｜base：`4e9dd61`（main tip）｜领取自 `docs/issues/ISSUE-02-pi-stream-stamping-and-message-boundary.md`
> 依赖核实：ISSUE-01 已完成（分支 `issue-01-p0-runtime-confirmation`，提交 `0a35a47`，尚未合入 main）——四项诊断全部成立，P0-1/P0-2 实锤，本 issue 范围无需缩改。本计划直接引用其结论与脱敏证据。

## 1. 背景

64d6d7b 删除旧 Claude runner 时，一并删除了给流事件统一补 `turnId`/`queryRunId` 的 `decorateStreamEvent` 与产出 `raw_sdk_event` 边界事件的 stream-processor，但宿主侧消费链未动：

- **P0-1**：Pi runner 的 `toStreamEvent`（`pi-runner.ts:113-245`）所有分支均不产 `turnId`/`queryRunId`（唯一例外是 interrupted 状态事件 `:478-484`）。宿主原样 `broadcastStreamEvent`（`src/index.ts:6866` 一带）→ `src/web.ts:2578-2580` 走 `RunStreamFence.observe`（无 `queryRunId`）→ run 进行中且事件无 `turnId` 即 `accepted:false`（`src/run-stream-fence.ts:45-48`，fail-closed 由 `tests/run-stream-fence.test.ts:61` 锁定）。ISSUE-01 实机：219/219 流事件零盖章，全部被栅栏丢弃——Web 运行期收不到任何实时流。
- **P0-2**：宿主 `TurnOutputCoordinator`（`src/turn-output-coordinator.ts:109-116`）按 `raw_sdk_event` 的 `stream_event/message_start|stop` 切分 assistant 消息；Pi 不产该事件 → 首个顶层 `tool_use_start` 置 `hasTopLevelTool=true` 后 `activeMessage` 永不提交，`visibleAnswerText`（`:184-189`）恒为空 → 飞书卡片正文在工具调用后被清空、不再续写（`src/index.ts:6859-6861/6919-6924` 覆写 `streamingAccumulatedText`）。

两处消费端（`processGroupMessages` `src/index.ts:6853-6866` 与 `processAgentConversation` `:14831-14839`）共用同一 reducer 与广播路径，修复需对两处同时生效。

## 2. 用户决策（需求采访产物，2026-11-20 拍板）

**消息边界采用方案 (a1)：runner 复用 `raw_sdk_event` 边界事件，与旧契约逐字段等价。**

理由：

- **宿主零改动**：`TurnOutputCoordinator`、中断持久化（`src/index.ts:6873-6876` 注释锁定的 "provisional until message_stop" 语义）、Web 快照/trace 全部按原设计恢复工作；既有 4 个协调器边界测试（`tests/turn-output-coordinator.test.ts:10-141`）直接适用于真实 Pi 链路。
- **掉线逻辑口径的"补生产者"分支**：消费端完好、设计动机明确（issue 明示该协调器语义为刻意设计），按用户定下的审查口径优先补齐等价生产者，而非重造消费端。
- 备选对比：(a2) 新增明确事件类型——命名更诚实、为 ISSUE-10 删净 `raw_sdk_event` 铺路，但需动共享契约+三副本同步+协调器+两处调用链，diff 面与回归面显著更大；(b) 协调器无边界推断——最小 diff 但属启发式（Pi 权威 `message_start/end` 被丢弃，同消息内"工具调用之后的文本"会被误判为新消息，provisional 显示与 interrupt 持久化语义都要重推敲），且改动两处调用共用的核心 reducer。
- **下游登记**：本方案使 `raw_sdk_event` 的 `message_start/stop` 切片存活——ISSUE-10 清理消费端时保留该分支，不再整体删除。

## 3. 技术方案

### 3.1 流式盖章（P0-1）

- 新增 `container/agent-runner/src/stream-stamp.ts`：导出纯函数 `stampStreamEventIdentity(event, stamp)`——仅填补缺失字段（`??` 语义），已有值不覆盖（interrupted 事件自带的 `turnId`/`queryRunId` 保持原值），stamp 值未定义时不添加键。
- `container/agent-runner/src/pi-index.ts` `runTurn` 的 `emit` 包装处（原 `:370` 一带，issue 建议的统一盖章点）对所有 `output.streamEvent` 盖章：
  - `turnId` = `activeInputTurnId`（当前输入 turn，warm IPC 激活时由 `onTurnActivated` 更新为 `latestIpcDeliveryId`）；
  - `queryRunId` = `input.queryRunId`（冷启动由宿主 `queue.getActiveQueryId` 注入，warm 注入随 IPC 文件经 `applyTurnContext`（`:236`）更新）。
- 该包装是 runner 全部 `ContainerOutput` 的唯一出口（`emitRuntimeEvent`、`publishResult` 的 usage 事件、interrupted 状态事件、premature 终态均经 `options.emit`），一处盖章全覆盖，不逐事件构造。
- **栅栏语义不放宽**：盖章后事件带 `queryRunId` → `broadcastStreamEvent` 走 `observeExact` 精确匹配当前 run；迟到的旧 run 事件因携带旧进程自己的旧 `queryRunId` 被拒。`observe` 的 fail-closed 分支原样保留（无盖章的遗留直写路径仍被拦）。
- **下游影响核实**（盖章只填上正确值，无破坏性新增分支）：`streamEvent.turnId` 的消费方全部为 `||` 回退读法——`src/index.ts:6721/6977/7029/14888/14941/14959`、`src/web.ts:2343-2364`（快照 turn 重置/回填）、Web `chat.ts:638/2593-2597`（turn 切换与消息回填）。盖章使这些回填从"恒空/恒不匹配"恢复为按输入 turn 正确关联。
- 非目标：不补 `sessionId`（Pi 事件已自带，issue 仅要求两字段）；不改 `run-stream-fence.ts` / `web.ts` / `index.ts` / `turn-output-coordinator.ts`；interrupted 事件的既有字段语义保持不动。

### 3.2 消息边界（P0-2，方案 a1）

- `container/agent-runner/src/runtime/types.ts`：`RuntimeEvent` 新增 `message_boundary` 变体 `{ type: 'message_boundary'; sessionId: string; boundary: 'start' | 'stop' }`。
- `container/agent-runner/src/runtime/pi/pi-session.ts` `mapPiEvent`：新增 `message_start`/`message_end` 分支——仅当 `event.message.role === 'assistant'` 时映射为 `message_boundary`；user/toolResult 角色不映射（维持未识别类型静默丢弃惯例）。Pi SDK 事件面已核实：`pi-agent-core/dist/types.d.ts` 的 `AgentEvent` 原生含 `message_start`/`message_end`（每条消息各一对），主会话消息恒为顶层（`WithParentToolCallId` 仅包 `tool_execution_*`）。
- `container/agent-runner/src/runtime/pi/pi-runner.ts` `toStreamEvent`：`message_boundary` → 与旧契约逐字段等价的 `raw_sdk_event`（对照 64d6d7b 删除的 `stream-processor.ts:464-476`）：
  - `rawType: 'stream_event/message_start' | 'stream_event/message_stop'`；
  - `title: 'Assistant message started' | 'Assistant message completed'`；
  - `parentToolUseId: null`（顶层）；`agentScope: 'main'`；`displayLevel: 'debug'`；`sessionId`；
  - `messageUuid` 不设——Pi `AssistantMessage` 无 uuid/id 字段，宿主协调器回退 `implicit-N` 计数（旧契约同样存在该回退路径）。
- 宿主零改动：协调器 `:109-116` 既有分支直接命中；proactive 模式下边界事件照旧被 `shouldBroadcastSdkStreamEvent` 过滤出广播、协调器不被喂（与旧 runner 行为一致）；Web 端非 primary 的 `raw_sdk_event` 静默忽略（`chat.ts:1600-1608`）。

### 3.3 测试（新增 `tests/pi-stream-stamping-and-boundary.test.ts`）

全部用 Pi 实际产出的事件序列驱动**真实映射链**（fake AgentSession 发原生 `AgentSessionEvent` → 真实 `PiRuntimeSession` → 真实 `runPiQueryAttempt` → 收集 `ContainerOutput`），不手造 `raw_sdk_event` 夹具：

1. 盖章单测：`stampStreamEventIdentity` 补缺、保留已有值（interrupted 事件）、stamp 未定义时不加键。
2. 边界映射链：assistant `message_start/end` → 旧契约等价 `raw_sdk_event`（逐字段断言）；user/toolResult 角色的 `message_start/end` 不产任何事件。
3. **run 进行期间 Web 能收到流事件**：对收集到的每个盖章事件 `observeExact(jid, queryRunId)` 全部 accepted；同一事件不盖章则 fail-closed（引既有 `run-stream-fence.test.ts` 锁定）。
4. **迟到的旧 run 事件仍被拒**：A run 结束、B run 激活后，A 的盖章事件 `observeExact(jid, 'run-a', …)` rejected——fail-closed 语义不变。
5. **工具调用后飞书卡片正文继续续写**：真实序列（叙述 → 顶层工具 → 工具结果 → 新消息 → 收尾）喂真实 `TurnOutputCoordinator`：叙述段回滚入 `narrationSegments`、`message_stop` 提交 `answerCandidate`、新 `message_start` 重开、`visibleAnswerText` 恢复续写。
6. **中断时 interrupt_partial 不为空**：message 进行中（`message_stop` 前）`visibleAnswerText` === 已累积文本（非空）；interrupt 路径产出 interrupted 状态事件且自带两字段。
7. 源码契约（锁定 pi-index 接线，仿 `agent-runner-sdk-subagent-contract.integration.test.ts` 读源码惯例）：`pi-index.ts` 的 `emit` 包装处调用 `stampStreamEventIdentity`。

### 3.4 验证

- 机审：`npm run verify`（六步）+ `node scripts/check-scope.mjs`。
- 实机验收（用户侧，按 issue 验收标准与 ISSUE-01 确认方法复测）：Web 运行期实时流、重连后快照完整、飞书卡片工具调用后继续续写、P0-1/P0-2 不再现。实机部分需要运行中的服务与已绑定飞书群，属用户侧操作，交付记录中登记待用户复测。

## 4. 范围与约束（`.gatescope.json`）

allow：`container/agent-runner/src/runtime/types.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/stream-stamp.ts`（新增）、`container/agent-runner/src/pi-index.ts`、`tests/pi-stream-stamping-and-boundary.test.ts`（新增）、`docs/issue02-pi-stream-stamping-and-message-boundary-plan.md`（本文）、`docs/issues/ISSUE-02-pi-stream-stamping-and-message-boundary.md`、`docs/issues/README.md`。

非目标：子代理与工具卡修复（ISSUE-03）；`raw_sdk_event`/hook 等消费端去留（ISSUE-10，本方案保留 message_start/stop 切片）；`src/`、`web/`、`shared/` 零改动；DB 零改动；不删不放宽 run 栅栏。

## 5. 风险与应对

- **run 串台（栅栏安全机制）**：盖章必须保证迟到旧事件带旧 `queryRunId`。盖章点在 runner 进程内，`input.queryRunId` 来自宿主注入（冷启动 `queue.getActiveQueryId` / warm IPC 回显）——旧进程的值即旧 run，天然满足；测试 §3.3-4 显式锁定。
- **两处消费调用**：方案 a1 宿主零改动，`processGroupMessages` 与 `processAgentConversation` 自动同构修复（同一事件流、同一 reducer）。
- **warm follow-up 期间 turn 漂移**：`onTurnActivated` 更新 `activeInputTurnId`/`input.queryRunId` 后，emit 包装读调用时值，同 turn 内事件一致；跨 turn 的新值随新 IPC 回显生效，语义与 `writeOutput` 顶层 `inputTurnId` 关联一致。
- **边界事件对旧快照语义的影响**：`updateStreamingSnapshot` 对 `raw_sdk_event` 仅入 trace；盖章后同 turn 事件 `turnId` 一致不触发误重置，新 turn 触发的重置为原设计行为（"Reset on new turn"）。
