# THESIS-09 用量（四）：聊天气泡只留耗时，飞书摘要按 D-C3

| 字段          | 值                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                    |
| 领取人 / 分支 | THESIS-09 会话 / `claude/thesis-09-bubble-duration-only`                                                                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                                                                        |
| 类型          | 裁剪（显示层）                                                                                                                                                                                                                                                            |
| 依赖          | THESIS-07（回写语义已改为只累加耗时与轮数）                                                                                                                                                                                                                               |
| 阻塞          | 无                                                                                                                                                                                                                                                                        |
| 可并行        | ✅ 01、02、03、04、05、08、10、12、13、15。⚠️ 11（前端权限门涉及的文件未逐一核实）。❌ 06、07（本包依赖它们）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                          |
| 预计改动路径  | `web/src/components/chat/MessageBubble.tsx`、`web/src/lib/token-usage-presentation.ts`、`web/src/stores/chat.ts`、`tests/**`；D-C3 选 ② 时再加 `src/feishu-usage-display.ts`、`src/feishu-cards/sections.ts`、`src/feishu-cards/types.ts`、`src/feishu-streaming-card.ts` |
| 需用户决策    | **是**：D-C3（已拍板 ②，2026-11-25）                                                                                                                                                                                                                                      |
| 来源          | 方案 §6（T4）、§11.2，审核更正 S1                                                                                                                                                                                                                                         |

## 目标

聊天气泡只显示耗时，不再显示 token 数和明细提示。飞书卡片摘要按 D-C3 处理。

## 范围（锚点为 `d6e04aa`）

| 部分         | 内容                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 气泡         | `MessageBubble.tsx:108-183` 的 `TokenUsageDisplay` 只保留耗时分支，耗时为 0 时不显示；去掉"N tokens"与悬停明细（主模型、输入输出、缓存读写、推理）        |
| 辅助函数     | `web/src/lib/token-usage-presentation.ts`（100）只保留 `parseTokenUsage`，删除三个 token 明细辅助函数                                                     |
| 实时拼装     | `web/src/stores/chat.ts` 用流事件实时拼 `token_usage` 的两处（:2340、:2632）收口为只带耗时与轮数，与 THESIS-07 的回写格式一致（审核补充，方案原清单漏列） |
| 飞书（D-C3） | 选 ① 不改代码；选 ② 时 `formatFeishuUsageNote`（`src/feishu-usage-display.ts:65`）与两个卡片文件改为只显示耗时与轮数                                      |

## 非目标

- 不改 `usage` 流事件结构（`tests/pi-usage-stream.test.ts` 不动）。
- 不改宿主回写（THESIS-07 已完成）。

## 需用户决策（领取前拍板）

| #    | 问题                          | 选项                                                                           | 审核建议 |
| ---- | ----------------------------- | ------------------------------------------------------------------------------ | -------- |
| D-C3 | 飞书卡片摘要里的 token 与费用 | ① token 保持现状，费用一行随定价下线自然消失（零代码）；② 同样只保留耗时与轮数 | ①        |

为什么选项要重写：费用一行显示的是被定价层覆盖后的 `costUSD`（`src/index.ts:6090`、:10041），THESIS-07 删掉覆盖步骤之后，第三方端点的上游费用恒为 0，`formatFeishuUsageNote` 只在 `costUSD > 0` 时显示费用。所以原方案的"保持现状"已经不可能完全保持。

## 执行前核实

- `token_usage` 的读方只有 `MessageBubble.tsx` 和 `stores/chat.ts`（已核实：后端与 runner 只写不读，`src/container-runner.ts:224` 的命中是一行注释）。改格式前再 grep 一次。
- 历史消息里已有的完整 `token_usage` JSON（含 token 明细）仍要能被 `parseTokenUsage` 解析，只是不再显示明细。

## 实现步骤（TDD）

1. **Red**：
   - 组件用例：气泡只渲染耗时，不出现"tokens"字样与明细提示；耗时为 0 时不渲染；
   - 源码契约用例：`MessageBubble.tsx` 不再引用三个 token 辅助函数；
   - 兼容用例：旧格式的 `token_usage` 也只显示耗时。
2. **Green**：按范围表修改。
3. **测试同步**：`tests/usage-display-formatting.test.ts`（174，断言三个 token 辅助函数）改为只测耗时解析。
4. **前端清扫**：方案 §11.4。

## 验收条件

1. 新增用例全绿；`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工验收（用户）**：流式回复过程中与刷新页面后，气泡都只显示耗时；飞书卡片摘要符合 D-C3。

## 风险与回滚

- **回滚**：`git revert <提交号>`。

## 交付记录

- **提交**：立项 `737853e`、实现 `f94d719`、交付 `（本提交）`。
- **验证**：`npm run verify` 6/6 全绿（366 测试文件，3017 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 实现树 18 路径、交付树 19 路径全部在声明范围内；`make typecheck`、`make build` 通过。23 skipped 为基线既有，本包未新增 skip。
- **改动**：
  - 气泡：`MessageBubble.tsx` 的 `TokenUsageDisplay` 改为 `ReplyDuration`，只渲染 `durationMs`（0/负数/非数字/缺失不渲染）；删除 Tooltip 明细与三个 token 辅助函数导入。
  - 辅助函数：`token-usage-presentation.ts` 只保留 `parseTokenUsage`（排除数组），历史完整 `token_usage` JSON 仍可解析。
  - 实时拼装：`stores/chat.ts` 两处 usage 事件只写 `{durationMs,numTurns}`，与 THESIS-07 宿主回写一致。
  - 飞书 D-C3 ②：legacy note 只输出 `⏱ <耗时> · <轮数>`（无数据空串）；v2 meta row 删除 `💡 Token`，耗时值追加轮数，仅轮数时用 `🔁 轮数`；删除 `formatFeishuTokenSummary`、`formatTokens`、`CardMeta` 的 token/cost 字段与控制器透传。
- **偏差与登记**：
  1. D-C3 按用户拍板取 ②，不是审核建议的 ①。
  2. `src/feishu-cards/types.ts` 超出 issue 预计的三个飞书文件：删除 `CardMeta` 中随之失效的 token/cost 字段，避免共享类型留死字段；已在 plan §3 与 `.gatescope.json` 登记。
  3. `formatTokens`（`sections.ts`）随 `💡 Token` 字段删除后失去唯一消费者，一并删除；`tests/feishu-card.test.ts` 的对应断言同步移除。
  4. v2 meta row 在「耗时缺失但轮数 > 1」时用独立 `🔁 轮数` 字段，而不是把轮数追加到 `⏱ 耗时`；行为符合「只显示耗时与轮数」，与 plan §0 的字面写法略有差异。
  5. 空 usage note 时 legacy 路径提前返回，不再用 trace-only 整卡 patch 覆盖已有摘要；`complete()` 已定稿 trace footer，不丢 trace。
  6. 宿主无 `lastReplyMsgId` 的兜底分支仍 `JSON.stringify(se.usage)` 写入完整 usage（THESIS-07 行为，本包非目标不改）；气泡只读 `durationMs`，多余字段被忽略。
  7. 方案 `docs/issues2/task-thesis-trim-plan.md` 的 D-C3 行仍保留选项描述与「选 ①」风险措辞；最终拍板 ② 记录在本 issue、README 索引与交付记录，未扩宽方案文件。
  8. 用量专题（06/07/08/09）尚未全部完成（08 进行中），方案 §2 裁决台账不更新。
- **审查**：规格符合性审查通过（零阻塞）；代码质量审查初轮 1 个 Major（`patchUsageNote` 丢失 `modelUsage` 类型契约）、6 个 Minor；Major 与 5 个 Minor 已修复（补 `modelUsage`、补主对话/流式卡片用例、finite 防护、数组排除、空 note 提前返回、组件改名），复核通过（Critical 0 / Major 0 / Minor 3，剩余为非阻塞的源码契约脆弱性与窄 trace 边界）。详见 `docs/审查记录.md`。
- **已知限制**：飞书 v2 路径的模型标签仍依赖 `modelUsage`（只用于选主模型，不显示 token）；无 `modelUsage` 时模型字段省略，属既有行为。
- **人工验收（用户）**：流式回复过程中与刷新页面后，气泡都只显示耗时；飞书卡片摘要只有耗时与轮数、无 token/费用；历史消息气泡不回显 token 明细。
- **未实机验收**，由用户执行上述人工验收。
