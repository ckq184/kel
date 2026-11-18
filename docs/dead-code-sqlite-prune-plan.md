# 任务立项：死代码与 SQLite 死表治理

> 立项日期：2026-11-18｜base：`1d9c899`｜状态：已获用户批准
> 前序：plugins 裁剪（plugin-prune-plan.md）之后的全仓死代码与 DB 死表治理。

## 1. 背景结论（两轮只读探查）

1. **SQLite 没有膨胀，无需 VACUUM**：库 917KB、freelist=0、WAL 24 帧全部已提交，VACUUM 收益≈0。治理手段 = better-sqlite3 v76 迁移步 + 既有 `enforcePreMigrationBackup` 备份门禁 + `sqlite-snapshot.mjs`。
2. **臃肿清单**：~95 处后端确定死导出（billing/redeem/usage 裁剪残留整族）、~8000 行旧 Claude runner 集群、6 张零行死表 + 4 张 billing 残留表（5 行历史数据）+ 4 个死列 + ~220 行永久休眠迁移代码、前端 8 个死导出与 4 个 store 死字段、`proxy-agent` 死依赖。

## 2. 探索误报修正（不按误报执行）

- `ClaudeProviderSection` 是「模型配置」Tab 唯一内容、Provider 管理唯一挂载点，调活的 `/api/config/claude/*`——**保留**，仅删其 2 个死类型。
- `image-detector.ts` 被 pi 链 `mcp-tools.ts:899` 动态 import——移出旧 runner 删除清单。

## 3. 已确认裁决（用户选定）

1. DB 完整治理：v76 DROP 死表死列 + 删休眠迁移代码（走既有备份门禁）。
2. 旧 Claude runner 集群一并删除（git 历史可找回；tsconfig 仅编译 pi-index.ts）。
3. 疑似死项：删 `scripts/cleanup-heartbeat.ts`、`tests/e2e/interrupt-ipc-message-loss.mjs`；ClaudeProviderSection 项因误报修正撤销。

## 4. 实施步骤（立项 1 提交 + 实现 1 提交）

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + .gatescope.json，base=1d9c899）                                                                                                                                                                                                                                                                  |
| 1    | 旧 runner 集群删除：`container/agent-runner/src/index.ts`、`runtime/claude/`、`runtime-mcp-policy.ts`、死 barrel `runtime/index.ts`、18 个仅旧链路附件（image-detector 除外）+ 测试 agent-runner-runtime-policy / stream-processor；tsc 闭合校验；runtime-migration.md 裁决改写                                     |
| 2    | 后端死代码：db.ts 52 函数（redeem 13/billing 12/usage 12/历史消息任务 IM 9/运维 6）、runtime-config 15+1、schemas 12、types 2、零散 13+routes 内部 2；index.ts 7 个 export 关键字收敛                                                                                                                               |
| 3    | 前端：8 个死导出、usage store 4 个死字段（billedCostUSD/billed_cost_usd/totalActiveDays/totalMessages）；`npm uninstall proxy-agent`                                                                                                                                                                                |
| 4    | DB v76：DROP 10 表（6 零行死表 + 4 billing 残留）+ 4 死列（auto_memory_recall/subscription_plan_id/task_id/cost_usd，cost_usd 先删写入路径）；CURRENT_SCHEMA_VERSION 75→76；备份门禁区间同步；删 v23–v28 休眠段与 balance_transactions 双份兜底；核实 sessions/workspace_runtime_sessions 与 token_usage 两个存疑项 |
| 5    | 疑似死文件：cleanup-heartbeat.ts、e2e mjs、CSS safe-area-bottom（grep 确认后删）                                                                                                                                                                                                                                    |
| 6    | 测试同步（db-upgrade-safety 版本断言等）+ 文档 + verify + check-scope + `refactor:` 提交（不 push）                                                                                                                                                                                                                 |

## 5. 风险清单

| #   | 风险                                | 缓解                                                                     |
| --- | ----------------------------------- | ------------------------------------------------------------------------ |
| 1   | v76 迁移破坏现有库（最高风险）      | 既有备份门禁（失败拒绝迁移）+ 降级拒绝；迁移前后只读对账；真实库副本演练 |
| 2   | SELECT \*（115 处）掩蔽死列漏判     | 只 DROP 确认清单；存疑列（token_usage 等）走核实项                       |
| 3   | 动态 import 陷阱误伤 pi 链          | tsc 闭合校验，报错回捞；image-detector 已移出                            |
| 4   | db.ts 大批删除连带 stmts()/类型断裂 | 每删一族即 typecheck；警惕同名近似符号                                   |
| 5   | usage 页面渲染破坏                  | 仅删零消费字段，UsagePage/UsageTrendChart 消费的全保留                   |
| 6   | verify 边缘预算用例轮换翻红         | 已知现象，冷却复测再定性                                                 |

## 6. 验证方式

1. `npm run verify` 六步全绿；`check-scope` 通过
2. DB 冒烟：v75 库原地升 v76、migration-backups 生成、`/api/auth/status` 200
3. 只读对账：v76 后 sqlite_master 无死表、死列消失、存量行数据完好
4. 全仓 grep：billing/redeem 死符号与旧 runner 文件零残留
