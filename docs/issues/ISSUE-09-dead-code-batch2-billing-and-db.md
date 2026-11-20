# ISSUE-09 死代码批 2：billing 残留与 DB 死表死列迁移

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                    |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                         |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                        |
| 类型          | 删除死代码，并做一次数据库迁移（**本任务池中风险最高的一项**）                                                                                                                                                                                                                                                                                                                            |
| 依赖          | ISSUE-07 第 2 项：只有 `registered_groups` 的三个列要等它的结论，其余项可以先做                                                                                                                                                                                                                                                                                                           |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                                                                                                        |
| 预计改动路径  | `src/runtime-config.ts`、`src/db.ts`、`src/types.ts`、`src/schemas.ts`、`src/routes/usage.ts`、`src/routes/auth.ts`、`src/routes/channel-accounts.ts`、`src/usage-service.ts`、`src/memory-store.ts`、`src/channel-reliability-store.ts`、`web/src/stores/usage.ts`、`web/src/stores/auth.ts`、`tests/db-upgrade-safety.test.ts`、`tests/routes-usage.test.ts`，以及其他相应的 `tests/**` |
| 需用户决策    | 部分：清单中标注“需确认”的项                                                                                                                                                                                                                                                                                                                                                              |
| 来源          | 审查报告 §6.2、§6.3                                                                                                                                                                                                                                                                                                                                                                       |

## 删除清单

**一、billing 残留（代码层面）**

- `src/runtime-config.ts`：5 个系统设置 `billingEnabled`、`billingMode`、`billingMinStartBalanceUsd`、`billingCurrency`、`billingCurrencyRate`，以及它们的 `BILLING_*` 环境变量回退。代码位于 `:3065-3110`、`:3211-3220`、`:3297`、`:3363-3366`
- `src/db.ts`：
  - `:12844` 的 `getUserGroupCount`
  - `:12628` 的 `safeParseJsonArray`
  - `:71` 处对 `UserBalance` 的无用 import
  - `:12626`、`:12834-12846` 的空段落注释
- `src/types.ts:1055-1116` 的 7 个类型：`UserBalance`、`BalanceTransactionType`、`BalanceTransactionSource`、`BalanceReferenceType`、`RedeemCodeType`、`BillingAuditEventType`、`DailyUsage`
- `src/schemas.ts:888-922` 的 `BillingPlanCreateSchema`
- `/api/usage/stats` 中的 billing 字段：`totalMessages`、`totalActiveDays`、`billedCostUSD`，以及 breakdown 里的 `cost_usd`、`billed_cost_usd`（`src/routes/usage.ts:104-115`；`src/db.ts:3557`、`:3642`）。`tests/routes-usage.test.ts:126` 仍在断言 `totalMessages`，要一并修改
- 前端 `web/src/stores/usage.ts:16-22`、`:42-44` 的旧别名。注释说是为“older callers”保留的，但仓库里已经没有这样的调用方

**二、DB 死表与死列（需要新增一个 migration）**

| 表或列                                                                 | 现状                                                                                                                       | 是否需确认                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `usage_daily_summary` 整表                                             | 每次记录 usage 都会写入（`src/db.ts:1097`、`:163-177`、`:3483`），只有迁移时读过                                           | 否                        |
| `usage_records.cost_usd`                                               | 值与 `provider_estimated_cost_usd` 相同，只在 v51 回填时读过                                                               | 否                        |
| `registered_groups.selected_skills`、`mcp_mode`、`selected_mcps`       | 永远写入常量，行解析器也不映射这三列                                                                                       | 等 ISSUE-07 第 2 项的结论 |
| `channel_accounts.default_agent_profile_id`                            | 输出时已被剥离（`src/routes/channel-accounts.ts:167`）；`tests/routes-channel-accounts.test.ts:162-171` 断言这个字段被忽略 | 否                        |
| `users.ai_name`、`ai_avatar_emoji`、`ai_avatar_color`、`ai_avatar_url` | `PUT /api/auth/profile` 和 `/avatar` 仍然可以写入，但没有任何地方读取；聊天头像读的是 appearance.json                      | 否，但要同时移除写入路径  |
| `workspace_memory_provenance.recorded_at`                              | 只在 INSERT 时写入，所有 JOIN 都不取这一列                                                                                 | 否                        |
| `turn_runs.heartbeat_at`、`correlation_id`                             | 只写不读，可能作诊断用                                                                                                     | **需确认**                |
| `usage_events.billed_cost_usd`、`usage_records.billed_cost_usd`        | 意图信号，注释说明“镜像估算值”；records 侧这一列会进入 CSV 导出                                                            | **需确认**                |

## 迁移要求（CLAUDE.md §10“修改数据库”）

- 新增一个 migration，并升级 `CURRENT_SCHEMA_VERSION`。
- 补迁移测试，并在**同一个提交**里更新 `tests/db-upgrade-safety.test.ts` 的 head pin（v70、v71 都曾漏改过，有前车之鉴）。
- 迁移要经过现有的备份门禁 `enforcePreMigrationBackup`；必须同时具备前向升级能力和拒绝降级的保护。
- 参考 64d6d7b 的 v76 做法，以及 `docs/dead-code-sqlite-prune-plan.md`。
- 删除列之前，先删掉所有写入这些列的代码路径。

## 验收标准

- `npm run verify` 和 check-scope 都通过。
- 拿一份真实库的副本做演练：v76 库能原地升级到新版本，并生成了 migration-backups；只读对账确认死表、死列已经消失，存量数据完好。
- 冒烟测试：`/api/health` 和 `/api/usage/stats` 正常，用量页面渲染正常。

## 风险

- `SELECT *` 共有 115 处，可能掩盖死列的漏判。只删除清单中已确认的列。

## 交付记录

（领取后填写）
