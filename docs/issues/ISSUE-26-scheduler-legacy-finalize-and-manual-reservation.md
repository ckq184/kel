# ISSUE-26 调度器旧收尾残留：finalizeRecurringRun 恒早退与 pendingManualTaskIds 无写入方

| 字段          | 值                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                   |
| 领取人 / 分支 | —                                                                                                                        |
| 优先级        | P3                                                                                                                       |
| 类型          | 死代码（可能涉及 `src/db.ts` 访问器）                                                                                    |
| 依赖          | ISSUE-25（`durableRun` 已改必填）                                                                                        |
| 阻塞          | 无                                                                                                                       |
| 预计改动路径  | `src/task-scheduler.ts`、`src/db.ts`、`tests/task-restart-recovery.test.ts`、`tests/task-continuation-scheduler.test.ts` |
| 需用户决策    | **是**：`updateTaskAfterRun`、`pauseTaskAfterRun` 有专门测试和设计注释，属意图信号；删除范围需用户确认                   |
| 来源          | ISSUE-25 需求采访中的范围外发现，用户 2026-11-24 拍板“登记为新 issue”                                                    |

## 现状（以 ISSUE-25 交付提交 `a4fb4a0` 为准）

- `finalizeRecurringRun`（`src/task-scheduler.ts:788`）在 `preserveDefinitionCursor` 为真或任务在 `activeDurableTaskIds` 中时直接返回（`:796`）。ISSUE-25 之后三个 runner 只能带 `durableRun` 进入，`preserveDefinitionCursor` 恒为 `!!durableRun === true`，因此其后的 `updateTaskAfterRun` / `pauseTaskAfterRun` 在生产中永远不执行；V2 在物化 occurrence 时自行推进定义游标（`materializeDueOccurrences`）。
- 7 处调用点（`:889`、`:952`、`:1396`、`:1586`、`:1619`、`:1738`、`:1995`）连同它们前面的 `safeComputeNextRun` 计算都成了无效功。
- `updateTaskAfterRun`、`pauseTaskAfterRun`（`src/db.ts`）因此没有生效的生产调用方，只有 `tests/task-restart-recovery.test.ts`、`tests/task-continuation-scheduler.test.ts`（用来模拟“运行后收尾”）在用；`src/task-scheduler.ts` 中多处日志文案与注释（如 `:898`、`:1092`、`:1383`、continuation 清扫注释）以及 `src/db.ts` 一处注释仍以它为前提描述行为，需一并核实。
- `pendingManualTaskIds`（`:618`）从未被 `add`，只被 `isTaskReserved`、`getRunningTaskIds` 读取和 `startSchedulerLoop` 清空。

## 建议范围（待用户拍板）

1. 先核实 V2 下“周期任务无法计算下次时间时暂停而不是标记完成”这一设计意图（`finalizeRecurringRun` 注释）是否已由 `materializeDueOccurrences` 的 `Invalid schedule` 分支覆盖；若有缺口属于掉线逻辑，先请用户决定。
2. 视拍板：删除 `finalizeRecurringRun` 与各调用点的 `safeComputeNextRun` 计算，或保留并补注释。
3. 视拍板：删除 `updateTaskAfterRun`、`pauseTaskAfterRun` 并改写依赖它们的测试夹具与注释。
4. 删除 `pendingManualTaskIds` 及其读取点。
5. 删除前用 `git grep -w` 交叉核实，范围含 `tests/`、`docs/`。

## 交付记录

（领取后填写）
