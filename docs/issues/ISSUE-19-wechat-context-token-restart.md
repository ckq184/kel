# ISSUE-19 微信 context_token 重启丢失与“无 token”被误判为 uncertain

| 字段          | 值                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                   |
| 领取人 / 分支 | —                                                                                                                                                                                                        |
| 优先级        | P2                                                                                                                                                                                                       |
| 类型          | 缺陷（渠道可靠性）                                                                                                                                                                                       |
| 依赖          | 无（ISSUE-14 的 outbox 重投 worker 让问题二在重启后必现）                                                                                                                                                |
| 阻塞          | 无                                                                                                                                                                                                       |
| 预计改动路径  | `src/wechat-inbound.ts`、`src/wechat-outbound.ts`、`src/wechat.ts`，可能涉及 `src/im-manager.ts`、`src/channel-outbox-delivery.ts`（错误分类映射）、`src/db.ts`（若持久化 token），以及相应的 `tests/**` |
| 需用户决策    | **是**：见下文“需用户决策”                                                                                                                                                                               |
| 来源          | ISSUE-14 实机验收（2026-11-23，分支 `claude/intelligent-shamir-6c676c`）；用户拍板“新开一个 issue 登记两点”                                                                                              |

## 现象（实机证据）

ISSUE-14 实机验收第一轮：服务停止时注入“认领后进程死亡”的 outbox 文本行，然后重启。worker 在 10:04:20 认领该行，按 payload 重建后调用 `imManager.sendMessage`，微信出站抛出 `No context_token available for WeChat chat <chatId>`，该行被落成 `uncertain`，同 turn 被围栏，只能人工 resolve。用户在重启**前**发过入站消息，但刷新的是旧进程的缓存。

第二轮：同一进程内用户先发入站消息、再注入 `retry_wait` 行，worker 在 7 秒内投递成功，用户在微信收到。可见 worker 本身正常，问题出在微信渠道。

## 问题一：context_token 只存在进程内存

- `src/wechat.ts` 里的 `contextTokenCache` 是进程内的 `Map`（from_user_id → 最新 context_token），由 `src/wechat-inbound.ts` 的 `contextTokenCache.set(...)` 在入站时写入，断开或重连时 `clear()`。
- `src/wechat-outbound.ts` 的文本、图片、文件三个出站函数取不到 token 就直接抛错。
- 后果：服务重启后、收到该用户新的入站消息之前，任何主动消息都发不出去，包括 outbox worker 重投、定时任务推送、恢复流程补发。

## 问题二：“无 token”是发送前就确定的拒绝，却被当作结果不确定

- 该异常在调用 iLink 接口**之前**抛出，可以确定消息没有发出；但它是普通 `Error`，而 `deliverChannelOutboxItem` 对 `sending` 之后的普通异常一律标为 `uncertain`（只有 `DefinitiveChannelDeliveryError` 才会落到 `failed`/`retry_wait`）。
- 后果：本可以安全重试或标记失败的行，被围栏住整个 turn，必须人工 resolve。

## 需用户决策

1. 问题一的方向：持久化 context_token（落库或落文件，需确认 token 的有效期和安全性）、维持内存但在缺 token 时提示用户“发一条消息以恢复”，还是两者结合。
2. 问题二的分类：“无 token”映射为 `DefinitiveChannelDeliveryError` 后，转 `failed` 还是带 `retryAt` 转 `retry_wait`（等用户下次入站后由 worker 重投）；映射放在渠道层还是 im-manager 层。
3. 其他渠道（飞书、QQ）里是否还有同类“发送前确定拒绝却抛普通异常”的路径，是否顺带盘点。

## 验收标准（待拍板后细化）

- 有测试锁定：缺 token 时出站行不进入 `uncertain`，并按拍板的语义落到 `failed` 或 `retry_wait`。
- 按问题一的拍板，重启后的主动发送行为有测试或实机证据。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

（领取后填写）
