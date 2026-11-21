# ISSUE-10 死代码批 3：Claude SDK 遗留消费端与无人消费的链路

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | issue-10-dead-code-batch3-legacy-consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
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

- **提交**：立项 `597493a`（领取登记 + 八项拍板与计划落档，base=`20b4d93`）；实现与交付落档为后续提交（见分支历史）。
- **拍板**：需求采访八项全采推荐方案——①todo_update 整链下线 ②workflowRun 全链下线 ③截断链路消费端整链下线（DB 历史读兼容保留）④删 admitted+cancelled ⑤快照接线+清死通道 ⑥AUTO_COMPACT_WINDOW 删注入 ⑦ANTHROPIC_API_KEY 补 RESERVED ⑧QQ stub 随链删。
- **验证**：`npm run verify` 六步全绿（337 文件 / 2701+ 用例通过 / 0 失败 / 77 skip，含两轮——Major② 修复后复跑同样全绿）；`node scripts/check-scope.mjs` 通过（62 路径全在声明内；范围随实现扩宽 8 条路径均已留痕：feishu-cards/sections.ts、src/utils.ts、MessageList.tsx、message-presentation.ts 与 5 个测试文件）。
- **独立审查**：规格符合性轮**通过、零阻塞**（删除清单逐项核对全落地、保留项核实完好、测试断言全部收紧、34 个 autocrlf 幻影逐个 diff 排除）；质量轮初判不通过（**Major×2**：新测试文件未跟踪的提交丢失风险；快照未填 `audit.agentProfile` 致 classify 恒判 `stale_profile`、预览 'current' 不可达）——两项均已修复并复验（两路径 record 前经 `getAgentProfile`+`hashRuntimePolicy` 从 DB 补齐四元组，接线测试补源锚），复验 verify 6/6 全绿。结论与 Minor 台账详见 `docs/审查记录.md` ISSUE-10 段。
- **与 issue 描述的偏差**：
  1. 行号全面漂移（issue 写于基线 `3f34cf7`），实现按 HEAD `20b4d93` 三路探查重核后落地；宿主卡 switch 已被 ISSUE-03 抽至 `src/stream-card-feeder.ts`，第三消费端在彼处收口。
  2. `background-tasks.md` 为活 prompt（pi-index 经 prompt-plan 加载），死的是三个 stale-summary utils 与 `isSuspectTruncatedStreamResult`——修正调查初判，只删函数与两测试，保留 md。
  3. `common` 对象因 qq 历史上从未经 `connectUserQQ` 消费该键、wechat 活读，故 feishu 侧删除后 `common` 不再携带 `ignoreMessagesBefore`，wechat 调用点内联 `Date.now()` 精确补偿。
  4. 拍板⑤的 stdin `skillManifest` IIFE 整簇下线：`ClaudeContextAudit` 自带 skills.manifestHash/selectedSkillIds，classify 比对无需独立 manifest；宿主路径 `audit.mcp` 原已设置无需补。
  5. 飞书卡模板 5 折叠面板→4（PROGRESS_PANEL 元素与 `buildProgressListText` 随 Todo 面板链删除，`tests/feishu-card.test.ts` 锚点同步）。
  6. 拍板⑦ 的断言落在新增 `tests/run-context-snapshot-wiring.test.ts`（计划草拟于 runtime-config-env，覆盖等价）。
- **行为变化明示**（均随拍板）：旧 wf_*.json 工件不再显示；`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 不再注入（Bash 内 claude CLI 走其默认压缩策略），custom env 可携带该键但平台不管理；Web 端 Hook/Todo/Permission 展示组件与飞书卡对应面板下线；`context_audit` 事件类型整体消失，审计改宿主直记快照。
- **遗留登记**：`shouldEmitBackgroundTaskNotice` 孤儿导出（删除级联 ISSUE-11 契约文件，列下批）；`StreamEvent.taskPatch` 等 0 生产字段不在清单未动；reply-delivery 挂起纯函数残留（计划内保留）；heldUsagePatchTarget 命名不副实（ISSUE-12 候选）。
- **待用户实机验收**（issue 验收标准实机部分，本会话无运行中服务）：Web/飞书/QQ 对话流式输出、工具卡渲染、中断收口；agent-profiles 预览的 run_context 状态（修复后应可达 'current'）。
