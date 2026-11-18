# 任务立项：飞书“消息处理暂时失败”重试提示每条消息只发一次

> 立项日期：2026-11-18｜base：`a8077df`｜状态：方案已获用户确认（见 §3）
> 性质：真 Bug 修复。承接 `docs/feishu-route-rejection-terminal-plan.md` §7 中记录的遗留问题。
> 同时更正该文档的一处事实错误（见 §1.3）。

## 1. 背景与取证

### 1.1 现象

用户反馈飞书 bot 仍在持续发送「⚠️ 消息处理暂时失败，系统将自动重试」。

### 1.2 根因（已读代码复核）

`src/feishu.ts` `processClaimedIncomingMessage` 末尾 catch：

```ts
failClaimedInbound(claim, payload, err, true);
if (source === 'ws') {
  await sendTextToChat(chatId, '⚠️ 消息处理暂时失败，系统将自动重试');
}
```

- `failClaimedInbound(..., retry=true)` 把记录放回 `queued`，约每 5 秒由 `recoverQueuedInbox` 重新认领并再次执行；
- 恢复路径的 `source` 取自持久化信封（`parseRecoveredInbox`），原始实时消息即 `'ws'`，所以**每一次**重试失败都会再发一遍提示；
- 对任何持续性失败（解析器异常、飞书 API 报错、连接停用……），提示每 5 秒一条，永不停止。

### 1.3 更正

`docs/feishu-route-rejection-terminal-plan.md` 称 `channel_inbox` “没有尝试计数”“无 attempt 列，需 schema 迁移”，**不准确**：
`channel_inbox.attempt` 列存在（`src/channel-reliability-store.ts` 建表），每次被认领 `attempt = attempt + 1`
（`claimChannelInbox`），`ClaimedChannelInboxItem.attempt` 可直接读取。正确的说法是：**有计数，但重试流程没有用它设上限、
也没有用它限制提示**。本任务只用它限制提示，重试语义不变。

### 1.4 现网部署状态（取证，非本任务改动）

用户正在运行的 3001 后端取自主仓 checkout（分支 `main`），不含 `56c36c0` 与 `a8077df`；此前报告的合法拒绝无限重试在
现网仍然存在，需先把这些提交合入并重启才会生效。本任务实现提交后，由用户确认的方式将分支快进合入主仓 `main`
（本地、不 push、不重启服务）。

## 2. 方案

`src/feishu.ts` catch 里的提示条件由 `source === 'ws'` 改为 `source === 'ws' && claim.attempt <= 1`：

```ts
// 仅实时消息的首次失败提示自动重试；后续静默重试不再重复提示，backfill 回填的旧消息失败不打扰用户。
if (source === 'ws' && claim.attempt <= 1) { … }
```

- 首次处理（`handleIncomingMessage` 认领后 `attempt === 1`）失败：照常提示一次；
- 之后的恢复重试（`attempt >= 2`）：静默，重试语义、退避间隔、`failClaimedInbound` 调用均不变；
- 不改 schema、不改 `channel-reliability-store.ts`、不改 IM 包装器。

## 3. 裁决（用户已确认）

| 方案                                           | 评估                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **每条消息只通知一次（采纳）**                 | 一处条件 + 测试；重试语义不变                                                                 |
| 通知一次 + 有界重试后终止（用 `attempt` 上限） | 飞书 API 短时故障超过上限会丢消息，且需决定上限与最终提示文案，属于独立语义变更，建议另立小项 |
| 不改，只部署已有修复                           | 非合法拒绝类的持续失败仍每 5 秒刷屏，未解决                                                   |

## 4. 已知边界（接受）

- 若首次处理因进程崩溃/租约过期被重新认领（`attempt` 已为 2），之后才失败，则该消息不会收到提示。宁可漏提示也不刷屏。
- 启动闸门（`shouldDeferInbound`）把记录延后重试也会推进 `attempt`，同样不影响之后的静默策略。
- 失败原因仍可从 `channel_inbox.error` 与日志（`Feishu message intake failed; durable Inbox scheduled a retry`）查到。

## 5. 不做

- 不加重试上限、不改退避、不改 `channel_inbox` schema、不碰 `channel-reliability-store.ts`。
- 不改 CI/lint/门禁配置；不改库、不碰 `data/`；不 push；不重启任何服务。
- 不处理运行库里已卡住的 `queued` 记录。

## 6. 步骤（TDD）

1. 立项提交（本文档 + `.gatescope.json`，base `a8077df`）。
2. 在 `tests/feishu-p2p-first-dm-bootstrap.test.ts`（真实 `IMConnectionManager` + 真实 feishu 处理器夹具）新增用例，先红：
   持续失败（解析器抛普通异常）→ 首次失败发 1 条提示；`vi.useFakeTimers` 推进两轮恢复重试后记录仍 `queued`、`attempt >= 3`，
   提示总数仍为 1。
3. 实现 `feishu.ts` 条件，测试转绿；同时更正 `docs/feishu-route-rejection-terminal-plan.md` 的上述错误表述。
4. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过，实现单独提交，不 push。
5. 经用户确认，把分支快进合入主仓 `main`（本地），重启由用户执行。

## 7. 风险与未验证项

| 风险                                               | 应对                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 首次失败时提示本身发送失败，之后再也不提示         | 与修复前对“发送失败”的处理一致（记日志不重试提示）；接受                                  |
| 用例依赖假定时器推进恢复定时器                     | 夹具连接完成后才启用假定时器，`finally` 还原；若不稳定，改为直接断言 `attempt` 与提示计数 |
| 现网实际刷屏的错误类别未知（用户选择自行提供文本） | 提示去重后，具体错误仍需根据用户提供的 `channel_inbox.error` / 日志另行判断               |
