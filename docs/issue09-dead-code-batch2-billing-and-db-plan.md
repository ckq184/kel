# 任务立项：ISSUE-09 死代码批 2 —— billing 残留与 DB 死表死列迁移

> 立项日期：2026-11-20｜base：`5d76afb`（main tip）｜分支：`issue-09-dead-code-batch2-billing-and-db`
> 来源：`docs/issues/ISSUE-09-dead-code-batch2-billing-and-db.md`（审查报告 §6.2、§6.3）
> 前序依赖：ISSUE-07（项 2 拍板 410 已落地、项 6 代码层下线已完成）——已解除；ISSUE-08 已完成（db.ts 无未合入改动）。

## 0. 用户拍板（2026-11-20 需求采访）

| #   | 项                                                              | 决策                                                                                                                                                                              |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | `turn_runs.heartbeat_at`、`correlation_id`                      | **保留**。属渠道可靠性状态机设计词汇（claim→心跳→定稿），SQLite 人工对账可查最后心跳与触发消息关联，零改动。                                                                      |
| ②   | `usage_events.billed_cost_usd`、`usage_records.billed_cost_usd` | **彻底下线**。镜像恒等于估算值（计费订阅已删无乘数）；物理删列 + usage-service 停算 + API/CSV 字段全下线。CSV 导出少 `billedCostUSD` 一列（thesis-lite 交付记录已备案过此预期）。 |

## 1. 范围 A：billing 代码残留（纯代码层，无 DB 变更）

| 文件                                | 删除内容                                                                                                                                                                                                                                                                                              | 交叉核实结论                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime-config.ts`             | 5 个系统设置 `billingEnabled/billingMode/billingMinStartBalanceUsd/billingCurrency/billingCurrencyRate`：`SystemSettings` 类型字段、`DEFAULT_SYSTEM_SETTINGS` 默认值、解析段（含 invalidFields 分支）、`BILLING_*` 环境变量回退                                                                       | `git grep -w` 仅命中 runtime-config 自身（定义/默认/解析/回退），无外部消费                                                                                                                                                                                                                       |
| `src/db.ts`                         | `getUserGroupCount`（:12837）、`safeParseJsonArray`（:12621）、`:71` 的 `UserBalance` import、`:12626/:12834` 一带空段注释                                                                                                                                                                            | 两函数零调用方；`UserBalance` import 未使用                                                                                                                                                                                                                                                       |
| `src/types.ts`                      | `:1055-1116` 的 7 类型：`UserBalance`、`BalanceTransactionType`、`BalanceTransactionSource`、`BalanceReferenceType`、`RedeemCodeType`、`BillingAuditEventType`、`DailyUsage`                                                                                                                          | 仅定义 + db.ts 未用 import；tests 零引用                                                                                                                                                                                                                                                          |
| `src/schemas.ts`                    | `BillingPlanCreateSchema`（:897-929 含段注释）                                                                                                                                                                                                                                                        | 零消费方                                                                                                                                                                                                                                                                                          |
| `src/db.ts` + `src/routes/usage.ts` | `/api/usage/stats` billing 镜像字段：summary 的 `billedCostUSD`（db.ts `getUsageAnalytics` 类型与产出，经路由 `...data.summary` 透出）；breakdown/daily 的 `cost_usd`、`billed_cost_usd` 别名；attributions 的 `billedCostUSD`；路由层别名 `totalMessages`、`totalActiveDays`；CSV 列 `billedCostUSD` | 前端 UsagePage/store 已不消费（thesis-lite 已删 4 死字段）；`tests/routes-usage.test.ts:126` 断言 totalMessages+billedCostUSD 需同步改写                                                                                                                                                          |
| `src/usage-service.ts`              | `billedCostUSD` 镜像计算与返回字段（models[].billedCostUSD、汇总、replay 回读）                                                                                                                                                                                                                       | 恒等于 `providerEstimatedCostUSD`，注释自认「镜像估算值」                                                                                                                                                                                                                                         |
| `web/src/stores/usage.ts`           | `UsageSummary` 6 个旧别名字段（totalInputTokens…totalCostUSD，:16-22）及 `aggregateSummary` 对应产出；`UsageBreakdown.cost_usd`、`request_count`（:42-44）及 `normalizeBreakdown` 对应写入                                                                                                            | 仓库内无组件读取；**保留** legacy 响应归一化机制（`?? row.cost_usd` 回退、`RawUsageSummary/RawUsageBreakdown` legacy 键、无窗口响应的 off-by-one 修剪）及其专门测试 `frontend-usage-experience.test.ts`——按 README「意图信号默认保留」口径，该机制有设计动机注释与专门测试，不在 issue 字面清单内 |

## 2. 范围 B：DB 死表死列（v77 迁移，先删写入路径再删列）

| 表.列                                                                  | 处置                         | 写入路径下线点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage_daily_summary` 整表                                             | DROP TABLE                   | `stmts().insertUsageUpsert`（:163-178 定义 + :3481 调用）、CREATE+索引（:1096-1111）、v55→v56 `ensureColumn(total_reasoning_tokens)`（:2137 一带）、v51 回填块内的 `INSERT OR REPLACE INTO usage_daily_summary`（:1721 一带；表已被本任务删除，回填死数据一并移除，usage_records 部分保留）                                                                                                                                                                                                                                                                          |
| `usage_records.cost_usd`                                               | DROP COLUMN                  | `insertUsageInsert` 列清单（:159）+ :3472 处值（重复传 estimated）；fresh CREATE（:1059）。v51 回填块对 cost_usd 的 UPDATE/SELECT 引用保留——仅对 v<51 老库执行，届时列仍在，其后 v77 才删                                                                                                                                                                                                                                                                                                                                                                            |
| `usage_records.billed_cost_usd`、`usage_events.billed_cost_usd`        | DROP COLUMN（拍板②）         | `recordUsageEventBatch`（events INSERT :3430-3446、records INSERT :3474）、`ensureColumn('usage_records','billed_cost_usd')`（:1123）、fresh CREATE（:1061/:1083）、`getRecordedUsageEventCost`（:3300-3316）、`getUsageAnalytics` 聚合（:3606 等）、usage-service 计算、CSV 列                                                                                                                                                                                                                                                                                      |
| `registered_groups.selected_skills`、`mcp_mode`、`selected_mcps`       | DROP COLUMN ×3               | `ensureColumn` ×3（:1306/:1317/:1318）、upsert 列与常量（:10048-10107）、`RegisteredGroupRow` 三字段（:9116/:9125-9126）、`assertSchema('registered_groups')` pin 中的 `'selected_skills'`（:1484）、`tests/db-folder-unique-rebuild-order.test.ts:169` 期望列表                                                                                                                                                                                                                                                                                                     |
| `messages.sdk_message_uuid`                                            | DROP COLUMN                  | fresh CREATE（:569）、`ensureColumn`（:1402）。写链 ISSUE-07 项 6 已下线（`tests/session-workflows.test.ts:176` 负向测试已预告本列删除）                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `channel_accounts.default_agent_profile_id`                            | DROP COLUMN                  | fresh CREATE（:707）、行类型/解析器（:9731/:9773）、upsert 列+值（:9814/:9828）、patch（:9911/:9927-9936）、`src/types.ts:252/:262`、路由剥离行（`routes/channel-accounts.ts:167`）、`tests/routes-channel-accounts.test.ts:162-171`、`tests/channel-account-routing.test.ts:89` fixture                                                                                                                                                                                                                                                                             |
| `users.ai_name`、`ai_avatar_emoji`、`ai_avatar_color`、`ai_avatar_url` | DROP COLUMN ×4（连写入路径） | fresh CREATE（:829-832）、`ensureColumn` ×4（:1159-1162）、`mapUserRow`（:11449-11455）、db 层 `toUserPublic`（:11479-11482）、`assertSchema('users')` pin（:1506-1509）、`updateUserFields` union+写入分支（:11713-11716/:11778+）、`src/types.ts` User/UserPublic 字段、`routes/auth.ts` toUserPublic（:92-95）、PUT `/api/auth/profile` ai*\* 分支（:612-623）、`ProfileUpdateSchema` ai*\* 字段、POST `/api/auth/avatar` 的 `target=ai` 分支（:800-811；非 `user` target 改 400）、`web/src/stores/auth.ts` UserPublic/payload 字段与 `uploadAvatar` target 类型 |
| `workspace_memory_provenance.recorded_at`                              | DROP COLUMN                  | `src/memory-store.ts` CREATE（:552-565 一带）与 INSERT 列（:389-400 一带）、`tests/ckqclaw-owner-profile-store.test.ts` 两处直插                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turn_runs.heartbeat_at`、`correlation_id`                             | **保留（拍板①）**            | 不动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### v77 迁移设计（照 v76 先例 `64d6d7b`）

1. `CURRENT_SCHEMA_VERSION` 76 → 77。
2. initDatabase 末段（v76 trim 之后、`schema_version` 写回之前）追加 v77 trim，门控 `!v77Check || parseInt(v77Check,10) < 77`：
   - 事务内 `DROP TABLE IF EXISTS usage_daily_summary`；
   - 死列按 `PRAGMA table_info` 判存在后 `ALTER TABLE … DROP COLUMN`（v76 同款防重入），清单见上表；
   - 日志一行。
3. 备份门禁自动覆盖：`enforcePreMigrationBackup` 对 `39 <= v < 77` 生成 `migration-backups/`；降级拒绝既有保护不变。
4. **同一提交**更新 `tests/db-upgrade-safety.test.ts`：
   - head pin 字面量 76 → 77 + v77 注释行（v70/v71 连锈两版的前车之鉴）；
   - 新增 v77 升级用例：伪造 v76 库（死表死列带哨兵行）→ boot → 断言 schema_version=77、`usage_daily_summary` 消失、各死列消失、存活数据完好；fresh 库不再创建死表死列。

### 实施顺序（宪法：删列之前先删全部写入路径）

1. 迁移测试先行（Red：head pin 与新用例对 76 报红）。
2. 范围 A 代码删除 + 受影响测试同步（routes-usage / usage-accounting / pricing-routes / frontend fixtures）。
3. 范围 B 写入路径下线（上表右列逐项）+ fresh CREATE/ensureColumn/assertSchema pin 同步。
4. v77 trim 落地 + 版本号 + head pin（Green）。
5. `npm run verify` 六步 + `node scripts/check-scope.mjs`。

## 3. 验收标准（与 issue 一致）

1. `npm run verify` 六步全绿；check-scope 范围核对通过。
2. 真实库副本演练：v76 库原地升级到 v77 并生成 migration-backups；只读对账确认死表死列消失、存量数据完好。
3. 冒烟：`/api/health`、`/api/usage/stats` 正常，用量页面渲染正常。

## 4. 非目标

- `turn_runs.heartbeat_at/correlation_id`（拍板①保留）。
- 前端 legacy 响应归一化机制与 off-by-one 修剪测试（意图信号，不在 issue 字面清单）。
- `/api/usage/stats` 的 `totalInputTokens` 等 6 个 camelCase 别名（issue 仅点名 `totalMessages/totalActiveDays/billedCostUSD`；其余别名属 API 对外兼容面，未列入不动）。
- CI / lint / hooks 配置（宪法第 6 条另行批准）。
- `SELECT *` 115 处的潜在死列再排查（issue 风险条明示只删确认清单）。

## 5. 风险与缓解

| #   | 风险                                                                        | 缓解                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v77 迁移破坏存量库（本任务池最高风险）                                      | 既有备份门禁失败即拒迁 + 降级拒绝；迁移前后只读对账；真实库副本演练                                                                                                                                     |
| 2   | v<51 老库直升 v77：v51 回填块引用 `cost_usd`                                | 该块在 v77 trim 之前执行，届时列仍在；usage_daily_summary 回填语句随表一并移除避免 no-such-table                                                                                                        |
| 3   | fresh 库 ensureColumn 残留指向已删表/列 → 首启报错                          | 删表/列的同时删除对应 ensureColumn、CREATE、assertSchema pin、rebuild-order 测试期望                                                                                                                    |
| 4   | `assertSchema('users'/'registered_groups')` pin 与新 schema 不符 → 首启即抛 | pin 列表与 fresh CREATE 同一提交同步；迁移测试覆盖 fresh + 升级两条路径                                                                                                                                 |
| 5   | db.ts 大批删除连带类型断裂                                                  | 每删一族即 typecheck；同名近似符号警惕（cost_usd vs provider_estimated_cost_usd）                                                                                                                       |
| 6   | API 响应字段移除的兼容性                                                    | `/api/auth/profile` 用户对象去掉 ai\_\* 4 字段、`/api/usage/stats` 去 billing 镜像字段、CSV 少一列——均为 issue 既定范围且前端同仓同版部署、无外部消费方；宪法第 2 条破坏性变更已随 issue + 本次拍板明示 |
| 7   | verify 边缘预算用例轮换翻红                                                 | 已知现象，冷却复测再定性                                                                                                                                                                                |

## 6. 回滚点

- base pin `5d76afb`（`.gatescope.json`）；验收失败回滚到 base 重来，禁止在污染状态堆改。
- 真实库回滚：迁移前自动备份（`migration-backups/messages-v76-to-v77-*.db`）可整库还原。
