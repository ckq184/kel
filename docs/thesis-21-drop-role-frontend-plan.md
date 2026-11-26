# 任务立项：THESIS-21 角色只留管理员（前端）与公开用户字段

> 立项日期：2026-11-26｜base：`a0c29c2`（main tip，THESIS-19 合入后）｜分支：`claude/thesis-21-drop-role-frontend`
> 并行：THESIS-20（后端角色判断，`claude/thesis-20-drop-role-backend`，进行中、尚未合入 main）
> 来源：[docs/issues4/THESIS-21-drop-role-frontend.md](issues4/THESIS-21-drop-role-frontend.md)

## 0. 需求采访结论

- **目标**：前端不再按角色显隐页面或控件，唯一账号可进入全部页面；界面不再出现“多用户”字样；公开用户对象保留 `role: 'admin'`，去掉只对多用户有意义的 `disable_reason`、`notes`、`deleted_at`。
- **完成条件**：`web/src` 非测试源码不再出现 `requireAdmin`、`role === 'admin'` / `role !== 'admin'`、`多用户`（MCP 页面按 issue 非目标豁免，见 §1 差异 1）；`GET /api/auth/me`、登录与账户接口返回的 `user` 保留 `role: 'admin'` 且不含三个字段；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改后端角色判断（THESIS-20）；不改 `is_my_home`（THESIS-34）；不改 MCP 页面作用域代码（THESIS-37）；不改 IM 侧“允许成员”；不拆大组件；不动 `data/`、DB schema 与迁移链。
- **需用户决策**：无（issue 标注“否”）；并行关系已在 issue 与 README 3.1 矩阵中定为 ⚠️。

## 1. 执行前核实（base `a0c29c2`）

| 项               | 复核结论（`git grep` 实测）                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由角色守卫     | `web/src/App.tsx:173` 的 `/monitor` 路由包 `<AuthGuard requireAdmin>`；`web/src/components/auth/AuthGuard.tsx` 的 `requireAdmin` prop、`role === 'admin'` 引导判断与 `role !== 'admin'` 跳转。                                                                                                                                                                                                                   |
| 局部 `isAdmin`   | 11 个生产文件：`SystemSettingsSection`、`SettingsPage`、`SettingsNav`（prop）、`TasksPage`、`CreateTaskForm`、`TaskDetail`、`AgentProfilesPage`、`AgentIdentitySection`、`AgentCapabilitiesSection`、`AddMcpServerDialog`/`McpServersPage`（MCP）、`CreateContainerDialog`、`FilePanel`、`ChatView`、`LoginPage`、`SetupProvidersPage`。                                                                         |
| 多用户文案       | `web/src/pages/LoginPage.tsx:115`“自托管、多用户、多渠道”；`web/src/components/settings/AboutSection.tsx:90`“多用户协作体验”。                                                                                                                                                                                                                                                                                   |
| 后端公开用户对象 | `src/routes/auth.ts:74 toUserPublic` 返回 `role`、`status`、`disable_reason`、`notes`、`deleted_at`；`src/db.ts:8701` 还有同名内部投影供 `listUsers`/`getAllUsers`（`capability-runtime-mutation.ts`、`routes/mcp-servers.ts` 仅读 `id/status`）。收窄共享 `UserPublic` 时两处投影需同步。                                                                                                                       |
| 前端用户类型     | `web/src/stores/auth.ts:5 UserPublic`：`role: 'admin' \| 'member'`、`status`、`disable_reason`、`notes`、`deleted_at`。`status` 仍被 `ProfileSection.tsx:118` 展示“已启用/已禁用”，保留。                                                                                                                                                                                                                        |
| 任务执行模式     | `web/src/utils/task-edit.ts` 的 `getAllowedTaskExecutionModes`/`canSelectTaskExecutionMode` 只被 `TaskDetail` 的工作区切换守卫与 `tests/frontend-agent-product-contract.test.ts` 使用；单角色下 host/container 恒可用。                                                                                                                                                                                          |
| 锁定测试         | `tests/frontend-settings-information-architecture.test.ts:52,141-144`（`requireAdmin`、`isAdmin`、`canAccessSystemSettings` 原文）、`tests/thesis-11-drop-permissions.test.ts:256`、`tests/frontend-agent-product-contract.test.ts:101-107`、`tests/frontend-host-directory-mount.test.ts:125-132`、`tests/agent-profiles-page-dom.test.tsx:371-385`、`tests/message-bubble-duration-only.test.tsx` 的用户夹具。 |
| 不受影响的锁     | `tests/frontend-task-run-status.test.ts` 锁定 `disabled={isScript \|\| adminHostOnlyMode}`，本包保留该表达式。                                                                                                                                                                                                                                                                                                   |
| e2e 夹具         | `web/tests/e2e/**` 不参与 `npm run verify`（vitest exclude）与 `web/` 类型检查（`web/tsconfig.json` 仅 include `src`），且现有夹具已含类型外字段。本包不改它，避免无法在 verify 中验证的改动；作为遗留登记。                                                                                                                                                                                                     |

与 issue 的差异：

1. **MCP 页面豁免**：issue 非目标写明“不改 MCP 页面（THESIS-37）”，故 `web/src/pages/McpServersPage.tsx` 的 `isAdmin`（“导入宿主机副本”按钮与 `AddMcpServerDialog` 的系统/个人作用域）与 `AddMcpServerDialog` 的 `isAdmin` prop 保留给 THESIS-37。源码契约测试显式豁免这两个文件并注明原因，不把它们计入“角色门清零”。
2. **范围扩 `src/db.ts`**：`UserPublic` 是前后端共用的公开类型，`db.ts:8701` 的内部投影返回同一类型；只改 `src/routes/auth.ts` 会类型检查失败或留下不一致形状。`db.ts` 只改该投影三字段，不动 `listUsers` 的角色过滤（THESIS-20 范围）。
3. **e2e 不改**：见上表，登记为非阻塞遗留。

## 2. 方案（TDD）

### 2.1 Red

新增 `tests/thesis-21-drop-role-frontend.test.ts`：

1. **源码契约**：扫描 `web/src/**/*.{ts,tsx}`（排除 `*.test.*`），用 TypeScript scanner 剔除注释后断言：
   - 无 `requireAdmin`；
   - 无 `role === 'admin'`、`role !== 'admin'`、`user?.role === 'admin'` 等按角色的比较（正则 `\brole\b\s*[!=]==\s*'admin'`）；
   - 无 `多用户`；
   - 豁免 `web/src/pages/McpServersPage.tsx`、`web/src/components/mcp-servers/AddMcpServerDialog.tsx`（THESIS-37）。
2. **前端类型契约**：`web/src/stores/auth.ts` 的 `UserPublic` 含 `role: 'admin'`（不再含 `'member'`），不含 `disable_reason`、`notes`、`deleted_at`；仍保留 `status`。
3. **API 契约**（临时 `DATA_DIR` + 内存 Hono app，参照 `tests/thesis-10-single-account.test.ts`）：
   - `POST /api/auth/login` 与 `GET /api/auth/me` 的 `user`：`role === 'admin'`，且 `disable_reason`/`notes`/`deleted_at` 不存在；
   - `PUT /api/auth/profile` 的 `user` 同样收窄。
4. 在 base 上运行应失败（Red）。

### 2.2 Green

1. **后端**：`src/types.ts` 的 `UserPublic` 删除 `disable_reason`、`notes`、`deleted_at`；`src/routes/auth.ts` 与 `src/db.ts` 两个 `toUserPublic` 同步删除。
2. **前端类型**：`web/src/stores/auth.ts` 的 `role` 收为 `'admin'`，删除三字段。
3. **路由与守卫**：删 `App.tsx` 的 `requireAdmin`；`AuthGuard` 删 prop 与角色跳转，保留首启引导（`setupStatus?.needsSetup`）；`SetupProvidersPage` 删非管理员跳转；`LoginPage` 的引导条件去掉角色判断。
4. **设置**：`SettingsPage` 删 `isAdmin`/`canAccessSystemSettings` 与按角色回退 tab 的逻辑；`SettingsNav` 删两个 prop，系统配置与管理后台恒显示；`SystemSettingsSection` 的宿主机集成区删 `isAdmin` 加载/渲染门。
5. **任务**：`TasksPage`/`CreateTaskForm` 删 `isAdmin` prop 与条件渲染，默认执行模式固定 `host`（`adminHostOnlyMode` 逻辑保留）；`TaskDetail` 删 `executionRole`/`isAdmin` 与工作区切换守卫（两模式恒可用），保留 `disabled={isScript || adminHostOnlyMode}`；`utils/task-edit.ts` 删角色模式表，只留 `buildTaskWorkspacePatch`。
6. **智能体**：`AgentProfilesPage` 删 `isAdmin` 与 prop 传递；`AgentIdentitySection`/`AgentCapabilitiesSection` 删 `isAdmin` prop 与宿主能力条件（`hostAvailable` 恒真）；宿主机 Claude 配置单选项不再 `disabled`。
7. **聊天/文件/工作区**：`ChatView` 的 `isOwnHome` 去掉角色兜底、保留 `created_by` 与 `folder === 'main'`；`CreateContainerDialog` 删 `canHostExec` 全部分支（宿主机模式恒可用）；`FilePanel` 删 `canOpenLocalFolder` 门。
8. **文案**：`LoginPage` 改“自托管、多渠道…”；`AboutSection` 改“日常使用体验”。
9. **锁定测试同步**：`frontend-settings-information-architecture`、`thesis-11`、`frontend-agent-product-contract`、`frontend-host-directory-mount`、`agent-profiles-page-dom`、`message-bubble-duration-only` 按新契约改断言/夹具，不删除无关断言。
10. **文档**：`docs/API.md` 认证一节补公开用户对象说明。

### 2.3 Refactor / 门禁

- `git grep -n -E "requireAdmin|role\s*[!=]==\s*'admin'|多用户" -- web/src` 只剩 MCP 豁免文件。
- `git grep -n "disable_reason\|deleted_at\|notes" -- src/types.ts src/routes/auth.ts src/db.ts web/src/stores/auth.ts` 只剩任务/其他领域同名字段。
- `npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。

## 3. 任务拆解

| #   | 任务             | 主要文件                                          | 独立验收                                 |
| --- | ---------------- | ------------------------------------------------- | ---------------------------------------- |
| T1  | 立项             | 本文件、`.gatescope.json`、issue、README          | check-scope 通过；base 为 `a0c29c2`      |
| T2  | Red 契约         | `tests/thesis-21-drop-role-frontend.test.ts`      | 新契约在 base 上失败                     |
| T3  | 后端公开字段     | `src/types.ts`、`src/routes/auth.ts`、`src/db.ts` | 三个响应契约通过；类型检查绿             |
| T4  | 前端角色门与类型 | `web/src/**`（见 §4）                             | 源码契约通过；页面无角色条件；类型检查绿 |
| T5  | 锁定测试同步     | 6 个既有测试                                      | 相关测试通过，无关断言保留               |
| T6  | 门禁与交付       | 全范围、issue/README/方案台账/审查记录            | verify 六步全绿；check-scope 通过        |

回滚点：base `a0c29c2`；每个提交可单独 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-21-drop-role-frontend-plan.md`、`docs/issues4/THESIS-21-drop-role-frontend.md`、`docs/issues4/README.md`、`docs/issues4/task-personal-slim-plan.md`、`docs/审查记录.md`、`docs/API.md`、`src/types.ts`、`src/routes/auth.ts`、`src/db.ts`、`web/src/App.tsx`、`web/src/components/auth/AuthGuard.tsx`、`web/src/stores/auth.ts`、`web/src/utils/task-edit.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/SystemSettingsSection.tsx`、`web/src/components/settings/AboutSection.tsx`、`web/src/components/tasks/CreateTaskForm.tsx`、`web/src/components/tasks/TaskDetail.tsx`、`web/src/components/agents/AgentCapabilitiesSection.tsx`、`web/src/components/agents/AgentIdentitySection.tsx`、`web/src/components/chat/ChatView.tsx`、`web/src/components/chat/CreateContainerDialog.tsx`、`web/src/components/chat/FilePanel.tsx`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/pages/SetupProvidersPage.tsx`、`web/src/pages/TasksPage.tsx`、`tests/thesis-21-drop-role-frontend.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`tests/thesis-11-drop-permissions.test.ts`、`tests/frontend-agent-product-contract.test.ts`、`tests/frontend-host-directory-mount.test.ts`、`tests/agent-profiles-page-dom.test.tsx`、`tests/message-bubble-duration-only.test.tsx`。

与 issue“预计改动路径”的差异：不含 MCP 页面两个文件（THESIS-37）；新增 `src/db.ts`（共享 `UserPublic` 投影）；`web/tests/**` 不改（见 §1 差异 3）。

## 5. 验收条件

1. `web/src` 非测试源码无 `requireAdmin`、`role` 与 `'admin'` 的比较、无“多用户”；MCP 页面豁免。
2. 登录、`/me`、账户接口返回的 `user` 含 `role: 'admin'`，不含 `disable_reason`、`notes`、`deleted_at`。
3. 单账号可进入运行状态、系统设置、主 CKQClaw、宿主机集成等原管理员页面；新建工作区可选宿主机模式。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 新契约在 base 上失败、实现后通过（非空转）。
6. **人工冒烟（用户）**：登录页与“关于”页无“多用户”字样；登录后所有页面可达；新建工作区可选宿主机模式。

## 6. 非目标

- 不改后端角色判断（THESIS-20）与 `UserRole` 类型/建表默认值/夹具。
- 不改 `is_my_home` 与归属检查（THESIS-34）。
- 不改 MCP 页面作用域代码（THESIS-37）；不改 IM 侧“允许成员”。
- 不删 `users` 表列、不改 schema/迁移链。
- 不拆分组件、不顺手清理任务/上下文等其他 `deleted_at`/`notes` 字段。
- 不改 `web/tests/e2e/**`（不在 verify 覆盖内，登记遗留）。

## 7. 风险与回滚

- 唯一行为变化是前端不再隐藏管理入口与宿主机选项；对唯一 admin 账号显示不变。
- `UserPublic` 收窄会影响所有 auth 响应；前端已无消费方，`ProfileSection` 只用 `status`。
- 与 THESIS-20 并行：`src/routes/auth.ts`（不同区域）、`src/types.ts`（不同行）预期可合并；簿记文件冲突时后合入方保留两边。
- 回滚：`git revert <提交号>`；无数据与 schema 变更。
