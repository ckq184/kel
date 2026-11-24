# 任务立项：ISSUE-25 旧调度租约簇退役

> 立项日期：2026-11-24｜base：`e520f6c`（本地 main tip，ISSUE-23 合并提交）｜分支：`claude/zealous-noyce-f62ae0`
> 来源：`docs/issues/ISSUE-25-legacy-scheduler-lease-retirement.md`

## 0. 需求采访结论（2026-11-24）

- **目标**：删除 V2 调度下不生效的旧定义级租约簇（入口、租约函数、非 durable 守卫、`claimTaskForRun` 与 `running_until`/`runner_id` 两列）。
- **完成条件**：上述代码和列删除；依赖它的测试改走 V2 入口，覆盖的不变量不减；保留行为（missed 推进、一次性任务补跑、手动运行、script 任务）有回归测试；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：改数据库须新增 migration、升级 `CURRENT_SCHEMA_VERSION`、补迁移测试，并在同一提交更新 `tests/db-upgrade-safety.test.ts` 的 head pin；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 项                             | 复核结论                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| isolated 路径                  | `runTask` 生产唯一调用点在 V2 `src/task-scheduler.ts:2912`，带 `durableRun: claim`；另一调用点是 `enqueueIsolatedScheduledTask`（`:952`）                                                                                                                        |
| script 路径                    | `runScriptTask` 不导出，唯一调用点 `:2757`，传 `claim`                                                                                                                                                                                                           |
| group 路径                     | `runGroupModeTask` 不导出，唯一调用点 `:2805`，传 `claim`                                                                                                                                                                                                        |
| 手动运行                       | `triggerTaskNow`（`:3478`）建 `trigger_type='manual'` 的 `task_runs` 行后走同一 V2 claim；`manualRun` 由 `claim.trigger_type === 'manual'` 派生，不存在非 durable 的手动运行                                                                                     |
| `enqueueIsolatedScheduledTask` | `git grep -w`：`src/` 无调用方；仅 `tests/routes-tasks-contract.test.ts`（2 处）、`tests/task-scheduler-contract.test.ts`（5 处）                                                                                                                                |
| `claimScheduledRun`            | 只在三个 runner 的 `!durableRun` 分支调用；script/group 分支连测试都进不去                                                                                                                                                                                       |
| `claimTaskForRun`              | 调用方：`claimScheduledRun`、`tests/task-restart-recovery.test.ts:94`、`tests/task-scheduler-contract.test.ts:2752`                                                                                                                                              |
| `running_until`/`runner_id`    | 只由 `claimTaskForRun` 写入；`src/db.ts` 另 4 处（`:1992`、`:2459`、`:2476`、`:8865`）只清空；建表 `src/db-schema/core-tables.ts:64-65`、补列 `src/db-schema/task-tables.ts:54-55`、类型 `src/types.ts:508-509`；`tests/schema-v54-task-runs.test.ts` 为历史夹具 |
| docs                           | 仅 `docs/issues/`、`docs/dead-code-review-r2.md` 与 issue16/21 立项文档的历史记载，不需改                                                                                                                                                                        |

## 2. 用户决策（2026-11-24，全部按推荐）

| 问题       | 决策                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 函数层     | **全删并改写测试**：删 `enqueueIsolatedScheduledTask`、`claimScheduledRun`、`getTaskLeaseMs` 与三个 runner 的 `!durableRun` 守卫；`durableRun` 改必填                   |
| DB 层      | **删函数并迁移删列**：删 `claimTaskForRun` 及其专门用例；新 migration DROP 两列，清理建表、补列、清空 SQL 与类型字段                                                    |
| 范围外发现 | **登记为新 issue（ISSUE-26）**：`finalizeRecurringRun` 在全 durable 下恒早退、其内 `updateTaskAfterRun`/`pauseTaskAfterRun` 生产不生效；`pendingManualTaskIds` 从未 add |
| 测试改写   | **删 claim-loss 子场景，其余改走 V2**                                                                                                                                   |

## 3. 方案

1. **回归锚点（先行）**：新增 `tests/issue25-scheduler-retained-behavior.test.ts`，经 `startSchedulerLoop` 断言：离线期间到期的周期任务落 `missed`/`backfill` 并推进 `next_run`；离线期间到期的一次性任务以 `backfill` 物化、不记 `missed`。手动运行与 script 任务沿用 `tests/task-scheduler-contract.test.ts` 已有 V2 用例（`paused tasks can still be run manually once`、`manual trigger reserves…`、script 系列）。
2. **测试改写**：
   - `routes-tasks-contract`：“排队中的定时运行阻止 PATCH、drop 后释放”改由 `triggerTaskNow` 入队（V2 `task_runs` 计入 `getRunningTaskIds`）。
   - `task-scheduler-contract`：“一个预留、一个固定 JID”改由 `triggerTaskNow`；“enqueue 拒绝、抛错时释放预留”改由 `triggerTaskNow`，删 claim-loss 子场景。
3. **函数层删除**：`src/task-scheduler.ts` 删上述函数与守卫，`RunTaskOptions.durableRun` 与 `runScriptTask`/`runGroupModeTask` 的 `durableRun` 参数改必填；`pendingScheduledTaskIds` 若随之无写入方一并删除（仅属本簇）。
4. **DB 迁移**：`src/db.ts` 删 `claimTaskForRun` 与 4 处清空子句；新增 v78 migration `ALTER TABLE scheduled_tasks DROP COLUMN`（列存在才删）；删建表与 `ensureColumn` 中两列；`src/types.ts` 删字段；升级 `CURRENT_SCHEMA_VERSION`，同提交更新 `tests/db-upgrade-safety.test.ts` head pin，补迁移测试；删 `tests/task-restart-recovery.test.ts` 的 `claimTaskForRun` 用例。
5. **登记 ISSUE-26**，同步 README 索引。

## 4. 非目标

- 不动 `finalizeRecurringRun`、`updateTaskAfterRun`、`pauseTaskAfterRun`、`safeComputeNextRun` 的现有逻辑（登记 ISSUE-26）。
- 不改 V2 调度行为、`task_runs` 表结构与路由接口。
- 不做实机验收。

## 5. 回滚点

`.gatescope.json` 的 `base`：`e520f6c`。
