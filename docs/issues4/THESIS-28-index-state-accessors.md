# THESIS-28 index.ts 拆分（一）：模块状态读写器

| 字段          | 值                                                                   |
| ------------- | -------------------------------------------------------------------- |
| 状态          | 待领取                                                               |
| 领取人 / 分支 | —                                                                    |
| 优先级        | P2                                                                   |
| 类型          | 结构重构（不改行为）                                                 |
| 依赖          | THESIS-19、20、22、23、26、34、35、36、37（都可能改 `src/index.ts`） |
| 阻塞          | 29、30、31                                                           |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 28 行                      |
| 预计改动路径  | `src/index.ts`、`src/host-state.ts`、`tests/**`                      |
| 需用户决策    | 否                                                                   |
| 来源          | 方案 P7、§7.2                                                        |

## 目标

把 `src/index.ts` 的四个模块级可变状态收进 `src/host-state.ts`，提供读写器。这是后续三个拆分包的前提：被搬出去的代码要读写这些状态，不能再直接引用 `index.ts` 的局部变量。本包不搬任何业务函数。

## 现状（`248c7cb`）

- `src/index.ts:645` `let registeredGroups`，以及 `sessions`、`lastAgentTimestamp`、`globalMessageCursor`。调查时的重新赋值点：:4176–4212（`loadState`）、:4278、:4318、:4835、:8988、:11254、:14011。
- `src/host-state.ts`（73 行）是 ISSUE-12 为 turn 注册表建立的宿主共享状态模块，已有先例。
- 读源码文本的测试：`tests/host-ipc-output-router.test.ts` 钉死 `streamingAccumulatedText`、`agentStreamingAccText` 等变量名；其余见方案 §7.2。

## 设计约束

- 读写器只是薄封装：`getRegisteredGroups()` 返回当前对象引用，`setRegisteredGroups(next)` 整体替换；不引入事件、不复制对象，保证与原来的引用语义一致（原代码里有"整体重新赋值"与"原地修改"两种写法，逐处保持）。
- `index.ts` 内部也改为经读写器访问，避免同一状态两种访问方式并存。

## 顺带：清理未用 import（原 THESIS-26 B1）

`src/index.ts` 约 30 条整行未用的 import 与 38 个未用说明符，以及 `src/db.ts`、`src/container-runner.ts`、`src/feishu.ts`、`src/ipc/watcher.ts`、`src/routes/config.ts`、`src/wechat.ts` 的零星未用 import（`ca4ebce` 调查，约 −140 行）。前面各包合入后数量会变，执行时用 `npx tsc --noEmit --noUnusedLocals` 重新列出。单独一个提交，先于状态迁移。

## 非目标

- 不搬函数，不改任何业务逻辑与日志。
- 不动 `processGroupMessages`、`processAgentConversation` 内部的闭包状态。

## 实现步骤（TDD）

1. **Red**：`host-state` 读写器单测（替换后读到新引用、原地修改可见）；一个契约断言：`src/index.ts` 不再有这四个顶层 `let`。
2. **Green**：迁移状态与全部访问点。
3. 全量测试；读源码文本的测试若匹配了 `registeredGroups[` 一类写法，改为匹配读写器调用，断言意图不变。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：重启服务后工作区列表、会话、IM 收发、定时任务各走一次。

## 风险与回滚

- 漏改一处访问点会导致读到旧引用。TypeScript 能抓到大部分（顶层 `let` 删除后旧名不再存在）。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
