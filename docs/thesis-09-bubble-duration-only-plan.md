# 任务立项：THESIS-09 用量（四）：聊天气泡只留耗时，飞书摘要按 D-C3 ②

> 立项日期：2026-11-25｜base：`479e2fd`｜分支：`claude/thesis-09-bubble-duration-only`
> 来源：[docs/issues2/THESIS-09-bubble-duration-only.md](issues2/THESIS-09-bubble-duration-only.md)（方案 §6 T4、§11.2，审核更正 S1/O5）
> **状态：已实现并交付（实现提交 `f94d719`），等待用户人工验收。**

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-C3 = ② 飞书也只留耗时与轮数**：飞书卡片不再显示 token 明细与费用，摘要改为耗时与轮数；同步重写 `tests/usage-display-formatting.test.ts`。审核建议的 ① 已被用户否决。
- **目标**：聊天气泡只显示耗时，不再显示 token 数与明细提示；飞书卡片摘要同样只保留耗时与轮数。
- **完成条件**：新气泡用例覆盖「只渲染耗时」「耗时为 0 不渲染」「旧格式仍可解析但只显示耗时」；飞书两种卡片模式（legacy note 与 v2 meta row）都不再出现 token/费用，只出现耗时与轮数；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；用户完成人工验收。
- **约束**：不改 `usage` 流事件结构（`tests/pi-usage-stream.test.ts` 不动）；不改宿主回写（THESIS-07 已完成）；不改表结构；不读写 `data/`。

| #    | 问题                                         | 拍板                                                                                                                                                                                           |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-C3 | 飞书卡片摘要里的 token 与费用                | **②**：摘要只留耗时与轮数；费用字段随 token 摘要一起删除。                                                                                                                                     |
| 跨包 | 与进行中的 THESIS-08（模型单价下线）是否冲突 | **不冲突**：README 矩阵 08↔09 为 ✅；08 只动定价层后端与设置页，本包只动气泡、chat store 与飞书卡片，无共享文件。                                                                              |
| 格式 | 飞书摘要的具体文案                           | legacy note 统一为 `⏱ <耗时> · <轮数>`（例如 `⏱ 2.5s · 3 轮`），无数据时返回空串；v2 meta row 删除 `💡 Token` 字段，把轮数追加到 `⏱ 耗时` 值后面（`2.5s · 3 轮`）。耗时/轮数缺失时对应段省略。 |

## 1. 关键事实（开工前核实，main `479e2fd`）

- **依赖已满足**：THESIS-07 已合入 main（`e5fad5c`），气泡回写只累加 `durationMs`/`numTurns`（`src/usage-accumulator.ts`），前端不再能依赖回写里的 token 明细。
- **气泡显示**：`web/src/components/chat/MessageBubble.tsx:108-183` 的 `TokenUsageDisplay` 目前用 `parseTokenUsage` + 三个明细辅助函数渲染 `N tokens · X 秒`，悬停有主模型/输入输出/缓存读写/推理明细；`:29-32` 导入三个辅助函数，`:9-15` 的 Tooltip 组件只被该块使用。
- **辅助函数**：`web/src/lib/token-usage-presentation.ts` 共 100 行，导出 `parseTokenUsage`（`:33`）、`getAuthoritativeTokenBreakdown`（`:49`）、`getDisplayedTokenTotal`（`:78`）、`getPrimaryModelUsage`（`:89`）。删除后三者和它们的私有类型/函数。
- **实时拼装**：`web/src/stores/chat.ts` 有两处用流事件拼完整 `token_usage`：agent 消息路径 `:2338-2382`、主对话路径 `:2629-2675`。两处都改为只写 `{ durationMs, numTurns }`，与 THESIS-07 的回写格式一致。
- **飞书 legacy note**：`src/feishu-usage-display.ts:65` 的 `formatFeishuUsageNote` 先拼 `formatFeishuTokenSummary`，再在 `costUSD > 0` 时拼费用，最后拼耗时/轮数；唯一生产调用方是 `src/feishu-streaming-card.ts:2329`。THESIS-07 删掉 `costUSD` 覆盖后费用段已不会再出现，但 token 摘要仍在。
- **飞书 v2 meta row**：`src/feishu-cards/sections.ts:193` 的 `buildMetaRow` 在 `:206-213` 渲染 `💡 Token`；`:12` 导入 `formatFeishuTokenSummary`；`:95` 的 `formatTokens` 在该字段删除后失去生产调用方（仅测试引用）。`src/feishu-streaming-card.ts:2996-3041` 的 `buildStructuredFinalCard` 把 usage 的 token/cost 字段传给 `CardMeta`；`:2302-2311` 的 `patchUsageNote` 参数类型也带 token/cost。
- **`CardMeta` 类型**：`src/feishu-cards/types.ts:17-31` 的 token/cost 字段（`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`reasoningTokens`、`costUSD`）在本包后失去所有读方；按方案 §11.4 第 2 项随摘要删除。该文件超出 issue 预计的三个飞书文件，按「扩宽范围只能改声明」在 §3 登记。
- **历史数据兼容**：旧消息的 `token_usage` JSON 仍含 token 明细，`parseTokenUsage` 只做 JSON.parse，不校验字段，因此能继续解析；显示层忽略 token 字段。
- **测试面**：
  - `tests/usage-display-formatting.test.ts`（174 行）断言三个 token 辅助函数与飞书 token 摘要，整文件按 D-C3 ② 重写；
  - `tests/chat-agent-messages.test.ts:271-296` 断言 agent 实时拼装保留 `inputTokens` 等字段，改为只断言 `durationMs`/`numTurns`；
  - `tests/feishu-thread-routing.test.ts:263-274` 断言 legacy note 含 `15 tokens（输入 10 · 输出 5）`，改为断言耗时/轮数且不含 token；
  - `tests/feishu-card.test.ts:19`、`:236-240` 引用 `formatTokens`，`:541-542`、`:647-648` 的 meta 夹具带 `inputTokens`/`outputTokens`，随字段删除同步清理；
  - 新增组件用例（happy-dom）与源码契约用例，覆盖 issue 的实现步骤 1。
- **文档**：`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` 未描述聊天气泡或飞书卡片的 token 展示，本包无文档正文改动，只需 `docs:check` 通过。
- **红线**：不改 `usage` 流事件（`StreamEvent` 的 usage 字段保留，THESIS-08/14 仍可能需要）；不改 `src/index.ts` 的宿主回写；不改 `src/db.ts` 与表结构；不读写 `data/`。

## 2. 实现步骤（TDD）

1. **Red**：
   - 新增 `tests/message-bubble-duration-only.test.tsx`（happy-dom，`createRoot` + `act`，与既有 DOM 用例同风格）：
     - 新格式 `{"durationMs":2500,"numTurns":2}` → 气泡出现 `2.5s`，不出现 `tokens`、`主模型`、`输入`、`缓存读取`、`缓存写入`、`推理`；
     - 旧格式（含 input/output/cache/reasoning/modelUsage）→ 仍只出现 `2.5s`，不出现 token 明细；
     - `durationMs: 0` 或缺失 → 不渲染耗时（无 `2.5s`/`0.0s` 之类的耗时文本）。
   - 新增/扩展源码契约用例：
     - `MessageBubble.tsx` 不再引用 `getAuthoritativeTokenBreakdown`、`getDisplayedTokenTotal`、`getPrimaryModelUsage`，且不再出现 `tokens` 字样与 Tooltip 明细；
     - `token-usage-presentation.ts` 只导出一个函数 `parseTokenUsage`；
     - `stores/chat.ts` 两处 `JSON.stringify` 只含 `durationMs` 与 `numTurns`；
     - `src/feishu-usage-display.ts` 不再有 `tokens`/`costUSD`/`formatFeishuTokenSummary`；`sections.ts` 不再有 `💡 Token` 与 `formatTokens`；`CardMeta` 不再有 token/cost 字段。
   - 先跑相关用例确认因旧实现而红。
2. **Green**：
   - `MessageBubble.tsx`：`TokenUsageDisplay` 只保留耗时分支（`durationMs > 0` 才渲染，否则返回 null）；删除三个辅助函数导入、Tooltip 导入与明细 JSX。
   - `token-usage-presentation.ts`：只保留 `parseTokenUsage` 与展示所需的最小 payload 类型；删除三个辅助函数及其私有类型/函数。
   - `stores/chat.ts`：两处 `tokenUsageJson` 改为 `JSON.stringify({ durationMs: usage.durationMs, numTurns: usage.numTurns })`。
   - `feishu-usage-display.ts`：删除 `FeishuTokenUsage`、`tokenCount`、`formatFeishuTokenCount`、`formatFeishuTokenSummary`；`formatFeishuUsageNote` 只拼耗时与轮数，无内容时返回空串。
   - `feishu-cards/sections.ts`：删除 token 摘要导入与 `💡 Token` 字段、删除失去调用方的 `formatTokens`；`⏱ 耗时` 值追加轮数。
   - `feishu-cards/types.ts`：删除 `CardMeta` 的 token/cost 字段。
   - `feishu-streaming-card.ts`：`patchUsageNote` 与 `buildStructuredFinalCard` 的 usage 参数收窄为 `durationMs`/`numTurns`/`modelUsage`；meta 不再传 token/cost 字段。
3. **测试同步**：重写 `tests/usage-display-formatting.test.ts`；更新 `tests/chat-agent-messages.test.ts`、`tests/feishu-thread-routing.test.ts`、`tests/feishu-card.test.ts` 的断言与夹具。
4. **前端清扫（方案 §11.4）**：确认 `token-usage-presentation` 无死导出、`MessageBubble` 无残留 Tooltip/明细文案、`web/package.json` 无因此失去唯一消费者的依赖（本包不删依赖）；`tokens`/`Token` 相关界面文案与测试样例无残留（`EffectiveCapabilitiesPreview` 的上下文 token 百分比属于另一功能，保留）。
5. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。
6. **交付**：issue 状态与 README 索引改「已完成」，写交付记录；用量专题（06/07/08/09）尚未全部完成（08 进行中），不更新方案 §2 裁决台账。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-09-bubble-duration-only.md`、`docs/issues2/README.md`、`docs/thesis-09-bubble-duration-only-plan.md`、`docs/审查记录.md`、`web/src/components/chat/MessageBubble.tsx`、`web/src/lib/token-usage-presentation.ts`、`web/src/stores/chat.ts`、`src/feishu-usage-display.ts`、`src/feishu-cards/sections.ts`、`src/feishu-cards/types.ts`、`src/feishu-streaming-card.ts`、`tests/**`。

其中 `src/feishu-cards/types.ts` 超出 issue 的预计改动路径：删除 `CardMeta` 中随摘要一起失效的 token/cost 字段，避免共享类型留下死字段；按「扩宽范围只能改声明」登记。

不含 `src/index.ts`（宿主回写）、`src/db.ts`、表结构、`usage` 流事件、`web/package.json` 与其他前端文件。

## 4. 验收条件

1. 聊天气泡只显示耗时；token 数与悬停明细消失；耗时为 0 时不显示。
2. 飞书 legacy note 与 v2 meta row 都不再显示 token 与费用，只显示耗时与轮数；无数据时不显示摘要。
3. 历史消息的完整 `token_usage` JSON 仍能解析，只是不再显示明细。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；方案 §11.4 清扫检查项通过。
5. 非目标未被实现：`usage` 流事件、宿主回写、`src/db.ts`、表结构零改动。
6. **人工验收（用户）**：流式回复过程中与刷新页面后，气泡都只显示耗时；飞书卡片摘要只有耗时与轮数。

## 5. 非目标

- 不改 `usage` 流事件结构（`tests/pi-usage-stream.test.ts` 不动）。
- 不改宿主回写（THESIS-07 已完成）。
- 不删表、不迁移数据、不改 `src/db.ts`（THESIS-14）。
- 不动 QQ 卡片（`src/qq-streaming-card.ts` 的 `patchUsageNote` 是空实现）。
- 不动上下文窗口/能力预览里的 `tokens` 文案（`EffectiveCapabilitiesPreview.tsx`，不属于用量账单展示）。

## 6. 风险与回滚

- **旧消息兼容**：旧 `token_usage` 含 token 明细，`parseTokenUsage` 不校验字段，显示层只取 `durationMs`/`numTurns`；新增兼容用例兜底。
- **实时气泡**：两处 `chat.ts` 收口后，刷新前的气泡也不会再闪出 token 数；若只改一处，另一条路径仍会显示完整明细，源码契约用例按两处断言。
- **飞书卡片**：legacy note 与 v2 meta row 是两条独立渲染路径，需分别覆盖；`patchUsageNote` 在卡片已拆分或非 completed 状态会跳过，属既有行为，不改变。
- **并行协调**：与 THESIS-08 无文件交集；08 删除定价层不影响本包的 `costUSD` 字段清理（本包只删显示层字段）。
- **回滚**：`git revert <提交号>`；无数据迁移，回滚零额外操作。
