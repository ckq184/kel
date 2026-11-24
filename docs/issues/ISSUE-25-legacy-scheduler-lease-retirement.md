# ISSUE-25 旧调度租约簇退役：enqueueIsolatedScheduledTask、claimScheduledRun 与 running_until/runner_id 列

| 字段          | 值                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 进行中                                                                                                                                                                                     |
| 领取人 / 分支 | claude/zealous-noyce-f62ae0                                                                                                                                                                |
| 优先级        | P3                                                                                                                                                                                         |
| 类型          | 死代码与 DB 死列（需迁移）                                                                                                                                                                 |
| 依赖          | 无                                                                                                                                                                                         |
| 阻塞          | 无                                                                                                                                                                                         |
| 预计改动路径  | `src/task-scheduler.ts`、`src/db.ts`、`src/db-schema/*`、`src/types.ts`、`tests/task-scheduler-contract.test.ts`、`tests/routes-tasks-contract.test.ts`、`tests/db-upgrade-safety.test.ts` |
| 需用户决策    | **是**：属于“有专门测试”的意图信号，删除范围（只删函数层，还是连 DB 列一起迁移）需用户确认                                                                                                 |
| 来源          | ISSUE-21 B2（原登记于 ISSUE-16 交付记录），用户 2026-11-23 拍板“拆成独立 issue”                                                                                                            |

## 现状（以 `638d0c7` 为准）

- 生产的 3 条调度路径（isolated、script、group，`src/task-scheduler.ts` V2 durable 执行入口）全部带 `durableRun`，`runTask`/`runScriptTask`/`runGroupModeTask` 里的非 durable 分支只能从测试进入。
- `claimScheduledRun`（`src/task-scheduler.ts:869`）→ `db.claimTaskForRun`（`src/db.ts:2425`）只能经 `enqueueIsolatedScheduledTask`（`:920`）进入，后者在 `src/` 没有调用方，只有 `tests/routes-tasks-contract.test.ts`、`tests/task-scheduler-contract.test.ts` 在用。
- `scheduled_tasks.running_until`、`runner_id` 两列只由 `claimTaskForRun` 写入，其余位置只做清空。
- 已被 durable `task_runs` 取代，无功能缺口（见 `docs/dead-code-review-r2.md` “旧调度租约簇”行）。

## 建议范围

1. 删除 `enqueueIsolatedScheduledTask`、`claimScheduledRun` 与三处非 durable 分支；改写两个测试文件中依赖它的用例，保持对 V2 路径的覆盖不减。
2. 视用户拍板：删除 `claimTaskForRun` 与两列（新 migration、升级 `CURRENT_SCHEMA_VERSION`、同提交更新 `tests/db-upgrade-safety.test.ts` 的 head pin）。
3. 删除前用 `git grep -w` 交叉核实，范围含 `tests/`、`docs/`。

## 交付记录

（领取后填写）
