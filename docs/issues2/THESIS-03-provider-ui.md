# THESIS-03 供应商（二）：界面只剩第三方表单

| 字段          | 值                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                        |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                             |
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

（交付时填写）
