# THESIS-02 供应商（一）：接口封口，不再接受官方型与 OAuth

| 字段          | 值                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                   |
| 领取人 / 分支 | THESIS-02 会话 / `claude/thesis-02-provider-api-seal`                                                                                                                                                                                                    |
| 优先级        | P1                                                                                                                                                                                                                                                       |
| 类型          | 裁剪（后端接口）                                                                                                                                                                                                                                         |
| 依赖          | 无                                                                                                                                                                                                                                                       |
| 阻塞          | THESIS-05（凭据刷新函数的调用方在本包删除）                                                                                                                                                                                                              |
| 可并行        | ✅ 01、03、04、06、07、08、09、15。⚠️ 12（`src/routes/auth.ts` 不同函数）；13（`docs/ACL-MATRIX.md`）。❌ 05（依赖本包）；10、11（同改 `src/routes/config.ts`、`src/routes/auth.ts`）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `src/schemas.ts`、`src/routes/config.ts`、`src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts`、`docs/API.md`、`docs/ACL-MATRIX.md`、`tests/**`                                                                            |
| 需用户决策    | **是**：D-1（存量官方型供应商怎么处理）、D-4（类型怎么收窄）                                                                                                                                                                                             |
| 来源          | 方案 §5（T1），审核更正 S3                                                                                                                                                                                                                               |

## 目标

接口层不再接受、不再提供官方 Claude 能力：创建官方型供应商被拒，OAuth 与订阅用量路由下线，"是否已配置供应商"的判断只认第三方。

## 范围（锚点为 `d6e04aa`）

1. **Schema 收窄**：`UnifiedProviderCreateSchema`（`src/schemas.ts:900`）的 `type` 枚举（:903）只接受 `third_party`；删除 `ClaudeOAuthCredentialsSchema`（:781）及其只被官方路径使用的引用。
2. **删除路由**（`src/routes/config.ts`）：`oauthFlows`（:657）、`fetchOAuthUsage`（:683）、`GET /claude/providers/:id/usage`（:1328）、`POST /claude/oauth/start`（:1398）、`POST /claude/oauth/callback`（:1439）。
3. **合并态校验改为无条件**：PATCH 与 secrets 两个 handler 的校验（:907-925、:1071-1094）去掉 `previous.type === 'third_party'` 前提，对所有供应商生效。
4. **三处"已配置"判断**（审核更正 S3，注意不是四处）：
   - `src/routes/auth.ts:105-115` `buildSetupStatus`：去掉 `claudeCodeOauthToken`、`claudeOAuthCredentials`。`anthropicApiKey` 是共用字段（runner 第三方分支以 `apiKey || authToken` 注册，`pi-provider.ts:180`），判断改为"有 Base URL，且有 Auth Token 或 API Key"，不能误伤"Base URL + API Key"的第三方配置。
   - `src/routes/bug-report.ts:77-81`：它现在只认官方凭据，只配第三方的用户已经被判为不可用（存量缺陷）。**改写**为与上面相同的第三方判定，不能只删。
   - `src/agent-profile-generator.ts:29-37` `hasUsableClaudeProvider`：去掉两个官方字段，判定口径与上面统一。
   - `src/routes/groups.ts:2565-2566` 不属于本包（它是工作区容器环境变量的写入，归 THESIS-05 的 D-3）。
5. **OAuth 回调里的凭据刷新调用**（:1546-1549）随路由一起删除；secrets handler 里 `claudeOAuthCredentials` 分支（:1126-1129）随 Schema 收窄失去入口，一并删除。`updateAllSessionCredentials`、`closeAllActiveForCredentialRefresh` 的函数本体留给 THESIS-05。
6. **文档**：`docs/API.md` 中三个路由和官方字段的说明，`docs/ACL-MATRIX.md` 中对应的行。

## 非目标

- 不改 `claude-provider.json` 的存储格式（version 5），不删 V2/V3→V4→V5 的迁移代码（方案 §5.6）。
- 不改前端（THESIS-03）、runner（THESIS-04）、凭据写入（THESIS-05）。
- 不改第三方的增删改查、健康检查、`/claude/balancing`、`/claude/apply`。

## 需用户决策（领取前拍板）

| #   | 问题                     | 选项                                                                       | 方案默认 |
| --- | ------------------------ | -------------------------------------------------------------------------- | -------- |
| D-1 | 存量数据里的官方型供应商 | ① 用户先在界面删除，再用裁剪版；② 加载时忽略并告警；③ 加载时拒绝启动       | ①        |
| D-4 | 类型声明怎么收窄         | ① 存储层保留 `official` 取值，只收窄接口与界面；② 存储层一并收窄并升版迁移 | ①        |

D-1 选 ① 时，用户需要在执行本包**之前**在旧版界面删除官方型供应商；存量情况代理不读（`data/` 是敏感区），由用户确认（方案 V-3）。

## 执行前核实

- **V-4**：`src/provider-failure.ts:13` 起的官方鉴权失败文案是否被第三方路径复用。复用的不删。
- **V-6**：`/claude/providers/health`、`/claude/providers/:id/reset-health` 对官方型供应商的处理。
- 删除前对 `oauthFlows`、`fetchOAuthUsage`、`ClaudeOAuthCredentialsSchema`、`CachedOAuthUsage` 做一次 `git grep -w`，范围包含 `tests/`。

## 实现步骤（TDD）

1. **Red**：
   - `type: 'official'` 的创建请求返回 400；
   - `POST /api/config/claude/oauth/start`、`POST /api/config/claude/oauth/callback`、`GET /api/config/claude/providers/:id/usage` 返回 404；
   - 只配了"Base URL + Auth Token"或"Base URL + API Key"的第三方供应商，`GET /api/auth/me` 返回的 `setupStatus.claudeConfigured`、bug-report 的可用性、Agent Profile 生成器的可用性都判为已配置；
   - 第三方供应商的创建、修改、密钥更新、健康检查回归用例保持通过。
2. **Green**：按范围 1 至 5 修改。
3. **测试同步**：按方案 §5.10 改写其中涉及官方或 OAuth 路由的用例（主要是 `tests/routes-provider-runtime-apply.test.ts`、`tests/unified-provider-third-party-baseurl.test.ts`、`tests/runtime-config-default-provider.test.ts`）。

## 验收条件

1. 携带 `type: 'official'` 的创建请求返回 400；三个 OAuth 与用量路由返回 404。
2. 三处"已配置"判断对两种第三方配置都返回已配置，对空配置返回未配置。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 非目标未被实现：存储格式、迁移代码、前端、runner 均无改动。

## 风险与回滚

- 前端在 THESIS-03 之前仍会显示官方选项，提交会得到 400，这是预期的过渡状态。
- **回滚**：`git revert <提交号>`。

## 交付记录

（交付时填写）
