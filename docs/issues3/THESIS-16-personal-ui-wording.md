# THESIS-16 个人版界面表面收口：角色标签、MCP 成员访问、管理员措辞

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 类型          | 裁减收尾（界面文案与无意义控件）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 依赖          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 可并行        | ✅ 17、18、ISSUE-26（口径见 [README 第三节](README.md#三并行关系)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 预计改动路径  | `web/src/components/settings/ProfileSection.tsx`、`web/src/components/mcp-servers/{AddMcpServerDialog,McpServerDetail,McpServerCard}.tsx`、`web/src/pages/{SetupPage,McpServersPage,MonitorPage,AgentProfilesPage}.tsx`、`web/src/components/settings/{SystemSettingsSection,MainAgentCapabilitiesSection}.tsx`、`web/src/components/chat/{CreateContainerDialog,HostDirectoryMountEditor,ContainerEnvPanel}.tsx`、`web/src/components/tasks/{CreateTaskForm,TaskDetail}.tsx`、`web/src/components/agents/AgentSkillsPolicyEditor.tsx`、`tests/**`、`web/tests/**` |
| 需用户决策    | **是**：D-U1 至 D-U3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 来源          | THESIS-11 交付记录"后续建议（THESIS-16）"；`docs/审查记录.md` THESIS-11 节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 目标

系统只有一个账号且恒为 admin（D-E1 ②a）。界面上仍有三类以多用户为前提的表面：个人资料页的"管理员/普通成员"标签、MCP 的"成员访问"控件、各处"管理员……""仅管理员可用"的措辞。本包只改界面表面，让文案与个人版定位一致；内部的 `role`、admin 判断、数据归属、存储字段与接口字段全部保留（THESIS-11 的"方案 B"）。

## 现状（`68a57de`）

| 类别             | 位置                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 角色标签         | `ProfileSection.tsx:118`：`role === 'admin' ? '管理员' : '普通成员'`                                                                                                                                                                                                                                                                                    |
| MCP 成员访问控件 | `AddMcpServerDialog.tsx:177-208`（"成员访问"单选：`admin_only` 仅管理员 / `shared` 共享给成员，及凭据提示）；`McpServerDetail.tsx:184-191`（只读展示）、`:235-266`（编辑）；`McpServerCard.tsx:27`（"仅管理员可用"徽标）；`McpServersPage.tsx:241` 说明文字；`AddMcpServerDialog.tsx:151` "所有用户可见，管理员维护"；`McpServerDetail.tsx:222`、`:497` |
| 首启页           | `SetupPage.tsx:61`、`:129`、`:135`、`:144`、`:147`（"创建管理员账号""系统已被其他管理员初始化"等）                                                                                                                                                                                                                                                      |
| 宿主机模式措辞   | `SystemSettingsSection.tsx:486`、`:547`、`:552`（"管理员纯宿主机模式"）；`CreateContainerDialog.tsx:511`；`CreateTaskForm.tsx:181`、`:267`、`:543`；`MonitorPage.tsx:139`；`HostDirectoryMountEditor.tsx:170`                                                                                                                                           |
| 其余"管理员"措辞 | `AgentSkillsPolicyEditor.tsx:103`（徽标）、`:217`；`ContainerEnvPanel.tsx:198`；`TaskDetail.tsx:453`；`MainAgentCapabilitiesSection.tsx:247`；`AgentProfilesPage.tsx:800`                                                                                                                                                                               |

断言这些文案的测试（执行时逐个核对）：`tests/mcp-servers-frontend.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`tests/agent-profiles-page-dom.test.tsx`、`tests/agent-capability-preview.test.ts`、`tests/thesis-10-single-account.test.ts`。

## 非目标

- 不改 `users.role`、`adminRoleMiddleware`、`canAccessGroup` 等任何权限或归属判断；不改接口字段名与设置键名（`memberAccess`、`adminHostOnlyMode`、`ADMIN_HOST_ONLY_MODE` 都保留）。
- 不改后端返回的错误文案（`src/routes/tasks.ts` 等约 30 处含"管理员"）。单账号下这些 403 分支基本不会触发；要改另立包。
- 不改 IM 侧的"允许成员""所有允许成员"（`ImBindingDialog.tsx`、`UserChannelsSection.tsx`、`constants/im.ts` 等）——这里的"成员"指 IM 群成员，属于保留的 IM 侧访问控制。
- 不改代码注释（`App.tsx:103`、`UncertainOutboxCard.tsx:31`）；顺手改可以，但不作为验收项。

## 需用户决策（领取前拍板）

| #    | 问题                     | 选项                                                                                                                   | 建议 |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| D-U1 | 个人资料页的角色标签     | ① 删除标签；② 固定显示"管理员"                                                                                         | ①    |
| D-U2 | MCP"成员访问"控件        | ① 界面隐藏该控件与相关提示，新建沿用后端默认值 `admin_only`，存量值不动；② 保留控件，只改文案                          | ①    |
| D-U3 | "管理员……"措辞的改写口径 | ① 去掉"管理员"前缀，按功能命名（如"纯宿主机模式""宿主机工作区"），首启页改为"创建账号"；② 只改首启页与资料页，其余保留 | ①    |

D-U2 ① 的依据：后端在缺省时把 `memberAccess` 归一为 `admin_only`（`src/mcp-utils.ts:332-338`），唯一账号是 admin，取值对行为没有影响。选 ① 时要确认隐藏后不留下无引用的组件或常量（方案 §11.4，THESIS-15 的可达性契约会兜底文件级孤儿）。

> **2026-11-25 补注（issues4 立项）**：第三轮已拍板去掉角色（[personal-slim](../issues4/task-personal-slim-plan.md) P1）。MCP"成员访问"控件与 `memberAccess` 将由 [THESIS-21](../issues4/THESIS-21-drop-role-frontend.md) 连同后端整体删除，资料页角色标签也在其范围内。本包领取时若尚未做 D-U1、D-U2，可以直接把这两项交给 THESIS-21，只做 D-U3 的文案改写，避免先隐藏再删除的重复劳动。

## 执行前核实

- 逐个打开上面列出的测试，区分"断言文案"与"断言行为"：前者随改写更新；后者（例如 MCP 访问控制、宿主机模式迁移）不动。
- `git grep -n -E "管理员|普通成员|成员访问|共享给成员" -- web/src` 重新定位；结果与本 issue 的现状表不一致时以 grep 为准，并在交付记录写明差异。

## 实现步骤（TDD）

1. **Red**：新增契约用例，断言 `web/src` 非测试文件里不再出现 `普通成员`、`成员访问`、`共享给成员`、`管理员纯宿主机`、`创建管理员`（按拍板结果调整清单）；IM 侧"允许成员"作为正控制保留。
2. **Green**：按拍板改写文案、隐藏控件；同步更新断言旧文案的测试。
3. 跑 `npm run verify` 与 `node scripts/check-scope.mjs`。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 契约用例通过，且在 `68a57de` 上运行会失败（不是空转）。
3. **人工冒烟（用户）**：首启页、设置页"个人资料""系统设置"、MCP 新建与详情、新建工作区、新建定时任务各看一遍，没有"普通成员""成员访问"等字样；新建 MCP 后在 Agent 里能正常使用。

## 风险与回滚

- 只改文案与展示，回滚为 `git revert <提交号>`。
- 隐藏 MCP 控件后，若库里存量有 `shared` 的系统 MCP，界面看不到这个值；对单账号无行为影响，在交付记录注明。

## 交付记录

（待填）
