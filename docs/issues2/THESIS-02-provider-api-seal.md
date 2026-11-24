# THESIS-02 供应商（一）：接口封口，不再接受官方型与 OAuth

| 字段          | 值                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                   |
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

交付日期 2026-11-24，分支 `claude/thesis-02-provider-api-seal`，base `11eeeae`。

### 提交

| 提交      | 内容                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| `52a2552` | 立项：领取、立项计划 `docs/thesis-02-provider-api-seal-plan.md`、`.gatescope.json`           |
| `302514e` | 实现：Schema 收窄、三条路由删除、无条件合并态校验、三处已配置判断改写，含 Red/回归测试与文档 |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引、`docs/审查记录.md`                          |

### 用户拍板（2026-11-24）

1. **D-1 ①**：存量官方型供应商由用户先在当前界面删除，再使用裁剪版；本包零代码处理，代理不读写 `data/`。
2. **D-4 ①**：存储层保留 `official` 取值，只收窄 HTTP 输入 Schema；`claude-provider.json` 保持 version 5，V2/V3→V4→V5 迁移链不动。
3. **官方凭据输入端一并摘除**：create 与 secrets 输入不再接受 `claudeCodeOauthToken`、`clearClaudeCodeOauthToken`、`claudeOAuthCredentials`、`clearClaudeOAuthCredentials`；`anthropicApiKey` 保留为共用字段（runner 第三方分支以 `apiKey || authToken` 注册）。

### 实现要点

- `src/schemas.ts`：`UnifiedProviderCreateSchema.type` 改为 `z.literal('third_party')`；删除 `ClaudeOAuthCredentialsSchema`；create/secrets 摘除四个官方凭据字段；superRefine 改为无条件第三方规则。
- `src/routes/config.ts`：删除 `oauthFlows`、OAuth/用量常量与缓存、两个 `setInterval`、`fetchOAuthUsage`、`node:crypto` 导入；删除 `GET /claude/providers/:id/usage`、`POST /claude/oauth/start`、`POST /claude/oauth/callback`；PATCH 与 secrets 的合并态校验去掉 `previous.type === 'third_party'` 前提；删除 secrets 的官方凭据分支与 `updateAllSessionCredentials` 调用，随之删除只为该分支服务的 `runAfterProviderPersistence`/`ClaudeConfigPersistedError` 及两处 catch（审查确认全仓无其他 thrower）。
- `src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts`：统一为"有 Base URL，且有 Auth Token 或 API Key"；`bug-report` 由只认官方凭据改写为第三方判定，修复"只配第三方被判不可用"的存量缺陷。
- `docs/API.md`：删除三条路由行，补封口说明（只接受第三方端点、密钥端点不再接受官方凭据字段）。
- `tests/api-route-caller-contract.test.ts`：Web 前端仍调用三条已删除路由（THESIS-03 才删界面），按契约测试机制登记三条 `KNOWN_GAPS`（`no-route`，挂 `THESIS-03`）。

### 验证

- 新增 `tests/thesis-02-provider-api-seal.test.ts`（14 例）：Schema 拒官方/剥官方字段、HTTP 创建官方 400、三条路由 404、`setupStatus` 四象限（Base URL+Token、Base URL+API Key、官方-only、空）、PATCH/secrets 无条件校验（含存量 official 夹具）。
- 新增 `tests/thesis-02-bug-report-capability.test.ts`（4 例）：`claudeAvailable` 四象限，逐例重载模块绕过 5 分钟缓存。
- 改写：`tests/unified-provider-third-party-baseurl.test.ts`（官方 schema 放行改拒绝、official PATCH 夹具改 third_party、secrets 补 token 改 400）、`tests/agent-profile-generator.test.ts`（补 Base URL，新增官方-only/空配置拒绝、Auth Token 可用）、`tests/api-route-caller-contract.test.ts`（KNOWN_GAPS）。
- `npm run verify` 六步全绿（361 文件，2971 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 15 个路径全在声明范围内，无扩宽。
- 独立规格符合性审查：通过（零阻塞）；独立代码质量审查：通过（Critical 0 / Major 0 / Minor 5），详见 `docs/审查记录.md`。未做实机验收，由用户执行。

### 与 issue 描述的偏差和登记项

- **未改 `src/runtime-config.ts`**：`OAuthUsageResponse`、`OAuthUsageBucket`、`CachedOAuthUsage`、`parseOAuthUsageBucket` 在删除用量路由后成为死导出，但不在本 issue 预计路径内，且并行的 THESIS-04 会改该文件；登记为遗留，建议在 THESIS-04/05 或后续清扫中处理。
- **D-1 ① 过渡行为（请用户注意）**：若未删除存量 official 供应商，其任何 PATCH 现在都会按第三方规则校验（token-only 的存量 official 会被 400）；其 OAuth 凭据无法再经接口更新；只配 `anthropicApiKey`（无 Base URL）的存量 official 仍可经 secrets 更新该共用字段——这是 D-4 ① 与"apiKey 共用"拍板的直接结果，不是漏封。
- **三处判断的聚合口径**：`auth.ts` 扫描全部 enabled 供应商，`bug-report.ts` 与 `agent-profile-generator.ts` 走 `getClaudeProviderConfig()`（实际 SDK 使用的那份配置）。多供应商且默认供应商异常时可能给出不同结论；D-1 ① 清理官方供应商后基本消失，登记给 THESIS-04/05 评估是否统一。
- **KNOWN_GAPS anti-rot 盲区**：契约测试只检测"路由复活"，不检测"前端调用方消失"；THESIS-03 删除界面调用后，需按其注释手工删除这三条白名单条目。
- **健康检查无专门测试**：`/claude/providers/health`、`/claude/providers/:id/reset-health` 全仓无专门用例，属既有缺口，本包未引入；本包未改这两条路由。
- 未改 `docs/ACL-MATRIX.md`：该文件没有逐路由 Provider 行，只有"Provider → `manage_system_config`"的权限口径，本包未改权限模型。
