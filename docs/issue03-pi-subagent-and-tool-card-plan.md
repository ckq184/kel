# 任务立项：ISSUE-03 Pi 事件契约（二）：子代理与工具卡

> 立项日期：2026-11-20｜base：`cfae147`（main tip，含 ISSUE-02 合入）｜领取自 `docs/issues/ISSUE-03-pi-subagent-and-tool-card.md`
> 依赖核实：ISSUE-01 已完成并合入 main（`860f648`，P0-9① 实测 toolName=`Agent`）；ISSUE-02 已完成并合入 main（`cfae147`，同一映射函数已扩出 `message_boundary` 分支）。串行前置满足。

## 1. 背景

旧 Claude runner 发出 `task_start`/`task_notification`/`tool_result` 等事件并携带 `toolInputSummary`/`skillName`；Pi runner 只发少数几种事件，宿主/飞书卡/QQ 卡/Web 的子代理与工具卡显示失真。ISSUE-01 已实锤：Pi 子代理工具名实测为 `Agent`（别名表 `pi-runtime.ts:139-149` 将 Task→'Agent'、TaskOutput→'get_subagent_result'、TaskStop→'steer_subagent'），宿主（`src/index.ts:7059`）与 Web（`web/src/stores/chat.ts:2734`）只认 `toolName === 'Task'`。

## 2. 用户决策（需求采访产物，2026-11-20 拍板）

**子代理工具名在 runner 事件层归一（方案 A）**：`toStreamEvent` 反向映射 `Agent→Task`（及 `get_subagent_result→TaskOutput`、`steer_subagent→TaskStop` 对称对齐）。理由：宿主/Web 识别零改动即命中；卡片/侧栏显示产品词汇 Task 与旧 UX 一致；与 ISSUE-02 的 a1 决策同一哲学（runner 产出消费端期待的契约，宿主面最小）。代价（已接受）：事件 trace 不再显示 Pi 原生名。DB/侧栏按 `toolUseId` 记账不受此决策影响。

## 3. 技术方案（五项）

### 3.1 子代理识别（决策 A）

- `pi-runner.ts` 新增反向别名表 + 归一函数，应用于 `tool_use_start`/`tool_progress`/`tool_use_end` 三分支的 `toolName`。
- 已核实：`get_subagent_result`/`steer_subagent` 在全仓无匹配点，归一属词汇对称；唯一有消费的匹配是 `'Task'`（宿主 DB 建行 + Web `ensureSdkTask` 建虚拟标签页）。
- 宿主 `src/index.ts:7059` 与 `web/src/stores/chat.ts:2734` 零改动。

### 3.2 子代理状态 + 完成摘要落库

- Pi `task_progress`（`pi-runner.ts:214-219` 已映射 `taskStatus=lifecycle`、`taskSummary=result||error`）增加 `taskDescription`（广播 details.description，卡片任务标题不再恒为 'Task'）。
- 宿主 `feedStreamEventToCard` 的 `task_progress` 分支（`src/index.ts:729-743`，两路共用）按 `taskStatus` 映射终态：completed→`completed`、failed→`error`、其余→`running`；终态附 ✅/❌ 摘要事件。
- Web `updateTaskRuntime`（`chat.ts` task lane）同样按 `taskStatus` 映射终态（现状 `:1241` 无条件 running）。
- **完成摘要落库**（原 `task_notification` 收尾 `src/index.ts:7138-7211` 的等价实现）：group 路径 Task DB 块新增"终态 `task_progress`"分支——复用 `pickRunningTaskForNotification()` alias 回退（广播不带父 toolCallId，已取证：扩展 `buildEventData` 只含 id/type/description/result/error/status 等），`updateAgentStatus(id, status, taskSummary 截断)` + `queryTaskIds.delete` + `broadcastAgentStatus`，语义镜像 `:7190-7204`。已核实 agent conversation 路径无 Task DB 孪生块（全仓唯一 `'Task'` 匹配点在 group 路径）；卡片层两路共用 `feedStreamEventToCard` 天然同步。`:8614` 兜底清理保留为安全网。
- 并行子代理时 alias 回退可能歧义（单活跃任务回退按现有语义取当前 running 任务）——继承旧 task_notification fallback 同等局限，登记为已知限制。

### 3.3 工具结果

- Pi 已把结果放在 `tool_use_end.toolResult`（`pi-runner.ts:160-170`）；宿主 `feedStreamEventToCard` 的 `tool_use_end` 分支（`:643-649`）直接读取 `se.toolResult` push `↳ 结果` 时间线（镜像 `tool_result` 分支 `:650-663` 的格式）。runner 零改动。`tool_result` 事件分支保持原样，去留归 ISSUE-10。

### 3.4 失败标志

- `shared/stream-event.ts` 新增 `isError?: boolean` 信封字段（`tool_use_end` 携带），执行 `make sync-types` 同步三副本。字段新增不动 eventType 词汇表，ISSUE-13 生产者契约不受影响。
- runner：`toStreamEvent` 的 `tool_use_end` 透传 `event.isError`（仅 true 时设置）；`pi-session.ts:209` 已有 `isError` 来源。
- 宿主：`endTool(se.toolUseId, se.isError === true)`（`:646`）+ ✅/❌ 按 isError；遗留 `task_notification` 分支 `endTool` 参数同步修正（`:772`，分支本身归 ISSUE-10）。
- Web：`applyStreamEvent` 的 `tool_use_end`（`:1404` 一带）按 isError 显示 ✗/✓；⑤ `tool_use_end` 任务兜底（`:2849-2862`）按 isError 收敛 `error`/`completed`。
- 飞书卡（`:2171`）与 QQ 卡（`:345`）`endTool(id, isError)` 签名与错误态渲染已存在——卡片文件零改动。

### 3.5 工具参数与技能名

- runner `toStreamEvent` 的 `tool_use_start` 产出 `toolInputSummary: summarizeToolInput(event.input)`（含脱敏）与 `skillName: extractSkillName(toolName, input)`——ISSUE-08 特意保留的两个孤儿函数接回生产链路（`utils.ts:119/:160`）。
- 宿主卡片 `tool_use_start` 分支补 `updateToolSummary(toolUseId, toolInputSummary)`（旧链路由 tool_progress 喂，Pi 在 start 即有全量参数）。
- Web `tool_use_start`（`chat.ts:1367` 一带）已消费两字段渲染 `工具 X (摘要)`/`技能 X`——零改动。
- 如实登记：Pi 无名为 `Skill` 的原生工具（工具目录取证 bash/edit/...），`skillName` 生产链路接通但当前在 Pi 下休眠，与旧契约字段对齐。

### 3.6 ISSUE-13 生产者契约白名单注记同步

`tests/stream-event-producer-contract.test.ts` 四条挂 ISSUE-03 的条目（task_start/task_updated/task_notification/tool_result）本 issue 走"等价实现"路径（不新增这些事件的生产者）：注记更新为"ISSUE-03 已完成（等价实现：识别归一/终态映射/↳结果读取/落库等价），消费分支下线归 ISSUE-10"。条目保留（类型仍无生产者）。

## 4. 测试方案

新增 `tests/pi-subagent-tool-contract.test.ts`（沿用 ISSUE-02 的真实链范式：fake AgentSession 发 Pi 原生事件 → 真实 `PiRuntimeSession`/`runPiQueryAttempt`；子代理生命周期经真实 `PiSubAgentAdapter` + 假 EventBus）：

1. `tool_execution_start` 名为 `Agent` → `tool_use_start.toolName === 'Task'` 且带 `toolInputSummary`（command/path 摘要 + 秘密脱敏断言）；`get_subagent_result`/`steer_subagent` 同样归一。
2. `tool_execution_end` 带 `isError` → `tool_use_end.isError === true` 且 `toolResult` 透传；无 isError 不设键。
3. 子代理生命周期广播（created→started→completed/failed）→ `task_progress` 的 `taskStatus`/`taskDescription`/`taskSummary` 映射。
4. 宿主 `feedStreamEventToCard`（stub session 断言）：`tool_use_end` → `endTool(id, true)` + ❌ 标签 + `↳ 结果` 时间线；`task_progress` 终态 → `updateTask` completed/error + ✅/❌ 事件；`tool_use_start` → `updateToolSummary`。 harness 参照既有卡片测试（tests/channel-card-finalization.test.ts 等，实现期按其范式搭）。
5. Web `updateTaskRuntime` 终态映射与 `tool_use_end` 兜底 isError——按既有前端 store 测试范式（实现期定位 harness；若无现成范式则以最小 set 断言）。
6. 完成摘要落库块：镜像 `:7190-7204` 既有未测代码路径，无现成 processGroupMessages 集成 harness——如实登记为"代码审查 + 实机验收覆盖"（与旧 task_notification 落库块同等待遇，不虚称机测覆盖）。

## 5. 验证

- 机审：`npm run verify`（六步，含 sync-types 后的三侧 typecheck）+ `node scripts/check-scope.mjs`。
- 实机（用户侧，issue 验收标准）：子代理完成/失败显示、失败工具不显 ✅、卡片 ↳ 结果、Web 工具卡参数摘要、子代理会话出现在侧栏。

## 6. 范围与约束（`.gatescope.json`）

allow：`container/agent-runner/src/runtime/pi/pi-runner.ts`、`shared/stream-event.ts`、`src/stream-event.types.ts`、`web/src/stream-event.types.ts`、`container/agent-runner/src/stream-event.types.ts`（后三者为 sync-types 产物）、`src/index.ts`、`web/src/stores/chat.ts`、`tests/pi-subagent-tool-contract.test.ts`（新）、`tests/stream-event-producer-contract.test.ts`（白名单注记）、`docs/issue03-pi-subagent-and-tool-card-plan.md`、`docs/issues/ISSUE-03-pi-subagent-and-tool-card.md`、`docs/issues/README.md`。

非目标：hook/todo 等无对应概念消费端的清理（ISSUE-10）；`tool_result`/`task_start` 等事件分支的删除（ISSUE-10）；流式盖章/消息边界（ISSUE-02 已完成）；DB schema 零改动；卡片文件（`feishu-streaming-card.ts`/`qq-streaming-card.ts`）零改动（宿主传参即生效）。

## 7. 风险

- **归一层误导 trace**：事件名不再等于 Pi 原生名——决策 A 已明示接受；反向别名表与 `pi-runtime.ts` 正向表同文件族维护，防漂移。
- **并行子代理 alias 歧义**：广播无父 toolCallId（已取证扩展源码），沿用与旧 fallback 同等局限，登记已知限制；单活跃任务为主流场景。
- **两路同步**：卡片层共用 `feedStreamEventToCard` 天然同步；DB 落库块仅在 group 路径存在（已核实唯一匹配点）。
- **共享类型变更**：仅增字段不动词汇表，三副本经 `make sync-types`，verify 第 3 步三侧 typecheck 兜底。
