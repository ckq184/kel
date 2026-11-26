# THESIS-21 角色只留管理员（前端）与公开用户字段

| 字段          | 值                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                      |
| 领取人 / 分支 | ZCode 会话 / `claude/thesis-21-drop-role-frontend`（与 THESIS-20 并行）                                                                                                                                                                                     |
| 优先级        | P1                                                                                                                                                                                                                                                          |
| 类型          | 裁减（前端角色门与多用户文案）                                                                                                                                                                                                                              |
| 依赖          | THESIS-19                                                                                                                                                                                                                                                   |
| 阻塞          | 无                                                                                                                                                                                                                                                          |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 21 行                                                                                                                                                                                                             |
| 预计改动路径  | `web/src/App.tsx`、`web/src/components/auth/AuthGuard.tsx`、`web/src/stores/auth.ts`、`web/src/types.ts`、`web/src/components/**`、`web/src/pages/**`、`src/routes/auth.ts`（仅 `toUserPublic`）、`src/types.ts`、`tests/**`、`web/tests/**`、`docs/API.md` |
| 需用户决策    | 否                                                                                                                                                                                                                                                          |
| 来源          | 方案 P1                                                                                                                                                                                                                                                     |

## 目标

前端不再根据角色显隐页面或控件，所有页面对唯一账号开放；界面上不再有"多用户"字样。公开用户对象保留 `role: 'admin'`（系统唯一的角色），去掉只对多用户有意义的字段。

## 现状（`607d1b6`）

- `web/src/App.tsx:173` 起的 `requireAdmin` 路由守卫；`web/src/components/auth/AuthGuard.tsx:82` 起按角色决定是否跳转首启引导。
- 约 11 个文件里的局部 `isAdmin`（宿主机模式、工作区创建、任务、设置、Agent 能力），前端合计约 133 行角色相关代码。
- 多用户文案：`web/src/pages/LoginPage.tsx:115`"自托管、多用户、多渠道"；`web/src/components/settings/AboutSection.tsx:118`"多用户协作体验"（THESIS-16 交付记录登记的遗留）。
- `toUserPublic`（`src/routes/auth.ts:74`）返回 `role`、`status`、`disable_reason`、`notes`、`deleted_at`。
- THESIS-16 已删资料页角色标签与 MCP 成员访问控件。MCP 页面剩余的作用域代码归 THESIS-37。

## 非目标

- 不改后端角色判断（THESIS-20）。
- 不改 `is_my_home`（随 THESIS-34 前后端一起改）与 MCP 页面（THESIS-37）。
- 不改 IM 侧"允许成员""所有允许成员"（指 IM 群成员）。
- 不拆分大组件。

## 执行前核实

- 若 THESIS-20 尚未合入：后端仍可能对某些接口做角色检查，前端删掉角色门后对唯一 admin 账号显示不变。
- `git grep -n -E "isAdmin|requireAdmin|\\.role\\b|多用户" -- web/src` 重新定位，结果与现状不一致时以 grep 为准。

## 实现步骤（TDD）

1. **Red**：`web/src` 非测试文件不再出现 `requireAdmin`、`role === 'admin'`、`多用户`；`GET /api/auth/me` 与登录响应保留 `role: 'admin'`，不含 `disable_reason`、`notes`、`deleted_at`。
2. **Green**：删前端角色门；改两处文案；删 `toUserPublic` 多余字段与前端类型。
3. 同步 `docs/API.md` 的用户对象说明；THESIS-15 的可达性契约兜底孤儿文件。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：登录页与"关于"页无"多用户"字样；登录后所有页面可达（含运行状态）；新建工作区可选宿主机模式。

## 风险与回滚

- 只改展示与响应字段；回滚为 `git revert <提交号>`。

## 交付记录

- **状态**：已完成（2026-11-26）。分支 `claude/thesis-21-drop-role-frontend`；提交：立项 `7d28f90`、实现 `8978fd4`、规格审查处置 `9301bcf`、质量审查处置 `4669733`；base `a0c29c2`（与 THESIS-20 并行，未推送）。
- **范围**：34 个路径，全部在 `.gatescope.json` allow 内。较 issue 预计路径的差异：MCP 页面两文件按非目标留给 THESIS-37（未改）；扩 `src/db.ts`（共享 `UserPublic` 投影同步删除三字段）；`web/tests/e2e/**` 未改（不在 verify 与 `web/tsconfig.json` 覆盖内，登记遗留）。
- **实现摘要**：
  - 前端删 `requireAdmin`、`AuthGuard` 角色跳转、`isAdmin`/`canHostExec`/`canOpenLocalFolder`/`canAccessSystemSettings`/`executionRole` 等角色分支；`/monitor`、系统设置、主 CKQClaw、宿主机集成、宿主机模式、宿主机 Skills、打开工作区文件夹对唯一账号恒可用；登录页与“关于”页去掉“多用户”字样。
  - 公开用户对象保留 `role`（唯一账号为 `admin`）与 `status`，从 `src/types.ts`、`src/routes/auth.ts`、`src/db.ts` 两处投影及前端类型删除 `disable_reason`、`notes`、`deleted_at`。
  - 删除 `task-edit` 的角色模式表与 `TaskDetail` 工作区切换角色守卫（host/container 恒可用）；保留 `disabled={isScript || adminHostOnlyMode}`、脚本任务工作区过滤、宿主机目录挂载校验等与角色无关的边界。
- **验收匹配度**：
  1. `web/src` 非测试源码无 `requireAdmin`、`role` 与 `'admin'` 比较、无“多用户”；MCP 豁免仅 `McpServersPage.tsx` 与 `AddMcpServerDialog.tsx`，两文件零改动。
  2. 登录、`GET /api/auth/me`、`PUT /api/auth/profile` 实测 `user.role === 'admin'`、无三字段、`status` 保留。
  3. 原管理员页面与控件不再有角色条件（静态核实通过）；人工冒烟待用户。
  4. `npm run verify` 六步全绿（369 文件 3028 通过 / 23 跳过，32.0s）；`node scripts/check-scope.mjs` 34 路径通过；`npm run docs:check` 161 个 Markdown 通过。
  5. 新契约在 base `a0c29c2` 上 7 条失败、实现后全部通过（非空转）；质量处置后合并为 6 条。
- **审查**：规格符合性通过（零阻塞；5 条非阻塞，3 条已修、2 条登记）；代码质量通过（Critical 0 / Major 0 / Minor 9，5 条已修、4 条登记）。
- **遗留（登记，不在本包范围）**：
  - `web/tests/e2e/mobile-chat-harness.tsx` 与 `mobile-chat.spec.ts` 仍使用 `member` 角色与三字段；e2e 不在 verify/tsconfig 覆盖内，恢复 e2e 时需同步。
  - `web/src/components/agents/AgentSkillsPolicyEditor.tsx` 的 `hostAvailable` 恒真导致“不可查看宿主机 Skills”分支不可达（文件不在 allow，归能力清理任务）。
  - `web/src/pages/MonitorPage.tsx:48` 注释仍称“admin 角色守卫”（文件不在 allow；随 THESIS-20/21 合并后顺手清理）。
- **与 THESIS-20 并行**：`git merge-tree` dry-run 仅 `.gatescope.json` 与 `docs/issues4/README.md` 两处簿记冲突；`src/routes/auth.ts`、`src/types.ts`、`src/db.ts` 可自动合并；`tests/thesis-11-drop-permissions.test.ts` 与 `docs/API.md` 为两包共同修改区，合并时保留本包“无 `requireAdmin` / 公开字段收窄”的语义，并对并集跑一次 verify。
- **人工冒烟（待用户）**：登录页与“关于”页无“多用户”；登录后运行状态、系统设置、主 CKQClaw、宿主机集成可达；新建工作区可选宿主机模式；任务页可建脚本/宿主机任务。
