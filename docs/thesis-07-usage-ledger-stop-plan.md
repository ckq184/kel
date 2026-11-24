# 任务立项：THESIS-07 用量（二）：停记账，气泡回写改为不经账本

> 立项日期：2026-11-24｜base：`5ccf1b3`（立项）→ `38418cc`（THESIS-06 合入后的实现基线）｜分支：`claude/thesis-07-usage-ledger-stop`
> 来源：[docs/issues2/THESIS-07-usage-ledger-stop.md](issues2/THESIS-07-usage-ledger-stop.md)（方案 §6 L2/T2，审核更正 S1）
> **状态：已实现并交付（实现提交 `217c12c`），等待用户人工冒烟。**

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：用量表不再新增记录；聊天气泡的耗时改为不经账本的累加回写，停记账之后气泡耗时仍然正确。
- **完成条件**：对话与 isolated 定时任务跑完后 `usage_records`、`usage_events` 不新增记录；一条回复连续收到多次不同 `eventId` 的 `usage` 事件时，消息上的耗时是各次之和，同一 `eventId` 重放不重复累加；推送给 Web 与飞书的流事件里 `costUSD` 是上游原值；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；用户完成人工冒烟。
- **约束**：不改 `src/db.ts`、不改表结构、不动 `usage` 流事件本身、不删定价层（THESIS-08）、不改前端气泡与飞书卡片显示（THESIS-09）、不读写 `data/`。

| #        | 问题                                      | 拍板                                                                                                                                                        |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖     | THESIS-06 未完成，07 依赖它且矩阵为 ❌    | **已解除**：06 已合入 main（`38418cc`），本分支 rebase 后进入实现；立项阶段曾只立项不实现。                                                                 |
| 拆包确认 | 方案 §15 v0.4「停记账随模型单价一并执行」 | **确认按现有拆分**：07 先停记账，08 紧随其后删定价；中间态定价层只被 `/api/pricing` 与设置页使用，不影响功能。                                              |
| 内存状态 | 累加态只放内存，进程重启时中间态丢失      | **接受**：重启后同一回复若继续收到 usage 事件，累计从 0 重来，整值覆盖可能让气泡耗时暂时变小；只影响重启瞬间仍在生成/多轮回复的消息。不为此改 `src/db.ts`。 |
| 实现落点 | issue 原文写「在 `src/index.ts` 内」累加  | **抽独立纯模块** `src/usage-accumulator.ts`：`index.ts` 顶层会执行 `main()`，测试无法导入；抽模块才能按 TDD 单测累加与去重。                                |

## 1. 关键事实（开工前核实，锚点为 `5ccf1b3`）

- **写账本的调用点共五处**（审核更正 S1）：
  - `src/index.ts:6090`、`:10041`：推送前用 Kaboo 计价结果覆盖流事件 `usage.costUSD`；
  - `src/index.ts:6410`、`:10190`：写账本，再经 `rebuildMessageTokenUsageFromLedger`（`:6421`、`:10202`）回写 `messages.token_usage`；
  - `src/task-scheduler.ts:1208`：isolated 定时任务调用 `recordIsolatedTaskUsage`。
- **包装与模块**：`writeUsageRecords`（`src/index.ts:1792`）、`src/usage-service.ts`（214 行）、`src/task-usage.ts`（42 行）；`src/index.ts:528` 的 `recordUsageEvent` 导入只被包装函数使用。
- **V-C5（已核实）**：Pi runner 每个 turn 只在 `publishResult` 发一次 `usage`（`container/agent-runner/src/runtime/pi/pi-runner.ts:358-379`），`eventId` 为 `pi:<sessionId>:<firstTimestamp>`（`pi-session.ts:134-143`）；`agent_end.messages` 是本次 run 新生成的消息（`pi-agent-core` 的 `agent-loop.js:152/182/207`），不含历史轮次。因此按回复累加 `durationMs`/`numTurns` 不会重复计数；同一 `eventId` 重放需在内存去重。
- **`updateLatestMessageTokenUsage`（`src/db.ts:1214`）**：有 `msgId` 时按 `id + chat_jid` 精确更新；无 `msgId` 时更新该 chat 最近一条 `token_usage IS NULL` 的 agent 消息（`src/db.ts:193-201`）。本包只改有 `msgId` 的分支，`else` 分支保持现状（它本来就不经账本）。
- **前端显示兼容**：`TokenUsageDisplay`（`web/src/components/chat/MessageBubble.tsx:108-183`）对只含 `durationMs`/`numTurns` 的 JSON 会只渲染耗时（`:126`、`:136`），不会崩。实时气泡仍由 `web/src/stores/chat.ts:2347-2348`、`:2639-2640` 从流事件拼 token，本包不动。
- **测试面（比 issue 多一处）**：
  - 随本包删除：`tests/usage-accounting.test.ts`（630）、`tests/task-usage-routing.test.ts`（200）；
  - **issue 未列、执行前必须处理**：`tests/pricing-routes.test.ts` 第 54 行导入 `usage-service`，`describe('custom pricing store + recordUsageEvent injection')`（`:268-468`，5 个用例）与 `:683-720` 的缓存失效用例依赖 `recordUsageEvent`。本包删 `usage-service` 后该文件无法编译，需删掉这些用例并移除 `recordUsageEvent`/`getEffectiveCustomPricing` 导入；其余 CRUD 与 `/api/pricing` 路由用例保留，留给 THESIS-08 整文件删除。
  - 不动：`tests/pi-usage-stream.test.ts`（`usage` 流事件）；`tests/routes-usage.test.ts` 已随 THESIS-06 删除。
- **文档**：`CLAUDE.md`、`docs/API.md`、`docs/ACL-MATRIX.md` 均未提及 `usage-service`/`task-usage`/`writeUsageRecords`；本包无文档正文改动，只需 `docs:check` 通过。
- **红线**：不改 `src/db.ts`；`rebuildMessageTokenUsageFromLedger`、`recordUsageEventBatch` 等函数本体留给 THESIS-14 随表删除。

## 2. 实现步骤（TDD）

> 立项提交只含 plan、范围声明与领取状态，**不落 Red 用例**：当时分支上写失败用例会让 `npm run verify` 第 4 步变红。06 合入后，Red 用例与 Green 一起落在实现提交里：先确认 8 个用例因模块缺失/契约未满足而红，再写实现转绿。

1. **Red**：
   - 新增 `tests/usage-accumulator.test.ts`（纯模块）：
     - 同一 key 连续三次不同 `eventId` 的 usage，`durationMs`/`numTurns` 为三次之和；
     - 同一 `eventId` 重放不重复累加；
     - 不同 key（不同 chat/message）互不影响；
     - 缺 `eventId` 时仍累加（无法去重，作为已声明的限制）；
     - 条目数超过上限时按插入顺序淘汰最旧 key。
   - 新增 `tests/thesis-07-usage-ledger-stop.test.ts`（源码契约）：
     - `src/index.ts` 不再出现 `recordUsageEvent`、`writeUsageRecords`、`rebuildMessageTokenUsageFromLedger`、`providerEstimatedCostUSD`；
     - `src/task-scheduler.ts` 不再出现 `recordIsolatedTaskUsage`；
     - `src/usage-service.ts`、`src/task-usage.ts` 不存在；
     - `src/index.ts` 在 `usage` 事件分支调用 `usageAccumulator.accrue` 并经 `updateLatestMessageTokenUsage` 回写；
     - 全仓 `src/`（除 `db.ts` 定义外）不再有 `recordUsageEventBatch` 的生产调用方。
   - 改写 `tests/pricing-routes.test.ts`：删掉上述依赖 `recordUsageEvent` 的用例与导入。
2. **Green**：
   - 新增 `src/usage-accumulator.ts`：纯函数/工厂，`accrue(key, usage)` 返回累计的 `{ durationMs, numTurns }`；内部按 key 保存 `eventIds` 集合做去重，条目数与每 key 事件数设上限并淘汰最旧。
   - `src/index.ts`：删 `recordUsageEvent`、`rebuildMessageTokenUsageFromLedger` 导入与 `writeUsageRecords` 包装；删两处 `costUSD` 覆盖块（`:6082-6108`、`:10034-10060`）；把 `:6407-6445`、`:10183-10219` 的回写改为「有 `msgId` 时累加后按 ID 写 `{durationMs,numTurns}`，无 `msgId` 时保持原样」。
   - `src/task-scheduler.ts`：删 `recordIsolatedTaskUsage` 导入与调用块，保留流事件广播。
   - 删除 `src/usage-service.ts`、`src/task-usage.ts`。
3. **测试同步**：删除 `tests/usage-accounting.test.ts`、`tests/task-usage-routing.test.ts`；按第 1 步改写 `tests/pricing-routes.test.ts`。
4. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。
5. **交付**：issue 状态与 README 索引改「已完成」；写交付记录；若专题 C 的 06/07/08/09 全部完成，才更新方案 §2 裁决台账（否则不动）。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-07-usage-ledger-stop.md`、`docs/issues2/README.md`、`docs/thesis-07-usage-ledger-stop-plan.md`、`docs/审查记录.md`、`src/index.ts`、`src/task-scheduler.ts`、`src/usage-service.ts`、`src/task-usage.ts`、`src/usage-accumulator.ts`、`tests/**`。

不含 `src/db.ts`、表结构、定价层（`src/kaboo-pricing.ts`、`src/custom-pricing-store.ts`、`src/routes/pricing.ts`）与前端（`web/**`）。

## 4. 验收条件

1. 对话与 isolated 定时任务跑完后，`usage_records`、`usage_events` 不新增记录。
2. 一条回复连续收到三次不同 `eventId` 的 `usage` 事件后，消息上的耗时是三次之和；同一 `eventId` 重放不重复累加。
3. 推送给 Web 与飞书的流事件里，`costUSD` 是上游原值（第三方端点为 0），不再被覆盖。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 非目标未被实现：`src/db.ts` 与表结构无改动；`usage` 流事件、定价层、前端气泡与飞书卡片显示无改动。
6. **人工冒烟（用户）**：对话一轮后气泡显示耗时；运行一次定时任务后任务正常结束。

## 5. 非目标

- 不改 `src/db.ts`：`rebuildMessageTokenUsageFromLedger`、`recordUsageEventBatch` 等函数本体留给 THESIS-14。
- 不动 `usage` 流事件本身（`tests/pi-usage-stream.test.ts` 不动）。
- 不删定价层（THESIS-08）。本包之后 `kaboo-pricing.ts`、`custom-pricing-store.ts` 只剩 `/api/pricing` 与设置页在用。
- 不改前端气泡和飞书卡片的显示（THESIS-09）；飞书费用一行消失是 D-C3 选 ① 的预期行为，不是缺陷。
- 不删表、不迁移数据（THESIS-14）。

## 6. 风险与回滚

- **气泡回写路径必须先改**：只删账本不改回写，气泡耗时会变成 0；实现顺序按第 2 节先落累加模块再删调用点。
- **飞书卡片的费用一行会消失**：它来自本包删除的 `costUSD` 覆盖步骤，属 D-C3 ① 的预期行为。
- **直到 THESIS-09 之前，刷新后的气泡只在有 `msgId` 的分支缺 token 明细**：本包按 D-C2 只累加耗时与轮数；实时气泡仍由前端流事件拼 token，不受影响。
- **重启丢失中间态**：用户已确认接受。注意累加是整值覆盖：重启或条目淘汰后，同一回复若继续收到 usage 事件，累计从 0 重来，气泡耗时可能暂时变小；只影响重启瞬间仍在生成/多轮回复的消息。
- **缺 `eventId` 时无法去重**：旧 `deriveUsageEventId` 会用内容哈希兜底；新实现缺 `eventId` 按次累加。Pi runner 恒带 `eventId`（`pi-session.ts:134-143`），实践无回退；第三方/旧集成若不带则由上游保证不重放。
- **并行协调**：`src/task-scheduler.ts` 也是 R2 任务池 ISSUE-26 的改动对象，两者不同时进行；`tests/pricing-routes.test.ts` 同时是 THESIS-08 的删除对象，本包只删依赖 `recordUsageEvent` 的用例，08 再整文件删除。
- **回滚**：实现提交一到两笔，`git revert <提交号>`；无数据迁移，回滚零额外操作。
