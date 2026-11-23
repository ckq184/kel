# 任务立项：ISSUE-14 Channel Outbox 后台 worker —— 重启后 retry_wait 自动重投

> 立项日期：2026-11-23｜base：`38da090`（本地 main tip，ISSUE-16 合并提交）｜分支：`claude/intelligent-shamir-6c676c`
> 来源：`docs/issues/ISSUE-14-channel-outbox-worker.md`
> 前序依赖：无。

## 0. 需求采访结论（2026-11-23）

- **目标**：服务重启后滞留在 `channel_outbox` 中、已无人能重驱的 `retry_wait` 行，由后台 worker 在一个轮询周期内自动收口：能安全重建的物理重投，不能重建的转 `failed` 并告警。
- **完成条件**：验收标准四条（见 issue）全部满足；`tests/channel-outbox-restart-retry-wait.test.ts` 的“滞留”断言改写为“worker 重投”，保留 turn 重驱对照；`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
- **约束**：不改 `channel_outbox` schema；不改 payload 格式；`uncertain` 行与 uncertain-sibling 围栏零绕过；物理重投必须走 `deliverChannelOutboxItem` 状态机（`idempotency_key` 去重 + 租约 CAS）；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 事实                                                                                                                                                            | 位置                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 启动只调用一次 `reconcileChannelOutboxDeliveries()`，仅翻转状态不投递                                                                                           | `src/index.ts:14873`、`src/channel-reliability-store.ts:1914`                             |
| `claimNextChannelOutbox` 生产零调用                                                                                                                             | `src/channel-reliability-store.ts:1707`                                                   |
| 生产投递入口只有两处 turn 驱动调用                                                                                                                              | `src/index.ts:2118`（`deliverScopedChannelOutput`）、`src/feishu-capability-outbox.ts:65` |
| 所有生产调用都是 `mode: 'single'`；pre-send 阶段只有 `claimed`，到 `sending` 之间只隔一个 `await notifyPersisted`（生产无钩子）                                 | `src/channel-outbox-delivery.ts` `deliverChannelOutboxItem`                               |
| text payload = `{ text, presentation?, deliveryRole?, inputTurnId?, logicalChatJid? }`，足够重建 `imManager.sendMessage(sourceJid, text, [], { presentation })` | `src/workspace-interaction-runtime.ts:66`、`src/index.ts:2210-2226`                       |
| image/file payload 只有 `fileName`/`contentHash`（及 `mimeType`/`caption`），没有路径和字节，**不能重建**                                                       | `src/index.ts:2237-2262`、`:2648-2690`                                                    |
| mutation payload = `{ operation, params }`，执行依赖内存中的 `activeTurn.context`，**不能重建**                                                                 | `src/feishu-capability-outbox.ts`、`src/ipc/feishu-capability-ops.ts:116`                 |
| `card` 种类无生产者                                                                                                                                             | `git grep "kind: 'card'" src` 零命中                                                      |
| 运行期 `retry_wait`：飞书 mutation 被限流（`DefinitiveChannelDeliveryError` 带 `retryAt`），靠模型用同一 `idempotencyKey` 重试并按 ID 重新认领                  | `src/feishu-capability-outbox.ts`                                                         |
| `channel_outbox.turn_run_id` 外键 `ON DELETE CASCADE`，outbox 行不会脱离 turn 单独存在                                                                          | `src/channel-reliability-store.ts:425`                                                    |
| 恢复循环：15s `setInterval` + `unref` + 重入合并 + `trigger()`，每轮 live pass 会把租约过期的 running/finalizing turn 置 `interrupted`                          | `src/channel-reliability-recovery.ts:224`、`src/channel-reliability-store.ts:1461`        |

## 2. 用户决策（2026-11-23 逐项拍板，全部按推荐）

| 项                    | 决策                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 重投范围              | **只重投 text**：按 payload 重建后走 `deliverChannelOutboxItem`；image/file/card/mutation 无法安全重建，转 `failed` 并打 warn        |
| 认领条件              | **只认领终态 turn 的行**（`completed`/`failed`/`interrupted`/`cancelled`）；活跃 turn 的行（含运行期限流重试）继续交给 turn 自己重驱 |
| 轮询与挂点            | **并入 15s 恢复循环**，作为每轮 reconcile 之后的一个阶段；启动时 reconcile 之后先跑一次                                              |
| 异常与过期            | payload 校验失败转 `failed`+warn；渠道暂不可用保留 `retry_wait` 等下一轮；`created_at` 超过 **1 小时**的行转 `failed`，不再发送      |
| mutation 幂等回执语义 | 随“只重投 text”决策失去意义：mutation 行一律转 `failed`，不需要定义重投回执                                                          |

## 3. 实现方案

1. **store**：`src/channel-reliability-store.ts` 新增 `listRetryableChannelOutboxForTerminalTurns(now, limit)`：`status='retry_wait' AND available_at<=now AND lease_owner IS NULL`，JOIN `turn_runs` 且 turn 处于终态，`NOT EXISTS` 同 turn 的 `uncertain` 行（围栏），按 `available_at, turn_run_id, ordinal` 排序、有界。
2. **worker**：`src/channel-outbox-delivery.ts` 新增 `runChannelOutboxRetryPass(deps)`，依赖注入 `sendText(jid, text, options)`、`isChannelAvailable(jid)`、`owner`、`now`、`maxAgeMs`（默认 1h）、`limit`。逐行：
   - 超龄 / 非 text / text payload 校验失败 → `claimChannelOutboxById` + `failChannelOutbox`（CAS，不发送），warn；
   - 渠道不可用 → 跳过（不认领、不改 `attempt`）；
   - 否则以行内路由、`turnRunId`、`ordinal`、`kind`、原 payload、`idempotencyKey` 调 `deliverChannelOutboxItem`，send 闭包调 `sendText` 并回 `syntheticChannelProviderAck`（与 live 路径一致）；发送中普通异常照旧落 `uncertain`。
   - 返回 `{ delivered, failed, uncertain, skipped }` 计数。
3. **循环挂点**：`src/channel-reliability-recovery.ts` 的 `startChannelReliabilityRecoveryLoop` 增加可选 `afterPass` 阶段，在同一 `active` promise 里于 reconcile 之后执行，异常单独捕获记日志，不影响 reconcile。
4. **启动接线**：`src/index.ts` 在 `reconcileChannelOutboxDeliveries()` 之后构造 worker（`imManager.sendMessage` / `imManager.isChannelAvailableForJid`，owner `ckqclaw-outbox-worker:<pid>`），传入恢复循环并 `runImmediately`；修正 `reconcileChannelOutboxDeliveries` 注释（不再写“没有 worker”）。日志：有动作 info、无动作 debug（沿用恢复循环降噪口径）。
5. **测试（TDD）**：新增 `tests/channel-outbox-worker.test.ts`；改写 `tests/channel-outbox-restart-retry-wait.test.ts`；`tests/channel-turn-runtime.test.ts` 或新文件补 `afterPass` 顺序与异常隔离用例。

## 4. 任务拆分与回滚点

| 任务 | 内容                                       | 验收                                                                                                                | 回滚点   |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------- |
| T1   | store 查询 + worker 函数 + 单测            | 终态 turn 的 text 行重投；活跃 turn/未到期/uncertain/围栏零动作；非 text、坏 payload、超龄转 failed；渠道不可用保留 | 立项提交 |
| T2   | 恢复循环 `afterPass` + 启动接线 + 注释修正 | `afterPass` 在 reconcile 后执行、异常隔离；index 接线源码断言                                                       | T1 提交  |
| T3   | 改写重启复现测试                           | 重启 → reconcile → turn 终态 → 一轮 worker 后 delivered；turn 重驱对照保留                                          | T2 提交  |
| T4   | 门禁与交付落档                             | verify 六步全绿、check-scope 通过、issue 已完成                                                                     | T3 提交  |

## 5. 非目标

- 不扩展 image/file payload、不持久化 mutation 上下文、不改 `channel_outbox` schema。
- 不让 `claimNextChannelOutbox` 接入生产（它不能按 turn 状态过滤；worker 走 `claimChannelOutboxById` CAS）。
- 不处理 `uncertain` 行（仍由 Monitor 人工 resolve），不改 `deliverScopedChannelOutput` 的输出窗口规则。
- 不处理 `claimNextChannelTurnRun` 零调用（不在本 issue 范围）。
