# ISSUE-06 前端掉线逻辑修复

| 字段          | 值                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                        |
| 领取人 / 分支 | issue-06-frontend-dropped-logic                                                                                                                                                                                                                               |
| 优先级        | P1                                                                                                                                                                                                                                                            |
| 类型          | 缺陷修复（掉线逻辑与无效请求）                                                                                                                                                                                                                                |
| 依赖          | 无                                                                                                                                                                                                                                                            |
| 阻塞          | ISSUE-11（两个 store 重复加载 `/api/groups` 的问题）                                                                                                                                                                                                          |
| 预计改动路径  | `web/src/components/layout/**`、`web/src/stores/**`、`web/src/pages/**`、`web/src/components/**`、`web/src/utils/agent-product.ts`；第 3 项如果选择补路由，还会改 `src/routes/channel-accounts.ts`；第 6 项会改 `src/routes/groups.ts`；以及相应的 `tests/**` |
| 需用户决策    | 部分：第 2 项和第 3 项                                                                                                                                                                                                                                        |
| 来源          | 审查报告 §4.2、§6.3                                                                                                                                                                                                                                           |

## 要做的事

1. **`group_created` 刷新错了 store**
   - 现状：`web/src/components/layout/AppLayout.tsx:88-91` 刷新的是 `useGroupsStore`，而侧栏读的是 `useChatStore.groups`（`UnifiedSidebar.tsx:82`）。
   - 后果：定时任务新建的工作区不会出现在侧栏。
   - 要做：改为刷新 chat store。数据源统一的问题见 ISSUE-11，本 issue 只修这个可见缺陷。

2. **Agent 能力深链没有生产者（需用户决策）**
   - 现状：`web/src/pages/AgentProfilesPage.tsx:220`（读取 `?agent=`）和 `:386`（读取 `#agent-capabilities`）能处理这个深链；但生成链接的 `buildAgentCapabilitiesHref`（`web/src/utils/agent-product.ts:95`）只在 `tests/frontend-agent-product-contract.test.ts:77` 中被调用。
   - 方案（请用户二选一）：
     - (a) 在工作区或聊天的“管理能力”入口接上这个链接；
     - (b) 删除页面上的处理逻辑和对应测试。

3. **已配对聊天重命名调用了不存在的路由（需用户决策）**
   - 现状：`web/src/components/settings/hooks/usePairedChats.ts:56-72` 发出 `PUT /api/channel-accounts/:id/paired-chats/:jid`，但后端在 `src/routes/channel-accounts.ts:868/893` 只有 GET 和 DELETE。现在还没有组件调用它，一旦接到界面上就会 404。
   - 方案（请用户二选一）：
     - (a) 补上后端路由，并把功能接到界面；
     - (b) 删除前端的 `rename`。

4. **`agent_reply` 前端没有订阅**
   - 现状：`src/web.ts:1922-1930` 发出 `agent_reply`，但前端没有订阅它（`web/src/stores/chat.ts:1878` 只有一条过期的注释）。
   - 后果：“图片发送失败”“文件未找到”这类 ⚠️ 提示，Web 用户看不到。
   - 要做：前端订阅这个事件并以系统提示展示，或者让后端改走前端已订阅的通道。

5. **加载失败时界面没有提示**
   - 现状：以下 4 个 store 的 `error` 字段都在 catch 里写入，但没有任何组件读取：
     - `web/src/stores/agent-profiles.ts:50`
     - `web/src/stores/files.ts:29`
     - `web/src/stores/monitor.ts:39`
     - `web/src/stores/users.ts:76`
   - 要做：把这些错误展示到对应页面。

6. **删除无效请求和无效字段**
   - `web/src/pages/MonitorPage.tsx:80-94` 请求的 providers 被 `ProviderSwitcher` 丢弃了；而且这个 GET 请求还会触发 `providerPool.refreshFromConfig` 这个副作用（`src/routes/config.ts:798`）。删掉这个请求。
   - `ChatGroupItem.lastMessage`：后端在 `src/routes/groups.ts:380` 为每个工作区计算，前端从不渲染。删掉这个字段，或者真正用起来。

## 非目标

- 子代理状态的前端部分由 ISSUE-03 负责。
- 死代码删除（例如前端的 `stopGroup`、usage store 中的孤立 action）由 ISSUE-08 负责。

## 验收标准

- 定时任务新建的工作区会立即出现在侧栏。
- ⚠️ 警告在 Web 上可见；加载失败时有提示。
- 无效请求已移除。
- `npm run verify` 通过，并且有对应的前端测试。

## 交付记录

- **提交**：立项 `c1daf86`（计划 `docs/frontend-dropped-logic-plan.md` + 范围声明，base=2493eab）；实现 `4b9b397`（24 文件，+619/−136，含 7 个新测试文件）。分支 `issue-06-frontend-dropped-logic`，未合入 main，合入由用户决定。
- **验证**：`npm run verify` 六步全绿（第 4 步 322 个测试文件 / 2596 用例通过、23 skipped）；`node scripts/check-scope.mjs` 28 个路径全在声明范围内；pre-commit secret 扫描与格式检查通过。
- **用户决策执行**：第 2 项按 (a) 在 `AgentWorkspaceGroup`"更多操作"菜单接"管理能力"入口（custom 分区专用，`__default__` 哨兵排除）；第 3 项按 (b) 删除 `usePairedChats.rename`/`renamingJid` 及 `PairingSection` 类型占位。
- **独立规格审查**：通过（无阻塞问题；3 条非阻塞建议均已在下述偏差与登记中处理）。
- **与 issue 描述的偏差**：
  1. 第 4 项 issue/审查报告称"7 处 ⚠️ 警告"——逐点核实后真实警告为 **6 处**（`src/index.ts` 原 10661 行一处是图片**发送成功**的 displayText 回显，无 ⚠️ 且已由 `broadcastNewMessage` 承载，属完整输出冗余广播，与 9444 行文本回复同类）。6 处警告均已带 `notice: true`，2 处完整输出广播保持未标记，测试按"6+2"锁定。
  2. 第 6b 项 issue 称后端 `lastMessage`"前端从不渲染"——交叉核实发现存活消费者：`ChatView.tsx:778` 将其作为会话侧栏主行 meta 渲染（`tests/frontend-session-sidebar-copy.test.ts:17` 契约锁定）。故**后端字段保留**，只删前端 `ChatGroupItem` 的死 prop 链（4 处传参点）。
  3. 第 6a 项实现比 plan 字面更彻底：`ProviderSwitcher` 中的 `SimpleProvider` 类型定义一并删除（全仓已无引用，测试锁定不存在），避免遗留新死代码。
- **范围外登记**：
  - `web/src/stores/agent-profiles.ts` 的孤儿 `error` 字段（加载失败已由 `profilesError` 展示于 `AgentProfilesPage`，该字段无人读取）——死代码，归 **ISSUE-08** 处置，本任务未动。
  - `agent_reply` 完整回复冗余广播（9444/10666 行，内容已由 `new_message` 承载）的存废属掉线逻辑决策，归 **ISSUE-07/10** 统筹，本任务保持原状仅加注释。
