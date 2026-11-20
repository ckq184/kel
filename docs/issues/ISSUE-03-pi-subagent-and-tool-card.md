# ISSUE-03 Pi 事件契约（二）：子代理与工具卡

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成（实机验收项待用户执行，见交付记录）                                                                                                                                                                                                                                                                                                                                                     |
| 领取人 / 分支 | issue-03-pi-subagent-and-tool-card（ZCode 会话，2026-11-20 领取）                                                                                                                                                                                                                                                                                                                              |
| 优先级        | P0                                                                                                                                                                                                                                                                                                                                                                                             |
| 类型          | 缺陷修复（掉线逻辑）                                                                                                                                                                                                                                                                                                                                                                           |
| 依赖          | ISSUE-01（已完成并合入 main 860f648，P0-9① 实测 toolName=Agent）、ISSUE-02（已完成并合入 main cfae147，同一映射函数已扩出 message_boundary）                                                                                                                                                                                                                                                   |
| 阻塞          | ISSUE-10、ISSUE-12                                                                                                                                                                                                                                                                                                                                                                             |
| 预计改动路径  | `container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`container/agent-runner/src/utils.ts`、`src/index.ts`（约 628-860 行的流事件处理，以及 7093-7215 行的子代理处理）、`src/feishu-streaming-card.ts`、`src/qq-streaming-card.ts`、`web/src/stores/chat.ts`、相应的 `tests/**` |
| 需用户决策    | 已决策（2026-11-20）：子代理工具名在 **runner 事件层归一**（`Agent→Task` 及对称别名，宿主/Web 识别零改动），理由与备选对比见 `docs/issue03-pi-subagent-and-tool-card-plan.md` §2                                                                                                                                                                                                               |
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

- **提交**：立项 `a678b0a`（领取登记 + 计划与范围声明落档，base=`cfae147`）、实现 `9103481`（本收尾提交前）。
- **方案**：用户决策 A——`pi-runner.ts` 反向别名表把 `Agent/get_subagent_result/steer_subagent` 归一为 `Task/TaskOutput/TaskStop`（唯一 seam，宿主 `index.ts` 与 Web `chat.ts` 的 `'Task'` 识别零改动经 diff 实证）；五项全落地：识别、终态（宿主卡片/Web 两处 taskStatus 映射 + group 路径终态落库等价分支）、`tool_use_end` 读 `toolResult` push ↳ 结果、`isError` 三侧透传（shared 信封新字段 + sync-types 三副本 + 宿主 ❌/✅ 与 endTool + Web ✗/✓ 与 ⑤ 兜底）、`toolInputSummary`/`skillName` 接回 `summarizeToolInput`/`extractSkillName` 生产链。
- **结构性小步（ISSUE-12 方向预演，范围声明留痕）**：`feedStreamEventToCard` 自 `src/index.ts` 原位抽取为 `src/stream-card-feeder.ts`（index.ts 顶层 `main()` 使函数不可机测），index 原位 import+re-export、两处调用点保留；除 ISSUE-03 四处声明修改点外逐字一致（独立审查 diff 对照确认）；`internal-context-audit-visibility` 锚点测试随之指向新模块。
- **验证**：`npm run verify` 六步全绿（338 文件 / 2693 用例，含新增 `tests/pi-subagent-tool-contract.test.ts` 15 用例：runner 真实链归一/摘要/isError/skillName/子代理广播经真实 `PiSubAgentAdapter` 映射、宿主卡片 prototype-stub 断言、Web 真实 store 断言）；`node scripts/check-scope.mjs` 通过（15 路径全在声明内，扩宽 3 路径均已声明留痕）。
- **独立规格审查**：**通过、零阻塞**。非阻塞 5 条登记：①task_progress 的 🔄 推送随终态逻辑移入 controller 守卫——审查证实该分支在唯一生产者下为死代码（Pi task_progress 不设 `summary` 字段）且行为中性，留痕防未来新运行时设置 summary 时 QQ 行为漂移；②memory_recall 分支一处注释措辞改动（零行为）；③plan 声明的脱敏断言未进新测试——脱敏由既有 `tests/agent-runner-utils-redact.test.ts` 覆盖，无生产缺口；④测试 12 标题含 isError fallback 但该点实际由测试 13 覆盖（纯命名）；⑤落库等价块较旧块两处良性出入（broadcast 摘要加兜底文案、alias 回退省略 debug 日志）。
- **如实登记（机测不可达）**：终态 `task_progress` 落库块无现成 `processGroupMessages` 集成 harness，按 plan §4 与旧 `task_notification` 落库块同等待遇，由代码审查 + 实机验收覆盖；并行子代理的 alias 回退歧义为已知限制（广播无父 toolCallId，与旧 fallback 同等局限）。
- **下游登记**：ISSUE-10 接手 `tool_result`/`task_start`/`task_updated`/`task_notification` 消费分支下线（生产者契约白名单注记已更新为"等价实现路径、归 ISSUE-10"）；`skillName` 生产链已接通但 Pi 无名为 `Skill` 的工具故当前休眠（与旧契约字段对齐，复用 `extractSkillName` 待未来 Skill 名工具出现即生效）。
- **待用户实机验收**（issue 验收标准）：子代理完成/失败在 Web 与飞书显示终态、失败工具不显 ✅、卡片 ↳ 结果时间线、Web 工具卡参数摘要、子代理会话出现在侧栏。
