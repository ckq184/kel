# THESIS-17 一次性模型调用 `sdkQuery` 只剩第三方路径

| 字段          | 值                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                       |
| 领取人 / 分支 | `claude/thesis-17-sdk-query-third-party-only`                                                                                                                |
| 优先级        | P1                                                                                                                                                           |
| 类型          | 裁减收尾（被裁路径的残留分支）                                                                                                                               |
| 依赖          | 无                                                                                                                                                           |
| 可并行        | ✅ 16、ISSUE-26。⚠️ 18（D-Q1 选 ② 时同改 `src/runtime-config.ts`）（口径见 [README 第三节](README.md#三并行关系)）                                           |
| 预计改动路径  | `src/sdk-query.ts`、`tests/**`；D-Q1 选 ② 时另加 `src/runtime-config.ts`、`src/routes/auth.ts`、`src/routes/bug-report.ts`、`src/agent-profile-generator.ts` |
| 需用户决策    | 已拍板：D-Q1 ①（2026-11-25）                                                                                                                                 |
| 来源          | THESIS-04 交付记录"`sdkQuery` 残留官方路径"；THESIS-02 交付记录"三处判断的聚合口径"                                                                          |

## 目标

THESIS-04 按 D-2 ② 让 Agent 主路径只剩第三方：宿主要求必须有 Base URL，Runner 遇到 official 直接报错。宿主进程内的一次性模型调用 `sdkQuery` 没有跟上：没有 Base URL 时，它仍会给 Pi 设置 `anthropic` 官方运行时密钥，并使用内置的官方模型目录。本包让它与 D-2 ② 一致：没有 Base URL 就不发请求。

## 现状（`68a57de`）

- `src/sdk-query.ts:31` `resolveModel`：有 Base URL 时注册第三方 provider（`:38-63`）；没有时走官方分支——`setRuntimeApiKey('anthropic', ...)`（`:65-70`），未配模型时取 `runtime.getModels('anthropic')[0]`（`:71`），否则按 `providerId/modelId` 取内置目录（`:72-73`）。
- `sdkQuery`（`:93`）在 `try` 里调用 `resolveModel`，任何异常都被 `catch` 记日志后返回 `null`（约 `:163-169`）。
- 调用方共 6 处，都已经处理 `null`：
  - `src/index.ts:3662` `summarizeWithClaude`（`/recall` 摘要，可用 `RECALL_MODEL` 覆盖模型；`null` 时回落为原始消息）、`:3700`（对话标题生成；`null` 时跳过）；
  - `src/routes/tasks.ts:1059`（后台 AI 解析定时任务；`null` 时把任务置为 `paused` 并记日志）；
  - `src/routes/bug-report.ts:435`、`src/agent-profile-generator.ts:217`、`:251`——这两处调用前已经检查 Base URL（`bug-report.ts:80`、`agent-profile-generator.ts:34`），不会走到官方分支。
- 实际会走到官方分支的只有 `index.ts` 两处和 `tasks.ts`，前提是默认供应商没有 Base URL。D-1 ① 要求用户先删掉官方供应商，所以正常部署下这条分支已经不可达。

另一个登记项（THESIS-02）：判断"供应商已配置"有两种聚合口径——`src/routes/auth.ts:102` 扫描全部启用的供应商；`bug-report.ts:80`、`agent-profile-generator.ts:34` 只看 `getClaudeProviderConfig()` 返回的那一份（也就是 `sdkQuery` 实际使用的配置）。多个供应商且默认那个缺凭据时，两边结论可能不同。

## 非目标

- 不改 Runner（THESIS-04 已收口）。
- 不改供应商存储格式（D-4 ①）。
- 不改 `splitModelRef` 对无前缀模型名补 `anthropic` 的约定：第三方分支用它拼 `ckqclaw-<providerId>` 的 provider 名，与官方无关。
- 不改各调用方对 `null` 的降级方式；只在执行前核实里确认它们都已降级。

## 需用户决策（领取前拍板）

| #    | 问题                                 | 选项                                                                                                                                                            | 建议 |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D-Q1 | "已配置"判断的两种聚合口径要不要统一 | ① 不统一，在交付记录说明差异（官方供应商删除后差异只在"多个第三方供应商、默认那个缺凭据"时出现）；② 抽一个共用判断函数，三处都按 `getClaudeProviderConfig()` 判 | ①    |

选 ② 会改变 `GET /api/auth/me` 里 `setupStatus.claudeConfigured` 的语义（从"任一启用的供应商可用"变为"默认供应商可用"），需要同步 `docs/API.md` 并补用例。

**拍板（2026-11-25）**：D-Q1 ①。三处判断保持现状，差异写入交付记录。

## 执行前核实

- 重新确认上面三处调用方对 `null` 的降级（回落原始消息、跳过标题、任务置为 `paused`）在领取时仍然成立。不成立就停下报告，不在本包里改调用方。
- `git grep -n -E "setRuntimeApiKey|getModels\('anthropic'" -- src` 确认官方分支只在 `src/sdk-query.ts`。

## 实现步骤（TDD）

1. **Red**：新增 `sdkQuery` 用例——没有 Base URL 时返回 `null`，且不调用 `setRuntimeApiKey`、不读取内置 `anthropic` 模型目录；有 Base URL 时仍注册 `ckqclaw-*` provider（回归）。
2. **Green**：`resolveModel` 在没有 Base URL 时直接抛出明确错误（例如"需要第三方供应商的 Base URL"），删除官方分支；由 `sdkQuery` 现有的 `catch` 转为 `null` 并记日志。
3. D-Q1 选 ② 时，再补共用判断函数及三处调用方的用例。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n "setRuntimeApiKey" -- src` 无结果。
3. **人工冒烟（用户）**：第三方供应商下，`/recall`、AI 解析定时任务、对话标题生成照常工作。

## 风险与回滚

- 唯一的行为变化：默认供应商没有 Base URL 时，回顾、标题、任务解析从"尝试走官方"变为"不发请求"。D-1 ① 之后这本来就是坏配置。
- 回滚：`git revert <提交号>`。

## 交付记录

- **提交**：`47515f8`（立项）、`5ab1ec3`（实现）、`cfafdc0`（规格审查处置）、质量审查处置与交付随本提交（分支 `claude/thesis-17-sdk-query-third-party-only`，基于 main `5a47254`）。
- **实现**：`resolveModel` 先检查 `anthropicBaseUrl`，为空直接抛 `sdkQuery requires a Base URL on the selected third-party provider`，由 `sdkQuery` 的 catch 转 `null` 并记日志；删除 `setRuntimeApiKey('anthropic', …)` 与内置 `anthropic` 模型目录回退（`getModels`/`getModel`）。第三方分支的 `ckqclaw-*` 注册、`splitModelRef` 约定与调用方 `null` 降级未变。
- **D-Q1 ①**：不统一"已配置"聚合口径。`src/routes/auth.ts` 继续扫描全部启用供应商；`bug-report.ts` / `agent-profile-generator.ts` 继续按 `getClaudeProviderConfig()`（默认供应商）判。差异仅在"多个第三方供应商、默认那个缺凭据"时出现：`setupStatus.claudeConfigured` 可能为 true，而 `sdkQuery` 使用默认供应商并因缺 Base URL 返回 `null`。`docs/API.md` 未改。
- **验证**：`npm run verify` 六步全绿（368 文件，3024 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 7 个路径全在声明范围内；`git grep -n "setRuntimeApiKey" -- src` 无结果，源码契约用例同步锁定。
- **偏差**：无。规格审查建议 6、质量审查 Minor 1/2/3/7 属既有代码或可选优化，未在本包扩范围。
- **范围外登记**：`scripts/test-real-model-smoke.ts:23-30` 的 `providerConfigured` 仍把官方凭据算作已配置，纯官方配置会显示已配置但 `sdkQuery` 返回 `null`；留待后续触碰该脚本时对齐。
- **未实机验收**：需用户在第三方供应商下冒烟 `/recall`、AI 解析定时任务、对话标题生成。
