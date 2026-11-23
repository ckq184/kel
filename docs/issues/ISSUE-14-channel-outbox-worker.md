# ISSUE-14 Channel Outbox 后台 worker：重启后 retry_wait 自动重投

| 字段          | 值                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                          |
| 领取人 / 分支 | `claude/intelligent-shamir-6c676c`                                                                                                                              |
| 优先级        | P2                                                                                                                                                              |
| 类型          | 实现                                                                                                                                                            |
| 依赖          | 无                                                                                                                                                              |
| 阻塞          | 无                                                                                                                                                              |
| 预计改动路径  | `src/channel-reliability-store.ts`、`src/channel-outbox-delivery.ts`、`src/index.ts`，以及相应的 `tests/**`                                                     |
| 需用户决策    | **是**：worker 轮询周期；按行内 `kind`/`payload` 重建物理投递闭包的方案（payload schema 无运行时校验，旧库行可能落后于当前代码）；`mutation` 类行的幂等回执语义 |
| 来源          | ISSUE-07 项 3 用户决策（2026-11-20：本任务只写复现测试与修注释修文档，worker 另立本 issue）                                                                     |

## 缺口：重启后 retry_wait 行无人重投

以下证据链取自 ISSUE-07 调查（2026-11-20，worktree HEAD `0f462b3`；`src/index.ts` 行号随 ISSUE-07 各批次实现持续漂移，按语义定位）：

- 启动路径只调用一次 `reconcileChannelOutboxDeliveries()`（`src/index.ts` 启动序列，调查时点约 `:19953-19977`），它仅转发 `reconcileExpiredChannelOutbox`（`src/channel-reliability-store.ts:1955`）：pre-send 阶段（`claimed`/`uploading`/`uploaded`）且租约过期的行**只翻状态为 `retry_wait`，不投递**；`sending` 阶段翻 `uncertain`。
- 通用认领函数 `claimNextChannelOutbox`（`src/channel-reliability-store.ts:1748`）与 `claimNextChannelTurnRun`（`:1269`）**生产零调用**，只有测试在用；历史上也没有任何后台 outbox worker 存在过。
- 唯一的生产投递入口 `deliverChannelOutboxItem` 只有两处 turn 驱动调用：`src/index.ts` 的 channel side-effect 分发（调查时点约 `:2585`）与 `src/feishu-capability-outbox.ts:65`。没有新入站消息重驱（或游标重放）同一 `idempotencyKey` 的 turn 时，`retry_wait` 行无限期滞留。
- `src/channel-outbox-delivery.ts` 的 `reconcileChannelOutboxDeliveries` 注释曾声称 "before new outbox workers start"，ISSUE-07 项 3 已改为如实描述；现状由 `tests/channel-outbox-restart-retry-wait.test.ts` 锁定（翻转后滞留 + 仅同 `idempotencyKey` turn 重进 `deliverChannelOutboxItem` 才重投）。

## 实现要点

- **认领与租约**：复用现成的 `claimNextChannelOutbox`（`owner` 稳定标识 + 租约 + `lease_token` CAS），不改 `channel_outbox` schema。
- **主要工作量在 dispatcher**：按行的 `kind`（`text`/`image`/`file`/`card`/`mutation`）与 `payload` **重建物理投递闭包**（Feishu 发送 / 上传后发送），再走 `deliverChannelOutboxItem` 的既有状态机（或提取可复用的执行函数）。注意：`payload` 是入队时的 JSON 快照，重建闭包时需处理旧库行的 payload 与当前代码不一致的情况（建议需用户决策的回退策略：跳过并标 `failed` 还是告警人工介入）。
- **挂点参考**：`startChannelReliabilityRecoveryLoop`（`src/channel-reliability-recovery.ts:224`，默认 15s `setInterval` + `unref` + 重入合并 + `trigger()` 手动触发）是现成的循环模式，worker 可并列挂同一启动序列，或并入该循环的一个阶段。
- **边界**：`uncertain` 行仍须人工 resolve（`resolveUncertainChannelOutbox`，Monitor 放行入口见 ISSUE-07 项 4），worker 不得自动重投；worker 也不得绕过 uncertain-sibling 围栏（同 turn 有 uncertain 行时跳过该 turn 的全部行）。
- **幂等**：物理重投必须继续走 outbox 行的 `idempotency_key` 去重与租约 CAS，不能旁路直发。

## 验收标准

- 重启后存在 `retry_wait` 行（pre-send 租约过期翻转产生）时，worker 在一个轮询周期内自动认领并完成物理投递或转入 `failed`/`uncertain`，无需新入站消息。
- `tests/channel-outbox-restart-retry-wait.test.ts` 的"滞留"断言改写为"worker 认领重投"断言（保留 turn 重驱路径作为 worker 不可用时的对照），或明确说明两条路径的并存关系。
- worker 对 `uncertain` 行零动作、对同 turn uncertain-sibling 围栏零绕过，均有测试。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

（领取后填写）
