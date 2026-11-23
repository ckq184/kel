# 任务立项：ISSUE-19 微信 context_token 重启丢失与“无 token”被误判为 uncertain

> 立项日期：2026-11-23｜base：`5322ef2`（本地 main tip，ISSUE-14 合并提交）｜分支：`claude/issue-19-wechat-context-token`
> 来源：`docs/issues/ISSUE-19-wechat-context-token-restart.md`（ISSUE-14 实机验收发现）

## 0. 需求采访结论（2026-11-23）

- **目标**：服务重启后，微信机器人仍能给已授权的用户发主动消息；发送前就能确定的拒绝不再把 outbox 行标成 `uncertain`、封住整个 turn。
- **完成条件**：两个问题都有测试锁定；`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
- **约束**：不改数据库 schema；token 只落在加密的渠道账号 secret 里；凭据和 token 不得写进日志；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 事实                                                                                                                                                     | 位置                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `contextTokenCache` 是进程内 `Map`，connect 开始和 disconnect 时都会 `clear()`                                                                           | `src/wechat.ts:597`、`:649`                                  |
| 入站在授权通过后写缓存 `contextTokenCache.set(fromUserId, msg.context_token)`                                                                            | `src/wechat-inbound.ts:305`                                  |
| 文本、图片、文件三个出站函数取不到 token 就抛普通 `Error`；图片、文件超过大小上限也抛普通 `Error`，都发生在调用 iLink 之前                               | `src/wechat-outbound.ts:210-221`、`:248-262`、`:340-356`     |
| `deliverChannelOutboxItem` 只把 `DefinitiveChannelDeliveryError` 当确定拒绝，`sending` 之后的其他异常一律落 `uncertain`                                  | `src/channel-outbox-delivery.ts` catch 分支                  |
| 长轮询游标 `getUpdatesBuf` 已经经 `onUpdatesBuf` 回调写入渠道账号加密 secret（`saveChannelAccountSecret`），类型是 `Record<string, string \| undefined>` | `src/index.ts:13450-13470`、`src/channel-account-secrets.ts` |
| 配置链路：`index.ts` → `imManager.connectUserWeChat(config, options)` → `createWeChatChannel(config, onUpdatesBuf)` → `createWeChatConnection(config)`   | `src/im-manager.ts:1180-1220`、`src/im-channel.ts:562-610`   |
| 扫码确认时 secret 是合并写入（保留旧字段），所以存 token 时要绑定 `ilinkBotId`，换号后旧 token 自动作废                                                  | `src/routes/channel-accounts.ts:728`                         |

## 2. 用户决策（2026-11-23，全部按推荐）

| 项            | 决策                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| token 持久化  | **存进渠道账号加密 secret**：仿照 `onUpdatesBuf` 新增回调，按微信用户 ID 保存最新 token 和写入时间；启动时回灌缓存；与 `ilinkBotId` 绑定，换号即作废 |
| 无 token 归类 | **转 failed**：不封 turn，不重试                                                                                                                     |
| 映射位置      | **通用错误类**：`src/im-channel.ts` 定义 `ChannelPreSendRejection`，渠道抛它，`deliverChannelOutboxItem` 把它当确定拒绝                              |
| 范围          | **只改微信的发送前检查**（缺 token、图片或文件超过大小上限）；iLink 非零错误码、飞书、QQ 的同类路径只盘点并登记到交付记录                            |

## 3. 实现方案

1. **通用错误类**：`src/im-channel.ts` 导出 `ChannelPreSendRejection extends Error`（注释写明只能用于“确定没有调用提供方”的拒绝）。`src/channel-outbox-delivery.ts` 的 catch 把它和 `DefinitiveChannelDeliveryError` 一样视为确定拒绝（无 `retryAt` → `failed`）。
2. **微信出站**：`src/wechat-outbound.ts` 三处缺 token、两处超过大小上限改抛 `ChannelPreSendRejection`，错误信息不变。
3. **token 序列化**：新增 `src/wechat-context-tokens.ts`，提供纯函数：`parseWeChatContextTokens(raw, botId)`（JSON 损坏或 botId 不符返回空）、`serializeWeChatContextTokens(botId, entries)`（按写入时间保留最近 200 个用户）。secret 里用一个字符串字段 `contextTokens` 存 JSON。
4. **连接层**：`WeChatConnectionConfig` 增加 `contextTokens?: Record<string, string>`；connect 清空缓存后用它回灌；`WeChatConnectOpts` 增加 `onContextToken?(userId, token)`，入站写缓存且 token 变化时调用。`im-channel.ts`、`im-manager.ts` 透传。
5. **启动接线**：`src/index.ts` 微信分支从 secret 解析 `contextTokens` 传入 config；`onContextToken` 回调读最新 secret、合并后 `saveChannelAccountSecret`（与 `onUpdatesBuf` 同一写法），不在日志里输出 token。
6. **测试（TDD）**：序列化纯函数；连接层回灌与回调（重连后缓存仍可用、token 不变不回调）；出站缺 token、超大小抛 `ChannelPreSendRejection`；`deliverChannelOutboxItem` 遇到它落 `failed` 而非 `uncertain`；index 接线源码断言。

## 4. 任务拆分与回滚点

| 任务 | 内容                                       | 验收                                                     | 回滚点   |
| ---- | ------------------------------------------ | -------------------------------------------------------- | -------- |
| T1   | 通用错误类 + outbox 归类 + 微信出站改抛    | 缺 token / 超大小的 outbox 行落 `failed`，turn 不被围栏  | 立项提交 |
| T2   | token 序列化 + 连接层回灌与回调 + 启动接线 | 重启（新连接）后用持久化 token 能发送；换 botId 后不回灌 | T1 提交  |
| T3   | 门禁与交付落档                             | verify 全绿、check-scope 通过、issue 已完成              | T2 提交  |

## 5. 非目标

- 不把 iLink 返回的非零错误码改成确定拒绝（服务端是否已投递无法确认）。
- 不改飞书、QQ 的出站错误分类，只盘点登记。
- 不新增数据库表、不升级 schema；不做 token 过期探测或主动刷新。
- 不处理 `im-channel.ts` 中 `!inner` 时静默返回的分支（经 `imManager` 调用时被 `isConnected()` 挡住，不可达），只登记。
