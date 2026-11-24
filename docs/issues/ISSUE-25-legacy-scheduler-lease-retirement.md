# ISSUE-25 旧调度租约簇退役：enqueueIsolatedScheduledTask、claimScheduledRun 与 running_until/runner_id 列

| 字段          | 值                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                     |
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

- **分支**：`claude/zealous-noyce-f62ae0`，base `e520f6c`；立项文档 `docs/issue25-legacy-scheduler-lease-retirement-plan.md`。
- **核实结论**：生产中 isolated、script、group 三条路径都只从 V2 执行入口调用并带 `durableRun`；手动运行由 `triggerTaskNow` 建 `trigger_type='manual'` 的 `task_runs` 行，同样走 V2 claim，不存在非 durable 的手动运行。`enqueueIsolatedScheduledTask` 只有测试调用；`runScriptTask`、`runGroupModeTask` 不导出，其非 durable 分支连测试都进不去。

| 项         | 拍板（2026-11-24，均按推荐）      | 落地                                                                                                                                                                                                             | 提交                 |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 回归锚点   | —                                 | 新增 `tests/issue25-scheduler-retained-behavior.test.ts`：离线到期的周期任务落 `missed`/`backfill` 并推进 `next_run`，一次性任务以 `backfill` 补跑；改动前即为绿                                                 | `01ccf82`            |
| 测试改写   | 删 claim-loss 子场景，其余改走 V2 | routes-tasks 的“排队阻止 PATCH、drop 后释放”与 task-scheduler-contract 的“一个预留、一个固定 JID”“enqueue 拒绝、抛错时释放预留”改由 `triggerTaskNow` 入队                                                        | `01ccf82`            |
| 函数层     | 全删并改写测试                    | 删 `enqueueIsolatedScheduledTask`、`claimScheduledRun`、`getTaskLeaseMs` 及三个 runner 入口的非 durable 守卫，`durableRun` 改必填；随之失去调用方的 `isTaskStillActive`、`pendingScheduledTaskIds` 一并删除      | `4cf974c`            |
| DB 层      | 删函数并迁移删列                  | 删 `claimTaskForRun` 及其专门用例；v77→v78 trim 在列存在时 DROP `running_until`、`runner_id`；建表、`ensureColumn`、4 处清空子句与类型字段同步删除；`CURRENT_SCHEMA_VERSION` 78，head pin 同提交更新并补升级用例 | `a4fb4a0`、`043a792` |
| 范围外发现 | 登记为新 issue                    | 新建 ISSUE-26：`finalizeRecurringRun` 在全 durable 下恒早退、`updateTaskAfterRun`/`pauseTaskAfterRun` 生产不生效；`pendingManualTaskIds` 从未 add                                                                | `71047c4`            |

- **保留行为的回归覆盖**：missed 推进与一次性补跑见上方新增锚点；手动运行见 `tests/task-scheduler-contract.test.ts` 的 `paused tasks can still be run manually once`、`manual trigger reserves…`、`manual reservation is released…`；script 任务见同文件 script 系列用例。均未改动且全绿。
- **验证**：`npm run verify` 6/6 步全绿，总耗时 28.3s，第 4 步 358 个文件、2927 条通过、23 条跳过；`node scripts/check-scope.mjs` 通过，18 个路径都在声明范围内。
- **偏差**：
  - `isTaskStillActive` 未在立项方案中点名：它只被已删的非 durable 守卫调用，V2 路径从未经过，删除不改变行为。
  - 另有两处 head 字面量（`tests/pricing-routes.test.ts`、`tests/task-continuation-scheduler.test.ts`）未随 `a4fb4a0` 更新，由 verify 第 4 步发现，在 `043a792` 补齐；`db-upgrade-safety` 的 head pin 按约定与迁移同提交。
  - 未做实机验收；合入 main、推送由用户决定。
