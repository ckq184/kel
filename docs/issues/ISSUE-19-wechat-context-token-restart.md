# ISSUE-19 微信 context_token 重启丢失与“无 token”被误判为 uncertain

| 字段          | 值                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                   |
| 领取人 / 分支 | `claude/issue-19-wechat-context-token`                                                                                                                                                                   |
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

- **分支**：`claude/issue-19-wechat-context-token`，base `5322ef2`；方案见 `docs/issue19-wechat-context-token-plan.md`。
- **用户拍板（2026-11-23，全部按推荐）**：
  - token 持久化：存进渠道账号加密 secret，按微信用户 ID 存最新 token 和写入时间，与 `ilinkBotId` 绑定，换号即作废。
  - 无 token 归类：转 `failed`，不封 turn，不重试。
  - 映射位置：渠道层通用错误类 `ChannelPreSendRejection`，outbox 状态机把它当确定拒绝。
  - 范围：只改微信的发送前检查（缺 token、图片或文件超过大小上限），其余同类路径盘点登记。
- **提交**：
  - `6bb9758` 立项（状态进行中、README 索引、plan、`.gatescope.json`）；
  - `e557514` T1：`ChannelPreSendRejection` + outbox 归类 + 微信出站改抛，新增 `tests/wechat-pre-send-rejection.test.ts`、`tests/channel-pre-send-rejection-outbox.test.ts`；
  - `3900658` T2：`src/wechat-context-tokens.ts` + 连接层回灌与回调 + 适配器、manager、index 接线，新增 `tests/wechat-context-tokens.test.ts`、`tests/wechat-context-token-wiring.test.ts`；
  - 本交付落档提交。
- **验收对照**：
  - 缺 token 时出站行不进入 `uncertain`：发送前抛 `ChannelPreSendRejection`，outbox 行落 `failed`，同 turn 后续行照常投递；调用 iLink 之后的普通异常仍落 `uncertain`。均有测试。
  - 重启后的主动发送：新连接在没有收到任何入站消息时，用持久化的 token 发送成功（连接层测试）；换 `ilinkBotId` 后旧 token 不回灌；secret 写入读最新值合并，和游标写入互不覆盖；token 值不进日志（源码断言）。
  - 门禁：`npm run verify` 六步全绿（2834 过 23 跳 0 败，26.2s）；`node scripts/check-scope.mjs` 17 个路径全在声明范围内。
- **偏差**：
  1. 错误类没有直接定义在 `src/im-channel.ts`，而是放在新的零依赖模块 `src/channel-errors.ts`，再由 `im-channel.ts` 重新导出。原因：`im-channel.ts` 依赖链很重（会拉起配置和各渠道模块），outbox 模块直接 import 它有循环依赖风险。`.gatescope.json` 的 allow 相应扩宽。
  2. 旧版 `/api/config/user-im` 热重载路径（`src/index.ts` 中 `saveUserWeChatConfig` 那一支）没有接 token 持久化：按 CLAUDE.md，它只用于兼容，新功能统一走 `channel-accounts`。
  3. T2 第一次提交时 pre-commit 格式检查没过，但命令用 `;` 串联，提交照样执行了；随即格式化并 amend 成 `3900658`，门禁通过。之后的提交命令改用 `&&` 串联。
- **范围外登记**：
  - 飞书 `src/feishu.ts:1863` 的 `Feishu client is not connected` 是发送前确定的拒绝，但仍抛普通 `Error`，会落 `uncertain`；飞书、QQ 其余几处 `No message_id in response`、`no file_info in response` 发生在调用之后，结果确实不确定，维持现状正确。
  - iLink 返回非零错误码（例如持久化 token 已失效）仍按普通错误处理，落 `uncertain`：服务端是否已投递无法确认，按拍板不改。token 的实际有效期没有文档，需要实机观察。
  - `src/im-channel.ts` 中微信适配器 `!inner` 时静默返回的分支：经 `imManager` 调用时会被 `isConnected()` 挡住，不可达，不处理。
- **待用户决定**：实机验收（重启服务后，在没有新入站消息的情况下，确认主动消息能发出）、合入 main、推送。
