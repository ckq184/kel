# THESIS-05 供应商（四）：凭据链清理与工作区官方令牌字段

| 字段          | 值                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                         |
| 领取人 / 分支 | —                                                                                                                                                                                                                              |
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

（交付时填写）
