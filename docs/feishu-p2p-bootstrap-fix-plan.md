# 任务立项：修复飞书首次私聊注册失败（P2P 引导探测抛 ChannelRouteRejectedError）

> 立项日期：2026-11-18｜base：`4379013`｜状态：方案已获用户确认（见 §3）
> 性质：真 Bug 修复，不涉及死代码清理、pi runner、端口隔离等其它任务，不依赖其提交。

## 1. 背景与取证

### 1.1 现象（用户从运行时数据库观察，非本任务取得，未改库）

- `channel_inbox` 中一条私聊「你好」（chat `oc_527a…`，08:45:32）：状态 `queued`、已重试 34 次，
  错误为 `Channel binding resolver rejected route for feishu:oc_527a…#account:d2e1383d-…`。
- `owner_im_id` 始终为 NULL；渠道密钥里始终没有 `ownerOpenId`（更新时间停在 08:10）。

### 1.2 根因（已读代码复核，结论成立）

两处代码对 `resolveEffectiveChatJid` 的“解析不到”语义不一致：

| 位置                                                     | 语义                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/im-manager.ts:341-362`（`scopeConnectOpts` 包装器） | 连接停用/暂停（`inboundAllowed()` 为假）**或**底层解析器返回 `null` 时，均 `throw new ChannelRouteRejectedError(...)`；既有测试 `tests/im-manager-channel-accounts.test.ts:560-591` 明确 pin 了“null → throw” |
| `src/feishu.ts:2337-2346`（P2P 引导）                    | 写成 `!resolveEffectiveChatJid(chatJid)`，期望解析不到时拿到 falsy，随后执行 `onNewChat` / `onP2pSender` 完成“首条私聊即注册 + 学习 owner”                                                                    |

走真实账号连接时，传给 feishu 的是 im-manager 包装后的 `resolveEffectiveChatJid`。未注册私聊的
`registeredGroups[chatJid]` 不存在 → 底层 `buildResolveEffectiveChatJid()`（`src/index.ts:17820-17825`）
返回 `null` → 包装器抛错 → 异常在 `!resolve…(…)` 求值处冒出，`onNewChat` / `onP2pSender` 永远不会执行 →
私聊无法注册、owner 无法学习；`src/feishu.ts:2846-2851` 把异常记为失败并交给 channel_inbox 重试，
注册前提永不满足，于是无限重试。

引导块上方注释（`feishu.ts:2319-2336`）与 `tests/feishu-route-safety.test.ts:19-42` 都写明了意图
“首条 DM 必须能在路由检查前自行注册”，意图正确、与包装器契约不一致，属于实现缺陷而非设计取舍。

### 1.3 影响面评估（`git grep -w resolveEffectiveChatJid` 全调用方核对）

- **飞书**：唯一把“解析不到”当作需要引导的分支（`feishu.ts:2337-2346`）。第二处调用
  `resolveAdmittedChannelRoute`（`feishu.ts:2348`）必须保持严格。
- **QQ**（`qq.ts:1592`、`qq.ts:1807`）、**微信**（`wechat.ts:867`）：在路由解析之前已有
  `isChatAuthorized` 配对门禁（`qq.ts:1577`/`1793`、`wechat.ts:852`）——陌生会话先走 `/pair`，
  未配对消息在到达解析器前即被拒收。不存在“未注册就探测路由”的引导分支，**不受本 Bug 影响**。
- 包装器的 throw 对 QQ/微信是“合法拒绝抛错”，行为不在本任务范围。

## 2. 裁决

| 方案                                       | 评估                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. feishu 侧窄 try/catch（采纳）**       | 仅改 `feishu.ts` 引导块；只捕获 `ChannelRouteRejectedError` 视为“未绑定”，其它异常照常抛出；im-manager 包装器契约、QQ、微信、类型面零改动；第二道严格路由检查仍抛错 |
| 1+. 抽成 `channel-admission.ts` 探测小工具 | 契约与错误类同处、可单测，但新增一个仅单点使用的导出（违背“不为单次使用造抽象”），不采纳                                                                            |
| 2. 包装器拆成“探测 + 严格”两个入口         | 需同步改 `im-channel.ts` 三处转发、`feishu.ts` 与 `im-manager.ts` 的 opts 类型及三个 connect 函数，改动面 5 文件，QQ/微信也要过类型，对既有调用方影响最大，不采纳   |

用户已确认：方案 1（inline）、行为测试替换源码 pin、不处理“合法拒绝被无限重试”。

## 3. 方案

`src/feishu.ts` P2P 引导块改为：

```ts
if (chatType === 'p2p' && resolveEffectiveChatJid) {
  let routeResolved = true;
  try {
    routeResolved = !!resolveEffectiveChatJid(chatJid);
  } catch (err) {
    // im-manager 包装器对“解析不到”抛 ChannelRouteRejectedError（契约），
    // 对首条私聊而言它就是“尚未注册”信号；其它异常照常抛出。
    if (!(err instanceof ChannelRouteRejectedError)) throw err;
    routeResolved = false;
  }
  if (!routeResolved) {
    onNewChat?.(chatJid, resolvedChatName);
    if (senderOpenId && onP2pSender) onP2pSender(senderOpenId);
  }
}
```

- 引导之后的 `resolveAdmittedChannelRoute` 仍走严格包装器：合法拒绝依旧抛错，不被兜底吞掉。
- 连接被停用/暂停时探测也会抛同一异常，落入引导分支，但包装器的 `onNewChat` / `onP2pSender`
  在 `inboundAllowed()` 为假时均为 no-op，随后第二道严格检查再抛错、消息留待重试——与修复前对该场景的
  最终效果一致，无新副作用。
- 引导后 `onNewChat`（`index.ts:18368-18382`）经 `applyChannelAccountRegistrationFallback` 绑定账号默认工作区，
  第二道路由检查随即可解析；owner 经 `onP2pSender`（`index.ts:18417-18437`）写入 `ownerOpenId`。

## 4. 不做

- **不处理“合法拒绝被 channel_inbox 无限重试”**：包装器对 null 一律抛错，使 `feishu.ts:2368-2375` 的
  `binding_rejected` 丢弃分支经包装器时不可达，陈旧 mount 等合法拒绝同样会被无限重试。属于独立问题，
  会改变 admission 契约与“停用连接抛错以便重试”的语义，建议另立小项。
- 不改 `src/im-manager.ts`、`src/channel-admission.ts`、QQ、微信及任何类型定义。
- 不改 CI/lint/门禁配置；不触碰 `data/`；**不直接修改运行时数据库里卡住的那条 `queued` 消息**。

## 5. 步骤（TDD）

1. 立项提交（本文档 + `.gatescope.json`）。
2. 写回归测试 `tests/feishu-p2p-first-dm-bootstrap.test.ts`：真实 `IMConnectionManager` 包装 + 真实 feishu 处理器（mock Lark SDK）
   - 未知私聊首条消息不再抛 `ChannelRouteRejectedError`，`onNewChat` 被调用、私聊被注册；
   - 同一流程 `onP2pSender` 被调用并记录 owner open id；
   - 解析器合法拒绝（私聊已注册但绑定陈旧）时仍以 `Channel binding resolver rejected route` 失败并留在重试队列，不被引导兜底吞掉（探测无法区分“未注册”与“陈旧绑定”，引导对已注册私聊是幂等 no-op，与修复前设计意图一致）；
   - 账号被停用时不注册私聊、不学习 owner（包装器回调 no-op）；
   - 非 `ChannelRouteRejectedError` 的异常照常抛出；
   - 先确认在修复前变红。
3. 把 `tests/feishu-route-safety.test.ts` 中耦合源码格式的 pin 改为只断言“引导先于路由检查”的顺序。
4. 实现 `feishu.ts` 窄 try/catch，测试转绿。
5. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过，实现单独提交，不 push。

## 6. 风险

| 风险                                                                      | 应对                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| try/catch 误吞合法拒绝，削弱 fail-closed                                  | 只捕获 `ChannelRouteRejectedError`；引导块只做注册/学习 owner，第二道严格检查不动；测试覆盖合法拒绝仍抛 |
| 暂停/停用连接也进入引导分支                                               | 包装器回调在 `inboundAllowed()` 为假时 no-op；测试覆盖暂停连接不注册、不学习 owner                      |
| 源码 pin 测试随实现变红                                                   | 步骤 3 改为只断言顺序，行为由新测试守护                                                                 |
| 首条私聊即可认领 owner 属既有产品设计（“First valid DM claims this bot”） | 本任务不改变该语义，仅让它真正生效                                                                      |

## 7. 验证

1. 回归测试先红（修复前）后绿（修复后）。
2. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs`。
3. **未验证项（需真实飞书环境）**：卡住的那条 `queued` 消息在修复后重启服务是否被 channel_inbox 重试消化；
   这是运行时数据，本任务不改库，仅在报告中说明。
