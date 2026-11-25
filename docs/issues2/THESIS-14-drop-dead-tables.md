# THESIS-14 删除五张死表（一版前向迁移）

| 字段          | 值                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                         |
| 领取人 / 分支 | `claude/thesis-14-drop-dead-tables`                                                                                                                                                                                                                                                                            |
| 优先级        | P2                                                                                                                                                                                                                                                                                                             |
| 类型          | 数据库（破坏性变更，删表）                                                                                                                                                                                                                                                                                     |
| 依赖          | THESIS-06、07、08、10（五张表的读写调用全部删除）。D-F2 选 ② 清理列时，还要等 THESIS-11（`users.permissions`）、THESIS-12（`users.must_change_password`）                                                                                                                                                      |
| 阻塞          | 无。这是裁减专题的最后一个包，默认只做一次                                                                                                                                                                                                                                                                     |
| 可并行        | ✅ 15。❌ 01、02、03、04、05、06、07、08、09、10、11、12、13（按 D-F1 ① 在其余 issue 全部完成后单独执行；D-F1 选 ② 时另行评估）（口径见 [README 第三节](README.md)）                                                                                                                                           |
| 预计改动路径  | `src/db.ts`、`src/db-schema/usage-tables.ts`、`src/db-schema/agent-profile-tables.ts`、`src/db-schema/auth-tables.ts`、`src/db-schema/migrations-channel-trims.ts`（或同类迁移文件）、`tests/db-upgrade-safety.test.ts`、`tests/schema-v51-usage.test.ts`、`CLAUDE.md`、`docs/API.md`、`AGENTS.md`、`tests/**` |
| 需用户决策    | **是**：D-F1、D-F2、D-F3                                                                                                                                                                                                                                                                                       |
| 来源          | 方案 §9（用户 2026-11-24 裁决，取代第一轮"数据库不动"的安全线）                                                                                                                                                                                                                                                |

## 目标

用一版前向迁移删除裁剪后没有读写方的五张表：`usage_records`、`usage_events`、`custom_model_pricing`、`invite_codes`、`auth_audit_log`。新库不再创建它们，旧库升级时删除，迁移前自动备份。

## 范围（锚点为 `d6e04aa`）

1. **去掉建表语句**：`src/db-schema/usage-tables.ts:21-82`（`usage_records`、`usage_events` 及索引）、`src/db-schema/agent-profile-tables.ts:139`（`custom_model_pricing`）、`src/db-schema/auth-tables.ts:44`、:68（`invite_codes`、`auth_audit_log`）。
2. **加一版前向迁移**：`CURRENT_SCHEMA_VERSION`（`src/db.ts:138`，现为 78）升一版，对旧库执行 `DROP TABLE IF EXISTS`。写法参照 `src/db-schema/migrations-channel-trims.ts` 的 v76、v77、v78 先例：带版本判断、包在事务里、删除后写日志。
3. **删除 `src/db.ts` 的读写函数**（方案统计 21 个、约 1,004 行）：
   - 用量：`rebuildMessageTokenUsageFromLedger`（:1231）、`getUsageDateWindow`、`getRecordedUsageEventCost`、`getUsagePricingBucketTotals`、`recordUsageEventBatch`、`getUsageAnalytics`、`getUsageModelsForFilters`、`getUsageRecordsPage`、`getUsageUsers`，以及 `stmts()` 里的 `insertUsageInsert`（:176）；
   - 单价：`normalizePricingPattern`（方案未计入，THESIS-08 删掉 `src/routes/pricing.ts` 后没有调用方；`tests/no-duplicate-helpers-contract.test.ts:393` 断言它恰好导出一次，同步修改）、`listCustomModelPricingRules`、`getCustomModelPricingRule`、`createCustomModelPricingRule`、`updateCustomModelPricingRule`、`deleteCustomModelPricingRule` 与相关类型；
   - 邀请码：`createInviteCode`、`getInviteCode`、`registerUserWithInvite`、`getAllInviteCodes`、`deleteInviteCode`；
   - 审计：`logAuthEvent`、`queryAuthAuditLogs`；
   - 另加 `registerUserWithoutInvite`（:9958，审核补充）：它只写 `users` 表，不属于五张表，但 THESIS-10 下线注册后没有调用方。
   - 保留 `updateLatestMessageTokenUsage`（写的是 `messages` 表，THESIS-07 的回写还在用）。
4. **列（按 D-F2）**：候选为 `users.permissions`（THESIS-11 之后）、`users.must_change_password`（THESIS-12 之后）、`users.disable_reason`、`users.notes`（用户管理下线之后），以及 `users` 表里与邀请码相关的列（是否存在待核实）。做的话与删表放在同一版迁移，写法参照 v76、v77 的 `DROP COLUMN`。
5. **测试**：`tests/db-upgrade-safety.test.ts:578` 的版本号钉改为新版本，**与迁移在同一个提交**（CLAUDE.md 修改数据库条目）；按先例补三个用例。删除 `tests/schema-v51-usage.test.ts`。
6. **文档**：`CLAUDE.md` §7 核心表族（同时更正已在 v77 删除却仍列着的 `usage_daily_summary`，V-F5）、`docs/API.md`、`AGENTS.md` 中关于表结构的描述。

## 非目标

- 不重写迁移链，升级前的各版迁移步骤原样保留。
- 其余 36 张正式表与对应功能不受影响。
- 代理不读写 `data/`；用升级前数据库副本做冒烟由用户操作。

## 需用户决策（领取前拍板）

| #    | 问题                     | 选项                                                                     | 方案默认                |
| ---- | ------------------------ | ------------------------------------------------------------------------ | ----------------------- |
| D-F1 | 什么时候删               | ① 其余专题全部落地后，一版迁移一次删完；② 每个专题内各自删表、各自升版本 | ①                       |
| D-F2 | 是否连带清理用不到的列   | ① 只删表；② 表和列一起删，放在同一版迁移                                 | ①                       |
| D-F3 | 五张表的历史数据能否丢弃 | ① 可以丢弃；② 先导出留存                                                 | 须在 THESIS-06 之前拍板 |

## 执行前核实

- **V-F2**：以五张表为前置的测试。`tests/task-usage-routing.test.ts`、`tests/usage-accounting.test.ts` 已随 THESIS-07 删除；`tests/backup-restore-safety.test.ts`（859 行）是否涉及。
- **V-F3**：被删表上的索引与外键（`invite_codes.created_by` 指向 `users`），确认删除顺序不会被外键检查挡住。
- **V-F4**：D-F2 选 ② 时逐列核实。
- **V-F6**：立项时按当时的最终裁剪状态重新核对一遍"用不到"的名单。例如 THESIS-11 未执行时，`users.permissions` 不在候选里。
- 删除每个函数前用 `git grep -w` 确认没有调用方，范围包含 `tests/`。

## 实现步骤（TDD）

1. **Red（迁移）**：在 `tests/db-upgrade-safety.test.ts` 先写失败用例：旧库升级后五张表不存在；新库首次启动五张表不存在；迁移前备份存在。
2. **Green（迁移）**：去掉建表语句，加删表迁移，升版本号，同一提交更新版本号钉。
3. **Red（代码）**：源码契约用例：`src/db.ts` 不再出现五张表的名字。
4. **Green（代码）**：删除函数、预处理语句与类型；按 D-F2 处理列。

## 验收条件

1. 旧库升级后与新库首次启动后，五张表都不存在。
2. 迁移前自动生成完整备份（`enforcePreMigrationBackup`，`src/db.ts:454`，默认目录 `data/db/migration-backups/`），备份可被 SQLite 打开。
3. `src/db.ts` 中不再有这五张表的函数与建表语句。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. **人工冒烟（用户）**：用升级前的数据库副本启动 → 自动生成迁移备份 → 登录、对话、定时任务、渠道、记忆全部正常。

## 风险与回滚

- **五张表的历史数据会丢失**：用量记录、自定义单价规则、邀请码、登录审计记录。
- **代码回滚不等于数据回滚**：数据库升级后，把代码退回删表之前会被"拒绝降级"的检查挡住，必须同时用迁移前备份恢复数据库。所以本包排在最后，默认只做一次。
- **回滚**：代码 `git revert <提交号>`，同时用迁移前备份恢复数据库。

## 交付记录

- **提交**：`355b91f`（立项）、`b62bbd3`（实现）、`721cbfe`（审查处置）；本提交为交付（三处状态、方案台账与记录）。
- **分支 / base**：`claude/thesis-14-drop-dead-tables`，base `ad09dac`（THESIS-13/15 合入后的 main）。
- **改动**：
  - `src/db-schema/migrations-channel-trims.ts`：新增 v78→v79，事务内 `DROP TABLE IF EXISTS` 五表，存在性日志；`CURRENT_SCHEMA_VERSION` 78→79。
  - 删除建表与启动期触碰：`src/db-schema/usage-tables.ts` 整文件（含 v27→v28、v50→v51 两段以被删表为目标的迁移）、`auth-tables.ts` 的 `invite_codes`/`auth_audit_log`、`agent-profile-tables.ts` 的 `custom_model_pricing`、`task-tables.ts` 的两条 invite_codes `ensureColumn`、`migrations-legacy-rebuilds.ts` 的两个 `assertSchema`。
  - `src/db.ts`：删除方案列出的孤儿函数与 `insertUsageInsert`、相关局部类型及 `parseJsonDetails`（约 1,150 行），保留 `updateLatestMessageTokenUsage`；`src/types.ts` 删除 `InviteCode`、`InviteCodeWithCreator`、`AuthEventType`、`AuthAuditLog`。
  - 测试：新增 `tests/thesis-14-drop-dead-tables.test.ts`（源码契约）；`tests/db-upgrade-safety.test.ts` 新增 v79 用例（新库、伪造 v78 升级、备份可打开且五表哨兵行齐全、重启幂等）并把版本钉改 79；删除 `tests/schema-v51-usage.test.ts`；同步 thesis-10 审计契约、routes-system-settings-security、no-duplicate-helpers、task-continuation-scheduler。
  - 文档：`CLAUDE.md` §7 表族删除邀请码/审计与用量行（含 v77 已删的 `usage_daily_summary`）；runner 注释去掉 `usage_events` 幂等键说法；`AGENTS.md`/`docs/API.md` 实测无表结构描述，零改动。
- **验证**：`npm run verify` 6/6 全绿（367 文件，3020 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 通过（22 个路径全在声明范围内）；`npm run docs:check` 通过（129 个 Markdown）。
- **审查**：规格符合性审查通过（零阻塞）；代码质量审查通过（Critical 0 / Major 0 / Minor 9），9 项已逐项处置或登记。详见 `docs/审查记录.md`。
- **偏差 / 计划外**：
  - 新增 `src/db-schema/migrations-legacy-rebuilds.ts`、`src/types.ts`、runner 注释、`tests/task-continuation-scheduler.test.ts`、`tests/thesis-10-single-account.test.ts` 等 issue 未列路径，均已进 `.gatescope.json` 与 plan §1.3/§1.4。
  - 实现把"新库/旧库/备份"三类断言合并在一个 v79 用例中（issue 原文写"补三个用例"）；覆盖等价，粒度差异登记。
  - `usage-tables.ts` 整文件删除连带 v27→v28、v50→v51 两段迁移；与 issue 非目标"各版迁移步骤原样保留"字面有出入，属 plan §1.3 第 3 条已批准例外（不删会导致新库启动失败）。
- **未做 / 已知边界**：
  - 未实机验收：需用户用升级前数据库副本启动，确认自动迁移备份、登录/对话/定时任务/渠道/记忆正常。
  - v39 以下/无版本库沿用 `enforcePreMigrationBackup` 既有阈值，不生成升级备份。
  - v<77 老库的 v77→v79 链无专项 fixture（v79 为终态；v77 列删除不影响终态）。
  - 超大 `usage_records` 在 FK=ON 下 DROP 有启动耗时/内存峰值。
  - `src/auth.ts` 的 `generateInviteCode` 为 THESIS-10 遗留死代码，不在本包 allow，建议后续清理。
- **后续建议**：可另立小包清理 `generateInviteCode` 与 `src/db.ts` 的 v76 空分节横幅。
