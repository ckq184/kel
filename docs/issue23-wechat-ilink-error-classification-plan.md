# 任务立项：ISSUE-23 iLink 非零错误码的归类

> 立项日期：2026-11-23｜base：`b75a034`（本地 main tip，ISSUE-22 合并提交）｜分支：`claude/gallant-nash-709e79`
> 来源：`docs/issues/ISSUE-23-wechat-ilink-error-classification.md`

## 0. 需求采访结论（2026-11-23）

- **目标**：iLink 出站返回能证明消息未投递的错误码时，outbox 行落 `failed`，不再落 `uncertain` 封住整个 turn。
- **完成条件**：用户拍板的错误码被归为确定拒绝并有测试；其余错误码行为不变；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：不改数据库 schema；不改共享类型；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 项         | 复核结论                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现象       | 成立。`assertWeChatApiSuccess`（`src/wechat.ts:152`）对任何非零码抛普通 `Error`；`deliverChannelOutboxItem`（`src/channel-outbox-delivery.ts:388`）只认 `DefinitiveChannelDeliveryError` 与 `ChannelPreSendRejection`   |
| 调用点     | `src/wechat-outbound.ts` 三处：`sendMessageApi`（文本分段、图片标题共用）、`sendImage`、`sendFile`                                                                                                                      |
| 实机数据   | 无。三个验收 worktree 的 `channel_outbox.error` 只有本地错误（`No context_token`、租约过期、worker 放弃），没有任何 iLink 出站错误码                                                                                    |
| -14 的依据 | `src/wechat-poller.ts:60` 已把 -14 定义为会话过期；公开 SDK（wechat-ilink、lib-x/ilink、openclaw-weixin 衍生实现）一致把 -14 视为机器人会话超时，需要重新扫码；第三方笔记记录 `sendmessage` 在 token 不对时同样返回 -14 |
| -2 的依据  | 仅一份第三方笔记称媒体推送 context_token 无效时返回 `ret:-2`，文本消息是否同码未知                                                                                                                                      |
| 部分已发出 | 文本按 `MSG_SPLIT_LIMIT` 分段逐段发送，图片会先发标题；后段失败时前段已对用户可见                                                                                                                                       |

## 2. 用户决策（2026-11-23，全部按推荐）

| 问题       | 决策                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 错误码范围 | **仅 -14**；-2 及其他非零码维持 `uncertain`，等实机观察到再加                                              |
| 部分已发出 | **仅当本次发送还没有任何可见内容发出时**才算确定拒绝；已发出过任一段则仍落 `uncertain`                     |
| 错误类型   | **`src/channel-errors.ts` 新增 `ChannelProviderRejection`**（零依赖），outbox 归类与另两类同样视为确定拒绝 |
| 实机验证   | **交付后由用户决定**；本分支只做单元测试与门禁，交付记录写明依据                                           |

## 3. 方案

1. **错误类**：`src/channel-errors.ts` 导出 `ChannelProviderRejection extends Error`，注释写明只用于“服务商明确拒绝且本次操作没有产生可见消息”。
2. **outbox 归类**：`src/channel-outbox-delivery.ts` catch 分支把 `ChannelProviderRejection` 纳入 `explicitlyRejected`（无 `retryAt` → `failed`）。
3. **iLink 判定**：`assertWeChatApiSuccess` 在所有非零码都等于 -14 时抛 `ChannelProviderRejection`，错误信息格式不变；其余情况仍抛普通 `Error`。
4. **部分已发出降级**：`src/wechat-outbound.ts` 的 `sendMessage`、`sendImage` 记录本次是否已有可见调用成功；之后再收到 `ChannelProviderRejection` 时改抛普通 `Error`（信息不变，`cause` 保留原错误）。`sendFile` 只有一次可见调用，无需处理。

## 4. 测试（TDD，先红后绿）

- `assertWeChatApiSuccess`：`ret=-14`、`errcode=-14`、`base_resp.ret=-14` 抛 `ChannelProviderRejection`；`-2`、`40013`、混合码（`-14` 与其他非零码并存）仍抛普通 `Error`；信息格式不变。
- 出站：首段即 -14 → `ChannelProviderRejection`；第二段 -14 → 普通 `Error`；图片标题已发出后图片 -14 → 普通 `Error`；文件 -14 → `ChannelProviderRejection`。
- outbox：`deliverChannelOutboxItem` 在 `sending` 后遇到 `ChannelProviderRejection` 落 `failed`，同 turn 后续行不被围栏。

## 5. 非目标

- 不把 -2 或其他错误码归为确定拒绝。
- 不改 -14 时的连接状态上报或重新登录流程（出站路径不触发 `onConnectionStateChange`）。
- 不做实机复现；不改数据库与共享类型。

## 6. 回滚点

`.gatescope.json` 的 `base`：`b75a034`。
