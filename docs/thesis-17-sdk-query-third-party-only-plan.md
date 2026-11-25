# 任务立项：THESIS-17 一次性模型调用 `sdkQuery` 只剩第三方路径

> 立项日期：2026-11-25｜base：`5a47254`（main tip，纪律文档瘦身与收尾任务池合入）｜分支：`claude/thesis-17-sdk-query-third-party-only`
> 来源：[docs/issues3/THESIS-17-sdk-query-third-party-only.md](issues3/THESIS-17-sdk-query-third-party-only.md)

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-Q1 选 ①**：不统一"已配置"的两种聚合口径。本包只去掉 `sdkQuery` 的官方路径；`auth.ts` 继续扫描全部启用供应商（保留其 V3→V4 迁移兼容注释的既有动机），`bug-report` / Agent Profile 继续只看 `getClaudeProviderConfig()`。差异只在"多个第三方供应商、默认那个缺凭据"时出现，交付记录说明，不改 `/api/auth/me` 语义。
- **完成条件**：没有 Base URL 时 `sdkQuery` 返回 `null`，且不调用 `setRuntimeApiKey`、不读取内置 `anthropic` 模型目录；有 Base URL 时仍注册 `ckqclaw-*` provider（回归）；`git grep -n "setRuntimeApiKey" -- src` 无结果；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改 Runner（THESIS-04 已收口）、不改供应商存储格式（D-4 ①）、不改 `splitModelRef` 对无前缀模型名补 `anthropic` 的约定、不改各调用方对 `null` 的降级方式。

## 1. 执行前核实（base `5a47254`）

| 项               | 复核结论                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 官方分支位置     | `git grep -n -E "setRuntimeApiKey\|getModels\('anthropic'" -- src` 只命中 `src/sdk-query.ts:66`（`setRuntimeApiKey`）与 `:71`（`getModels('anthropic')`）；Runner 侧无命中，THESIS-04 已收口                                         |
| `resolveModel`   | `src/sdk-query.ts:31`：有 Base URL 时注册 `ckqclaw-<providerId>`（`:38-63`）并返回模型（`:62`）；无 Base URL 时设置官方 runtime key（`:65-70`），无模型时取内置目录首个（`:71`），否则按 `providerId/modelId` 取内置目录（`:72-73`） |
| 异常出口         | `sdkQuery`（`:93`）在 `try` 内调用 `resolveModel`，任何异常由 `catch` 记 `logger.warn` 后返回 `null`（`:163-168`）                                                                                                                   |
| `/recall` 调用方 | `src/index.ts:3635` 调 `summarizeWithClaude`，`null` 时 `:3646` 记日志并回落原始消息（`getConversationContext`）                                                                                                                     |
| 标题生成调用方   | `src/index.ts:3700`，`:3701` `if (!raw) return` 跳过标题                                                                                                                                                                             |
| 任务解析调用方   | `src/routes/tasks.ts:1059`，`:1064-1067` `null` 时把任务置 `paused` 并记日志                                                                                                                                                         |
| 另两处调用方     | `src/routes/bug-report.ts:435`（调用前 `:76-84` 检查 Base URL 与凭据）、`src/agent-profile-generator.ts:217`/`:251`（调用前 `:34-41` 的 `hasUsableClaudeProvider`）——不会走到官方分支                                                |
| 配置来源         | `sdkQuery` 用 `getClaudeProviderConfig()`：优先 `defaultProviderId`，其次第一个启用供应商，再次第一个；`auth.ts:102` 则扫描全部启用供应商。D-Q1 ① 保留该差异                                                                         |

## 2. 方案（TDD）

1. **Red**：新增 `tests/sdk-query-third-party-only.test.ts`，mock `@earendil-works/pi-coding-agent`、`../src/runtime-config.js`、`../src/config.js` 与 `../src/logger.js`，直接驱动 `sdkQuery`：
   - 无 Base URL、空模型名、带官方 `anthropicApiKey`：返回 `null`；断言 `setRuntimeApiKey`、`getModels`、`registerProvider` 均未调用，并记录 `logger.warn`。旧实现会调用 `setRuntimeApiKey` 与 `getModels`，用例按预期失败。
   - 有 Base URL + 模型引用 `zai/glm-4.6`：断言 `registerProvider('ckqclaw-zai', { baseUrl, api: 'anthropic-messages', apiKey })` 被调用、`getModel('ckqclaw-zai', 'glm-4.6')` 返回模型、会话收到 prompt、全程未调用官方开关注入（回归）。
2. **Green**：`resolveModel` 先取 `config.anthropicBaseUrl.trim()`，为空直接抛错（"需要第三方供应商的 Base URL"），删除官方分支（`setRuntimeApiKey` 与内置目录回退）；异常由 `sdkQuery` 现有 `catch` 转为 `null` 并记日志。
3. **Refactor**：错误文案与注释收口，保持 `splitModelRef` 与第三方注册参数不变。
4. **门禁**：`npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-17-sdk-query-third-party-only-plan.md`、`docs/issues3/THESIS-17-sdk-query-third-party-only.md`、`docs/issues3/README.md`、`docs/审查记录.md`、`src/sdk-query.ts`、`tests/sdk-query-third-party-only.test.ts`。

D-Q1 ① 不新增 `src/runtime-config.ts` 等四个源文件，故未列入。

## 4. 验收条件

1. 无 Base URL 时 `sdkQuery` 返回 `null`，不调用 `setRuntimeApiKey`、不读取 `getModels('anthropic')`；有 Base URL 的第三方路径回归用例通过。
2. `git grep -n "setRuntimeApiKey" -- src` 无结果。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 人工冒烟（用户，交付后）：第三方供应商下 `/recall`、AI 解析定时任务、对话标题生成照常工作。

## 5. 非目标

- 不改 Runner、供应商存储格式、`splitModelRef` 约定与各调用方 `null` 降级。
- 不统一"已配置"聚合口径（D-Q1 ①），不碰 `src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts`、`src/runtime-config.ts`。
- 不改 `docs/API.md`（`setupStatus` 语义不变）。
- 不做实机验收。

## 6. 风险与回滚

- **唯一行为变化**：默认供应商没有 Base URL 时，回顾摘要、对话标题、任务解析从"尝试走官方"变为"不发请求并记日志"。D-1 ① 之后这本来就是坏配置。
- **测试夹具风险**：`sdkQuery` 依赖 Pi 模块与文件系统，用例全部 mock runtime、session 与 DATA_DIR，不触碰真实凭据或网络；`fs.mkdirSync` 用临时目录并 spy 掉，避免写盘。
- **回滚**：`git revert <提交号>`；无数据与 schema 变更。
