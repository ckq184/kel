# THESIS-31 index.ts 拆分（四）：IM 连接回调与渠道重载

| 字段          | 值                                                        |
| ------------- | --------------------------------------------------------- |
| 状态          | 待领取                                                    |
| 领取人 / 分支 | —                                                         |
| 优先级        | P2                                                        |
| 类型          | 结构重构（搬代码，不改行为）                              |
| 依赖          | THESIS-30                                                 |
| 阻塞          | 无                                                        |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 31 行           |
| 预计改动路径  | `src/index.ts`、`src/im-callbacks/**`（新建）、`tests/**` |
| 需用户决策    | 否                                                        |
| 来源          | 方案 P7、§7.2                                             |

## 目标

把 IM 连接建立时注入的回调、渠道账号重载与绑定健康检查搬出 `src/index.ts`，约 1,800 行。完成后 `src/index.ts` 预计约 10k 行。

## 范围（`248c7cb`，按符号定位）

- 连接回调（约 :11830–13153）：`buildOnNewChat`（:11830）、自动 IM 会话、飞书机器人入群、`buildIsChatAuthorized`、`buildOnPairAttempt`、原生线程会话、`buildResolveEffectiveChatJid`、`buildOnAgentMessage`、主人与发送者闸门、跟进卡片动作。
- 渠道账号重载：`reloadChannelAccountById`（:13175）。THESIS-19、22 删掉的旧重载与旧配置同步不在此列。
- `checkImBindingsHealth`（:14912）。

建议目录：`src/im-callbacks/`。

## 约束

同 [THESIS-29 的拆分包通用约束](THESIS-29-index-split-im-commands.md#约束拆分包通用)。本簇相关的读源码测试有 `tests/channel-unbind-default-contract.test.ts`、`tests/feishu-channel-account-owner.test.ts`、`tests/channel-account-startup-contract.test.ts` 等。

## 实现步骤

1. 基线全量测试通过。
2. 搬代码、调整 import、改契约测试的读取路径。
3. 交付记录给出 `src/index.ts` 改前改后行数，以及本轮四个拆分包合计的变化。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：把机器人拉进一个新飞书群并 @ 它；QQ 或微信私聊配对；在设置页停用再启用一个渠道账号，确认重连。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
