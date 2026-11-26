# THESIS-26 安全瘦身（后端）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 死代码与重复代码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 依赖          | THESIS-19、20、34（都改 `src/db.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 阻塞          | 28 至 33                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 26 行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 预计改动路径  | `src/db.ts`、`src/config.ts`、`src/utils.ts`、`src/ipc/{watcher,message-delivery,image-delivery}.ts`、`src/routes/{files,mcp-servers,skills}.ts`、`src/memory-store.ts`、`src/channel-reliability-store.ts`、`src/script-runner.ts`、`src/admin-host-only-runtime.ts`、`src/agent-profile-runtime.ts`、`src/feishu-streaming-card.ts`、`src/qq-streaming-card.ts`、`src/feishu.ts`、`src/wechat.ts`、`src/feishu-inbound-attachments.ts`、`src/qq-media.ts`、`src/wechat-media.ts`、`src/wechat-outbound.ts`、`src/avatar-upload.ts`、`container/agent-runner/src/{workspace-memory-context,ipc-delivery}.ts`、新的共享 helper 文件、`tests/**`；D-S2 选 ① 时加 `tsconfig.json` |
| 需用户决策    | **是**：D-S2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 来源          | 方案 P7、§7.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 目标

删除不改变行为的死代码与重复代码，约 −660 行生产代码。

## 清单（`ca4ebce` 调查，`248c7cb` 复核；执行时逐项 `git grep -w` 再核实）

| #   | 项                                         | 位置                                                                                                                                                                                                                                                                                                                                                                                         | 估算 |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| B2  | 零引用导出                                 | `createSerializedAsyncTrigger`（runner `workspace-memory-context.ts:47`）、`SCHEDULER_POLL_INTERVAL`（`src/config.ts:19`）、`escapeCsvField`（`src/utils.ts:40`）；THESIS-19 未覆盖的其余零引用项                                                                                                                                                                                            | ~40  |
| B3  | 仅测试可达的生产函数                       | `src/db.ts` 的 `updateTaskRunNotification`、`updateTaskWorkspace`、`deleteTask`、`claimTaskRunNotificationById`、`deleteAllSessionsForFolder`、`deleteSessionsByProviderId`、`getAgentChannelMount`、`clearSenderAllowlist`；`src/channel-reliability-store.ts` 5 个；`src/memory-store.ts` 2 个；`src/script-runner.ts` 2 个；runner `ipc-delivery.ts` 约 97 行；`evaluateChannelAdmission` | ~380 |
| B4  | IPC 依赖接口重复声明                       | `src/ipc/watcher.ts` 的 `IpcWatcherDeps` 与 `message-delivery.ts`、`image-delivery.ts` 互相重述，改为 `Pick<>`                                                                                                                                                                                                                                                                               | ~100 |
| B5  | `src/routes/files.ts` 重复的路径校验前置段 | 五处相同前置段抽一个函数                                                                                                                                                                                                                                                                                                                                                                     | ~80  |
| B6  | 函数体完全相同的副本                       | `runtimeMutationFailure`（`src/routes/mcp-servers.ts:198` ≡ `src/routes/skills.ts`）、`getRuntimeJidsForTargets` ≡ `collectWorkspaceRuntimeJids`、`formatElapsed`（`src/feishu-streaming-card.ts:453` ≡ `src/qq-streaming-card.ts`）、`sendFile`（`src/feishu.ts` ≡ `src/wechat.ts`）                                                                                                        | ~60  |
| B7  | `src/memory-store.ts` 更新与遗忘的孪生事务 | 约三段相同结构                                                                                                                                                                                                                                                                                                                                                                               | ~70  |
| B8  | 6 份图片 MIME→扩展名映射                   | `src/feishu-inbound-attachments.ts`（两处）、`src/qq-media.ts`、`src/wechat-media.ts`、`src/wechat-outbound.ts`、`src/avatar-upload.ts`                                                                                                                                                                                                                                                      | ~40  |

B3 要把对应测试改为测公共路径或随函数删除；被删函数若有专门测试写明设计意图，按"意图信号"先报告。

> v1.1：原 B1（`src/index.ts` 等文件的未用 import 与局部变量，约 −140 行）移到 THESIS-28，本包不再改 `src/index.ts`。

## 非目标

- 不改任何行为、接口、日志文案。
- 不拆文件（THESIS-28 至 33）。
- 不动 issues3 THESIS-18 已删的项。

## 需用户决策（领取前拍板）

| #    | 问题                                                                                          | 选项                                        | 建议                                             |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| D-S2 | 后端 `tsconfig.json` 是否开启 `noUnusedLocals`/`noUnusedParameters`，防止未用 import 再长回来 | ① 只开 `noUnusedLocals`；② 两个都开；③ 不开 | ①（`noUnusedParameters` 会牵动大量接口实现签名） |

开启属于类型检查配置变更，按宪法第 6 条须用户批准。

## 实现步骤（TDD）

1. **Red**：B2、B3 的符号在 `src/`、`container/agent-runner/src/` 零出现（否定断言）；B5 至 B8 抽出的共享函数各补一组单测。
2. **Green**：逐项删除与合并；按 D-S2 改 `tsconfig.json`。
3. 跑一遍读源码文本的契约测试（`tests/no-duplicate-helpers-contract.test.ts`、`tests/ipc-type-bidirectional-contract.test.ts` 等），被钉死定义文件的 helper 不移动。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 交付记录给出改前改后的 `src/` 行数。
3. 无界面变化，不需要人工冒烟。

## 风险与回滚

- 纯删除与等价合并；回滚为 `git revert <提交号>`。

## 交付记录

（待填）
