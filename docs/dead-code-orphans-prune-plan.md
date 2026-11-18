# 任务立项：删除两个仅被测试引用的孤儿符号

> 立项日期：2026-11-18｜base：`b6357c4`｜状态：已获用户批准（核查报告第 3、4 项，"开始处理"）
> 前序：`docs/dead-code-tier2-prune-plan.md` §7（A 组清理时记为"连带孤儿，另案"）。

## 1. 背景与取证

A 组清理（`e24377e`）删掉了旧 Claude runner 遗留的调用方后，下面两个符号失去了最后的生产调用方：

| #   | 符号                         | 位置                                         | 生产引用 | 测试引用                                               | 原调用方（均已在 `e24377e` / `64d6d7b` 删除）                               |
| --- | ---------------------------- | -------------------------------------------- | -------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| 3   | `isStaleBackgroundWaitReply` | `container/agent-runner/src/utils.ts`        | 0        | `tests/background-task-summary-guard.test.ts` 3 个用例 | `shouldForceBackgroundTaskSummary`（旧 query 循环里决定是否强制补一轮汇总） |
| 4   | `serializeIpcInputMessage`   | `container/agent-runner/src/ipc-delivery.ts` | 0        | `tests/agent-runner-ipc-delivery.test.ts` 1 个用例     | `requeueIpcInputMessages`（旧 runner 把未处理消息写回 IPC 目录）            |

复核方式：`git grep -w` 与不区分大小写的 `git grep -i` 均只命中定义和测试；两个符号都没有动态字符串引用；文档里只有 tier-2 计划的一行记录。

## 2. 是死代码还是掉线逻辑（本任务的关键判断）

上一轮的教训是：引用分析看不见"靠数据字段连接"的功能，所以逐个核对符号背后的功能在 pi 链路里是否仍有实现。

- **#4 `serializeIpcInputMessage`：功能已被替代，安全。** 旧 runner 自己把被取消的消息写回 IPC 目录；pi 链路改为把被取消的回执交给宿主（`pi-runner.ts` 的 `cancelledIpcReceipts` → 输出里的 `ipcReceipts`），流提前结束时由宿主的重入队路径重试（`pi-runner.ts` 的 premature-end 分支）。runner 侧的文件重入队已不存在。
- **#3 `isStaleBackgroundWaitReply`：功能在 pi 链路里确实已经没有了，删除不改变现状，但要说明。**
  - 它的作用是：后台任务全部完成后，模型仍可能回复"1/6 完成，等待其余 5 个 Agent"这类过期的进度话术，旧 runner 检测到后强制补一轮汇总。
  - 它依赖旧 runner 对 SDK 后台任务的计数（`sawPendingBackgroundTasks`、`pendingBgTasks`）。pi runner 没有这套计数，整个"强制补汇总"机制随旧 runner 一起消失，这个谓词是它唯一的残骸，从 A 组清理起就没有调用方。
  - pi 链路目前对这一问题的唯一防线是提示词 `container/agent-runner/prompts/background-tasks.md`（`pi-index.ts` 在允许 `Task` 工具时加载），本任务保留它及其内容测试。
  - 是否在 pi 链路重建运行时防线是**新功能**，不在本任务范围；上一任务新增的子代理事件映射已能区分后台子代理的开始与完成，将来重建有现成的数据来源。

## 3. 裁决

1. 删除 `isStaleBackgroundWaitReply` 及其唯一使用者 `STALE_BACKGROUND_WAIT_PATTERNS`（连带孤儿）。
2. 删除 `serializeIpcInputMessage`。
3. 删除对应 4 个测试用例；`background-task-summary-guard.test.ts` 里"提示词约束"那个用例保留（提示词仍在生产加载）。
4. 删除后清理因此变成未使用的 import。

## 4. 不做（范围外）

- 不在 pi 链路重建"过期等待话术"的运行时防线（新功能，需单独立项并由用户决定）。
- 不改 `background-tasks.md` 提示词及其测试。
- 不改 `docs/dead-code-tier2-prune-plan.md`（历史记录，不回改）。
- 不处理核查报告第 5 项（`parseChannelPairingCode`，等用户确认行为变化）。

## 5. 实施步骤（立项 1 提交 + 清理 1 提交）

| 步骤 | 内容                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`b6357c4`）                                        |
| 1    | 删除符号、连带常量、4 个测试用例与未使用 import；`git grep -w` 复核零残留                     |
| 2    | `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过 + `refactor:` 提交（不 push） |

纯删除任务没有"先红后绿"：保护网是类型检查（任何遗漏引用都会编译失败）与全量测试。

## 6. 风险清单

| #   | 风险                               | 缓解                                                                                           |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | 有未发现的动态引用                 | `git grep -w` / `-i` 复核；类型检查与全量测试兜底；删除可由 git 历史完整恢复                   |
| 2   | 删掉谓词后，将来想重建防线需要重写 | 谓词只是 6 条正则，保存在 `e24377e` 之前的历史里；防线本身依赖已不存在的计数机制，需整体重设计 |
| 3   | 误删仍在生效的提示词保护           | 提示词内容测试保留，`background-tasks.md` 不动                                                 |

## 7. 验证方式

1. `git grep -w` 两个符号及连带常量零残留。
2. `npm run verify` 六步全绿（测试用例数应恰好减少 4）；`node scripts/check-scope.mjs` 通过。
