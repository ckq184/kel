# 前端掉线逻辑修复立项（ISSUE-06）：侧栏刷新、能力深链入口、重命名下线、agent_reply 警告、加载失败提示、无效请求清理

> 任务来源：`docs/issues/ISSUE-06-frontend-dropped-logic.md`（死代码与臃肿审查 R2 §4.2、§6.3）。
> 回滚点：`2493eab`（开工前 HEAD，见 `.gatescope.json` 的 `base`；分支
> `issue-06-frontend-dropped-logic` 的独立 worktree，主工作树由 ISSUE-05 会话占用）。
> 需求采访结论（2026-11-20，用户拍板）：
>
> - 第 2 项（Agent 能力深链无入口）：选 **(a) 接上入口**——统一侧栏自定义智能体
>   分组头部新增"管理能力"入口，链接到
>   `/agent-profiles?agent=<id>#agent-capabilities`。符合"意图信号默认保留"口径
>   （`tests/frontend-agent-product-contract.test.ts:77` 有契约测试锁定设计动机）。
> - 第 3 项（已配对聊天重命名调用不存在的路由）：选 **(b) 删除前端 rename**——
>   掉线逻辑"消费者还在、生产者没有"，用户决定连消费端一起下线；将来若需要
>   重命名，与"已接入会话"管理页统一设计后另行立项。

## 目标（What & Why）

六项互相独立的前端掉线逻辑修复，每项均有测试锁定：

1. **`group_created` 刷新错了 store**：`AppLayout.tsx:88-100` 收到定时任务工作区
   创建广播后刷新 `useGroupsStore`，但侧栏（`UnifiedSidebar.tsx:82`）读的是
   `useChatStore.groups`——新建工作区不出现。改为刷新 chat store；任务列表刷新
   保留。两个 store 重复加载 `/api/groups` 的统一问题归 ISSUE-11，本任务只修可见缺陷。
2. **Agent 能力深链接上入口**（用户已拍板 (a)）：页面侧的 `?agent=` 选中与
   `#agent-capabilities` 滚动逻辑齐全，但生成链接的 `buildAgentCapabilitiesHref`
   只被契约测试调用。在 `AgentWorkspaceGroup`（自定义智能体分组头）的"更多操作"
   菜单中新增"管理能力"项，`UnifiedSidebar` 对 custom 分区传入
   `buildAgentCapabilitiesHref(section.id)`。主智能体分区不加入口（其能力在
   设置页"主智能体能力"管理，且 `/agent-profiles` 只列自定义档案）。
3. **已配对聊天 rename 下线**（用户已拍板 (b)）：`usePairedChats.rename` 发出的
   `PUT /api/channel-accounts/:id/paired-chats/:jid` 后端只有 GET/DELETE，必 404
   （当前无组件调用）。删除 `rename`、`renamingJid` 与 `PairingSection` 类型中的
   对应可选成员，同步清理 `tests/wechat-pairing-dialog-dom.test.tsx` 的 mock。
4. **`agent_reply` 警告前端可见**：后端 7 处 ⚠️ 警告（图片/文件发送失败、文件未
   找到、无 IM 路由跳过等）只经 `agent_reply` 广播，前端零订阅，Web 用户看不到。
   方案：`agent_reply` 载荷增加可选 `notice` 标记——7 处警告广播带 `notice: true`，
   完整回复广播（`src/index.ts:9444`，已有 `new_message` 承载、前端本就不需要）
   不带标记保持原状；前端在 `AppLayout` 订阅 `agent_reply`，仅处理带 `notice` 的
   事件：`chat store` 新增 `handleAgentNotice`，把警告作为本地 `__system__` 消息
   追加进对应会话（`MessageList` 对未知系统内容按 divider 样式原样渲染文本，
   无需改注册表），不在当前会话时另弹 toast。同时把 `chat.ts:1876-1879` 的过期
   注释（声称 streaming 由 agent_reply 清理）改为现实（handleWsNewMessage 与
   status:interrupted 两路径）。
5. **加载失败有提示**：`monitor`、`files`、`users` 三个 store 的 `error` 字段
   在 catch 里写入但无组件读取（`users` 的 fetch 均吞错误不 rethrow，
   `UsersPage` 横幅的 try/catch 永不触发）：
   - `MonitorPage` 顶部展示 `useMonitorStore` 的 `error`；
   - `FilePanel` 展示 `useFileStore` 的 `error`；
   - `UsersPage` 在既有横幅区并入 `useUsersStore` 的 `error`。
   - `agent-profiles` store 的孤儿 `error` 字段：加载失败已由 `profilesError`
     展示（`AgentProfilesPage.tsx:1268-1270` 已渲染），无需新增展示；该重复字段
     本身属死代码，登记给 ISSUE-08（见交付记录），本任务不动。
6. **无效请求与死属性清理**：
   - `MonitorPage:80-94` 拉取 `/api/config/claude/providers`，但唯一消费者
     `ProviderSwitcher` 不使用 `providers` prop（只显示当前 provider 名），该 GET
     还触发后端 `providerPool.refreshFromConfig` 副作用（`src/routes/config.ts:798`）。
     删除请求、`providers` state 与 `ProviderSwitcher`/`GroupStatusCard` 的
     `providers` prop 链。
   - `ChatGroupItem.lastMessage` prop 传入但从不渲染（4 处传参点）。删除该 prop
     与传参。**后端 `groups.ts:380` 的 `lastMessage` 字段保留**——交叉核实发现它
     有存活消费者：`ChatView.tsx:778` 作为会话侧栏主行 meta 渲染
     （`tests/frontend-session-sidebar-copy.test.ts:17` 契约锁定），与 issue 描述
     "前端从不渲染"不符，故只清前端死 prop、不动后端字段（偏差已在交付记录登记）。

## 非目标

- 不统一 `useGroupsStore` / `useChatStore` 双份 `/api/groups` 加载（ISSUE-11）。
- 不删前端 `stopGroup`、usage store 孤立 action 等死代码（ISSUE-08）。
- 不为 `agent_reply` 完整回复广播补前端消费（其信息已由 `new_message` 覆盖；
  该广播的存废属掉线逻辑决策，归 ISSUE-07/10 统筹）。
- 不给警告消息做持久化（不落库；刷新后消失，与 IM 通道即时通知行为对齐）。
- 不动 `?agent=` 参数的选中同步逻辑（页面 URL 状态同步，另有用途）。
- 不动后端 `src/routes/groups.ts` 的 `lastMessage` 计算（有存活消费者）。

## 修改文件范围

| 文件                                                                      | 改动                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `web/src/components/layout/AppLayout.tsx`                                 | 第 1 项改刷 chat store；第 4 项订阅 `agent_reply`(notice)  |
| `web/src/components/layout/AgentWorkspaceGroup.tsx`                       | 第 2 项：菜单支持可选"管理能力"项                          |
| `web/src/components/layout/UnifiedSidebar.tsx`                            | 第 2 项传链接；第 6b 项删两处 `lastMessage` 传参           |
| `web/src/components/chat/ChatGroupItem.tsx`                               | 第 6b 项：删 `lastMessage` prop                            |
| `web/src/components/chat/FilePanel.tsx`                                   | 第 5 项：展示 files store `error`                          |
| `web/src/components/settings/hooks/usePairedChats.ts`                     | 第 3 项：删 `rename` / `renamingJid`                       |
| `web/src/components/settings/PairingSection.tsx`                          | 第 3 项：删类型占位                                        |
| `web/src/components/monitor/ProviderSwitcher.tsx`                         | 第 6a 项：删 `providers` prop                              |
| `web/src/components/monitor/GroupStatusCard.tsx`                          | 第 6a 项：删 `providers` prop 透传                         |
| `web/src/pages/MonitorPage.tsx`                                           | 第 5 项展示 error；第 6a 项删 providers 拉取               |
| `web/src/pages/ChatPage.tsx`                                              | 第 6b 项：删两处 `lastMessage` 传参                        |
| `web/src/pages/UsersPage.tsx`                                             | 第 5 项：横幅并入 users store `error`                      |
| `web/src/stores/chat.ts`                                                  | 第 4 项：`handleAgentNotice` + 过期注释修正                |
| `src/types.ts`                                                            | 第 4 项：`WsMessageOut` 的 `agent_reply` 增加可选 `notice` |
| `src/web.ts`                                                              | 第 4 项：`broadcastToWebClients` 支持.notice 选项          |
| `src/index.ts`                                                            | 第 4 项：7 处警告广播补 `notice: true`                     |
| `tests/frontend-sidebar-refresh-contract.test.ts`（新增）                 | 第 1 项源码契约                                            |
| `tests/frontend-agent-capabilities-entry.test.ts`（新增）                 | 第 2 项源码契约                                            |
| `tests/frontend-paired-chat-rename-removal.test.ts`（新增）               | 第 3 项源码契约                                            |
| `tests/agent-notice-broadcast-contract.test.ts`（新增）                   | 第 4 项：后端 notice 标记契约 + 前端订阅/handler 源码契约  |
| `tests/frontend-load-error-visibility.test.ts`（新增）                    | 第 5 项源码契约                                            |
| `tests/frontend-monitor-provider-request-removal.test.ts`（新增）         | 第 6a 项源码契约                                           |
| `tests/frontend-chat-group-item-props.test.ts`（新增）                    | 第 6b 项源码契约                                           |
| `tests/wechat-pairing-dialog-dom.test.tsx`                                | 第 3 项：mock 清理                                         |
| `docs/issues/ISSUE-06-frontend-dropped-logic.md`、`docs/issues/README.md` | 领取登记与交付记录                                         |

（如实现中发现清单外文件必须改动，先停下按流程扩宽 `.gatescope.json` 声明并说明理由。）

## 方案与测试设计

### 第 1 项：group_created 刷 chat store

- `AppLayout.tsx` 的 `group_created` handler：`useGroupsStore.getState().loadGroups()`
  → `useChatStore.getState().loadGroups()`；tasks 刷新保留。`useGroupsStore` import
  保留（`runner_state` 等 handler 仍在用）。
- 测试（源码契约）：断言 `group_created` 订阅块调用
  `useChatStore.getState().loadGroups()`，且不再调用
  `useGroupsStore.getState().loadGroups()`。

### 第 2 项：能力深链入口

- `AgentWorkspaceGroup`：新增可选 `onManageCapabilities?: () => void`；菜单出现条件
  从 `onRebuild` 放宽为 `onRebuild || onManageCapabilities`，新增"管理能力"菜单项
  （Sparkles 图标，与"重建工作区"同款式但默认色）。
- `UnifiedSidebar.renderAgentSection`：custom 分区传
  `onManageCapabilities={() => navigate(buildAgentCapabilitiesHref(section.id))}`
  （section.id 即 agent_profile_id，custom 分区必有）。
- 测试（源码契约）：`UnifiedSidebar` 源码含 `buildAgentCapabilitiesHref(section.id)`
  且经 `onManageCapabilities` 传入；`AgentWorkspaceGroup` 渲染"管理能力"菜单项；
  既有 `frontend-agent-product-contract.test.ts` 契约保持绿。

### 第 3 项：rename 下线

- `usePairedChats`：删 `rename`、`renamingJid` state 与返回项。
- `PairingSection`：`paired` 类型删 `rename?`、`renamingJid?`。
- `tests/wechat-pairing-dialog-dom.test.tsx`：mock 里删 `rename`/`renamingJid`。
- 测试（源码契约）：`usePairedChats.ts` 不含 `rename`、`api.put`；
  `PairingSection.tsx` 不含 `rename`。

### 第 4 项：agent_reply notice

- 后端：`src/types.ts` `agent_reply` 载荷加 `notice?: boolean`；
  `src/web.ts` `broadcastToWebClients(chatJid, text, options?: { notice?: boolean })`
  透传；`src/index.ts` 7 处警告调用（10595、10603、10661、13273、13377、13462、
  13499 行附近）补 `{ notice: true }`；9444 行完整回复广播不动。
- 前端：`chat store` 新增 `handleAgentNotice(chatJid, text)`——生成
  `local-notice-<ts>-<seq>` id 的 `__system__` 消息追加到 `messages[chatJid]`，
  `chatJid !== currentGroup` 时 `showToast('系统提示', text)`；
  `AppLayout` 订阅 `agent_reply`，`data.notice === true` 时转发。
- 测试（契约）：源码断言 7 处警告调用点均带 `notice: true`（按 ⚠️ 字面量定位），
  9444 处完整回复不带；`types.ts` 载荷含 `notice?: boolean`；`AppLayout` 订阅
  `agent_reply` 且过滤 `notice`；`chat.ts` 含 `handleAgentNotice` 且追加
  `__system__` 消息。store 行为另以单测锁定（mock api 后直接调 action，断言
  messages 追加与 toast 分支）。

### 第 5 项：加载失败提示

- `MonitorPage`：`const monitorError = useMonitorStore((s) => s.error)`，状态卡片区
  上方渲染 `role="alert"` 横幅（`loading && !status` 骨架屏时不重复展示）。
- `FilePanel`：解构 `error` 并在工具栏下方渲染 `role="alert"` 提示行。
- `UsersPage`：`const usersError = useUsersStore((s) => s.error)`，并入既有
  `(notice || error || usersError)` 横幅块（每条独立成行）。
- 测试（源码契约）：三个页面源码分别断言读取对应 store error 并以
  `role="alert"`/`text-error` 展示。

### 第 6 项：无效请求与死属性

- 6a：`MonitorPage` 删 providers 拉取 effect、`providers` state、`api` import；
  `ProviderSwitcher` 删 `providers` prop；`GroupStatusCard` 删 `providers` prop 与
  透传、`SimpleProvider` 转出口（保留 `ProviderSwitcher` 处定义）。
- 6b：`ChatGroupItem` 删 `lastMessage` prop；`UnifiedSidebar`、`ChatPage` 各两处
  传参点删除。
- 测试（源码契约）：`MonitorPage` 不再含 `claude/providers`；`ProviderSwitcher`
  与 `GroupStatusCard` 不含 `providers` prop；`ChatGroupItem.tsx` 不含
  `lastMessage`；`ChatView.tsx` 的 `mainMeta={group.lastMessage …}` 保留（防止
  误伤后端字段消费链）。

## 验收对照（issue 验收标准）

| 验收标准                                    | 对应项                |
| ------------------------------------------- | --------------------- |
| 定时任务新建的工作区会立即出现在侧栏        | 第 1 项               |
| ⚠️ 警告在 Web 上可见；加载失败时有提示      | 第 4、5 项            |
| 无效请求已移除                              | 第 3、6 项            |
| `npm run verify` 通过，并且有对应的前端测试 | 全部 + 7 个新测试文件 |
