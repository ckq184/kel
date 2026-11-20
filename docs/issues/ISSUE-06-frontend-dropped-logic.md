# ISSUE-06 前端掉线逻辑修复

| 字段          | 值                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                        |
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

（领取后填写）
