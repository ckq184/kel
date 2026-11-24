# THESIS-05 供应商（四）：凭据链清理与工作区官方令牌字段

| 字段          | 值                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                         |
| 领取人 / 分支 | THESIS-05 会话 / `claude/thesis-05-provider-credential-chain`                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                             |
| 类型          | 裁剪（宿主凭据链，全仓最敏感的代码之一）                                                                                                                                                                                       |
| 依赖          | THESIS-02（凭据刷新函数的调用方在 02 删除）、THESIS-04（同改 `src/runtime-config.ts`）                                                                                                                                         |
| 阻塞          | 无                                                                                                                                                                                                                             |
| 可并行        | ✅ 01、03、06、07、08、09、12、13、15。⚠️ 11（`src/routes/groups.ts`）。❌ 02、04（本包依赖它们）；10（`src/runtime-config.ts` 相邻区域、`src/schemas.ts`）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `src/runtime-config.ts`、`src/group-queue.ts`、`src/container-runner.ts`、`src/routes/groups.ts`（仅 D-3）、`src/schemas.ts`（仅 D-3）、`web/src/components/chat/ContainerEnvPanel.tsx`（仅 D-3）、`docs/API.md`、`tests/**`   |
| 需用户决策    | **是**：D-3（工作区"容器环境变量"里的官方令牌字段）                                                                                                                                                                            |
| 来源          | 方案 §5（T4），审核更正 S2                                                                                                                                                                                                     |

## 目标

删除只为官方 OAuth 服务的凭据写入与会话凭据刷新链路。过程中不生成 `.credentials.json`，`claude-provider.json` 仍为 version 5。

## 范围（锚点为 `d6e04aa`）

1. **凭据写入与刷新**（`src/runtime-config.ts`）：`writeCredentialsFile`（:2312）、`updateAllSessionCredentials`（:2367），以及 `createProvider`、`updateProviderSecrets`、`toPublicProvider`、`buildClaudeEnvLines`、`mergeClaudeEnvConfig` 里的 OAuth 分支。
2. **队列**：`closeAllActiveForCredentialRefresh`（`src/group-queue.ts:1934`）。THESIS-02 之后它已经没有调用方（审核已核实：全仓只有 `src/routes/config.ts` 两处调用，都已在 02 删除）。
3. **`.credentials.json` 写入**（`src/container-runner.ts`）：只删两段写入，即 :1281-1292（容器模式）和 :2401-2411（主机模式），条件都是 `mergedConfig.claudeOAuthCredentials`。
4. **D-3**：按拍板结果处理工作区"容器环境变量"里的 `claudeCodeOauthToken`：后端 PUT 路由（`src/routes/groups.ts:2565-2566`）、对应 Schema、`ContainerEnvConfig` 类型、`ContainerEnvPanel.tsx` 发送的空串字段（:98-101）。

## 不动（审核更正 S2，原方案误列为删除对象）

以下代码都在**第三方分支**里，作用是防止宿主机的 OAuth 登录态劫持第三方请求，保留：

- 主机模式剥离 `oauthAccount`（`src/container-runner.ts:2355-2384`，位于 `if (hostEnv['ANTHROPIC_BASE_URL'])` 内）。
- 容器模式的 `getContainerClaudeJsonPath`（:150-180）剥离 `oauthAccount`。
- 删除残留 `.credentials.json`（:1294-1303、:2388-2398）。裁剪后不会再生成新的凭据文件，但旧会话目录里可能还有残留，这段清理继续有用。

同样不动：存储格式与迁移链（`readStoredState`、`normalizeStoredState`、`migrateV3toV4`、`readStoredStateV4`）、`OFFICIAL_CLAUDE_PROFILE_ID`。官方专用字段在存储层留作闲置字段（按 D-4 ①）。

## 需用户决策（领取前拍板）

| #   | 问题                                                 | 选项                                     | 审核建议 |
| --- | ---------------------------------------------------- | ---------------------------------------- | -------- |
| D-3 | 工作区"容器环境变量"面板的 `CLAUDE_CODE_OAUTH_TOKEN` | ① 本包只摘掉这个字段；② 面板整体另行评估 | ①        |

已核实（V-5）：面板不提供官方凭据输入框，保存时把 `anthropicApiKey`、`claudeCodeOauthToken` 固定发空串；`mergeClaudeEnvConfig` 按"工作区值非空才覆盖"合并，全局是第三方时，工作区无法切回官方路径。所以 ① 的改动很小。`anthropicApiKey` 是共用字段，不摘。

## 执行前核实

- **V-2**：`resolveProfileToConfig`（`src/runtime-config.ts:1946`）把 `officialSecrets` 的凭据并入每个供应商配置。确认第三方供应商不依赖其中任何字段后，再删对应分支。
- 对 `writeCredentialsFile`、`updateAllSessionCredentials`、`closeAllActiveForCredentialRefresh`、`claudeOAuthCredentials` 做一次 `git grep -w`，范围包含 `tests/`。

## 实现步骤（TDD）

1. **Red**：
   - 用第三方供应商分别以主机模式和容器模式准备一次运行，会话目录里不生成 `.credentials.json`；
   - 存量 V5 配置文件（夹具）读写后仍是 version 5，第三方供应商字段不变；
   - 第三方分支的 `oauthAccount` 剥离与残留凭据清理的既有行为保持（若没有用例，补一个）。
2. **Green**：按范围 1 至 4 修改，单独提交。
3. **测试同步**：`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/routes-provider-runtime-apply.test.ts` 中的凭据刷新用例。

## 验收条件

1. 全量 vitest 通过；`claude-provider.json` 仍为 version 5，存量第三方供应商不需要迁移。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. **人工冒烟（用户，方案 §5 整体验收）**：用第三方供应商登录 → 对话流式回复，过程中不生成 `.credentials.json` → 设置页供应商列表没有"官方"标签 → 引导页没有"官方渠道"。

## 风险与回滚

- 只删官方专用的函数和分支，不改 V5 结构；本包单独提交，放在供应商专题的最后。
- `data/` 是敏感区，代理不读写；存量官方型供应商由用户按 D-1 处理。
- **回滚**：`git revert <提交号>`。

## 交付记录

交付日期 2026-11-24，分支 `claude/thesis-05-provider-credential-chain`，base `5ccf1b3`。

### 提交

| 提交      | 内容                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| `03e0d84` | 立项：领取、立项计划 `docs/thesis-05-provider-credential-chain-plan.md`、`.gatescope.json` |
| `2ebade8` | 实现：凭据链删除、D-3 ① 字段摘除、测试与 `docs/runtime-migration.md` 同步                  |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引、方案 §2 台账、`docs/审查记录.md`          |

### 用户拍板（2026-11-24）

**D-3 ①**：本包只摘工作区"容器环境变量"里的 `CLAUDE_CODE_OAUTH_TOKEN` 字段——后端 `ContainerEnvSchema`、PUT `/api/groups/:jid/env`、`ContainerEnvConfig`、公开视图与前端清空请求/遗留覆盖判断一并摘掉；`anthropicApiKey` 是共用字段，保留。

### 实现要点

- `src/runtime-config.ts`：删除 `writeCredentialsFile`、`updateAllSessionCredentials`、`DEFAULT_CREDENTIAL_SCOPES`；`buildClaudeEnvLines` 删除 `CLAUDE_CODE_OAUTH_TOKEN` 注入与 OAuth → `ANTHROPIC_AUTH_TOKEN` 映射；`createProvider` / `updateProviderSecrets` / `toPublicProvider` 摘掉 OAuth 输入与公开字段；`resolveProfileToConfig` 不再并入官方 OAuth 值；`mergeClaudeEnvConfig` 与 `providerToConfig` 在运行时边界统一置空（存储层字段保留，D-4 ①）。
- `src/group-queue.ts`：删除无调用方的 `closeAllActiveForCredentialRefresh`，shutdown 注释改为不引用该名字。
- `src/container-runner.ts`：删除容器模式（`buildVolumeMounts`）与主机模式（`runHostAgent`）两段 `.credentials.json` 写入及 `writeCredentialsFile` 导入；保留 `oauthAccount` 剥离与两处残留凭据清理。
- D-3 ①：`src/schemas.ts`、`src/routes/groups.ts`、`ContainerEnvConfig` / `ContainerEnvPublicConfig`、`saveContainerEnvConfig`、`toPublicContainerEnvConfig`、`web/src/components/chat/ContainerEnvPanel.tsx`、`web/src/stores/container-env.ts` 摘除 `claudeCodeOauthToken` 及相关公开字段；`anthropicApiKey` 全链路保留。
- 存储格式与迁移链（`readStoredState`、`normalizeStoredState`、`migrateV3toV4`、`readStoredStateV4`、`OFFICIAL_CLAUDE_PROFILE_ID`、`isOfficialClaudeMode`、`buildOfficialClaudeProviderConfig`）未改。

### 验证

- 新增 `tests/thesis-05-provider-credential-chain.test.ts`（14 例）：OAuth env 映射消失、第三方 env 输出不变、源码契约（函数/导入/字段删除）、V5 新建往返、容器模式残留凭据清理与 `.claude.json` 剥离行为、D-3 Schema/公开视图/前端源码契约。
- 改写 `tests/runtime-config-env.test.ts`（删除 OAuth 映射 describe）、`tests/thesis-02-provider-api-seal.test.ts`（存量官方供应商构造去掉已不可用的 OAuth 字段）。
- `npm run verify` 六步全绿（363 文件，3002 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 全部变更路径命中声明范围。
- 独立规格符合性审查：初轮唯一阻塞为 `check-scope` 被仓库既有 `node_modules` symlink 环境噪音判红，还原 symlink 并重装主树依赖后复核通过；独立代码质量审查：通过（Critical 0 / Major 0 / Minor 9），已修复其中 4 条（运行时边界置空、公开视图泄漏断言、HOME 隔离、失效注释），其余登记见下。详见 `docs/审查记录.md`。
- **人工冒烟未执行**：由用户按方案 §5 整体验收——第三方供应商登录 → 流式对话过程中不生成 `.credentials.json` → 设置页供应商列表没有"官方"标签 → 引导页没有"官方渠道"。

### 与 issue 描述的偏差和登记项

- **范围扩宽 2 个文件**（理由见 plan §3）：`web/src/stores/container-env.ts`（D-3 ① 公开视图与保存入参类型）、`docs/runtime-migration.md`（THESIS-04 立项时约定由本包订正 OAuth 映射陈述）。
- **`ContainerEnvConfig.claudeOAuthCredentials` 一并删除**：该字段从未被 Schema、PUT 路由或前端写入，属 `mergeClaudeEnvConfig` 的死分支，按范围 1 的"OAuth 分支"处理，不涉及任何数据迁移。
- **运行时边界置空**（质量审查 Minor）：`providerToConfig` 与 `mergeClaudeEnvConfig` 不再把存储层的官方 OAuth 值带进运行时配置对象；无消费方，属防御性收口。
- **`scripts/test-real-model-smoke.ts` 未改**：其 `providerConfigured` 仍读取 `config.claudeCodeOauthToken` / `claudeOAuthCredentials`；`providerToConfig` 置空后对存储型供应商已不再误报，脚本不在本包范围，登记为后续清理。
- **`resolveProfileToConfig` 是 base 上就无调用方的死函数**（`git grep` 仅定义与注释）：本包只改其内部 OAuth 赋值，未删除，登记给后续清理包。
- **V5 存量官方闲置字段无夹具用例**：存储层本包未改，新建 V5 往返与类型检查覆盖结构；构造含密文官方凭据的夹具需要绕过未导出的加密函数，未为本用例扩范围。
- **仓库既有 `node_modules` symlink 缺陷**：main 在 THESIS-01 合入时误把三个指向主工作树的绝对路径 symlink 提交入库（`17113e9`）；在 worktree 跑 `npm ci` 会顺着 symlink 清空主树依赖，并让 `check-scope` 出现范围外路径。本包用"worktree 真实依赖 + 交付前还原 symlink 并重装主树"绕过；建议另立 issue 从版本库移除这三个 symlink。
- **人工冒烟**：见上，由用户执行。
