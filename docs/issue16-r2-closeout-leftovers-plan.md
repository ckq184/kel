# 任务立项：ISSUE-16 R2 收尾遗留 —— group_created 掉线逻辑、待决策项与零散清理

> 立项日期：2026-11-23｜base：`1f64693`（本地 main tip，ISSUE-16 登记提交）｜分支：`claude/issue-16-r2-closeout-leftovers-2512ab`
> 来源：`docs/issues/ISSUE-16-r2-closeout-leftovers.md`
> 前序依赖：无（ISSUE-01 至 13、15 已合入 main）。

## 0. 需求采访结论（2026-11-23）

- **目标**：收口 R2 审查后各 issue 遗留的掉线逻辑、待决策项与零散清理，并补 WS 下行消息的生产者/消费者契约测试，防止“删了生产者、留着消费者”再次漏网。
- **完成条件**：A、C 节每项按用户拍板落地；B 节契约测试在 verify 第 4 步运行且白名单不含 `group_created`；D 节逐项勾选（跳过写明原因）；`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
- **约束**：审查口径（掉线逻辑先拍板、意图信号默认保留、删除前 `git grep -w` 交叉核实含 `tests/`/`docs/`）；修改共享类型后 `make sync-types`；不修改 `scripts/verify.mjs` 六步结构；合入 main 与推送由用户决定。

## 1. 证据复核（领取后重新定位，行号以 base 为准）

### A 节：不经 Web 的工作区创建路径盘点

| 路径                                                       | 位置                                                            | 进入侧边栏？                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| IM `/new <名称>` 命令                                      | `src/index.ts` `handleNewCommand` → `registerGroup(web:<uuid>)` | 是（`web:` 工作区）                                       |
| Agent `register_group` MCP 工具（仅管理员主工作区）        | `src/ipc/skill-registry-ops.ts` → 注入的 `registerGroup`        | 视 jid/folder 而定，可进入                                |
| IM 群自动注册                                              | `src/index.ts` `registerGroup(chatJid, { folder: homeFolder })` | 否（挂 home folder，`buildGroupsPayload` 排除）           |
| 启动期 `config/default-groups.json`、`ensureUserHomeGroup` | `src/index.ts` 启动流程                                         | 启动时无 Web 客户端在线，无实际影响                       |
| 定时任务新建工作区                                         | —                                                               | **不存在**（`task-scheduler.ts` 无 `registerGroup` 调用） |

结论：issue 推测的“定时任务工作区创建”场景已不存在，但 `/new` 与 `register_group` 两条非 Web 路径仍在，侧边栏只能等切路由时 `UnifiedSidebar` 自刷新。

### C 节复核要点

- C1：create 口两条 superRefine（至少一项；有 token 必须有 Base URL）合起来等价于“third_party 必须有 Base URL”；PATCH 只拦了“有 token 且清空 Base URL”，无 token 时清空 Base URL 得到双空。
- C2：`src/routes/groups.ts` 两条 410 路由，`tests/groups-mcp-legacy-route.test.ts` 锁定“任何 jid 都 410、不查库”。
- C3：三成员零引用；文件头注释写明休眠理由（意图信号）；删 `buildAuxPrefix` 会级联 `formatElapsed` 等。
- C4：三函数属 V1 定义级租约机制；调度器已用 V2（`getDueTaskDefinitionsV2` + `task_runs` 租约），`clearStaleTaskLeases` 注释称“必须启动时调用”但从未调用。`claimTaskForRun`/`updateTaskAfterRun` 仍有生产调用，不在本项范围。
- C5：store 的 `dataRange` 由前端用 `window.from/to` + `summary.activeDays` 拼出，用量页已直接展示这三项；`scope` 为筛选回显，无组件读取。

### D 节复核要点

- D3：`promptMode` 仍有其他取值来源——Agent 生成草稿 `setPromptMode(draft.prompt_mode)`，而 `src/agent-profile-generator.ts:156` 可产出 `'replace'`；版本恢复 `setPromptMode(profile.prompt_mode)` 也可能是存量 `'replace'`。issue 的前提“分支不可能为真”不成立 → **跳过**。
- D4：删 `shouldEmitBackgroundTaskNotice` 级联其唯一调用的跨标签页通知归属块（`isNoticeOwner`/`bindOwnerTracking`/`claimOwnershipIfVisible` 与 5 个模块级常量/变量），一并删除。
- D5：StreamEvent 全字段扫描（只读子代理 + 抽查）：两端皆无 `taskPatch`/`outputFile`/`isBackground`；只有消费者 9 个（`messageUuid`、`isNested`、`elapsedSeconds`、`taskType`、`workflowName`、`subagentType`、`lastToolName`、`sdkTaskUsage`、`isTeammate`）+ `usage.batchIndex`/`batchCount`；只有生产者 `isSynthetic`。

## 2. 用户决策（2026-11-23 逐项拍板，全部按推荐）

| 项          | 决策                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| A           | **(a) 补生产者**：`src/web.ts` 恢复仅发给工作区所有者的 `group_created` 广播，由 `registerGroup` 统一出口调用    |
| C1          | **补校验**：PATCH 与 secrets 两个写入口按合并态校验“至少填一项”                                                  |
| C2          | **确认保持现状**（固定 410、无鉴权、不查库），不改代码                                                           |
| C3          | **保留**，文件头注释补 ISSUE-08/ISSUE-16 决策引用                                                                |
| C4          | **连测试一起删除**三函数；`claimTaskForRun` 用例改为不依赖 `getDueTasks` 的断言；改写 `routes/tasks.ts` 两处注释 |
| C5          | **从 store 删除** `scope`/`dataRange` 及其类型；后端响应不变                                                     |
| D5 掉线字段 | **本 issue 不动**，交付时新建 ISSUE-17 登记逐字段决策                                                            |
| D5 双无字段 | **`taskPatch`、`isBackground`、`outputFile` 三个一起删**，`make sync-types`                                      |

## 3. 实现方案

1. **A(a)**：`src/web.ts` 新增 `broadcastGroupCreated(jid, folder, name, ownerUserId)`，经 `safeBroadcast(msg, false, new Set([ownerUserId]))` 只投递给所有者；无所有者（启动期默认组）不广播。`src/index.ts` `registerGroup` 在持久化、建目录成功后调用。`AppLayout.tsx` 订阅注释改为实际来源（IM `/new`、Agent `register_group`）。测试：`tests/group-created-ws.test.ts`（仿 `channel-account-status-ws.test.ts`：所有者收到、他人收不到、无所有者不发）+ 源码契约断言 `registerGroup` 调用广播。
2. **B**：新增 `tests/ws-message-producer-contract.test.ts`：解析 `src/types.ts` 的 `WsMessageOut` 各 `type`；生产点 = `src/**`（排除 `src/types.ts`）中 `type: '<t>'`；消费点 = `web/src/**` 中 `wsManager.on(\s*'<t>'`（允许换行）；反向检查 web 订阅类型必须在联合内，`connected`/`disconnected` 为 `web/src/api/ws.ts` 本地生命周期事件，作为显式白名单（注明来源）。已知缺口白名单每条带 issue 编号，A 落地后为空。失败信息说明“删生产者须同时处理消费端，掉线逻辑先登记由用户决定”。
3. **C1**：`src/routes/config.ts` PATCH：`previous.type === 'third_party' && !mergedBaseUrl && !previous.anthropicAuthToken` 拒绝；secrets：`third_party` 且合并后 token 为空（清除 token 或原本无 token）且无 Base URL 拒绝；文案与 create 口一致（`第三方供应商需要提供 Base URL 或 Auth Token`），在零副作用阶段拒绝。补路由用例（含存储态零副作用）。
4. **C3**：仅改注释。
5. **C4**：删 `src/db.ts` 三函数；`tests/task-restart-recovery.test.ts` 删对应用例并改写 claim 用例；`src/routes/tasks.ts` 注释改引 `getDueTaskDefinitionsV2`。
6. **C5**：`web/src/stores/usage.ts` 删字段、类型与写入点。
7. **D1–D6**：D1 改注释；D2 删 `agent-profiles` store 的 `error` 字段及全部写入点；D3 跳过（见 §1）；D4 删函数+级联块+4 处 mock 键；D5 删三字段并 `make sync-types`；D6 README 索引 ISSUE-12 行改“已完成”。

## 4. 测试方案

- 新增：`tests/group-created-ws.test.ts`、`tests/ws-message-producer-contract.test.ts`；扩充 `tests/unified-provider-third-party-baseurl.test.ts`；修改 `tests/task-restart-recovery.test.ts`、4 个 mock 文件。
- 保留并继续通过：`tests/frontend-sidebar-refresh-contract.test.ts`、`tests/groups-mcp-legacy-route.test.ts`、`tests/stream-event-producer-contract.test.ts`。
- 全量 `npm run verify` + `node scripts/check-scope.mjs`。

## 5. 非目标

- 不处理 D5 的只有消费者字段与 `isSynthetic`（登记 ISSUE-17 / 交付记录）。
- 不改 Web POST 创建路径的多标签页同步、不改 `/api/usage` 响应、不改 410 路由行为。
- 不处理 ISSUE-14、实机验收、远端分支 `claude/project-overview-ed5250`。

## 6. 回滚点与验收

- base pin `1f64693` 写入 `.gatescope.json`；失败回滚到该提交。
- A(a) 的实机验收（IM `/new` 后侧边栏自动刷新）需用户执行，自动化测试覆盖广播投递与调用接线。
