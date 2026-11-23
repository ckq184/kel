# ISSUE-23 iLink 非零错误码的归类：哪些属于确定拒绝

| 字段          | 值                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                       |
| 领取人 / 分支 | `claude/gallant-nash-709e79`                                                                 |
| 优先级        | P3                                                                                           |
| 类型          | 缺陷调查（需实机观察）                                                                       |
| 依赖          | 无                                                                                           |
| 阻塞          | 需要可用的微信机器人账号，并能制造 context_token 失效的场景                                  |
| 预计改动路径  | `src/wechat.ts`（`assertWeChatApiSuccess`）、`src/wechat-outbound.ts`，以及相应的 `tests/**` |
| 需用户决策    | **是**：观察结果出来后，决定把哪些错误码视为确定拒绝                                         |
| 来源          | ISSUE-21 A2（原登记于 ISSUE-19 交付记录），用户 2026-11-23 拍板“拆成独立 issue”              |

## 现象

`assertWeChatApiSuccess` 遇到 iLink 返回非零错误码时抛普通 `Error`。outbox 状态机把 `sending` 之后的普通错误都标成 `uncertain`，会封住整个 turn。如果某些错误码（例如持久化的 context_token 已失效）能证明消息没有投递，应当像 `ChannelPreSendRejection` 一样转为 `failed`。目前代码里没有依据判断哪些错误码属于这一类，token 的实际有效期也没有文档。

## 建议步骤

1. 实机制造 token 失效（例如长时间不与机器人互动后让 Agent 主动发消息），记录 iLink 的返回码与信息（不记录 token 与凭据）。
2. 确认该返回码下消息确实没有到达用户。
3. 请用户拍板：哪些错误码视为确定拒绝（抛 `DefinitiveChannelDeliveryError` 或 `ChannelPreSendRejection` 的同类），其余维持 `uncertain`。
4. TDD 落地，补 outbox 归类测试。

## 交付记录

- **分支**：`claude/gallant-nash-709e79`，base `b75a034`；立项文档 `docs/issue23-wechat-ilink-error-classification-plan.md`。
- **用户决策（2026-11-23，全部按推荐）**：仅 -14 视为确定拒绝；仅当本次发送还没有任何可见内容发出时才算；`src/channel-errors.ts` 新增 `ChannelProviderRejection`；实机验收交付后由用户决定。
- **提交**：
  - `e1cb098` 立项：领取、立项文档、`.gatescope.json`。
  - `b779848` 实现：`ChannelProviderRejection`；outbox 归类纳入该类（落 `failed`，不封 turn）；`assertWeChatApiSuccess` 在所有非零码都为 -14 时抛该类，错误信息格式不变；`sendMessage`、`sendImage` 在已有分段或标题发出后降级为普通错误（`cause` 保留原错误）。新增 `tests/wechat-ilink-provider-rejection.test.ts`，`tests/channel-pre-send-rejection-outbox.test.ts` 补 outbox 归类用例。
- **验证**：`npm run verify` 六步全绿（357 文件，2926 通过、23 跳过）；`node scripts/check-scope.mjs` 通过（10 个路径全在声明范围内）。
- **与 issue 描述的偏差**：
  - 没有做建议步骤 1、2 的实机观察。三个验收 worktree 的 `channel_outbox.error` 里没有任何 iLink 出站错误码。-14 的依据是 `src/wechat-poller.ts` 已有的会话过期常数，以及多个公开 iLink SDK 的一致处理（机器人会话超时，需要重新扫码）。实机验收由用户决定。
  - 第三方笔记称媒体推送 context_token 无效时返回 `ret:-2`，证据不足，未纳入，维持 `uncertain`。
- **遗留**：context_token 的实际有效期仍无文档；若实机观察到其他“确定未投递”的错误码，在 `assertWeChatApiSuccess` 的判定处追加并补测试即可。-14 出现在出站路径时不会触发连接状态上报（非目标）。
