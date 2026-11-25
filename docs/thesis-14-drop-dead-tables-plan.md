# 任务立项：THESIS-14 删除五张死表（一版前向迁移）

> 立项日期：2026-11-25｜base：`ad09dac`（THESIS-13/15 合入后的 main）｜分支：`claude/thesis-14-drop-dead-tables`
> 来源：[docs/issues2/THESIS-14-drop-dead-tables.md](issues2/THESIS-14-drop-dead-tables.md)（方案 §9、D-F1 至 D-F3）

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-F1 = ① 一版迁移一次删完**：其余专题已全部落地，本包是裁减专题最后一个功能包；一次迁移、一个备份、一个恢复点。
- **D-F2 = ① 只删表**：`users.permissions`、`users.must_change_password`、`users.disable_reason`、`users.notes` 四列原样保留；本包不改 `users` 表结构，不改 `src/db.ts` 的用户映射/写入辅助，也不动 THESIS-11/12 的交付测试。已核实 `users` 表没有邀请码相关列。
- **D-F3 = ① 可以丢弃**：`enforcePreMigrationBackup` 在旧库升级前写整库备份（默认 `data/db/migration-backups/`，没有自动清理），五张表数据仍可从备份恢复；`/api/usage` 导出端点已随 THESIS-06 删除，不做额外 CSV 导出。
- **排期 = 先立项，实现等 THESIS-13 合入**：THESIS-13 与本包共享 `CLAUDE.md`、`AGENTS.md`、`docs/API.md`，并行矩阵为 ❌。立项提交只做领取、计划和范围声明；THESIS-13 合入 main 后已 rebase 到 `ad09dac` 并把 `.gatescope.json` 的 `base` 更新为该提交，随后开始实现。

## 1. 关键事实（开工前核实，main `ad09dac`）

### 1.1 五张表与建表点

| 表                     | 建表位置                                                              | 备注                                                        |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `usage_records`        | `src/db-schema/usage-tables.ts` `ensureUsageTables`                   | 另含 `migrateUsageHistory` / `migrateUsageEventLedger`      |
| `usage_events`         | 同上                                                                  | v51 事件台账镜像列                                          |
| `custom_model_pricing` | `src/db-schema/agent-profile-tables.ts`（`ensureAgentProfileTables`） | 两个 partial unique index                                   |
| `invite_codes`         | `src/db-schema/auth-tables.ts`（`ensureAuthTables`）                  | `created_by` 外键指向 `users(id)`；`idx_invites_created_at` |
| `auth_audit_log`       | 同上                                                                  | `idx_auth_audit_created`                                    |

`CURRENT_SCHEMA_VERSION = 78`（`src/db.ts`）。v76/v77/v78 的 trim 先例都在 `src/db-schema/migrations-channel-trims.ts` 的 `trimRetiredSchemas`，本包在其末尾追加 v78→v79。

### 1.2 调用方核实（V-F6）

五张表在 `src/` 已无业务调用方，只剩 `src/db.ts` 的孤儿导出（`git grep -w` 每个符号仅命中定义，`insertUsageInsert` 的 3 处均为 `stmts()` 内部）：

- 用量：`rebuildMessageTokenUsageFromLedger`、`getUsageDateWindow`、`getRecordedUsageEventCost`、`getUsagePricingBucketTotals`、`recordUsageEventBatch`、`getUsageAnalytics`、`getUsageModelsForFilters`、`getUsageRecordsPage`、`getUsageUsers`，以及 `stmts().insertUsageInsert`。
- 单价：`normalizePricingPattern`、`listCustomModelPricingRules`、`getCustomModelPricingRule`、`createCustomModelPricingRule`、`updateCustomModelPricingRule`、`deleteCustomModelPricingRule`、`CustomModelPricing` 及输入类型。
- 邀请码：`createInviteCode`、`getInviteCode`、`registerUserWithInvite`、`getAllInviteCodes`、`deleteInviteCode`。
- 审计：`logAuthEvent`、`queryAuthAuditLogs`。
- 审核补充：`registerUserWithoutInvite`（只写 `users`，注册下线后无调用方）。
- **保留**：`updateLatestMessageTokenUsage`（写 `messages`，THESIS-07 气泡回写仍在用）及 `stmts().updateTokenUsageById` / `updateTokenUsageLatest`。

### 1.3 连带必须处理的死代码（超出 issue 预计路径，已在范围声明登记）

1. `src/db-schema/migrations-legacy-rebuilds.ts`：`migrateLegacySchemaRebuilds` 里对 `invite_codes`、`auth_audit_log` 的 `assertSchema` 是**每次启动无条件执行**的。表删除后，新库首次启动和旧库第二次启动都会因 `PRAGMA table_info` 为空而抛 "Incompatible DB schema"。必须删掉这两个 assert 块；`users` / `user_sessions` 的 assert 保留。
2. `src/db-schema/task-tables.ts`：`ensureTaskTableColumns` 对 `invite_codes` 的两条 `ensureColumn` 是无门控幂等的；表删除后会执行 `ALTER TABLE invite_codes` 并报 "no such table"。必须删除。
3. `src/db-schema/usage-tables.ts`：除 `ensureUsageTables` 外，还包括 v27→v28 的 `migrateUsageHistory` 和 v50→v51 的 `migrateUsageEventLedger`，两者会读写 `usage_records` / `usage_events`；表删除后必须一起删除，否则新库启动即失败。这是"迁移链不重写"的唯一例外：被删的步骤目标表本身就是本包要删的表，老库执行完也会在 v79 被删，不产生 D-F3 ① 之外的数据损失。
4. `src/types.ts`：`InviteCode`、`InviteCodeWithCreator`、`AuthEventType`、`AuthAuditLog` 在删除函数后仅剩定义，随之删除。
5. **不需要改** `src/db-schema/migrations-channel-trims.ts` 的 v76/v77 块：v77 对 `usage_records` / `usage_events` 只做 `DROP TABLE IF EXISTS` 和 `PRAGMA table_info` 判存在，新库无表时安全跳过。

### 1.4 测试影响（V-F2）

- `tests/schema-v51-usage.test.ts`：整体删除（断言 v51 台账迁移）。
- `tests/db-upgrade-safety.test.ts`：v77 用例中"伪造 v76 库并插入 usage_records/usage_events"的部分要移除或改为 v79 用例；版本号钉 `expect(...).toBe(78)` 同提交改 79，并在版本历史注释补 v79。
- `tests/task-continuation-scheduler.test.ts`：另一处 `CURRENT_SCHEMA_VERSION` 字面量钉（78）随版本升到 79，注释补 v79。
- `tests/routes-system-settings-security.test.ts`：`queryAuthAuditLogs` 调用点随函数删除而移除（该用例删除，行为面由 THESIS-10 的"路由不再调用 logAuthEvent"覆盖）。
- `tests/thesis-10-single-account.test.ts`：`audit writes stop` 用例原先用 `queryAuthAuditLogs()` 观察零写入，改为断言两个审计 API 不再导出，保留登录/登出/改密回归流程。
- `tests/no-duplicate-helpers-contract.test.ts`：删除 `normalizePricingPattern` 单一定义契约（helper 已随本包删除）。
- `tests/backup-restore-safety.test.ts`：不涉及五张表，无需改。
- `tests/thesis-07` 的源码契约：只断言"db.ts 之外无调用"，删除函数后仍成立。

### 1.5 数据、备份与回滚

- `enforcePreMigrationBackup` 在 `initDatabase` 打开库后、任何 schema 写入前执行；`schema_version >= 39` 且 `< CURRENT` 时用 `VACUUM INTO` 生成整库备份，`quick_check` 校验失败即中止启动。备份目录默认 `data/db/migration-backups/`，可用 `CKQCLAW_MIGRATION_BACKUP_DIR` 覆盖；**没有自动清理**。
- 因此 D-F3 ① 的"丢弃"仍保留一份完整可打开的旧库副本；用户的人工冒烟应确认备份文件存在且能打开。
- 代码回滚不等于数据回滚：降级打开会被"refusing downgrade"挡住，必须同时用迁移前备份恢复数据库。

### 1.6 外键与删除顺序（V-F3）

- 没有任何表以这五张表为父表（`REFERENCES usage_* / custom_model_pricing / invite_codes / auth_audit_log` 零命中）。
- `invite_codes.created_by → users(id)` 是子表指向父表；删除 `invite_codes` 不会受外键阻塞。删除顺序按先子表后无依赖表的惯例：`usage_events` → `usage_records` → `custom_model_pricing` → `auth_audit_log` → `invite_codes`。

### 1.7 文档

- `CLAUDE.md` §7 核心表族：用户与认证行删除 `invite_codes`、`auth_audit_log`；整行删除"用量"表族（同时清掉已在 v77 删除却仍列着的 `usage_daily_summary`，V-F5）。
- `docs/API.md`、`AGENTS.md`、`docs/ACL-MATRIX.md` 在 `ad09dac` 已无这五张表的描述，预计零改动；仍按 issue 声明保留在 allow 内，`npm run docs:check` 兜底。
- `container/agent-runner/src/runtime/pi/pi-session.ts` 的注释仍把 event id 描述为 `usage_events` 幂等键；表删除后该说法失效，随包改一行注释（仅注释，不改逻辑）。

## 2. 技术方案

### 2.1 v78→v79 迁移

在 `trimRetiredSchemas` 末尾追加，参照 v76/v77 写法：

- 门控 `const v79Check = getRouterStateInternal('schema_version'); if (!v79Check || parseInt(v79Check, 10) < 79)`。
- 包在 `db.transaction` 里，逐表 `DROP TABLE IF EXISTS`；删除前用 `tableExists` 记录实际存在的表，事务后 `logger.info` 输出被删清单（带 v79 前缀）。
- 新库（`v79Check` 为空）同样执行，保证"新库不创建、老库升级删除"两条路径都到同一终点。
- `CURRENT_SCHEMA_VERSION` 78 → 79；`tests/db-upgrade-safety.test.ts` 的字面量钉同提交更新。

### 2.2 删除建表与读写层

- 删 `src/db-schema/usage-tables.ts` 整个文件；`src/db.ts` 去掉 `ensureUsageTables` / `migrateUsageHistory` / `migrateUsageEventLedger` 的 import 与三处调用。
- `src/db-schema/auth-tables.ts`：删 `invite_codes`、`auth_audit_log` 的 CREATE TABLE 与索引；保留 `users`、`user_sessions`、`user_pinned_groups` 与 owner-profile 逻辑。
- `src/db-schema/agent-profile-tables.ts`：删 `custom_model_pricing` 建表与两个 `CREATE UNIQUE INDEX`。
- `src/db-schema/task-tables.ts`：删两条 `invite_codes` 的 `ensureColumn`。
- `src/db-schema/migrations-legacy-rebuilds.ts`：删 `invite_codes`、`auth_audit_log` 的 `assertSchema` 块。
- `src/db.ts`：按 1.2 清单删函数与 `stmts().insertUsageInsert`（类型字段、prepare、调用点）；清理 import 与注释里的表名；删 `CustomModelPricing`、`UsageQueryFilters`、`UsageEventRecordInput` 等只服务被删函数的类型；删只被审计查询使用的 `parseJsonDetails`；同步头部结构导览注释。
- `src/types.ts`：删 1.3 第 4 条列出的四个类型。

## 3. 实现步骤（TDD）

1. **Red（迁移）**：在 `tests/db-upgrade-safety.test.ts` 增加/改造用例：
   - 新库首次启动：五张表都不存在；
   - 伪造成 v78 库（五张表 + 哨兵行）升级：五张表不存在，`schema_version` = 79；
   - 升级前备份存在、可被 SQLite 打开（`quick_check`），且备份里五张表的哨兵行仍在；
   - 同时调整原 v77 用例里对 usage 表的伪造与断言。
2. **Red（源码契约）**：新增 `tests/thesis-14-drop-dead-tables.test.ts`：`src/db.ts` 不含五张表名与 24 个函数名；`usage-tables.ts` 不存在；auth/agent-profile/task-tables/legacy-rebuilds 不含对应建表、ensureColumn、assertSchema；`src/types.ts` 不含四个死类型；`CURRENT_SCHEMA_VERSION` 钉 79。
3. **Green（迁移与建表）**：按 2.1、2.2 落地，跑新用例转绿。
4. **Green（代码清理）**：删函数、类型、预处理语句与 import；`make typecheck` 收敛残余引用。
5. **测试同步**：删 `tests/schema-v51-usage.test.ts`；处理 `routes-system-settings-security`、`no-duplicate-helpers-contract`；确认 THESIS-11/12 的列测试不动。
6. **文档**：`CLAUDE.md` §7、runner 注释；`docs:check` 六步门禁内跑。
7. **验证**：`npm run verify` 六步全绿 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。
8. **交付**：issue 与 README 索引改"已完成"，方案 §2 台账第 16 行改为已完成（写明提交号），issue 末尾写交付记录与偏差。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-14-drop-dead-tables.md`、`docs/issues2/README.md`、`docs/issues2/task-thesis-trim-plan.md`、`docs/thesis-14-drop-dead-tables-plan.md`、`docs/审查记录.md`、`CLAUDE.md`、`AGENTS.md`、`docs/API.md`、`src/db.ts`、`src/types.ts`、`src/db-schema/usage-tables.ts`（删除）、`src/db-schema/agent-profile-tables.ts`、`src/db-schema/auth-tables.ts`、`src/db-schema/task-tables.ts`、`src/db-schema/migrations-channel-trims.ts`、`src/db-schema/migrations-legacy-rebuilds.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`（仅注释）、`tests/**`。

其中 `src/db-schema/migrations-legacy-rebuilds.ts`、`src/types.ts`、`container/agent-runner/.../pi-session.ts` 超出 issue 的预计改动路径，理由见 1.3；`AGENTS.md`、`docs/API.md` 预计零改动，保留在 allow 内仅用于表结构描述兜底。

## 5. 验收条件

1. 旧库（v78）升级后与新库首次启动后，五张表都不存在；`schema_version` = 79。
2. 旧库升级前自动生成完整备份（`enforcePreMigrationBackup`，默认 `data/db/migration-backups/`），备份可被 SQLite 打开且保留五张表的数据。
3. `src/db.ts` 不再有这五张表的函数、预处理语句与表名；`src/db-schema/` 不再创建它们；源码契约用例覆盖。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. **人工冒烟（用户）**：用升级前的数据库副本启动 → 自动生成迁移备份 → 登录、对话、定时任务、渠道、记忆全部正常；第二次启动不重复备份、不报 schema 错误。
6. D-F2 ①：`users` 四列与相关映射、类型、THESIS-11/12 测试保持原样。

## 6. 非目标

- 不删 `users.permissions`、`users.must_change_password`、`users.disable_reason`、`users.notes` 四列（D-F2 ①），不改 `src/types.ts` 的 `User` / `UserPublic` / `UserSessionWithUser`。
- 不重写其它历史迁移；只删 v27→v28、v50→v51 两段以被删表为目标的迁移函数（理由见 1.3）。
- 不动其余 36 张正式表与对应功能。
- 不读写 `data/`；CSV 导出与人工冒烟由用户操作。
- 不做 THESIS-13 的产品定位与访问边界文档整体改写。
- 不清理 `src/db.ts` 里 v76 遗留的空分节横幅（`User Subscriptions` 等），避免扩大范围。

## 7. 风险与回滚

- **五张表的历史数据丢失（已确认）**：D-F3 ①；备份是唯一恢复路径，备份文件可能因 `usage_records` 较大而明显变大。
- **代码回滚不等于数据回滚**：数据库升到 v79 后，退回旧代码会被"refusing downgrade"挡住，必须同时用迁移前备份恢复数据库。
- **新库首次启动是最大回归面**：`assertSchema`、`ensureColumn`、`migrateUsage*` 任一处漏删都会导致启动失败；Red 用例先覆盖新库路径。
- **THESIS-13 合入冲突**：`.gatescope.json` 与 README 索引按 README 第三节簿记冲突规则处理；实现前 rebase 并更新 base。
- **回滚**：`git revert <提交号>`，同时用迁移前备份恢复数据库。
