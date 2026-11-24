# THESIS-07 用量（二）：停记账，气泡回写改为不经账本

| 字段          | 值                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                    |
| 领取人 / 分支 | THESIS-07 会话 / `claude/thesis-07-usage-ledger-stop`                                                                                                                                                                     |
| 优先级        | P1                                                                                                                                                                                                                        |
| 类型          | 裁剪（记账层，方案 L2）                                                                                                                                                                                                   |
| 依赖          | THESIS-06                                                                                                                                                                                                                 |
| 阻塞          | THESIS-08、THESIS-09、THESIS-14                                                                                                                                                                                           |
| 可并行        | ✅ 01、02、03、04、05、10、11、12、13、15。❌ 06（本包依赖它）；08、09（依赖本包）；14（按 D-F1 ① 最后单独执行）。与 R2 任务池的 ISSUE-26 同改 `src/task-scheduler.ts`，不要同时进行（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `src/index.ts`、`src/task-scheduler.ts`、`src/usage-service.ts`、`src/task-usage.ts`、`tests/**`                                                                                                                          |
| 需用户决策    | 否（D-C1 已定 ③ 三层一起裁；D-C2 已定 ③ 气泡只留耗时）。停记账随模型单价一并执行是评估会话的推定（方案 §15 v0.4），立项时请用户确认一次                                                                                   |
| 来源          | 方案 §6（L2、T2），审核更正 S1                                                                                                                                                                                            |

## 目标

用量表不再新增记录；聊天气泡的耗时改为不经账本的累加回写，停记账之后气泡耗时仍然正确。

## 范围（锚点为 `d6e04aa`）

**写账本的调用点共五处**（审核更正 S1，原方案写的是两处）：

| 调用点                                     | 作用                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `src/index.ts:6090`（`writeUsageRecords`） | 主会话：推送前用 Kaboo 计价结果覆盖流事件的 `usage.costUSD`                                   |
| `src/index.ts:6410`                        | 主会话：写账本，再经 `rebuildMessageTokenUsageFromLedger`（:6421）回写 `messages.token_usage` |
| `src/index.ts:10041`                       | 子会话：推送前覆盖 `costUSD`                                                                  |
| `src/index.ts:10190`                       | 子会话：写账本，再经 `rebuildMessageTokenUsageFromLedger`（:10202）回写                       |
| `src/task-scheduler.ts:1208`               | isolated 定时任务：`recordIsolatedTaskUsage`                                                  |

另外删除：包装函数 `writeUsageRecords`（`src/index.ts:1792`）、`src/usage-service.ts`（214）、`src/task-usage.ts`（42）。

**气泡回写改造**：把 :6421 和 :10202 对 `rebuildMessageTokenUsageFromLedger` 的调用换成不经账本的累加。`updateLatestMessageTokenUsage(chatJid, json, msgId)` 已经支持按消息 ID 写入，但只能整值覆盖，`src/db.ts` 里也没有按消息读回 `token_usage` 的单条查询。在"本包不改 `src/db.ts`"的约束下，累加在 `src/index.ts` 内按消息 ID 进行。按 D-C2，只需要累加 `durationMs` 和 `numTurns`（审核优化 O5），不必在宿主重建完整的 token 明细。

## 非目标

- 不改 `src/db.ts`：`rebuildMessageTokenUsageFromLedger`、`recordUsageEventBatch` 等函数本体留给 THESIS-14 随表一起删除。
- 不动 `usage` 流事件本身（`tests/pi-usage-stream.test.ts` 不动）。
- 不删定价层（THESIS-08）。本包之后 `kaboo-pricing.ts`、`custom-pricing-store.ts` 只剩 `/api/pricing` 和设置页在用。
- 不改前端气泡和飞书卡片的显示（THESIS-09）。

## 执行前核实

- **V-C5（部分已结案）**：Pi runner 每个 turn 只在 `publishResult` 里发一次 `usage`，并带 `eventId`。还要确认一条可见回复会不会跨多个 turn；会的话，累加要按 `eventId` 去重，避免重放时重复计数。
- 累加状态放在内存里，进程重启后同一条消息的中间态会丢失。确认这对"只显示耗时"可以接受；不能接受就停下报告，不要擅自改 `src/db.ts`。
- `src/task-scheduler.ts` 也是 R2 任务池 ISSUE-26（待领取）的改动对象。两者同时进行时，先协调顺序。

## 实现步骤（TDD）

1. **Red**：
   - 对话与 isolated 定时任务跑完后，`usage_records`、`usage_events` 不新增记录；
   - 一条回复连续收到三次 `usage` 事件（不同 `eventId`）后，消息上的耗时是三次之和；同一 `eventId` 重放不重复累加；
   - 推送给 Web 与飞书的流事件里，`costUSD` 是上游原值（第三方端点为 0），不再被覆盖。
2. **Green**：删除五个调用点、包装函数与两个模块，实现累加回写。
3. **测试同步**：删除或改写 `tests/usage-accounting.test.ts`（630）、`tests/task-usage-routing.test.ts`（200）。

## 验收条件

1. 新增用例全绿；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 本包没有改 `src/db.ts` 和表结构。
3. **人工冒烟（用户）**：对话一轮后气泡显示耗时；运行一次定时任务后任务正常结束。

## 风险与回滚

- **飞书卡片的费用一行会消失**：它来自本包删除的 `costUSD` 覆盖步骤。这是 D-C3 选 ① 时的预期行为，不是缺陷；选 ② 时由 THESIS-09 一并改写摘要。
- **气泡回写路径必须先改**：如果只删账本、不改回写，气泡耗时会变成 0。本包必须在 THESIS-14 删表之前完成并验证。
- 停记账后用量数据不再增长，历史数据留在表里直到 THESIS-14。
- **回滚**：`git revert <提交号>`。

## 交付记录

- **状态**：已完成（2026-11-24）。分支 `claude/thesis-07-usage-ledger-stop`；立项 `4a14cc6`，实现 `217c12c`。
- **验证结果**：`npm run verify` 六步全绿（362 文件，2985 通过 / 23 跳过 / 0 失败，30.1s）；`node scripts/check-scope.mjs` 实现树 14 路径、交付树 15 路径全在声明范围内。独立代理规格符合性与代码质量两轮审查均通过（Critical 0 / Major 0 / Minor 5，均不阻塞；处置见 `docs/审查记录.md`）。
- **改动**：删除五处账本写入（`src/index.ts` 两处 `costUSD` 计价覆盖、两处写账本+`rebuildMessageTokenUsageFromLedger` 回写，`src/task-scheduler.ts` 的 `recordIsolatedTaskUsage`）、`writeUsageRecords` 包装、`src/usage-service.ts`、`src/task-usage.ts`；新增 `src/usage-accumulator.ts` 按回复累加 `durationMs`/`numTurns`，`eventId` 去重，经 `updateLatestMessageTokenUsage` 按消息 ID 整值回写；无 `msgId` 分支保持原行为。`costUSD` 不再被宿主覆盖。
- **与 issue 的偏差**：
  1. 累加逻辑放在新模块 `src/usage-accumulator.ts`，不是 issue 原文的 `src/index.ts` 内——`index.ts` 顶层执行 `main()`，测试无法导入；用户已批准抽纯模块。
  2. `tests/pricing-routes.test.ts` 额外删除 6 个依赖 `recordUsageEvent` 的计价注入用例（issue 未列；删 `usage-service` 后该文件无法编译），保留并补 3 个纯 store 投影用例；整文件留给 THESIS-08 删除。
  3. 立项阶段因 THESIS-06 未完成只立项不实现；06 合入 `38418cc` 后 rebase 再实现（用户拍板）。
  4. `src/custom-pricing-store.ts:5` 顶部注释仍提到已删除的 `recordUsageEvent`；该文件属定价层，本包不改，随 THESIS-08 整文件删除。
- **已知限制**（用户已接受）：累加态只在内存；重启或条目淘汰后，同一回复继续收到 usage 事件时累计从 0 重来，整值覆盖可能让气泡耗时暂时变小。缺 `eventId` 时无法去重；Pi runner 恒带 `eventId`，实践无回退。
- **测试覆盖缺口登记**：`tests/usage-accounting.test.ts` 同时覆盖仍在 `src/db.ts` 的 `rebuildMessageTokenUsageFromLedger`/`recordUsageEventBatch` 等函数；这些函数已无生产调用方，随 THESIS-14 删表时一并删除。`tests/pricing-routes.test.ts` 删掉的计价注入/禁用投影/缓存失效用例由 THESIS-08 整文件删除收口。
- **人工冒烟（待用户）**：对话一轮后气泡显示耗时；运行一次定时任务后正常结束；飞书卡片不再显示费用一行（D-C3 ① 预期行为，不是缺陷）。
