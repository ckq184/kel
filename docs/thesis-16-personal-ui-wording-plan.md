# 任务立项：THESIS-16 个人版界面表面收口

> 立项日期：2026-11-25｜base：`248c7cb`（main tip，THESIS-17 合入后）｜分支：`claude/thesis-16-personal-ui-wording`
> 来源：[docs/issues3/THESIS-16-personal-ui-wording.md](issues3/THESIS-16-personal-ui-wording.md)

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-U1 选 ①**：删除个人资料页的角色标签，只保留账号启用状态。`users.role` 字段、`role === 'admin'` 判断与数据归属全部保留。
- **D-U2 选 ①**：界面隐藏 MCP"成员访问"控件、只读展示与相关提示；新建系统 MCP 不再提交 `memberAccess`，由后端默认归一到 `admin_only`；存量 `shared` 值不动。`McpServer.memberAccess`、`McpServerCreate.memberAccess`、`McpServerUpdate.memberAccess` 与接口字段保留。
- **D-U3 选 ①**：全面去掉界面上的"管理员"前缀，按功能命名；首启页改为"创建账号"。IM 侧"允许成员"（群成员语义）不动。
- **完成条件**：`web/src` 非测试源码（去掉注释后）不再出现 `管理员`、`普通成员`、`成员访问`、`共享给成员`、`成员任务`；IM 侧"允许成员"正控制仍在；MCP 新建/编辑界面不再引用 `memberAccess`，后端默认与存量值行为不变；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改任何权限、归属、角色判断与接口字段名；不改 IM 侧访问控制；不改后端错误文案（`src/routes/tasks.ts` 等约 30 处含"管理员"的 403 文案保留）；不做实机验收。

## 1. 执行前核实（base `248c7cb`）

| 项                        | 复核结论                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文案分布                  | `git grep -n -E "管理员\|普通成员\|成员访问\|共享给成员" -- web/src` 命中 issue 现状表全部位置；另发现 `TaskDetail.tsx:636`、`:638`、`:653`、`:654`、`:708` 五处"管理员/成员任务"提示未列入现状表，按 D-U3 ① 一并改写                                                                                                     |
| 仅注释命中                | `web/src/App.tsx:103`、`web/src/components/monitor/UncertainOutboxCard.tsx:31` 只在注释中出现"管理员"；issue 非目标允许保留，本包不改，契约用例先去注释再断言                                                                                                                                                             |
| 能力预览 note             | `src/agent-capability-preview.ts:297` 生成用户可见 note"'有 N 个系统 MCP 仅限管理员，普通成员智能体不会继承。'"；仅 `ownerRole !== 'admin'` 时出现，但属于界面表面，按 D-U3 ① 改写为"当前不可用"，同步更新 `tests/agent-capability-preview.test.ts`。这是唯一改动的后端文件，不涉及权限判断                               |
| MCP 后端默认值            | `src/routes/mcp-servers.ts:481` 系统 MCP 创建时 `memberAccess: memberAccess ?? 'admin_only'`；`tests/routes-mcp-server-isolation.test.ts:145-163` 已覆盖"不传 memberAccess → admin_only"，本包不新增后端用例                                                                                                              |
| MCP 编辑保留存量值        | `src/routes/mcp-servers.ts:675-676` 仅在 `memberAccess !== undefined` 时改写；前端编辑不再发送该字段，存量 `shared` 不会被覆盖                                                                                                                                                                                            |
| `memberAccess` 字段保留   | `web/src/stores/mcp-servers.ts:26`、`:54`、`:66` 与 `src/mcp-utils.ts`、`src/routes/mcp-servers.ts` 的字段与校验全部保留，本包只删界面控件                                                                                                                                                                                |
| 断言旧文案的测试          | `tests/mcp-servers-frontend.test.ts:202-229`（源码契约：显式访问选项）、`tests/frontend-settings-information-architecture.test.ts:135`、`:189`、`tests/agent-profiles-page-dom.test.tsx:390`、`tests/agent-capability-preview.test.ts:356` 需随改写更新；其余 `memberAccess`/`adminHostOnlyMode` 用例断言行为或结构，不动 |
| `ProfileSection` 角色标签 | `:118` 为唯一 "管理员/普通成员" 角色标签；删除后 `currentUser` 仍用于启用状态，不产生未使用变量                                                                                                                                                                                                                           |

## 2. 方案（TDD）

1. **Red**：新增 `tests/thesis-16-personal-ui-wording.test.ts`：
   - 遍历 `web/src` 非测试模块，去掉行注释与块注释后断言不含 `管理员`、`普通成员`、`成员访问`、`共享给成员`、`成员任务`；在 base 上因现存文案失败。
   - 正控制：`web/src/components/chat/ImBindingDialog.tsx` 仍含 `所有允许成员`，`web/src/constants/im.ts` 仍含 `响应允许成员的所有消息`，防止误删 IM 侧群成员语义。
   - MCP 表面：`AddMcpServerDialog.tsx`、`McpServerDetail.tsx` 不含 `memberAccess` 与"成员访问/共享给成员/仅管理员"；`web/src/stores/mcp-servers.ts` 与 `src/routes/mcp-servers.ts` 仍含 `memberAccess`，锁定"界面隐藏、字段保留"。
   - 正向控制：`SetupPage.tsx` 含 `创建账号`，`SystemSettingsSection.tsx` 含 `纯宿主机模式`，避免删成空白。
2. **Green**：
   - D-U1：`ProfileSection.tsx` 删除角色分支，状态文案独立渲染。
   - D-U2：`AddMcpServerDialog.tsx` 删除 `memberAccess` state、重置、创建载荷中的条件字段与访问选择块；`McpServerDetail.tsx` 删除 `editMemberAccess` state、只读展示、不可用提示与编辑字段，PATCH 不再发送 `memberAccess`；`McpServerCard.tsx` 的不可用预览改"当前不可用"；`McpServersPage.tsx`、`AddMcpServerDialog.tsx` 的系统 MCP 说明去掉"成员/管理员"。
   - D-U3：按功能命名改写 `SetupPage`、`SystemSettingsSection`、`CreateContainerDialog`、`HostDirectoryMountEditor`、`ContainerEnvPanel`、`CreateTaskForm`、`TaskDetail`、`MonitorPage`、`AgentSkillsPolicyEditor`（徽标也删除）、`MainAgentCapabilitiesSection`、`AgentProfilesPage`，以及 `src/agent-capability-preview.ts` 的 note。
   - 同步更新上述四个既有测试中的文案断言。
3. **Refactor**：检查删除 `memberAccess` 后无未使用 state/常量/导入；`SkillSourceSection` 的 `badge` 仍被其他 section 使用，保留。
4. **门禁**：`npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-16-personal-ui-wording-plan.md`、`docs/issues3/THESIS-16-personal-ui-wording.md`、`docs/issues3/README.md`、`docs/审查记录.md`、`src/agent-capability-preview.ts`、`web/src/components/agents/AgentSkillsPolicyEditor.tsx`、`web/src/components/chat/ContainerEnvPanel.tsx`、`web/src/components/chat/CreateContainerDialog.tsx`、`web/src/components/chat/HostDirectoryMountEditor.tsx`、`web/src/components/mcp-servers/AddMcpServerDialog.tsx`、`web/src/components/mcp-servers/McpServerCard.tsx`、`web/src/components/mcp-servers/McpServerDetail.tsx`、`web/src/components/settings/MainAgentCapabilitiesSection.tsx`、`web/src/components/settings/ProfileSection.tsx`、`web/src/components/settings/SystemSettingsSection.tsx`、`web/src/components/tasks/CreateTaskForm.tsx`、`web/src/components/tasks/TaskDetail.tsx`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/pages/McpServersPage.tsx`、`web/src/pages/MonitorPage.tsx`、`web/src/pages/SetupPage.tsx`、`tests/agent-capability-preview.test.ts`、`tests/agent-profiles-page-dom.test.tsx`、`tests/frontend-settings-information-architecture.test.ts`、`tests/mcp-servers-frontend.test.ts`、`tests/thesis-16-personal-ui-wording.test.ts`。

与 issue"预计改动路径"的差异：多出 `src/agent-capability-preview.ts`（用户可见 note，见 §1）与 `.gatescope.json`、文档本身；其余一一对应。

## 4. 验收条件

1. 契约用例通过，且在 base `248c7cb` 上运行会失败（非空转）；IM 侧"允许成员"正控制通过。
2. `web/src` 非测试源码去注释后无 `管理员`、`普通成员`、`成员访问`、`共享给成员`、`成员任务`。
3. MCP 新建/编辑界面不再出现成员访问控件；新建系统 MCP 仍由后端默认 `admin_only`（既有后端用例），编辑不再覆盖存量 `memberAccess`。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 人工冒烟（用户，交付后）：首启页、设置页"个人资料""系统配置"、MCP 新建与详情、新建工作区、新建定时任务各看一遍无"普通成员""成员访问"等字样；新建 MCP 后在 Agent 里能正常使用。

## 5. 非目标

- 不改 `users.role`、`adminRoleMiddleware`、`canAccessGroup`、`task.permissions` 等任何权限或归属判断。
- 不改 `memberAccess`、`adminHostOnlyMode`、`ADMIN_HOST_ONLY_MODE` 等接口字段、设置键与存储格式；不改后端错误文案。
- 不改 IM 侧"允许成员""所有允许成员"及 `constants/im.ts` 的渠道文案。
- 不改 `web/src/App.tsx`、`UncertainOutboxCard.tsx` 的代码注释（issue 允许保留）。
- 不做实机验收、不做界面重构、不引入依赖。

## 6. 风险与回滚

- 只改文案与展示；隐藏 MCP 控件后，若库中存在 `shared` 系统 MCP，界面不再显示该值，对单账号无行为影响，交付记录注明。
- 契约用例覆盖全 `web/src`，未来若新增合法"管理员"文案会失败；这是有意的口径门禁。
- 回滚：`git revert <提交号>`；无数据、schema 或接口变更。
