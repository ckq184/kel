# ISSUE-14 Channel Outbox 后台 worker：重启后 retry_wait 自动重投

| 字段          | 值                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                          |
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

- **分支**：`claude/intelligent-shamir-6c676c`，base `38da090`；方案见 `docs/issue14-channel-outbox-worker-plan.md`。
- **用户拍板（2026-11-23，全部按推荐）**：
  - 重投范围：**只重投 text**（按 payload 重建，走 `deliverChannelOutboxItem` 状态机）；image/file/card/mutation 无法安全重建，转 `failed` 并 warn。
  - 认领条件：**只认领终态 turn 的行**；活跃 turn 的行（含运行期飞书限流重试）继续由 turn 重驱。
  - 轮询周期：**并入 15s 恢复循环**，作为 reconcile 之后的 `afterPass` 阶段，启动时立即跑一轮。
  - 异常与过期：payload 校验失败转 `failed`+warn；渠道不可用保留 `retry_wait`；`created_at` 超过 **1 小时**转 `failed`。
  - mutation 幂等回执语义：随“只重投 text”失去意义，mutation 行一律转 `failed`。
- **提交**：
  - `51a4835` 立项（状态进行中、README 索引、plan、`.gatescope.json`）；
  - `9fc4d9b` T1：`listRetryableChannelOutboxForTerminalTurns` + `runChannelOutboxRetryPass` + `tests/channel-outbox-worker.test.ts`；
  - `4922084` T2：恢复循环 `afterPass` 阶段 + `src/index.ts` 启动接线 + `tests/channel-reliability-recovery-outbox-stage.test.ts`；
  - `a43571e` T3：改写 `tests/channel-outbox-restart-retry-wait.test.ts`，同步 `docs/API.md`；
  - `e4991fb` T1 补：逐行异常隔离（自查发现）；
  - 本交付落档提交。
- **验收对照**：
  - 重启后 `retry_wait` 行在一个轮询周期内被收口：`recovery-outbox-stage` 用例证明本轮刚被置为 `interrupted` 的 turn，其 text 行在同一轮重投；不可重建的行转 `failed`。
  - 复现测试的“滞留”断言改写为“worker 收口”，turn 重驱用例保留为活跃 turn 对照，文件头注释写明两条路径并存。
  - `uncertain` 行零动作、uncertain-sibling 围栏零绕过：store 查询排除被围栏的 turn，`deliverChannelOutboxItem` 自身也检查围栏，两处都有测试覆盖。
  - 门禁：`npm run verify` 六步全绿（2805 过 23 跳 0 败，25.9s）；`node scripts/check-scope.mjs` 12 个路径全在声明范围内。
- **偏差**：
  1. 没有复用 `claimNextChannelOutbox`：它不能按 turn 状态和围栏过滤。改为新增候选查询，再按 ID 走 `claimChannelOutboxById` 的 CAS（重投经 `deliverChannelOutboxItem`，转 failed 经 `failChannelOutbox`）。`claimNextChannelOutbox` 仍然只有测试在用。
  2. 改动路径超出 issue 预计：多改了 `src/channel-reliability-recovery.ts`（`afterPass` 挂点）和 `docs/API.md`（原段落描述的正是本缺口，已改为现状）。`.gatescope.json` 的 allow 相应扩宽。
  3. 证据复核发现：生产中重启产生 `retry_wait` 的窗口实际很窄（所有生产调用都是 `single` 模式，“认领”到“标 sending”之间只隔一个微任务），worker 主要是兜底。
- **范围外登记**：`claimNextChannelTurnRun` 生产零调用，不在本 issue 处理；image/file payload 不含路径和字节，如果以后要重投附件，需要另立 issue 扩展 payload。
- **实机验收（2026-11-23，用户执行与确认）**：本 worktree 复制 ISSUE-16 的 `data/`（已接入微信），用 `npm --prefix container/agent-runner run build` 加 `npm run dev:all` 启动。
  - 第一轮（停服务注入“认领后进程死亡”的持久状态再重启，覆盖启动对账路径）：启动对账把 4 个 turn 置为 `interrupted`，翻转 `retry_wait` 4 条、`uncertain` 1 条。worker 首轮（10:03:46）把 file 行转 `failed`（不可重建）、2 小时前的超龄 text 行转 `failed`（超过 60 分钟），围栏 turn 的两行没有进入候选、都没动，均符合预期。text 行首轮因微信长轮询尚未连上被跳过（符合“渠道不可用保留”），10:04:20 被认领并调用发送，但微信报 `No context_token`（token 只在内存、重启后丢失），该行落 `uncertain`：没有重复发送，也没有送达。
  - 第二轮（服务运行中，用户先在微信发消息刷新当前进程的 token，再写入已中断 turn 加到期 `retry_wait` 文本行）：10:35:56 写入，10:36:03 worker 投递成功，行变 `delivered`（attempt 2，synthetic 回执），日志 `delivered: 1`，**用户确认微信收到补发消息**。
  - 结论：worker 的认领、重投、转 failed、围栏、渠道不可用保留五项行为都在实机上得到验证；重启后微信补发失败的原因在渠道层，已登记为 [ISSUE-19](ISSUE-19-wechat-context-token-restart.md)。
- **待用户决定**：合入 main、推送。
