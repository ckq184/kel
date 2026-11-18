# 任务立项：飞书合法拒绝路由被 channel_inbox 无限重试

> 立项日期：2026-11-18｜base：`56c36c0`｜状态：方案已获用户确认（见 §2、§6）
> 性质：真 Bug 修复。承接 `docs/feishu-p2p-bootstrap-fix-plan.md` §4「不做」中明确留作另立小项的问题；
> 依赖其提交 `f37a559` / `56c36c0`（本分支已快进到 `56c36c0`，纯本地操作，不 push）。

## 1. 背景与取证

### 1.1 根因（已读代码复核，结论成立）

`src/im-manager.ts` 的 `scopeConnectOpts` 包装器对 `resolveEffectiveChatJid` 在两种**语义完全不同**的情形下
都抛同一个 `ChannelRouteRejectedError`（`src/im-manager.ts:347-353`）：

| 情形                                                | 本质                        | 应有处理                  |
| --------------------------------------------------- | --------------------------- | ------------------------- |
| `inboundAllowed()` 为假（暂停 / 停用 / 用户被封存） | 连接状态问题，**可恢复**    | 保留重试                  |
| 底层解析器返回 `null`                               | 合法拒绝（陈旧/缺失的绑定） | 终止：`ignore` + 记录原因 |

于是 `src/channel-admission.ts` 的 `resolveAdmittedChannelRoute()`（文档明确写着“resolver 的 null = 陈旧/无效绑定 =
fail-closed，返回 null”）经包装器时**永远不会返回 null，只会抛错**：

- 飞书 `src/feishu.ts` 严格路由检查之后的 `if (!admittedRoute) { …ignoreClaimedInbound(claim, payload, 'binding_rejected') }`
  **不可达**；合法拒绝落入函数末尾 catch → `failClaimedInbound(claim, payload, err, true)`。
- `failChannelInbox` 带 `retryAt` 时只是把记录放回 `queued`（`src/channel-reliability-store.ts:966-983`）：
  **没有重试上限**（`attempt` 列虽每次认领自增，但重试流程不据此设限；此处原稿误写为“没有尝试计数”，已更正），
  固定 `FEISHU_INBOX_RETRY_DELAY_MS = 5s`，永远重试。
- 恢复路径沿用原 `source`（`'ws'`），catch 里 `source === 'ws'` 会**每次失败都向该聊天发**
  「⚠️ 消息处理暂时失败，系统将自动重试」——对合法拒绝等于每 5 秒一条重复提示。

### 1.2 三渠道评估

| 渠道 | 持久 inbox | 路由前门禁                              | 经包装器后的行为                                                                                                                                                               |
| ---- | ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 飞书 | 有         | 无配对门禁（P2P 有首条私聊引导，已修）  | 抛错 → 记失败并**无限重试** + 重复发“处理暂时失败”（真缺陷）                                                                                                                   |
| QQ   | 无         | `isChatAuthorized` 配对门禁在前（两处） | `dedup.markSeen` 先于路由，抛错进外层 catch，仅 `logger.error('Error handling QQ …message')`，消息被丢弃、**不重试**；各自的 `if (!resolvedRoute) { warn; return }` 分支不可达 |
| 微信 | 无         | `isChatAuthorized` 配对门禁在前（一处） | 同上（`'Error handling WeChat message'`）                                                                                                                                      |

结论：QQ/微信只有“日志级别与可达性”问题，无行为缺陷；飞书是真缺陷。

### 1.3 解析器返回 null 的来源（`src/index.ts` `buildResolveEffectiveChatJid`）

群/会话未注册、`channel_mounts` 陈旧、`target_agent_id` 找不到、`thread_map` 的 `target_main_jid` 陈旧、
主会话 `target_main_jid` 陈旧/缺失、无任何绑定、原生线程挂载升级冲突。均为**配置层持久性错误**，
等待重试不会自愈（首条私聊的“未注册”由 P2P 引导处理，不属于此处）。

## 2. 裁决（用户已确认）

| 方案                                                 | 评估                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 错误带 reason + admission 助手转 null（采纳）** | 包装器仍 throw（两处钉死测试的 `toThrow` 文案不变）；`ChannelRouteRejectedError` 加可选 `reason`；`resolveAdmittedChannelRoute` 仅把 `binding_unresolved` 转为 `null`，其余照常抛。改 2 个源文件，`feishu.ts` 零改动，三渠道同时回到各自既有的 dropped 分支 |
| B. 加 reason，仅 `feishu.ts` 局部 catch              | 改动面略小，但 QQ/微信 dropped 分支仍不可达，三渠道语义不一致                                                                                                                                                                                               |
| C. 包装器 null 改回返回 null，仅停用才抛             | 最贴近助手原契约，但要翻转 `tests/im-manager-channel-accounts.test.ts` 钉死的 null→throw，且改变 admission 契约与 P2P 探测前提，不采纳                                                                                                                      |

## 3. 设计

`src/channel-admission.ts`：

```ts
export type ChannelRouteRejectionReason =
  | 'binding_unresolved' // 解析器判定无合法路由（陈旧/缺失绑定）——终止
  | 'connection_inactive'; // 连接暂停/停用/用户封存——保留重试

export class ChannelRouteRejectedError extends Error {
  readonly sourceJid: string;
  readonly reason?: ChannelRouteRejectionReason; // 未标注（如流式卡片对账）保持原行为

  constructor(sourceJid: string, reason?: ChannelRouteRejectionReason) { … }
}

export function resolveAdmittedChannelRoute(…) {
  if (!resolver) return { targetJid: sourceJid, routing: null };
  let routing;
  try {
    routing = resolver(sourceJid, context);
  } catch (err) {
    // 配置了 resolver 的连接经 im-manager 包装器：它对“解析器 null”抛 binding_unresolved。
    // 恢复为本助手文档化的契约：stale/invalid binding → null（fail-closed，由调用方丢弃）。
    if (err instanceof ChannelRouteRejectedError && err.reason === 'binding_unresolved') return null;
    throw err;
  }
  return routing ? { targetJid: routing.effectiveJid, routing } : null;
}
```

`src/im-manager.ts`：三处抛错点带 reason——`resolveEffectiveChatJid` 的 `!inboundAllowed()` 与
`resolveFeishuConversationPlan` 的 `!inboundAllowed()` 为 `connection_inactive`；`resolved === null` 为
`binding_unresolved`。`reconcileStreamingCard` 的两处抛错**不标注**（语义是流式卡片账号授权，与入站路由无关）。

不变量：

- 飞书 P2P 引导探测（`src/feishu.ts` 直接调用解析器，不经助手）继续把任意 `ChannelRouteRejectedError` 视为“尚未注册”，
  `onNewChat` / `onP2pSender` 流程不变；引导后严格检查通过的路径不变。
- 暂停/停用连接：仍抛 `connection_inactive`，助手不吞，飞书走原 catch 保留重试。
- 没有 resolver 的独立连接器行为不变。

## 4. 行为矩阵

| 场景                                            | 修复前（飞书）         | 修复后（飞书）                                  | QQ / 微信                                              |
| ----------------------------------------------- | ---------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| 首条未知私聊                                    | 引导注册后通过（已修） | 不变                                            | 不适用（配对门禁在前）                                 |
| 解析器 null（陈旧 mount / agent 缺失 / 无绑定） | 无限重试 + 每 5s 提示  | `ignored`，reason `binding_rejected`，一次 warn | dropped 分支可达：`warn` + return（原为 `error` 日志） |
| 连接暂停 / 账号停用 / 用户封存                  | 保留重试               | 不变（仍保留重试）                              | 不变（抛错进外层 catch）                               |
| 解析器抛非 `ChannelRouteRejectedError` 异常     | 失败并重试             | 不变                                            | 不变                                                   |

## 5. 不做

- 不做有界重试：`channel_inbox.attempt` 列存在（原稿误写“无该列，需 schema 迁移”，已更正），但设上限会让短时故障丢消息，
  属独立语义变更，本任务不做。
- 不改“消息处理暂时失败”提示的触发策略（该问题已由 `docs/feishu-retry-notice-once-plan.md` 单独处理）。
- 不改 `src/feishu.ts`、`src/qq.ts`、`src/wechat.ts`；不改 CI/lint/门禁配置；不改库、不碰 `data/`；
  **不处理运行时数据库里已卡住的 `queued` 记录**。
- 不对合法拒绝的发送者回复提示（沿用既有 `binding_rejected` 分支的静默语义）。

## 6. 步骤（TDD）

1. 立项提交（本文档 + `.gatescope.json`，base `56c36c0`）。
2. 写回归测试并确认先红：
   - `tests/channel-admission.test.ts`：助手对 `binding_unresolved` 抛错返回 null；`connection_inactive` / 未标注 / 其它异常照常抛出。
   - `tests/im-manager-channel-accounts.test.ts`：包装器 null → `reason === 'binding_unresolved'`；暂停/停用 → `'connection_inactive'`（文案不变）。
   - `tests/feishu-p2p-first-dm-bootstrap.test.ts`（真实 `IMConnectionManager` + 真实 feishu 处理器）：
     合法拒绝（陈旧绑定私聊）**翻转**为 `ignored` / `binding_rejected` 且不再触发重试提示、不调用 `onFollowUpMessage`；
     停用账号仍 `queued`；首条私聊引导、owner 学习用例保持绿。
3. 实现 `channel-admission.ts` + `im-manager.ts`，测试转绿。
4. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过，实现单独提交，不 push。

## 7. 风险与未验证项

| 风险                                                               | 应对                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 合法拒绝的消息被终止后不补发（此前无限重试，偶有“事后补绑后补投”） | 用户已确认接受；终止是 `binding_rejected` 分支原本的设计意图，重试在配置层持久性错误上永不自愈，只产生噪音 |
| reason 漏标导致停用被误吞                                          | 助手只转换显式 `binding_unresolved`，未标注一律照常抛；测试覆盖                                            |
| QQ/微信日志级别由 error 降为 warn                                  | 行为不变；本任务**未做** QQ/微信真实处理器端到端测试，仅由助手单测与既有源码顺序 pin 覆盖                  |
| 停用连接的飞书消息仍每 5s 重试并重复提示                           | 不在本任务范围（停用账号通常已断开连接，恢复定时器随之失效），仅在报告中记录                               |
