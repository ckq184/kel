# ISSUE-17 StreamEvent 只有消费者的字段：逐字段决定补生产者还是下线消费分支

| 字段          | 值                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                                                             |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                  |
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

（领取后填写）
