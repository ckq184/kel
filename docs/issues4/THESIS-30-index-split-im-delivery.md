# THESIS-30 index.ts 拆分（三）：IM 投递与指示器

| 字段          | 值                                                       |
| ------------- | -------------------------------------------------------- |
| 状态          | 待领取                                                   |
| 领取人 / 分支 | —                                                        |
| 优先级        | P2                                                       |
| 类型          | 结构重构（搬代码，不改行为）                             |
| 依赖          | THESIS-29                                                |
| 阻塞          | 31                                                       |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 30 行          |
| 预计改动路径  | `src/index.ts`、`src/im-delivery/**`（新建）、`tests/**` |
| 需用户决策    | 否                                                       |
| 来源          | 方案 P7、§7.2                                            |

## 目标

把 IM 出站投递、输入中/处理中指示器与周期性流式缓冲搬出 `src/index.ts`，约 1,200 行。

## 范围（`248c7cb`，按符号定位）

- 投递：outbox 作用域、`deliverScopedChannelOutput`（:1971）、`sendImWithRetry`（:2120）、系统通知、主动发送回退、任务图片与文件发送（约 :1794–2726）。调查结论：这一簇只依赖 `imManager`，耦合最低。
- 指示器：typing 与处理中指示（约 :3940–4076）。
- 周期性流式缓冲（约 :8490–8635，无模块状态依赖）。

建议目录：`src/im-delivery/`，按投递、通知、指示器、流式缓冲分文件。

## 约束

同 [THESIS-29 的拆分包通用约束](THESIS-29-index-split-im-commands.md#约束拆分包通用)。本簇相关的读源码测试有 `tests/reply-delivery-host-contract.test.ts`、`tests/channel-side-effect-ack-contract.test.ts` 等，执行时用 `git grep -l "src/index.ts" -- tests` 逐个核对。

## 实现步骤

1. 基线全量测试通过。
2. 搬代码、调整 import、改契约测试的读取路径。
3. 交付记录给出 `src/index.ts` 改前改后行数。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：IM 里发消息，机器人回复（含流式卡片）；Agent 发送一张图片和一个文件到 IM；运行一次会给 IM 发通知的定时任务。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
