# ISSUE-09 死代码批 2：billing 残留与 DB 死表死列迁移

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                    |
| 领取人 / 分支 | issue-09-dead-code-batch2-billing-and-db                                                                                                                                                                                                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                        |
| 类型          | 删除死代码，并做一次数据库迁移（**本任务池中风险最高的一项**）                                                                                                                                                                                                                                                                                                                            |
| 依赖          | 无（原为 ISSUE-07 第 2 项，已解除：项 2 拍板改 410 并落地、项 6 亦做代码层下线，`registered_groups` 三列与 `messages.sdk_message_uuid` 的物理删列均可开工）                                                                                                                                                                                                                               |
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

| 表或列                                                                 | 现状                                                                                                                       | 是否需确认               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `usage_daily_summary` 整表                                             | 每次记录 usage 都会写入（`src/db.ts:1097`、`:163-177`、`:3483`），只有迁移时读过                                           | 否                       |
| `usage_records.cost_usd`                                               | 值与 `provider_estimated_cost_usd` 相同，只在 v51 回填时读过                                                               | 否                       |
| `registered_groups.selected_skills`、`mcp_mode`、`selected_mcps`       | 永远写入常量，行解析器也不映射这三列。ISSUE-07 项 2 已拍板改 410 并落地（2026-11-20），物理删列可开工                      | 否                       |
| `messages.sdk_message_uuid`                                            | 恒为 NULL。ISSUE-07 项 6 已做代码层下线：写链/回补簇已删、`ensureColumn` 暂留，物理删列随本 issue 迁移批                   | 否                       |
| `channel_accounts.default_agent_profile_id`                            | 输出时已被剥离（`src/routes/channel-accounts.ts:167`）；`tests/routes-channel-accounts.test.ts:162-171` 断言这个字段被忽略 | 否                       |
| `users.ai_name`、`ai_avatar_emoji`、`ai_avatar_color`、`ai_avatar_url` | `PUT /api/auth/profile` 和 `/avatar` 仍然可以写入，但没有任何地方读取；聊天头像读的是 appearance.json                      | 否，但要同时移除写入路径 |
| `workspace_memory_provenance.recorded_at`                              | 只在 INSERT 时写入，所有 JOIN 都不取这一列                                                                                 | 否                       |
| `turn_runs.heartbeat_at`、`correlation_id`                             | 只写不读，可能作诊断用                                                                                                     | **需确认**               |
| `usage_events.billed_cost_usd`、`usage_records.billed_cost_usd`        | 意图信号，注释说明“镜像估算值”；records 侧这一列会进入 CSV 导出                                                            | **需确认**               |

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

**交付提交**：`c33526e`（立项/领取登记）→ `faefc37`（实现，24 文件 +422/−547）→ 交付落档提交（本提交，docs）。

**用户拍板（2026-11-20 需求采访）**：

- ① `turn_runs.heartbeat_at`、`correlation_id`：**保留**（状态机设计词汇，人工对账可查，零改动）。
- ② `usage_events.billed_cost_usd`、`usage_records.billed_cost_usd`：**彻底下线**（镜像恒等于估算值；CSV 导出少 `billedCostUSD` 一列——thesis-lite 交付记录已备案过此预期）。

**交付内容与验收对照**：

- 范围 A billing 代码残留：runtime-config 5 设置与 `BILLING_*` 回退、db.ts `getUserGroupCount`/`safeParseJsonArray`/`UserBalance` import/空段注释、types 7 类型、`BillingPlanCreateSchema`、`/api/usage/stats` 的 `totalMessages`/`totalActiveDays`/`billedCostUSD` 与 breakdown `cost_usd`/`billed_cost_usd`（tests/routes-usage.test.ts 断言同步）、usage-service billed 镜像、前端 usage store 旧别名——全部落地；legacy 归一化机制（`??` 回退、RawUsage\* 键、off-by-one 修剪及其专门测试）按 README「意图信号默认保留」口径未动。
- 范围 B v77 迁移：`CURRENT_SCHEMA_VERSION` 76→77，trim 段 DROP `usage_daily_summary` + 13 死列（照 v76 先例：门控/事务/PRAGMA 防重入）；写入路径先行全部下线（含 v28/v51 回填改直写估算值 + `hasColumn` 门控保 fresh 可启动、`assertSchema` pin 同步、v55→v56 死表 ensureColumn 移除）；`tests/db-upgrade-safety.test.ts` head pin 同提交更新 + 新增 v77 升级用例（fresh 不建死表死列 / 伪造 v76 哨兵 / 存活数据完好 / 幂等复启）。
- `npm run verify` 六步全绿 33.9s（338 文件 2705 用例）；`check-scope` 27 路径全在声明内。
- 真实库副本演练：生产库只读连接 `VACUUM INTO` 快照（v76）→ 原地升级 v77 成功，`migration-backups/` 生成 `messages-v76-to-v77-*.db`，死表死列消失、7 表行数完好（usage_records/usage_events/messages/users/registered_groups/channel_accounts/turn_runs），二次启动幂等。
- 冒烟：`/api/health` healthy；登录后 `/api/usage/stats` 返回真实数据且 billing 镜像字段全部消失；CSV 导出无 `billedCostUSD` 列；`/usage` SPA 壳与静态资源 200。浏览器可视化验证因本会话 browser MCP 不可用（"Request workspace is not owned by this CLI"）未能执行，页面渲染以 SPA 壳+资源+数据 API+前端 store 契约测试（frontend-usage-experience 等绿）覆盖，留待用户实机点验。
- 独立代理双重审查：规格符合性通过（无阻塞、无越界、拍板①核实 turn_runs 零改动）、代码质量通过（Critical 0 / Major 0 / Minor 4 登记），详见 `docs/审查记录.md` ISSUE-09 节。

**与 issue 描述的偏差 / 登记项**：

- 预计改动路径中 `src/channel-reliability-store.ts` 因拍板①保留 turn_runs 两列而**零改动**；`tests/task-usage-routing.test.ts`、`tests/usage-display-formatting.test.ts`、`tests/channel-mounts-db.test.ts`、`tests/session-workflows.test.ts`、`tests/schema-v75-channel-trim.test.ts`、`tests/frontend-usage-experience.test.ts`、`tests/channel-account-routing.test.ts` 未改动即绿（声明范围内零 diff）。
- 范围扩宽两路径（.gatescope.json 声明同步）：`web/src/components/settings/ProfileSection.tsx`（`uploadAvatar` 唯一调用方随签名收窄去 `,'user'` 参数）、`tests/task-continuation-scheduler.test.ts`（v76 版本 pin 漏列，全量测试暴露后同步 77——issue「其他相应 tests/\*\*」条款覆盖）。
- 行为变化（宪法第 2 条已随 issue+拍板明示）：`/api/auth/profile` 用户对象去 ai\_\* 4 字段；`POST /api/auth/avatar` 无 target 从「写 AI 头像」改「写用户头像」、未知 target 改 400（AI 头像走 `/api/config/appearance/avatar`）；`/api/usage/stats` 去 3 billing 字段；CSV 少一列。
- 连带无害清理：`tests/usage-accounting.test.ts` 删除 `trackBillingUsage` 死 fixture 键；三个测试的 `getSystemSettings` 桩与两处「钱包」注释改为中性表述（桩保留以隔离宿主机真实设置文件）。
- Minor 遗留（见审查记录）：auth 路由既有零测试欠账（建议后续补 /avatar 400 负向用例）、reap 连带清理遗留 `-ai-*` 孤儿头像文件（注释已说明）、frontend fixture 历史形状注释建议。
