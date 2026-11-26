# THESIS-22 IM 配置单一真源：删旧配置与迁移 实施计划

> 来源：[THESIS-22](issues4/THESIS-22-im-config-single-source.md)、[personal-slim 方案 §2 P3/P8、§5](issues4/task-personal-slim-plan.md)。方案定范围与裁决，本文件定怎么落地。
> 依赖：THESIS-19 已完成并合入 main（`a0c29c2`）；THESIS-21 也已合入 main（`a4ee4bb`），本分支基线为 main `5f0db61`。
> 基线：`5f0db61`（开工前 HEAD，回滚点）。
> 版本：v1.0（2026-11-26）。

## 1. 目标与完成条件

渠道配置只认 `channel_accounts`（Web「渠道账号」）。旧的按用户 IM 配置文件、全局飞书配置文件、把旧配置复制成渠道账号的迁移/投影逻辑，以及只能经旧 json 开启的 `autoIsolateContext` 全部删除。飞书 `ownerOpenId` 与微信长轮询游标今后只存在渠道账号的加密 secret 里。

完成条件（与 issue 验收一致）：

1. `src/` 不再出现以下符号/路径：`getUserFeishuConfig`、`saveUserFeishuConfig`、`saveFeishuOwnerOpenId`、`getUserQQConfig`、`saveUserQQConfig`、`getUserWeChatConfig`、`saveUserWeChatConfig`、`ensureLegacyDefaultChannelAccount`、`syncDefaultChannelAccountCredentials`、`getFeishuProviderConfigWithSource`、`migrateSystemIMToPerUser`、`syncLegacyConfigToDefaultChannelAccount`、`migrateDataDirectories`/`movePathWithFallback`、`autoIsolateContext`、`USER_IM_CONFIG_DIR`、`feishu-provider.json`。
2. 启动时只加载 `channel_accounts` 并连接；不再遍历用户读取旧配置、不再写旧配置文件。
3. `ownerOpenId` 的两处读点（`/allow` 回填、未知飞书会话准入）改从渠道账号 secret 读取；微信游标只写渠道账号 secret，不再镜像旧 json。
4. `autoIsolateContext` 的配置读取、批量绑定、启动恢复、健康检查重建全部删除；`clearTargetAgentBindingsForDeletedAgents` 与 `/new` 使用的 `createAutoImConversationAgent` 保留。
5. `FeishuConfigSchema` 与其唯一使用方 `tests/feishu-config-validation.test.ts` 删除。
6. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
7. 文档同步 `CLAUDE.md` §9 末段与 `docs/API.md`。

## 2. 执行前核实：旧配置模块的导出与调用方

| 符号/文件                                                                                                                                                                         | 调用方（开工前）                                                                                                                                                                                             | 处置                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime-config.ts` `USER_IM_CONFIG_DIR`、`userImDir`、`get/saveUserFeishuConfig`、`saveFeishuOwnerOpenId`、`get/saveUserQQConfig`、`get/saveUserWeChatConfig` 及相关存储类型 | `src/index.ts`（启动投影、`migrateSystemIMToPerUser`、`syncLegacyConfigToDefaultChannelAccount`、`learnFeishuOwner`、微信游标镜像、`ownerOpenId` 两处读点）、`src/routes/channel-accounts.ts`（旧门面/投影） | 全段删除；`ownerOpenId` 读点改读渠道账号 secret；微信游标只写账号 secret                                                        |
| `readStoredFeishuConfig`、`defaultsFeishuFromEnv`、`getFeishuProviderConfigWithSource`、`FeishuProviderConfig`、`FEISHU_CONFIG_FILE`、`normalizeFeishuAppId`                      | `src/index.ts`（启动 global fallback、`migrateSystemIMToPerUser`）、`src/routes/auth.ts` `buildSetupStatus`                                                                                                  | 全部删除；`setupStatus.feishuConfigured` 改为由 `listEnabledChannelAccounts()` 中是否存在飞书账号推导（字段保留，前端类型不动） |
| `src/channel-account-migration.ts`（92 行）                                                                                                                                       | `src/index.ts` 启动投影、`syncLegacyConfigToDefaultChannelAccount`；`src/routes/channel-accounts.ts` GET/POST 投影                                                                                           | 整个文件删除；两个导出随之删除                                                                                                  |
| `src/routes/channel-accounts.ts` `syncLegacyUserImFacade`、`legacyCredentialsFor`、`ensureLegacyDefaultChannelAccounts`、`PROVIDER_NAMES`                                         | 本文件内 12 处 facade 调用、GET/POST 投影                                                                                                                                                                    | 全部删除；`is_legacy_default` 不可删等正式规则保留                                                                              |
| `src/index.ts` `migrateSystemIMToPerUser`、`syncLegacyConfigToDefaultChannelAccount`                                                                                              | 启动 `main()`、自身                                                                                                                                                                                          | 删除定义与调用                                                                                                                  |
| `src/index.ts` `movePathWithFallback`、`migrateDataDirectories`                                                                                                                   | `main()` 开头                                                                                                                                                                                                | 删除（issue 明确列入本包；本机已是 `data/` 布局）                                                                               |
| `src/index.ts` 启动「按用户投影旧配置」循环（`listUsers` 分页 + `Promise.allSettled`）                                                                                            | `main()`                                                                                                                                                                                                     | 删除；`listEnabledChannelAccounts` 连接路径保留                                                                                 |
| `src/index.ts` `learnFeishuOwner`                                                                                                                                                 | 零调用（THESIS-19 后已死）                                                                                                                                                                                   | 删除                                                                                                                            |
| `src/index.ts` `getUserContextIsolationConfig` / `applyAutoIsolateContext` / `applyAutoIsolateContextForGroups` 接线                                                              | `buildOnNewChat` 两处、启动恢复、健康检查、`webDeps` 注入、`src/im-context-isolation.ts`、`tests/im-context-isolation.test.ts`                                                                               | 全部删除；`src/im-context-isolation.ts` 只留 `clearTargetAgentBindingsForDeletedAgents`                                         |
| `src/index.ts` `ensureAutoImConversationBinding`                                                                                                                                  | 仅 autoIsolate 的三处调用                                                                                                                                                                                    | 删除；`resolveAutoImWorkspace` / `createAutoImConversationAgent` 仍被 `/new` 使用，保留                                         |
| `src/index.ts` `isSenderAllowedInGroup` 未知会话分支、`handleAllowCommand` 回填分支                                                                                               | 读 `getUserFeishuConfig(...).ownerOpenId`                                                                                                                                                                    | 改读 `group.channel_account_id` / JID 内账户 id 对应账号的 secret；旧无账户 id 的组回落到该用户的 legacy default 飞书账号       |
| `src/index.ts` 微信 `onUpdatesBuf`                                                                                                                                                | 写账号 secret 后镜像旧 json                                                                                                                                                                                  | 删除镜像分支                                                                                                                    |
| `src/schemas.ts` `FeishuConfigSchema`、`FEISHU_APP_ID_REGEX`                                                                                                                      | 仅 `tests/feishu-config-validation.test.ts`                                                                                                                                                                  | 删除 schema 与测试                                                                                                              |

**明确保留（非目标）**：

- `/api/config/user-im/bindings/:imJid` 与 `/reset-allowlist` 两条绑定管理正式路由。
- `is_legacy_default` 对历史无账户 JID 的路由与「legacy default 不可删除」规则。
- 渠道多账号能力。
- `src/db.ts` 的按用户白名单回填函数（`findEmptyAllowlistFeishuGroupsForUser`、`backfillEmptyAllowlistsForUser`）：本次只删除其唯一调用方，函数留在原处；零调用状态登记给 THESIS-34 处理，避免本包改动 `src/db.ts`。
- 磁盘上的旧 json 文件不删、不搬迁。
- `auto_im` 作为 `/new` 的默认会话来源类型保留。

## 3. 实现步骤（TDD）

### 3.1 Red

1. 改写三个按名字切片的契约测试：
   - `tests/channel-account-startup-contract.test.ts`：断言启动不再出现旧配置投影符号，仍按渠道账号连接。
   - `tests/feishu-channel-account-owner.test.ts`：切片终点改为 `async function main()`；断言 reload 不写旧配置。
   - `tests/wechat-account-runtime-contract.test.ts`：同一终点；断言分支只写 `channel_account_secret`，无旧游标镜像。
2. 新增 `tests/thesis-22-im-config-single-source.test.ts`：对 `src/` 全量 grep 断言第 1 节符号零出现；`src/channel-account-migration.ts` 不存在；`src/routes/channel-accounts.ts` 不再 import 旧配置 getter；`src/routes/auth.ts` 的 `feishuConfigured` 由 `listEnabledChannelAccounts` 推导。
3. 改写 `tests/routes-channel-accounts.test.ts` 两条用例：删除「POST 先投影 legacy default」与「facade 可见」断言，保留「legacy default 不可删除、编辑/切换落库」。
4. `tests/im-context-isolation.test.ts` 删除两个 autoIsolate describe，保留 `clearTargetAgentBindingsForDeletedAgents`。
5. 删除 `tests/channel-account-legacy-compat.test.ts` 与 `tests/feishu-config-validation.test.ts`。
6. 运行相关测试确认 Red。

### 3.2 Green

按第 2 节逐项删除/改写；`npm run typecheck` 清零未用 import 与类型引用。

### 3.3 文档

- `CLAUDE.md` §9 末段：改为「渠道配置只通过 `/api/channel-accounts` 管理；旧按用户 IM 配置与全局飞书配置文件不再读取」。
- `docs/API.md`：在渠道账号/旧门面说明处补充「旧 `user-im` 与 `feishu-provider.json` 存储层已删除，凭据只存在渠道账号加密 secret」。

## 4. 非目标

- 不改 `channel_accounts` 表结构与渠道账号接口（`setupStatus.feishuConfigured` 字段保留，仅数据来源变化）。
- 不改 `/api/config/user-im/bindings/*` 绑定管理路由。
- 不改 IM 侧访问控制（`owner_im_id`、`sender_allowlist`、`audience_mode`、`group-owner.ts`、`im-audience-policy.ts`、`channel-admission.ts`）。
- 不改数据库 schema 与 `src/db.ts`。
- 不读 `data/`、不删/搬磁盘上的旧 json。
- 不处理 `THESIS-23` 的兼容残留（环境变量别名、退役设置键、pre-V5 迁移等）。

## 5. 验收与门禁

1. `npm run verify` 六步全绿（format:changed、docs:check、typecheck、test、build、git diff --check）。
2. `node scripts/check-scope.mjs` 通过（`.gatescope.json` base=`5f0db61`）。
3. 人工冒烟（用户）：重启后飞书、QQ、微信三个渠道账号自动连上并能收发；设置页渠道账号列表正常；飞书新聊天会话归属与改前一致。

## 6. 风险与回滚

- **旧部署仍只把凭据放在 `data/config/user-im/*`、`data/config/feishu-provider.json` 或环境变量 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`**：合入后这些渠道不会连接。README 第四节已核实本机无旧文件、渠道账号为 0 行；环境变量回退随全局配置一并删除，部署若依赖需先创建渠道账号。
- **`migrateDataDirectories` 删除**：从 `store/`、`groups/` 旧布局直接升级的超旧部署不再自动搬迁。本机已是 `data/` 布局，issue 明确要求删除。
- **`/allow` 回填与未知飞书会话准入**：改从渠道账号 secret 读 `ownerOpenId`；无账户 id 的历史组回落到 legacy default 账号。若历史组既无账户 id 也无 legacy default 账号，行为退回「尚未识别 owner」，与旧文件缺失时一致。
- 回滚：`git revert <提交号>`。
