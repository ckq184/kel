# 任务立项：THESIS-03 供应商（二）：界面只剩第三方表单

> 立项日期：2026-11-24｜base：`17113e9`（main，含 THESIS-01、THESIS-02）｜分支：`claude/thesis-03-provider-ui`
> 来源：[docs/issues2/THESIS-03-provider-ui.md](issues2/THESIS-03-provider-ui.md)（方案 §5 T2、§11.2）

## 0. 需求采访结论

- **目标**：设置页的供应商编辑器与首次启动引导页 `/setup/providers` 只剩第三方表单；没有"官方"选项、OAuth 流程、官方模型选择与订阅用量条；前端类型按 D-4 ① 收窄。
- **完成条件**：契约用例全绿；`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；用户人工验收设置页与引导页。
- **约束**：不改后端（THESIS-02 已完成接口封口）、runner（THESIS-04）、凭据写入（THESIS-05）、`data/`、存储格式；不删 `BalancingConfig`、`withAgentContextSource`（方案 §11.5 已撤销 D-H1）。
- **需用户决策**：无。D-4 已在 THESIS-02 拍板为 ①（存储层保留 `official`，只收窄接口与界面）；本包不重新决策。D-1 ① 的操作前提（用户在旧界面删除存量官方型供应商）已在 THESIS-02 交付记录登记，本包按同一前提执行。

## 1. 关键事实（开工前核实，2026-11-24）

- **前端 official 取值只剩这些落点**（`git grep`，范围 `web/src`、`tests/`）：
  - `ProviderEditor.tsx`：`ProviderType`、`OfficialAuthTab`、类型切换（创建模式）、官方认证三页、OAuth 流程、官方模型选择、保存时的官方凭据分支；
  - `SetupProvidersPage.tsx`：`ProviderMode`（默认 `official`）、官方认证三页、OAuth 流程、`handleFinish` 的官方创建分支；
  - `ProviderList.tsx`：官方/第三方标签、`UsageBars` 挂载、`provider.type === 'third_party'` 条件；
  - `settings/types.ts`：`type: 'official' | 'third_party'`、官方凭据展示字段、`CachedOAuthUsage`/`OAuthUsageBucket`/`OAuthUsageResponse`；
  - `web/src/types.ts`：`ModelConfigOption.type`。
- **THESIS-02 的接口现状**：创建 Schema 只接受 `third_party`；`claudeCodeOauthToken`/`claudeOAuthCredentials` 输入已摘除；OAuth 与订阅用量三条路由已删除。前端仍调用它们，提交会得到 400/404，属方案预期的过渡态。
- **`UsageBars` / `CachedOAuthUsage` / `OAuthUsageResponse` / `oauthState` / `officialTab` 的调用方**：全在待改的两个组件与 `settings/types.ts` 内；`web/src/pages/UsagePage.tsx:335` 只有一句注释提到 `UsageBars`（页面本身归 THESIS-06 删除，本包不动）。
- **官方凭据展示字段**（`hasClaudeCodeOauthToken`、`claudeCodeOauthTokenMasked`、`hasClaudeOAuthCredentials`、`claudeOAuthCredentialsExpiresAt`、`claudeOAuthCredentialsAccessTokenMasked`）只被 `ProviderEditor` 的官方块与 `ProviderList` 的 `CredentialBadges` 使用。官方块删除后，按方案 §11.2"settings/types.ts（官方与 OAuth 的类型字段）"的清扫口径一并从 `UnifiedProviderPublic` 与列表凭据徽章中删除；第三方仍保留 `Auth Token` / `API Key` 两个徽章（`anthropicApiKey` 是共用字段，方案 §5.6）。
- **测试影响**：
  - `tests/frontend-settings-information-architecture.test.ts` 的"offers supported official model aliases"断言官方模型下拉，随功能删除；
  - `tests/pi-runtime-settings-and-credentials.test.ts` 的"official auth tabs carry the Pi bearer note (⑥)"断言官方认证页文案，随功能删除；
  - `tests/issue24-provider-multi-custom-headers.test.ts` 断言 `manageCustomHeaders: providerType === 'third_party'`，收口后改为常量 `true`（意图不变：请求头编辑器只服务第三方）；
  - `tests/api-route-caller-contract.test.ts` 有 3 条 `THESIS-03` 的 `KNOWN_GAPS`（OAuth start/callback、usage），前端调用方删除后按机制删除条目；
  - `tests/no-duplicate-helpers-contract.test.ts:380` 的 `OAuthUsageBucket` 唯一性断言只扫描 `src`、`shared`、`container/agent-runner/src`（`SOURCE_DIRS` 不含 `web`），删除前端声明不会打红。issue 的"执行前核实"预期不成立，交付记录写明；不改该用例。
- **红线**：不读不写 `data/`；不改后端与存储格式；不扩大范围到用量页（THESIS-06）、聊天容器环境变量面板（THESIS-05）、权限体系（THESIS-11）。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-03-provider-ui.test.ts`（源码契约）：
   - `ProviderEditor.tsx`、`SetupProvidersPage.tsx` 不再出现 `'official'` / `providerMode` / `oauth/start` / `oauth/callback` / `officialTab`；
   - 两个组件仍提交 `type: 'third_party'`，引导页保留第三方三必填字段；
   - `UsageBars.tsx` 不存在，`ProviderList.tsx` 不再引用 `UsageBars`、不出现"官方"标签；
   - `settings/types.ts` 不再声明三个 OAuth 用量类型，`UnifiedProviderPublic.type` 与 `ModelConfigOption.type` 收窄为 `'third_party'`。
2. **Green**：
   - `ProviderEditor.tsx`：删类型切换、官方认证三页、OAuth 流程、官方模型选择与官方保存分支；所有第三方条件改为无条件；创建/编辑只走第三方路径。
   - `SetupProvidersPage.tsx`：删模式切换与官方认证/OAuth/官方创建；`handleFinish` 只校验第三方三必填；默认且唯一表单为第三方。
   - `UsageBars.tsx`：整文件删除；`ProviderList.tsx` 去掉挂载、官方/第三方标签、`type` 条件与官方凭据徽章。
   - `settings/types.ts`：删 OAuth 用量三类型与官方凭据展示字段，`type` 收窄；`web/src/types.ts` 的 `ModelConfigOption.type` 收窄。
3. **测试同步**：按 §1 的测试影响逐项处理，并删除 `api-route-caller-contract` 的三条白名单。
4. **前端清扫（方案 §11.4）**：可达性、死导出、入口、依赖、文案、图标逐项过一遍；`web/package.json` 无只服务官方界面的包。
5. **验证**：`npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`；`make build` 由 verify 覆盖。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-03-provider-ui.md`、`docs/issues2/README.md`、`docs/thesis-03-provider-ui-plan.md`、`docs/审查记录.md`、`web/src/components/settings/ProviderEditor.tsx`、`web/src/pages/SetupProvidersPage.tsx`、`web/src/components/settings/UsageBars.tsx`、`web/src/components/settings/ProviderList.tsx`、`web/src/components/settings/types.ts`、`web/src/types.ts`、`tests/**`。

不含后端文件、`web/package.json`/lockfile、`docs/API.md`（接口文档已在 THESIS-02 同步，本包不改接口）。

## 4. 验收条件

1. 契约用例全绿；`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 方案 §11.4 清扫检查项通过：无不可达非测试文件、无死导出、无被裁入口、无残留依赖/文案/图标。
3. 人工验收（用户）：设置页供应商列表没有"官方"标签；新建与编辑供应商只有第三方表单；引导页 `/setup/providers` 没有"官方渠道"，用第三方端点能完成引导。

## 5. 非目标

- 不改后端、runner、凭据写入、容器环境变量面板（THESIS-04/05）。
- 不改存储格式、迁移链、数据库。
- 不删 `BalancingConfig`、`withAgentContextSource`（方案 §11.5）。
- 不删除用量页、模型单价页（THESIS-06/08），不改用量页内提到 `UsageBars` 的注释。
- 不读不写 `data/`；不代替用户做存量官方供应商清理与最终验收。

## 6. 风险与回滚

- **存量官方供应商**：D-1 ① 的前提是用户在旧界面删除；若未删除，列表仍会显示该条目（后端存储保留 `official`），但编辑器会按第三方表单呈现、官方凭据无法再更新。这与 THESIS-02 的过渡行为一致，不会损坏数据。
- **类型收窄是前端断言**：`UnifiedProviderPublic.type`、`ModelConfigOption.type` 收窄为 `third_party` 只影响前端类型；后端响应仍可能是 `official`（D-4 ①），属于预期。
- **测试面较小**：前端契约测试以源码 grep 为主，行为回归靠 `make build` 与现有第三方用例；人工验收由用户执行。
- **回滚**：实现与交付各一笔提交，`git revert <提交号>`。
