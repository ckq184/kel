# ISSUE-17 StreamEvent 只有消费者的字段：逐字段决定补生产者还是下线消费分支

| 字段          | 值                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                                                             |
| 领取人 / 分支 | claude/musing-chandrasekhar-c1aa7f                                                                                                                                                                                                                                 |
| 优先级        | P3                                                                                                                                                                                                                                                                 |
| 类型          | 掉线逻辑决策与落地                                                                                                                                                                                                                                                 |
| 依赖          | 无（ISSUE-16 已删除两端皆无的 `taskPatch`/`outputFile`/`isBackground`）                                                                                                                                                                                            |
| 阻塞          | 无                                                                                                                                                                                                                                                                 |
| 预计改动路径  | `shared/stream-event.ts` 及三份同步副本、`src/web.ts`（快照 `updateSnapshotTask`）、`src/stream-card-feeder.ts`、`src/turn-output-coordinator.ts`、`src/index.ts`、`web/src/stores/chat.ts`、`web/src/components/chat/ToolActivityCard.tsx`，以及相应的 `tests/**` |
| 需用户决策    | **是**：逐字段拍板                                                                                                                                                                                                                                                 |
| 来源          | ISSUE-16 D5 全字段扫描（2026-11-23，base `1f64693`）；用户拍板“本 issue 不动，另开 issue”                                                                                                                                                                          |

## 背景

ISSUE-16 D5 对 `shared/stream-event.ts` 的 `StreamEvent` 每个字段做了生产/消费扫描（生产方只有 runner `container/agent-runner/src/runtime/pi/pi-runner.ts` 与宿主 `src/index.ts` 的 `status` 事件构造）。两端皆无的三个字段已在 ISSUE-16 删除；下列字段**有消费者、没有生产者**，按审查口径属于掉线逻辑，须逐项请用户决定，不能直接删除。

下文行号以 `1f64693` 为准，领取时按语义重新定位。

## 字段清单

| 字段                                                                                     | 消费点（示例）                                                                                                    | 现状与意图信号                                                                                                                                                      | 建议候选                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `messageUuid`                                                                            | `src/turn-output-coordinator.ts:120,131,134`                                                                      | **有意不产出**：`pi-runner.ts:139` 注释写明 Pi AssistantMessage 无 uuid，宿主回退 `implicit-N` 计数；`tests/turn-output-coordinator.test.ts` 大量专门用例。意图信号 | 保留（登记为有意设计）                |
| `usage.batchIndex` / `batchCount`                                                        | `src/index.ts:6113-6120`、`:10048-10055`（`\|\| 0` / `\|\| 1` 兜底）                                              | runner 只写 `eventId`；定义处注释说明分片语义，缺省按单批处理行为正确                                                                                               | 保留 / 删字段与兜底                   |
| `isNested`                                                                               | `src/stream-card-feeder.ts:60,64`；`web/src/stores/chat.ts:1160,1254,1349`；`ToolActivityCard.tsx:46`             | runner `parentToolUseId` 固定为 `null`，嵌套工具从未产出；R2 审查 P0-10 提及                                                                                        | 补生产者 / 连消费分支下线             |
| `elapsedSeconds`                                                                         | `web/src/stores/chat.ts:1191,1323,1350`                                                                           | `ToolActivityCard.tsx:45` 取不到时用本地计时兜底；无意图信号                                                                                                        | 补生产者 / 连消费分支下线             |
| `taskType`、`workflowName`、`subagentType`、`sdkTaskUsage`、`isTeammate`、`lastToolName` | `src/web.ts` `updateSnapshotTask`（约 `:1955` 起）、`src/stream-card-feeder.ts:135-136`、`web/src/stores/chat.ts` | Claude SDK 时代信封字段，Pi runner 不产出；`docs/审查记录.md` ISSUE-10 节称“服务历史快照展示或不在清单，未动”——快照是否持久化后重放未核实（扫描标为不确定）         | 先核实快照重放路径，再补生产者 / 下线 |

另有**只有生产者、没有消费者**的 `isSynthetic`（`src/index.ts:5509`、`:9537` 写 `true`，定义注释以 “Reserved —” 开头），一并请用户决定保留或删除。

## 注意

- 遵守 README 审查口径：掉线逻辑先拍板；意图信号默认保留；删除前 `git grep -w` 交叉核实，范围含 `tests/`、`docs/`。
- 修改共享类型后执行 `make sync-types`；StreamEvent 事件类型增删会触发 `tests/stream-event-producer-contract.test.ts`，按其提示同步。
- 下线消费分支会影响飞书/QQ 卡片与 Web 快照展示，需给出可验证的回归测试。

## 验收标准

- 清单每个字段都有用户拍板结果并按结果落地，交付记录写明逐字段选择。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

- **分支**：`claude/musing-chandrasekhar-c1aa7f`（base `023cae9`，立项 `f56bdb9`）。未合入 main、未推送，由用户决定。
- **方案文档**：`docs/issue17-stream-event-consumer-only-fields-plan.md`（含按语义重新定位的证据表与决策表）。
- **核实结论**：快照 `streamingSnapshots` 是进程内 `Map`，只在 WebSocket 重连时推送，不落库，历史数据不依赖下列字段；pi-subagents 0.22.0 的生命周期广播带 `type`（完成/失败时另有 `toolUses/durationMs/tokens`），子代理内部工具调用不广播。
- **用户逐字段拍板（2026-11-23，全部按推荐）与落地**：

| 字段                       | 最终选择                                                                                            | 提交      |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `messageUuid`              | 保留并登记为有意设计（Pi 消息无 uuid，宿主回退 `implicit-N`），代码不动；防回潮契约锁定其仍在信封上 | `0efc58d` |
| `subagentType`             | runner 补生产者：`subagent` → `task_progress` 取广播 `details.type`                                 | `2783697` |
| `isSynthetic`              | 删除字段与 `src/index.ts` 两处写入                                                                  | `0efc58d` |
| `usage.batchIndex/Count`   | 删除字段、两处兜底、两个 pending 暂存变量与 `mergeHeldUsage`/`HeldUsageTotals`，usage 原样入账      | `0efc58d` |
| `isNested`                 | 连消费分支下线（feeder、飞书卡片内部状态与时间线缩进、Web store、`ToolActivityCard` 缩进）          | `3a6df0d` |
| `elapsedSeconds`           | 连消费分支下线，`ToolActivityCard` 只用本地计时                                                     | `3a6df0d` |
| `sdkTaskUsage`             | 连存储下线（快照与 Web 任务状态的 `usage`）                                                         | `16e9f79` |
| `taskType`、`workflowName` | 连存储下线                                                                                          | `16e9f79` |
| `lastToolName`             | 连消费分支下线（飞书任务行、`StreamingDisplay`、“Task 进度”标签只保留不带工具名的分支）             | `16e9f79` |
| `isTeammate`               | 连消费分支下线，所有 SDK Task 统一走 stale 计时                                                     | `16e9f79` |

- **测试**：新增 `tests/stream-event-consumer-only-fields.test.ts`（防回潮契约：下线字段不得出现在信封与三侧消费文件，保留项仍在），各步先红后绿；`tests/pi-subagent-tool-contract.test.ts` 补 `subagentType` 生产断言与 Web 任务泳道行为回归；`tests/feishu-card.test.ts` 嵌套缩进用例改为断言工具行不缩进。
- **验证**：`npm run verify` 六步全绿（31.1s；第 4 步 349 文件 2843 通过、23 跳过、0 失败）；`node scripts/check-scope.mjs` 通过（20 路径全在声明内，声明未扩宽）。
- **与 issue 描述的偏差**：
  1. 预计改动路径外实际还改了 `src/feishu-streaming-card.ts`、`src/feishu-cards/sections.ts`、`web/src/components/chat/StreamingDisplay.tsx`（飞书卡片内部状态与 Web 任务卡的消费分支），均已在立项声明内。
  2. `src/turn-output-coordinator.ts` 未改动（`messageUuid` 保留）。
  3. `ToolActivityCard.tsx` 原先未按 prettier 格式化，本次修改后整文件格式化，diff 行数因此偏大，逻辑改动仅三处。
- **范围外登记**：实机验收发现子代理没有沿用自定义 Provider（Explore 写死 `anthropic/claude-haiku-4-5`、显式 `model: "sonnet"` 均落到 Anthropic 官方通道报 401），新建 ISSUE-22。
- **实机验收（用户执行，2026-11-23，通过）**：本分支 worktree 以 `npm run dev:all` 启动（全新数据目录，Host 工作区，自定义 Provider），在飞书话题中发送“用一个子代理帮我调研一下当前目录有哪些文件，并汇总”。
  - 第 2 项（飞书任务行）：生成中卡片的“🤖 子 Agent / Task”面板显示两条任务行“失败 换模型通道调研目录 general-purpose”“失败 子代理调研当前目录 Explore”，子代理类型以灰字展示，无“[工具名]”——subagentType 生产者生效、lastToolName 下线生效。
  - 第 3 项（飞书工具时间轴）：4 行（bash / Task / bash / Task）全部顶格、无缩进——isNested 下线生效。
  - 第 6 项（用量）：`usage_records` 与 `usage_events` 各 1 条（输入 20805、输出 3047 token），未翻倍、未缺失——usage 分片暂存下线后直接入账。
  - 定稿卡片只保留“思考过程”与“工具调用 N”汇总面板，任务行与工具时间轴只在生成中可见，属既有设计。
  - **未实测**：Web 侧第 1 项（任务卡子代理类型）、第 4 项（工具卡本地计时）、第 5 项（任务卡完成态与刷新恢复），由 `tests/pi-subagent-tool-contract.test.ts` 与防回潮契约覆盖。
  - 子代理“成功完成”路径未覆盖：子代理请求全部返回 `401 invalid x-api-key`（与本 issue 无关），已新建 ISSUE-22 登记；失败路径的任务行展示已验证。
