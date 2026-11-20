# ISSUE-03 Pi 事件契约（二）：子代理与工具卡

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                         |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                              |
| 优先级        | P0                                                                                                                                                                                                                                                                                                                                                                                             |
| 类型          | 缺陷修复（掉线逻辑）                                                                                                                                                                                                                                                                                                                                                                           |
| 依赖          | ISSUE-01（P0-9① 的实际 toolName）、ISSUE-02（同一个事件映射函数，需串行）                                                                                                                                                                                                                                                                                                                      |
| 阻塞          | ISSUE-10、ISSUE-12                                                                                                                                                                                                                                                                                                                                                                             |
| 预计改动路径  | `container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`container/agent-runner/src/utils.ts`、`src/index.ts`（约 628-860 行的流事件处理，以及 7093-7215 行的子代理处理）、`src/feishu-streaming-card.ts`、`src/qq-streaming-card.ts`、`web/src/stores/chat.ts`、相应的 `tests/**` |
| 需用户决策    | 部分：子代理工具名在哪一层归一，见第 1 项                                                                                                                                                                                                                                                                                                                                                      |
| 来源          | 审查报告 §3 P0-9、P0-10                                                                                                                                                                                                                                                                                                                                                                        |

## 背景

旧 runner 会发出 `task_start`、`task_notification`、`tool_result` 等事件，还会带上 `toolInputSummary` 和 `skillName`。宿主、飞书/QQ 卡片和 Web 都依赖这些事件和字段。Pi runner 只发出 `tool_use_start`、`tool_use_end`、`task_progress` 等少数几种事件，所以子代理和工具卡的显示是失真的。

## 证据与要做的事

1. **子代理识别**
   - 现状：Pi 的别名表把 `Task` 映射成了 `'Agent'`（`pi-runtime.ts:146`），而宿主 `src/index.ts:7093-7098` 和 Web `web/src/stores/chat.ts:2752-2754` 都只认 `toolName === 'Task'`。
   - 后果：不会创建 `kind:'task'` 的子会话。
   - 要做：在以下两种做法中选一个——宿主和 Web 同时认 Pi 的子代理工具名（以 ISSUE-01 的结论为准），或者由 runner 在事件层统一归一成 `'Task'`。
2. **子代理状态**
   - 现状：Pi 的 `task_progress` 事件带有 `taskStatus=completed/failed`（`pi-runner.ts:214-219`）。但 Web `chat.ts:1241` 无条件写入 `status='running'`，飞书 `src/index.ts:739-752` 也把状态写死为 `'running'`。
   - 要做：让两边都把它识别为终态。同时补上完成摘要落库，作为原 `task_notification` 收尾逻辑（`src/index.ts:7176-7215`）的等价实现。
3. **工具结果**
   - 现状：Pi 把结果放在 `tool_use_end.toolResult` 里（`pi-runner.ts:160-170`），宿主却只在 `tool_result` 分支里读取（`src/index.ts:660-672`）。
   - 要做：在 `tool_use_end` 上读取 `toolResult`。
4. **失败标志**
   - 现状：`RuntimeEvent.isError` 有值（`pi-session.ts:209`），但被丢弃了；卡片的 `endTool(id, false)` 把参数写死为 false（宿主 `src/index.ts:656、782`）。
   - 要做：把 `isError` 透传到 `tool_use_end`，让飞书 `feishu-streaming-card.ts:2260` 和 QQ `qq-streaming-card.ts:345` 的错误态能显示出来。
5. **工具参数与技能名**
   - 现状：`toolInputSummary` 和 `skillName` 都没有生产者。
   - 要做：runner 产出这两个字段。可以复用 `container/agent-runner/src/utils.ts:117` 的 `summarizeToolInput`（目前只有测试在调用）和 `:192` 的 `extractSkillName`（目前没有任何调用方）。ISSUE-08 已经把这两个函数排除在删除清单之外。

## 非目标

- 不清理 Pi 中没有对应概念的事件消费端（hook、todo 等），这些由 ISSUE-10 负责。
- 不处理流式盖章和消息边界，这些由 ISSUE-02 负责。

## 验收标准

- `npm run verify` 和 check-scope 都通过。
- 实机验证：
  - 子代理完成后，Web 和飞书上都显示“已完成”，失败时显示“失败”；
  - 失败的工具不再显示 ✅；
  - 卡片上能看到“↳ 结果”时间线；
  - Web 工具卡显示参数摘要（路径或命令）；
  - 如果设计上要求子代理会话出现在侧栏，确认它确实出现了。

## 注意

- 宿主中的事件处理逻辑在 `processGroupMessages` 和 `processAgentConversation` 两处各有一份，修改时两处要同步。
- 修改共享类型后执行 `make sync-types`。

## 交付记录

（领取后填写）
