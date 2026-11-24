# 任务立项：THESIS-02 供应商（一）：接口封口

> 立项日期：2026-11-24｜base：`11eeeae`｜分支：`claude/thesis-02-provider-api-seal`
> 来源：[docs/issues2/THESIS-02-provider-api-seal.md](issues2/THESIS-02-provider-api-seal.md)（方案 §5 T1，审核更正 S3）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：接口层不再接受、不再提供官方 Claude 能力：创建官方型供应商被拒，OAuth 与订阅用量路由下线，"是否已配置供应商"的判断只认第三方。
- **完成条件**：`type: 'official'` 创建返回 400；三个 OAuth/用量路由返回 404；三处"已配置"判断对"Base URL + Auth Token"与"Base URL + API Key"都返回已配置、对空配置返回未配置；第三方增删改查与健康检查回归通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改 `claude-provider.json` 存储格式（version 5）与迁移链；不改前端（THESIS-03）、runner（THESIS-04）、凭据写入（THESIS-05）；`data/` 不读不写。

| #   | 问题                                       | 拍板                                                                                                                                                                                                                                              |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | 存量数据里的官方型供应商                   | ① 用户先在当前界面删除，再使用裁剪版。本包零代码处理；代理不读 `data/`，存量由用户确认。                                                                                                                                                          |
| D-4 | 供应商类型声明怎么收窄                     | ① 存储层保留 `official` 取值（`StoredProviderV4`、`UnifiedProvider`、`UnifiedProviderPublic`），只收窄 HTTP 输入 Schema；存储版本保持 5，V2/V3→V5 迁移链不动。                                                                                    |
| —   | 接口封口是否连 `claudeCodeOauthToken` 输入 | ① 一并摘掉：create/secrets 输入不再接受 `claudeCodeOauthToken`、`clearClaudeCodeOauthToken`、`claudeOAuthCredentials`、`clearClaudeOAuthCredentials`；`anthropicApiKey` 是共用字段，保留。底层 `updateProviderSecrets` 的官方分支留给 THESIS-05。 |

> D-1 ① 的实施前提：**用户在切换到裁剪版之前，先在当前界面删除官方型供应商**。若未删除，本包之后官方供应商仍会出现在列表中（D-4 ① 存储层保留），但其 OAuth 凭据无法再通过接口更新，三处"已配置"判断也不会把它算作已配置；不会损坏数据。

## 1. 关键事实（开工前核实）

- **V-4（官方鉴权失败文案）**：`src/provider-failure.ts:4-26` 的提示与 `PERMANENT_AUTH_ERROR_PATTERNS` 是通用错误分类，第三方端点同样会命中（`401`、`invalid x-api-key` 等），**保留不删**。
- **V-6（健康检查）**：`/claude/providers/health` 与 `/claude/providers/:id/reset-health` 走 `getEnabledProviders()` + `providerPool`，没有 `type === 'official'` 分支，本包不需要改。
- **三处"已配置"判断的现状**：
  - `src/routes/auth.ts:106-115`：`hasOfficial` 把 `claudeCodeOauthToken`、`claudeOAuthCredentials`、`anthropicApiKey` 都算作已配置；`hasThirdParty` 只认"Base URL + Auth Token"。
  - `src/routes/bug-report.ts:76-81`：只认 `anthropicApiKey || claudeCodeOauthToken || claudeOAuthCredentials`，只配第三方的用户已被判为不可用（存量缺陷），**必须改写不能只删**。
  - `src/agent-profile-generator.ts:29-37`：`anthropicApiKey || anthropicAuthToken || claudeCodeOauthToken || claudeOAuthCredentials`。
  - 统一后的第三方判定：**有 Base URL，且有 Auth Token 或 API Key**。
- **调用方核实**：`oauthFlows`、`fetchOAuthUsage`、`ClaudeOAuthCredentialsSchema`、`parseOAuthUsageBucket` 全仓（含 `tests/`、`docs/`）没有测试或文档调用；`updateAllSessionCredentials`、`closeAllActiveForCredentialRefresh` 的全仓调用方只有 `src/routes/config.ts:1127-1128`、`:1547-1548`，都在本包删除/改写的路由里，函数本体按方案留给 THESIS-05。
- **测试面**：`tests/unified-provider-third-party-baseurl.test.ts` 有 3 个 official 用例（schema 放行、PATCH 放行、secrets 补 token 放行）需要按收窄后语义改写；`tests/agent-profile-generator.test.ts` 的 mock 只返回 `anthropicApiKey`，需补 Base URL；`tests/routes-provider-runtime-apply.test.ts`、`tests/runtime-config-default-provider.test.ts`、`tests/routes-agent-profiles.test.ts` 用 `runtimeConfig.createProvider({ type: 'official' })` 做夹具，D-4 ① 下仍可编译，涉及接口语义的用例按实际行为改写。
- **用量类型留在 `src/runtime-config.ts`**：`OAuthUsageResponse`、`OAuthUsageBucket`、`CachedOAuthUsage`、`parseOAuthUsageBucket` 只被即将删除的 `fetchOAuthUsage` 使用。它们不在 issue 的预计改动路径内，且 `src/runtime-config.ts` 正被并行的 THESIS-04 触碰；本包不删这四个导出，作为既有死导出的遗留登记，避免扩大范围与并行冲突。
- **文档**：`docs/API.md:290`、`:295-296` 三行需要删除；`docs/ACL-MATRIX.md` 没有逐路由的 Provider 行（只有 `:202` 的权限口径"Provider、系统容量… → `manage_system_config`"），该口径不变。
- **红线**：不读不写 `data/`；不改存储格式/迁移；不动前端、runner、`.credentials.json` 写入与会话凭据刷新函数本体。

## 2. 实现步骤（TDD）

1. **Red**：
   - 新增 `tests/thesis-02-provider-api-seal.test.ts`：
     - `POST /claude/providers`（`configRoutes`）携带 `type: 'official'` 返回 400；
     - `GET /claude/providers/:id/usage`、`POST /claude/oauth/start`、`POST /claude/oauth/callback` 返回 404；
     - `GET /api/auth/me`（admin）对"Base URL + Auth Token"、"Base URL + API Key"返回 `setupStatus.claudeConfigured === true`，对空配置返回 `false`；
     - `GET /api/bug-report/capabilities` 的 `claudeAvailable` 对上述两种第三方配置为 `true`、对空配置为 `false`；
     - `UnifiedProviderSecretsSchema` 拒绝只带 `claudeCodeOauthToken` 的请求。
   - 更新 `tests/agent-profile-generator.test.ts`：可用夹具补 Base URL；新增"只有官方字段、没有 Base URL → 报未配置"的用例。
2. **Green**：
   - `src/schemas.ts`：`UnifiedProviderCreateSchema.type` 只接受 `third_party`；create/secrets 输入删除四个官方凭据字段；删除 `ClaudeOAuthCredentialsSchema`；
   - `src/routes/config.ts`：删除 `oauthFlows`、`fetchOAuthUsage`、三条路由及 OAuth 常量/缓存/定时器/未使用的 crypto 导入；PATCH 与 secrets 的合并态校验去掉 `previous.type === 'third_party'` 前提；删除 secrets handler 的官方凭据分支与 `updateAllSessionCredentials` 调用；
   - `src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts`：三处判断改为"Base URL && (Auth Token || API Key)"。
3. **测试同步**：按收窄语义改写 official/OAuth 用例；跑全量 vitest，确认没有连带打红。
4. **文档**：删除 `docs/API.md` 三行路由；`npm run docs:check`。
5. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-02-provider-api-seal.md`、`docs/issues2/README.md`、`docs/thesis-02-provider-api-seal-plan.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`docs/审查记录.md`、`src/schemas.ts`、`src/routes/config.ts`、`src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts`、`tests/**`。

不含 `src/runtime-config.ts`（存储格式、类型 union、用量类型与函数本体都不动）。

## 4. 验收条件

1. 携带 `type: 'official'` 的创建请求返回 400；三条 OAuth/用量路由返回 404。
2. 三处"已配置"判断对"Base URL + Auth Token"和"Base URL + API Key"都返回已配置，对空配置返回未配置。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 非目标未被实现：`src/runtime-config.ts`、存储格式、迁移代码、前端、runner、`.credentials.json` 写入均无改动。

## 5. 非目标

- 不改 `claude-provider.json` 的存储格式（version 5），不删 V2/V3→V4→V5 迁移代码。
- 不改前端（THESIS-03）、runner（THESIS-04）、凭据写入与会话凭据刷新（THESIS-05）。
- 不改第三方增删改查、健康检查、`/claude/balancing`、`/claude/apply`。
- 不删 `src/runtime-config.ts` 里的用量类型/解析器（不在本包路径，登记为遗留）。
- 不读不写 `data/`；不代替用户做存量清理与最终验收。

## 6. 风险与回滚

- **过渡状态**：前端（THESIS-03 之前）仍显示官方选项，提交会得到 400；OAuth 页面调用会得到 404。这是方案预期的过渡状态，不是回归。
- **存量官方供应商**：按 D-1 ① 由用户在执行本包后、切换裁剪版前删除；本包不改读取逻辑，不静默丢弃任何存量数据。
- **测试夹具**：多条测试直接调用 `runtimeConfig.createProvider({ type: 'official' })`；D-4 ① 下类型仍可编译，只改写与接口语义冲突的断言，避免无关大改。
- **回滚**：实现一到两笔独立提交，`git revert <提交号>`；无数据迁移，回滚零额外操作。
