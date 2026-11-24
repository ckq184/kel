# 任务立项：THESIS-05 供应商（四）：凭据链清理与工作区官方令牌字段

> 立项日期：2026-11-24｜base：`5ccf1b3`｜分支：`claude/thesis-05-provider-credential-chain`
> 来源：[docs/issues2/THESIS-05-provider-credential-chain.md](issues2/THESIS-05-provider-credential-chain.md)（方案 §5 T4，审核更正 S2）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：删除只为官方 OAuth 服务的凭据写入与会话凭据刷新链路；过程中不生成 `.credentials.json`；`claude-provider.json` 仍为 version 5。
- **完成条件**：第三方供应商在主机/容器两种模式下都不再写入 `.credentials.json`；官方 OAuth 环境变量映射消失；V5 存储往返不变；第三方分支的 `oauthAccount` 剥离与残留 `.credentials.json` 清理保持；工作区"容器环境变量"不再暴露官方令牌字段；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改 `claude-provider.json` 存储格式（version 5）与迁移链；`data/` 不读不写；不删 `oauthAccount` 剥离与残留凭据清理（审核更正 S2）。

| #   | 问题                                                 | 拍板                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-3 | 工作区"容器环境变量"面板的 `CLAUDE_CODE_OAUTH_TOKEN` | **①**（用户 2026-11-24 拍板）：本包只摘这个字段——后端 `ContainerEnvSchema`、PUT `/api/groups/:jid/env`、`ContainerEnvConfig`、公开视图（`hasClaudeCodeOauthToken` / `claudeCodeOauthTokenMasked`）与前端清空请求、遗留覆盖判断一并摘掉；`anthropicApiKey` 是共用字段，保留。 |

## 1. 关键事实（开工前核实，main `5ccf1b3`）

- **凭据刷新已无调用方**：THESIS-02 删除了 `src/routes/config.ts` 的两个调用点后，`updateAllSessionCredentials`（`src/runtime-config.ts:2378`）与 `closeAllActiveForCredentialRefresh`（`src/group-queue.ts:1934`）全仓（含 `tests/`、`docs/`）无调用方；`writeCredentialsFile` 只被 `src/container-runner.ts:1285`、`:2405` 与 `updateAllSessionCredentials` 内部调用。`DEFAULT_CREDENTIAL_SCOPES` 只服务 `writeCredentialsFile`。
- **V-2 结论**：`resolveProfileToConfig` 把 `officialSecrets` 三个字段并入每个供应商配置；其中只有 `anthropicApiKey` 是第三方也用到的共用字段（runner 以 `apiKey || authToken` 注册），OAuth 两个字段只被 `buildClaudeEnvLines` 的官方映射与 `writeCredentialsFile` 读取。第三方带 Base URL 时官方映射被跳过（`src/runtime-config.ts:1860-1872`），因此删除 OAuth 分支不影响第三方；`anthropicApiKey` 的并入保留。
- **V-5 结论**：`ContainerEnvPanel` 不提供官方凭据输入框；保存只发 `customEnv`，清空时固定发 `claudeCodeOauthToken: ''`；`claudeOAuthCredentials` 在 `ContainerEnvConfig` 里从未被任何入口写入（Schema、PUT 路由、前端都没有），属 `mergeClaudeEnvConfig` 的死分支。
- **第三方防护代码（不动）**：容器模式 `getContainerClaudeJsonPath` 的 `oauthAccount` 剥离（`src/container-runner.ts:174`）、主机模式 `oauthAccount` 剥离（`:2375`）、残留 `.credentials.json` 清理（`:1294-1303`、`:2388-2398`）都在第三方分支内，继续保留。
- **宿主写入点**：容器模式写入在 `buildVolumeMounts` 内（:1281-1292），可在测试中直接调用；主机模式写入在 `runHostAgent` 内（:2401-2412），整段依赖子进程，采用源码契约断言。
- **测试面**：`tests/runtime-config-env.test.ts` 的 "OAuth credential mapping" describe 锁定将删除的映射；`tests/thesis-02-provider-api-seal.test.ts` 有一处 `createProvider({ type: 'official', claudeCodeOauthToken })` 直接构造存量官方供应商，需随输入面收窄调整。其余 `claudeOAuthCredentials` 出现点均为存储 fixtures 或注释，不需要改。
- **文档面**：`docs/runtime-migration.md:162-167` 仍写"宿主把 OAuth token 映射到 `ANTHROPIC_AUTH_TOKEN`"，THESIS-04 立项时约定由本包删除映射时一并订正；`docs/API.md` 的供应商密钥端点仍未涉及 OAuth 字段，工作区 env 端点无字段清单，grep 确认无需改；`CLAUDE.md`、`README.md`、`AGENTS.md` 无相关陈述。
- **红线**：不读不写 `data/`；不改 V5 结构与迁移链；不删第三方防护代码；不动前端供应商编辑器（THESIS-03 已完成）。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-05-provider-credential-chain.test.ts`：
   - 行为：`buildClaudeEnvLines` 对"官方 OAuth token / 完整凭据、无 Base URL"的旧配置不再输出 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_AUTH_TOKEN`；第三方 Base URL + Auth Token 的输出不变。
   - 行为：`ContainerEnvSchema` 接受但剥离 `claudeCodeOauthToken`；`toPublicContainerEnvConfig` 不再返回 `hasClaudeCodeOauthToken` / `claudeCodeOauthTokenMasked`。
   - 行为：临时 `DATA_DIR` 下创建第三方供应商 → 读取 `claude-provider.json` 仍为 version 5，第三方字段与修复前一致（回归守卫，防凭据链改动误伤存储）。
   - 源码契约：`src/runtime-config.ts` 不再导出 `writeCredentialsFile` / `updateAllSessionCredentials`，不再有 `CLAUDE_CODE_OAUTH_TOKEN=` 注入；`src/group-queue.ts` 不再有 `closeAllActiveForCredentialRefresh`；`src/container-runner.ts` 不再导入/调用 `writeCredentialsFile`；`src/routes/groups.ts` 不再写 `claudeCodeOauthToken`；前端 `ContainerEnvPanel.tsx` / `container-env.ts` 不再出现该字段。
   - 保留契约：`src/container-runner.ts` 仍有 `delete stripped.oauthAccount`、主机模式 `delete claudeJson.oauthAccount`，且两处残留 `.credentials.json` 清理仍在。
   - 测试同步：删除 `tests/runtime-config-env.test.ts` 的 OAuth 映射 describe；调整 `tests/thesis-02-provider-api-seal.test.ts` 的存量官方供应商构造。
2. **Green**：
   - `src/runtime-config.ts`：删 `writeCredentialsFile`、`updateAllSessionCredentials`、`DEFAULT_CREDENTIAL_SCOPES`；删 `buildClaudeEnvLines` 的两段 OAuth 分支；`createProvider` / `updateProviderSecrets` / `toPublicProvider` 摘掉 OAuth 输入与公开字段；`mergeClaudeEnvConfig` 摘掉 OAuth 覆写与第三方剥离（保留字段为存储闲置值透传）；`resolveProfileToConfig` 不再并入 OAuth 两字段；D-3 ① 摘掉 `ContainerEnvConfig`、`ContainerEnvPublicConfig`、`saveContainerEnvConfig`、`toPublicContainerEnvConfig` 中的官方令牌字段。
   - `src/group-queue.ts`：删 `closeAllActiveForCredentialRefresh`，订正 shutdown 注释里对它的引用。
   - `src/container-runner.ts`：删两段 `.credentials.json` 写入与 `writeCredentialsFile` / `mergeClaudeEnvConfig` 导入；保留第三方清理块。
   - `src/schemas.ts`、`src/routes/groups.ts`、`web/src/components/chat/ContainerEnvPanel.tsx`、`web/src/stores/container-env.ts`：D-3 ① 字段摘除。
3. **文档**：订正 `docs/runtime-migration.md` 的 OAuth 映射陈述；`docs/API.md`、`docs/ACL-MATRIX.md` 经 grep 确认无对应行，不改；`npm run docs:check`。
4. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。
5. **交付**：issue 元信息、README 索引行、方案 §2 裁决台账同步（供应商专题 02-05 全部完成）。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-05-provider-credential-chain.md`、`docs/issues2/README.md`、`docs/issues2/task-thesis-trim-plan.md`、`docs/thesis-05-provider-credential-chain-plan.md`、`docs/审查记录.md`、`docs/runtime-migration.md`、`docs/API.md`、`src/runtime-config.ts`、`src/group-queue.ts`、`src/container-runner.ts`、`src/routes/groups.ts`、`src/schemas.ts`、`web/src/components/chat/ContainerEnvPanel.tsx`、`web/src/stores/container-env.ts`、`tests/**`。

超出 issue 预计改动路径的两个文件：

- `web/src/stores/container-env.ts`：D-3 ① 要摘掉公开视图字段与保存入参类型，store 是前端唯一的消费面，不改会留下死字段。
- `docs/runtime-migration.md`：THESIS-04 立项时已登记，本包删除 OAuth 映射时一并订正历史陈述。

## 4. 验收条件

1. 第三方供应商在容器模式（`buildVolumeMounts`）与主机模式（`runHostAgent` 源码）都不再写入 `.credentials.json`；官方 OAuth 环境变量映射消失。
2. 存量残留 `.credentials.json` 清理与 `oauthAccount` 剥离保持；`claude-provider.json` 仍为 version 5，第三方存量供应商无需迁移。
3. 工作区 env 接口/前端不再出现 `claudeCodeOauthToken` 与相关公开字段；`anthropicApiKey` 保留。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 人工冒烟（用户，方案 §5 整体验收）：第三方供应商登录 → 对话流式回复，过程中不生成 `.credentials.json` → 设置页没有"官方"标签 → 引导页没有"官方渠道"。

## 5. 非目标

- 不改 V5 存储结构、`readStoredState` / `normalizeStoredState` / `migrateV3toV4` / `readStoredStateV4` 与 `OFFICIAL_CLAUDE_PROFILE_ID`；官方字段在存储层留作闲置字段（D-4 ①）。
- 不删 `oauthAccount` 剥离、残留 `.credentials.json` 清理、`isOfficialClaudeMode` / `buildOfficialClaudeProviderConfig`（旧格式读取仍依赖）。
- 不改 runner（THESIS-04 已完成）、接口封口（THESIS-02）与前端供应商编辑器（THESIS-03）。
- 不动数据库表结构（THESIS-14）、Docker 模式、IM 渠道。

## 6. 风险与回滚

- **凭据存储是全仓最敏感的代码之一**：只删官方专用函数与分支，不改 V5 结构；本包单独提交。
- **存量官方型供应商**：按 D-1 ① 由用户先在界面删除；未删除时本包让官方 OAuth 不再产生凭据，与 THESIS-04 的"缺 Base URL 报错"一致，不损坏数据。
- **工作区 env 存量文件**：可能残留 `claudeCodeOauthToken` 键，裁剪后无任何读取方；代理不读写 `data/`，不做迁移。
- **回滚**：`git revert <提交号>`；无数据迁移，回滚零额外操作。
