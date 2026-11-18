# 任务立项：把子代理生命周期接回界面的 Task 契约

> 立项日期：2026-11-18｜base：`df3b174`｜状态：已获用户批准（核查报告后确认"立项修复"，三项设计取舍均按推荐项）
> 前序：`docs/pi-tool-event-format-plan.md`（其"不做"一节把子代理语义另案，即本任务）。

## 1. 背景与取证

pi 迁移后，子代理由 `@tintinweb/pi-subagents` 扩展提供（工具名 `Agent`），其生命周期经事件总线发出；runner 把它们全部映射成 `task_progress`。宿主、Web、飞书却仍按旧 Claude SDK 的 Task 契约读取：

| 界面行为                                  | 触发条件（代码位置）                                                                                  | pi 现状                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 宿主写入 `agents` 表（`kind='task'`）     | `task_start`，或 `tool_use_start` 且 `toolName==='Task'`（`src/index.ts` 流事件处理）                 | 都不发（工具名是 `Agent`）                            |
| Web 建子任务标签页、完成提醒、自动关闭    | 同上；收尾只认 `task_notification`、`task_updated`（`web/src/stores/chat.ts`）                        | 都不发；`task_progress` 对不存在的任务是空操作        |
| 飞书卡片的"子 Agent / Task"区与工具时间线 | `task_start` 启动、`task_notification` 收尾（`src/index.ts` 的 `case 'task_*'`）                      | 无启动、无收尾；只剩 `task_progress`                  |
| 状态                                      | 消费 `task_progress` 的地方一律写成 `running`（飞书 `updateTask`、`web.ts` 重连快照 `task.status`）   | 生命周期里的 `completed`、`failed` 也被写成运行中     |
| 标题与类型                                | `taskDescription`、`subagentType`                                                                     | 未填（描述只在 `rawEvent` 里），飞书标题退化为 `Task` |
| 后台完成提醒                              | `task_notification.isBackground === true` 时 Web 弹 toast 和浏览器通知（`chat.ts` 的 `isBackground`） | 不带该标记                                            |

补充事实（读 pi-subagents 源码，未运行）：

- 生命周期事件载荷为 `{ id, type, description, result, error, status, … }`，`id` 是 pi-subagents 的 agent id，与 pi 的 `Agent` 工具调用 id（toolCallId）不是同一个值，事件里不带 toolCallId。
- `subagents:created` 只对后台子代理发出，且携带 `isBackground: true`，发出时机在启动完成之后，可能晚于 `started`。`started` 对所有顶层子代理发出（含前台）。
- 前台子代理也会触发完成回调（源码注释"Foreground agents fire `onComplete` for lifecycle symmetry"），因此 `completed` / `failed` 对前台同样会发。
- `failed` 通道覆盖 `error`、`stopped`、`aborted` 三种终态。
- 嵌套子代理和工作流子节点不发这些事件（`isTopLevelAgent` 过滤）。
- `rawEvent` 在整个仓库只有 runner 这一处生产者、没有任何消费者；其载荷里含完整 `result` 文本，未截断未脱敏（与上一任务修掉的工具结果同类问题）。
- 旧 Claude runner 的契约（`64d6d7b^` 的 `stream-processor.ts`）：`task_start` 带 `agentScope:'task'`、`taskId`、`toolUseId`、`taskDescription`、`taskType`；`task_notification` 带 `agentScope:'task'`、`taskId`、`toolUseId`、`taskStatus`、`taskSummary`、`summary`，后台完成再带 `isBackground:true`。

## 2. 已确认裁决（用户逐项选定）

1. **关联方式**：用 pi-subagents 的 agent id 作任务 id（`taskId` 与 `toolUseId` 同取 agent id）。`Agent` 工具卡保持普通工具、不改名，与任务面板完全解耦，不依赖事件先后顺序。
2. **事件映射**：
   - `created`、`started` → `task_start`（同一个 agent id 只发一次）。
   - `completed` → `task_notification`，`taskStatus='completed'`。
   - `failed` → `task_notification`，`taskStatus='failed'`（含 stopped、aborted，界面一律显示为失败）。
   - `steered`、`compacted` 保持 `task_progress`，只带摘要，不改状态。
3. **后台提醒**：runner 在 `created` 里记下 `isBackground` 的 agent id，完成时给对应的 `task_notification` 打上 `isBackground:true`，恢复后台完成的 toast 与浏览器通知。

## 3. 方案

新增 `runtime/pi/pi-subagent-events.ts`，由 `pi-runner.ts` 在 `toStreamEvent` 的 `subagent` 分支调用，界面与宿主**不改**：

- 每次 `runPiQueryAttempt` 持有一个按会话的小状态：已启动的 agent id 集合、后台 agent id 集合。
- `task_start`：`agentScope='task'`、`displayLevel='primary'`、`taskId=toolUseId=agentId`、`taskDescription`（取 `details.description`，截 200）、`subagentType`（`details.type`）、`taskType='subagent'`。
- `task_notification`：`agentScope='task'`、`displayLevel='primary'`、`taskId=toolUseId=agentId`、`taskStatus`、`taskSummary` 与 `summary`；摘要经 `summarizeToolResult` 截断并脱敏（完成取 `result`，失败优先取 `error`）；后台子代理加 `isBackground:true`。收到后从状态里移除该 id，之后若同 id 重新启动（resume）会再发一次 `task_start`。
- `task_progress`（steered、compacted）：仅对已启动且未结束的 id 发出，带固定的短摘要；未知或已结束的 id 丢弃。
- 缺少 agent id 的事件无法关联，丢弃。
- 不再下发 `rawEvent`（无消费者，且含未脱敏的完整结果）。
- `RuntimeEvent` 契约与 `pi-subagents.ts` 适配器**不改**；描述、类型与后台标记从 `details` 里按字段取（缺失即忽略）。

## 4. 不做（范围外）

- 不映射 `Agent` 工具名、不为 `Agent` 工具卡补关联。
- 不下发子代理内部的工具调用与思考（pi-subagents 的子会话事件不经父会话订阅，另案）。
- 不发 `task_updated`、`workflowRun`、`sdkTaskUsage`、`outputFile` 等旧 SDK 专有字段。
- 不改宿主、前端、`shared/stream-event.ts`、`pi-subagents.ts`、`types.ts`。
- 不处理 runner 会话在子代理完成前被销毁的情况（沿用宿主与 Web 现有的超时与过期清理）。

## 5. 实施步骤（立项 1 提交 + 实现 1 提交）

| 步骤 | 内容                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`df3b174`）                                                                                                                                 |
| 1    | **Red**：新增 `tests/pi-subagent-events.test.ts`，经 `runPiQueryAttempt` 驱动假会话，覆盖启动、去重、完成、失败、后台标记、进度、未知 id、缺 id、脱敏截断、不带 `rawEvent`；先确认失败 |
| 2    | **Green**：新增 `pi-subagent-events.ts`，改 `pi-runner.ts` 的 `subagent` 分支与状态传递                                                                                                |
| 3    | `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过 + `fix:` 提交（不 push）                                                                                               |

## 6. 风险清单

| #   | 风险                                                                | 缓解                                                                                           |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | pi 下首次产生 `kind='task'` 的 `agents` 记录，此前从未出现过        | 宿主写入逻辑沿用 SDK 时代的既有代码，无 Schema 变化；记录创建与收尾按同一 id，不会残留 running |
| 2   | `created` 与 `started` 先后不定，重复创建面板                       | runner 按 agent id 去重，测试覆盖两种顺序                                                      |
| 3   | 事件载荷字段未被类型约束（`details: unknown`）                      | 字段缺失一律忽略；缺 id 的事件丢弃；测试覆盖                                                   |
| 4   | 前台子代理的完成事件仅由读源码确认，未实跑                          | 测试按契约驱动；任务面板另有宿主与 Web 的过期清理兜底                                          |
| 5   | `Agent` 工具卡与任务面板并存，界面出现两处                          | 与旧 SDK 一致（Task 工具卡 + 面板）；两者 id 不同，互不覆盖                                    |
| 6   | 摘要被截断到 400 字符                                               | 与工具结果策略一致；完整结果仍在主代理的 `get_subagent_result` 与会话 JSONL 里                 |
| 7   | 移除 `rawEvent`                                                     | 全仓无消费者（已 grep 核实）；同时去掉未脱敏的完整结果下发                                     |
| 8   | 状态按单次 `runPiQueryAttempt` 持有，子代理跨尝试存活时丢失后台标记 | 与会话生命周期一致；跨尝试时监听本身已随会话结束，沿用现有兜底                                 |

## 7. 验证方式

1. 新测试先红后绿。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 数据流复核：`task_start`、`task_notification` 在 pi runner 里重新有生产者；宿主 `agents` 记录创建与收尾使用同一 id。
4. 仍需真实界面目视确认（Web 子任务标签页、飞书任务区、后台 toast），不由本任务的测试覆盖。
