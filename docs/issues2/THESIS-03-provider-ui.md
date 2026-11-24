# THESIS-03 供应商（二）：界面只剩第三方表单

| 字段          | 值                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                        |
| 领取人 / 分支 | THESIS-03 会话 / `claude/thesis-03-provider-ui`                                                                                                                                                                                                               |
| 优先级        | P1                                                                                                                                                                                                                                                            |
| 类型          | 裁剪（前端）                                                                                                                                                                                                                                                  |
| 依赖          | 无。建议在 THESIS-02 之后，两者顺序颠倒也不会出错                                                                                                                                                                                                             |
| 阻塞          | 无                                                                                                                                                                                                                                                            |
| 可并行        | ✅ 01、02、04、05、06、07、09、10、12、13、15。⚠️ 08（`settings/types.ts`、`tests/no-duplicate-helpers-contract.test.ts`）；11（前端权限门涉及的文件未逐一核实）。❌ 14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                        |
| 预计改动路径  | `web/src/components/settings/ProviderEditor.tsx`、`web/src/pages/SetupProvidersPage.tsx`、`web/src/components/settings/UsageBars.tsx`、`web/src/components/settings/ProviderList.tsx`、`web/src/components/settings/types.ts`、`web/src/types.ts`、`tests/**` |
| 需用户决策    | 否（D-4 在 THESIS-02 拍板，本包按其结果收窄前端类型）                                                                                                                                                                                                         |
| 来源          | 方案 §5（T2）、§11.2                                                                                                                                                                                                                                          |

## 目标

设置页的供应商编辑器和首次启动引导页 `/setup/providers` 只有第三方表单，没有"官方"选项、OAuth 流程和订阅用量条。

## 范围（锚点为 `d6e04aa`）

| 部分              | 内容                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 编辑器官方模式 | `ProviderEditor.tsx`：类型切换（:545-600，切换按钮在 :562、:574）、官方模式块（:606-804，含 oauth、setup_token、api_key 三个认证页）、官方模型选择（:970-992）、OAuth 流程（:265-311）、保存时的官方凭据分支（:380 起、:465 起） |
| A2 引导页官方渠道 | `SetupProvidersPage.tsx`：状态（:46-58）、官方创建（:206-258）、渠道切换（:372-390）、官方表单（:394 起，三个认证页 :433、:501、:543）；默认值 :46 改为 `third_party`                                                            |
| A3 订阅用量条     | 删除 `UsageBars.tsx`（122 行）与 `ProviderList.tsx:343` 的挂载；删除 `settings/types.ts` 的 `CachedOAuthUsage`、`OAuthUsageBucket`、`OAuthUsageResponse`（:92-110 一带）                                                         |
| 列表标签          | `ProviderList.tsx:200-205` 的"官方 / 第三方"标签                                                                                                                                                                                 |
| 类型              | `web/src/types.ts:83`、`web/src/components/settings/types.ts:10` 按 D-4 收窄                                                                                                                                                     |

保留：`ProviderEditor.tsx` 的第三方模式块（:806-968）、环境变量与自定义请求头编辑（:993 起，ISSUE-24 刚交付）、`ClaudeProviderSection.tsx:182` 的"复制第三方提供商"。

## 非目标

- 不改后端（THESIS-02、04、05）。
- 不删 `BalancingConfig`、`withAgentContextSource`（审核 S5：前者仍被使用，后者是意图信号；方案已撤销 D-H1）。

## 执行前核实

- 删除 `OAuthUsageBucket` 会让 `tests/no-duplicate-helpers-contract.test.ts:380`（断言全仓恰好声明一次）失败，同步改成断言"不再声明"或删掉该用例，并在交付记录里写明。
- 对 `UsageBars`、`CachedOAuthUsage`、`OAuthUsageResponse`、`oauthState`、`officialTab` 做一次 `git grep -w`，范围包含 `tests/` 与 `web/`。

## 实现步骤（TDD）

1. **Red**：源码契约用例：引导页与编辑器源码不再出现 `official` 分支、OAuth 流程和 `UsageBars`；两处默认模式都是 `third_party`。
2. **Green**：按范围表修改。
3. **前端清扫**：按方案 §11.4 检查可达性（若 THESIS-15 已交付，直接跑它）、死导出、图标导入。

## 验收条件

1. 契约用例全绿；`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 方案 §11.4 清扫检查项通过。
3. **人工验收（用户）**：设置页供应商列表没有"官方"标签；新建与编辑供应商只有第三方表单；引导页 `/setup/providers` 没有"官方渠道"，用第三方端点能完成引导。

## 风险与回滚

- **回滚**：`git revert <提交号>`。

## 交付记录

交付日期 2026-11-24，分支 `claude/thesis-03-provider-ui`，base `17113e9`（main，含 THESIS-01、THESIS-02）。

### 提交

| 提交      | 内容                                                                                         |
| --------- | -------------------------------------------------------------------------------------------- |
| `b2093ef` | 立项：领取、立项计划 `docs/thesis-03-provider-ui-plan.md`、`.gatescope.json`                 |
| `decc279` | 实现：删除编辑器与引导页的官方模式/OAuth/订阅用量条，收窄前端类型，含 Red 契约用例与测试同步 |
| `2d99a6f` | 审查后收紧契约断言与类型注释（只改测试与注释，无实现行为变更）                               |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引、`docs/审查记录.md`                          |

### 实现要点

- `ProviderEditor.tsx`：删除类型切换、官方认证三页（OAuth / Setup Token / API Key）、OAuth 流程、官方模型选择与官方凭据保存分支；创建固定提交 `type: 'third_party'`，编辑只走第三方 PATCH 与 secrets；保留环境变量、自定义请求头、上下文窗口、名称回退与"保存时清空当前密钥"。
- `SetupProvidersPage.tsx`：删除模式切换与官方创建分支，页面直接呈现第三方表单；Base URL 与 Auth Token 必填、模型可选、自定义环境变量保留；删除只被 OAuth 成功提示使用的 `notice` 状态。
- 删除 `UsageBars.tsx`；`ProviderList.tsx` 去掉挂载、官方/第三方标签、`provider.type` 条件与官方凭据徽章，保留 API Key / Auth Token 徽章。
- `settings/types.ts`：`UnifiedProviderPublic.type` 收窄为 `'third_party'`，删除 OAuth 用量三类型与官方凭据展示字段；`web/src/types.ts` 的 `ModelConfigOption.type` 同步收窄；两处注明存储层仍可能返回存量 `official`（D-4 ①）。
- 测试：新增 `tests/thesis-03-provider-ui.test.ts`（9 例源码契约）；删除官方模型别名与官方认证页文案两例；`issue24` 的 `manageCustomHeaders` 断言改为常量并去掉标题里的"官方供应商"；`api-route-caller-contract` 按 THESIS-02 交付记录删除 3 条 `THESIS-03` 的 `KNOWN_GAPS`。

### 验证

- `npm run verify`：6/6 全绿（361 文件，2981 通过 / 23 跳过 / 0 失败，最终轮 49.8s）。
- `node scripts/check-scope.mjs`：15 个路径全在声明范围内，无扩宽。
- 独立规格符合性审查：通过（零阻塞）；独立代码质量审查：通过（Critical 0 / Major 0 / Minor 6），详见 `docs/审查记录.md`。
- 未做实机人工验收，由用户执行：设置页供应商列表无"官方"标签；新建与编辑只有第三方表单；引导页 `/setup/providers` 无"官方渠道"，用第三方端点能完成引导。

### 前端清扫（方案 §11.4）

1. **可达性**：`UsageBars` 只被 `ProviderList` 引用，删除后无新孤儿文件。
2. **死导出**：OAuth 用量三类型、`formatOAuthExpiry` 与官方凭据展示字段已删；`BalancingConfig`、`withAgentContextSource` 未动。
3. **入口**：编辑器、引导页、列表里没有官方选项、OAuth 入口或订阅用量条。
4. **权限与事件**：`UsageBars` 的可见性监听与 3 分钟轮询随文件删除。
5. **依赖**：`web/package.json` 没有只服务官方界面的包，未改 lockfile。
6. **文案与测试**：官方认证/模型文案随功能删除；`issue24` 测试标题去掉"官方供应商"；无新增界面术语测试样例。
7. **图标与样式**：`ExternalLink`、`Key` 不再导入；无专属样式表改动。

### 与 issue 描述的偏差和登记项

- **`tests/no-duplicate-helpers-contract.test.ts:380` 的预期不成立**：该断言的扫描范围是 `src`、`shared`、`container/agent-runner/src`（`SOURCE_DIRS` 不含 `web`）。删除前端 `OAuthUsageBucket` 后用例仍绿，未修改该用例；issue「执行前核实」的"必失败"判断有误。
- **官方凭据展示字段一并删除**：`hasClaudeCodeOauthToken`、`claudeCodeOauthTokenMasked`、`hasClaudeOAuthCredentials`、`claudeOAuthCredentialsExpiresAt`、`claudeOAuthCredentialsAccessTokenMasked` 从 `UnifiedProviderPublic` 与列表徽章删除。issue 范围表只点名 `types.ts:10`，本项按方案 §11.2"settings/types.ts（官方与 OAuth 的类型字段）"的清扫口径执行。
- **类型收窄是前端断言**：后端 wire 仍可能返回 `official`（D-4 ①）；当前无前端代码读取 `provider.type`，字段旁已加注释说明。
- **存量 official 供应商的过渡行为（请用户注意）**：D-1 ① 的前提是先在旧界面删净官方型供应商。若未清理，列表仍会显示该条目，但编辑会要求填写 API 端点、复制会因 schema 拒绝而 400；若它是默认供应商，删除按钮仍禁用，需先新增第三方并设为默认后清理。不会损坏数据。请在做人工验收前确认存量已清理。
- **删除行后的可见性错位**：环境变量/请求头行的"显示/隐藏"按数组下标存储，删除前一行会让后一行继承可见状态。该行为在 base 已存在，不是本包引入，未扩大范围修改。
- **`web/src/pages/UsagePage.tsx:335`** 的注释仍提到已删除的 `UsageBars`；该页归 THESIS-06 删除，本包未动。
- **范围外发现（建议另立任务）**：main `17113e9`（THESIS-01 合入）把三处绝对路径 `node_modules` 符号链接纳入版本库（根、`web/`、`container/agent-runner/`，指向本机主工作树）。之后创建的 worktree 会直接指向主工作树依赖，换机即失效。本包未修改。
- **方案 §2 裁决台账未改**：§5 供应商专题的 THESIS-04、05 尚未完成；按任务池 README 第一节第 6 步，专题内全部 issue 完成后才把台账该专题改为"已裁"并写明提交号。THESIS-03 交付不触发该行变更。
- **人工验收状态**：issue 验收条件第 3 项（设置页无"官方"标签、新建/编辑只有第三方表单、引导页无"官方渠道"）尚未执行，按工作流阶段 8 由用户本人或书面指定验收人完成；本记录不把代理的源码/构建检查冒充为人工验收。
