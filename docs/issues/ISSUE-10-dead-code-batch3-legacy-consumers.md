# ISSUE-10 死代码批 3：Claude SDK 遗留消费端与无人消费的链路

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 领取人 / 分支 | issue-10-dead-code-batch3-legacy-consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 删除死代码（消费端整簇下线）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 依赖          | ISSUE-02、ISSUE-03、ISSUE-04（先确定哪些消费端会被救活）；第 5 项需要 ISSUE-07 第 5 项的结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 阻塞          | ISSUE-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 预计改动路径  | `src/index.ts`、`src/web.ts`、`src/types.ts`、`src/feishu-streaming-card.ts`、`src/qq-streaming-card.ts`、`src/session-workflows.ts`、`src/routes/groups.ts`、`src/file-manager.ts`、`src/routes/files.ts`、`src/im-manager.ts`、`src/im-channel.ts`、`src/feishu.ts`、`src/container-runner.ts`、`src/channel-outbox-delivery.ts`、`src/channel-reliability-store.ts`、`container/agent-runner/src/runtime/pi/pi-runner.ts`、`container/agent-runner/src/types.ts`、`container/agent-runner/src/channel-prefixes.ts`、`scripts/sync-stream-event.sh`、`shared/stream-event.ts` 及其三份同步副本、`web/src/stores/chat.ts`、`web/src/components/chat/**`，以及相应的 `tests/**` |
| 需用户决策    | 部分：标注“需确认”的项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 来源          | 审查报告 §4.1、§6.3、§7、§14.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 开工前置条件

先读 ISSUE-02、03、04 的交付记录，确认哪些事件和字段已经由它们重新接回了生产者。**被重新接回的项不在本批删除范围内。**

## 删除清单

**一、Pi 不产出的事件，对应的消费分支**

这些分支分布在以下几处，必须同时修改：

- 宿主：`src/index.ts:701-858`
- Web 快照：`src/web.ts:2130-2149`、`:2482-2525`
- 前端：`web/src/stores/chat.ts:1528-1617`、`StreamingDisplay.tsx`
- 飞书和 QQ 卡片：`setHook`、`setTodos`

要处理的事件和链路：

- `hook_*`、`init`、`permission_denied`、`memory_recall`、`notification`、`prompt_suggestion`
- `raw_sdk_event`：如果 ISSUE-02 没有复用它
- `todo_update`：**需确认**，是删除，还是让 Pi 补一个生产者
- 截断续写链路（`src/index.ts:1392`、`:6826-6845`、`:7610-7680`、`:15291-15443`）和 `pendingBgTasks`
- workflowRun 的宿主侧扫描（`src/session-workflows.ts:192-207`、`:483-528`）：**需确认**，它受 `tests/workflow-card-contract.test.ts` 守护

**二、有调用方，但产出没人用的链路**

1. **存储用量缓存**：在 `src/file-manager.ts` 中删除 `_storageCache`、`calculateDirSize`（`:301`）、`STORAGE_CACHE_TTL`、`MAX_DIR_DEPTH`、`getStorageCacheKey`、`invalidateGroupStorageUsage`，同时删除 `src/routes/files.ts:385/898/934` 的三处调用
2. **`ignoreMessagesBefore`**：沿整条透传链删除：`src/index.ts:18425/18514` → `src/im-manager.ts:1082` → `src/im-channel.ts:290/454/591` → `src/feishu.ts:108`
3. **飞书全局单例旧 API**：`src/feishu.ts:3789-3837`
4. **`src/im-manager.ts:1261` 的 `sendFeishuMessage` 方法**
5. **ContainerInput 中的 `contextAudit` 和 `skillManifest`**（`src/container-runner.ts:1737-1812`、`:2747-2754`）：ISSUE-07 第 5 项已拍板（2026-11-20）——**方向为宿主直接记快照，不删除**：在 `src/container-runner.ts` 容器路径（约 `:1737-1812` 构造 `contextAudit` 处）与宿主机路径（约 `:2747-2754`）构造完成后调 `recordRunContextSnapshot`（`src/run-context-snapshot.ts`）。实现时注意两点：快照键为 `` `${chatJid}\0${agentId ?? 'main'}` ``（`snapshotKey`），而 agent-profiles 预览按 `'main'` 键读（`src/routes/agent-profiles.ts:317` 调 `getRunContextSnapshot(workspace.jid)` 未传 agentId），需键对齐；宿主构造的 audit 无 `sdkContextUsage` 字段，budget 区会显示 unavailable。ISSUE-07 只登记方向，不实现
6. **WS 消息**：`status_update`（`src/web.ts:2840-2853`、`:2953`，每 5 秒一次的定时器）、`typing`（`src/web.ts:1983-1991`）、`task_state` 类型（`src/types.ts:946-955`）
7. **runner 侧的死代码**：`task_progress.rawEvent`（`pi-runner.ts:220-224`），以及 pi-runner 中从未触发过的 case（`:171-186`、`:227-241`、`:257-259`）
8. **stdin 中的死字段**：`ckqclawOwnerProfile`、`ckqclawBootstrapPending`、`agentName`、`identityHash`（`src/index.ts:9117-9125` 等）
9. **死的环境变量注入**：`CKQCLAW_AGENT_MCP_POLICY`；`CKQCLAW_AGENT_TOOL_POLICY` 和 `CKQCLAW_AGENT_DISALLOWED_TOOLS`（只剩剥离代码）；以及 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 等 Claude SDK 时代的变量。保留之前，先确认 Bash 中运行的 claude CLI 是否还需要继承这些变量
10. **Output 中 `providerFailureRetrying` 和 `Maintenance` 的死分支**（`src/container-runner.ts` 多处）
11. **runner 的同步副本 `container/agent-runner/src/channel-prefixes.ts`**：同时删除 `scripts/sync-stream-event.sh:39-45` 中对应的同步目标
12. **不可达的状态值**：Inbox 的 `received` 和 `admitted`、Outbox 的 `cancelled`（`src/channel-reliability-store.ts:53-56`、`src/channel-outbox-delivery.ts:187`）。**需确认**它们是否是为将来预留的

## 注意

- 有些结构测试以源码字符串作为锚点，例如 `tests/internal-context-audit-visibility.test.ts`、`tests/feishu-capability-outbox.test.ts`，删除代码时要同步修改。
- 修改共享类型后执行 `make sync-types`。
- 宿主的事件处理逻辑在 `processGroupMessages` 和 `processAgentConversation` 中各有一份，两处要同步。

## 验收标准

- `npm run verify` 和 check-scope 都通过。
- 实机冒烟：Web、飞书、QQ 的对话都正常，包括流式输出、工具卡和中断。
- 删除清单逐项勾选，跳过的项写明原因。

## 交付记录

（领取后填写）
