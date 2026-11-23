# ISSUE-23 iLink 非零错误码的归类：哪些属于确定拒绝

| 字段          | 值                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                       |
| 领取人 / 分支 | —                                                                                            |
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

（领取后填写）
