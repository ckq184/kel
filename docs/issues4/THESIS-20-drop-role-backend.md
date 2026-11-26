# THESIS-20 角色只留管理员（后端）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | ZCode 会话 / `claude/thesis-20-drop-role-backend`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 裁减（多余角色与角色判断）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 依赖          | THESIS-19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 阻塞          | 23、26、27、28 至 37                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 20 行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 预计改动路径  | `src/types.ts`、`src/db-schema/auth-tables.ts`（仅建表默认值）、`src/middleware/auth.ts`、`src/web-context.ts`、`src/host-execution-policy.ts`、`src/task-acl.ts`、`src/routes/{config,monitor,groups,tasks,files,browse,skills,auth,agents,agent-profiles,workspaces}.ts`、`src/ipc/**`、`src/task-scheduler.ts`、`src/container-runner.ts`、`src/index.ts`、`src/db.ts`（按角色过滤的 SQL）、`src/agent-profile-policy.ts`、`src/agent-profile-runtime.ts`、`src/claude-context-resolver.ts`、`src/agent-capability-preview.ts`、`src/admin-host-only-runtime.ts`、`src/runtime-config.ts`、`src/web.ts`、`src/container-image-failure.ts`、`src/provider-failure.ts`、`src/reset-admin.ts`、`container/agent-runner/src/**`（`isAdminHome` 改名）、`tests/**`、`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md` |
| 需用户决策    | 否（方案 P1 已定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 来源          | 方案 P1、§4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 目标

系统里只有一个角色：管理员。`role` 恒为 `admin`；`member` 等其他角色从类型、建表默认值、代码与测试夹具里消失；所有"是不是管理员"的判断删除，代码直接走管理员分支。非主工作区的 Agent 仍不能创建脚本任务或宿主机任务（这是防提示词注入的能力边界，不是角色）。

## 现状（`607d1b6`）

- `UserRole`（`src/types.ts:645`）含 `member`；建表默认值 `role TEXT NOT NULL DEFAULT 'member'`（`src/db-schema/auth-tables.ts:29`）；测试夹具 `tests/helpers/route-test-user.ts` 的 5 个 helper 默认 `role: 'member'`（:20、:30、:36 起，16 个测试文件、130 处调用，33 处显式传 role）。
- `adminRoleMiddleware`（`src/middleware/auth.ts:134`）挂载 25 处：`src/routes/config.ts` 21、`src/routes/monitor.ts` 4。`tests/thesis-11-drop-permissions.test.ts` 按数量钉死。
- `hasHostExecutionPermission`（`src/web-context.ts:298`）= `role === 'admin'`；`canExecuteOnHost`（`src/host-execution-policy.ts:18`）在 `src/index.ts`、`src/task-scheduler.ts`、`src/container-runner.ts` 运行前复查 owner 是否为 active admin。
- `isAdminHome` 69 处（后端 12 个文件、runner 7 行）。
- `adminHostOnlyMode`：按 `role = 'admin'` 过滤的 SQL 在 `src/db.ts` 7622–7632；`isAdminHostOnlyOwner` 在 `src/index.ts:3188`、:3263；启动时按角色重写主工作区执行模式（`src/index.ts` 4285–4307）。
- 宿主机 Skills 只对 admin 可见：`src/routes/skills.ts` 223–330、`src/agent-profile-policy.ts` 36–56、`src/agent-profile-runtime.ts` 51–53、`src/agent-builder.ts` 218–230。
- `setupStatus` 只在 admin 时返回（`src/routes/auth.ts` :201 一带）。
- 后端"联系管理员"提示：`src/container-image-failure.ts`、`src/provider-failure.ts`、`src/index.ts`。
- 估算：后端约 420 行角色判断，约 455 行在角色分支块内。

## 非目标

- 不删 `users.role` 列；新建账号写 `admin`。
- 不动 MCP 的角色与可见性代码（`memberAccess`、仅管理员系统 MCP）——整体归 THESIS-37 删除，避免两个包改同一段代码。
- 不动数据归属检查（THESIS-34）；`canAccessGroup` 等只去掉未使用的 `role` 参数。
- 不改前端（THESIS-21）。
- 不改 IM 侧访问控制；`/reset-owner` 应急路由只去掉其中的角色判断。
- 不改设置键与环境变量名 `adminHostOnlyMode`、`ADMIN_HOST_ONLY_MODE`。

## 执行前核实

- 区分三类"像角色判断"的代码，逐处登记：① 纯角色判断（删，保留管理员分支）；② 宿主机执行闸门（`hasHostExecutionPermission`、`canExecuteOnHost`：不再看角色，保留"工作区存在、有 owner 记录"的检查）；③ 主工作区判断（`isAdminHome` → `isHome`，保留）。
- 无 owner 的工作区（`created_by` 为空）目前被拒绝宿主机执行，保持不变（THESIS-34 再统一处理）。
- 可以只读查看本机数据库核对 `users.role` 的现有值（方案 §3 放宽项）。

## 实现步骤（TDD）

1. **Red**：`src/`、`container/agent-runner/src/`、`tests/` 非否定断言处不再出现 `'member'`、`UserRole` 只剩 `'admin'`；系统配置与运行状态接口只需登录；宿主机执行不再查角色但仍拒绝不存在的工作区；非主工作区 Agent 仍不能建脚本任务；`setupStatus` 对唯一账号返回。更新 `tests/thesis-11-drop-permissions.test.ts` 与 `tests/thesis-13-personal-docs.test.ts` 的钉死断言。
2. **Green**：按"执行前核实"的三类逐处改；删 `adminRoleMiddleware` 与 25 处挂载；`isAdminHome` 全仓改名 `isHome`；建表默认值改 `'admin'`；测试夹具去掉 `role` 参数或固定为 `admin`；"联系管理员"改为直接说明处理办法。
3. 文档：`docs/ACL-MATRIX.md` 去掉 admin 角色层；`CLAUDE.md` §8、`docs/API.md`、`README.md` 同步。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n -E "adminRoleMiddleware|hasHostExecutionPermission|isAdminHome|'member'" -- src container/agent-runner/src tests` 只剩否定断言。
3. **人工冒烟（用户）**：系统设置、运行状态页可用；新建宿主机工作区并对话；新建脚本定时任务并运行；宿主机 Skills 在能力页可见；首启引导（用新数据目录）能走完。

## 风险与回滚

- 本包改宿主机执行闸门，须在 THESIS-19 之后开工。
- 回滚：`git revert` 对应提交区间。

## 交付记录

- **提交**：`76e0cf0`（立项）、`de6f7fa`（实现）、`4fd7096`（同步 main，THESIS-19 正式合入）、`af03db8`（规格审查处置）、`37e00a7`（规格审查非阻塞）、`f1b7892`（质量审查处置）、`e806b97`（质量复核处置），交付簿记随本提交（分支 `claude/thesis-20-drop-role-backend`）。
- **实现**：`UserRole` 只留 `'admin'`；建表默认值 `'admin'`；历史 role 行读取时按 admin 解释。删除 `adminRoleMiddleware`（25 处挂载）与 `hasHostExecutionPermission`，调用点走管理员分支；`isAdminHome` 全仓收敛为 `isHome`（host/runner/IPC/跨组 ACL）；`canExecuteOnHost` 只查 owner 存在且 active；Home 恒 Host，非 Home 仍不能建脚本任务/跨组投递。系统配置、运行状态、宿主机 Skills、`setupStatus` 对唯一登录账号开放。MCP 可见性与数据归属检查未动（分别归 THESIS-37、THESIS-34）；前端未动（THESIS-21）；提示语去掉“联系管理员”。
- **验证**：`npm run verify` 六步全绿（369 文件，3024 通过 / 23 跳过）；`node scripts/check-scope.mjs` 33 路径通过（实现提交 105 路径通过）；`git grep -n -E "adminRoleMiddleware|hasHostExecutionPermission|isAdminHome" -- src container/agent-runner/src tests` 仅剩否定断言；`git grep -n "'member'" -- src container/agent-runner/src` 零命中；新契约 10 例在 base 上 5 项失败、实现后全通过。
- **审查**：规格符合性审查通过（2 条阻塞已关闭）；代码质量审查通过（Critical 0 / Major 1 已关闭；Minor 已修或登记）。
- **偏差**：见方案 §8.1-12（MCP 保留、`HOST_MOUNT_ACCOUNT_INACTIVE`、workspaces 治理字段、env/删消息走管理员分支、`isMain` 兼容、签名变更、测试白名单、提示语、`permissions.is_admin` 删除、遗留 SQL role 过滤、host-only 迁移范围、源码扫描契约）。
- **范围外登记**：`src/runtime-config.ts` 的 IM 配置注释与 SQL role 过滤、`src/claude-context-resolver.ts` 注释、历史 plan/审查记录旧符号保留；`web/src` 角色 UI 与 MCP `system` 作用域分别归 THESIS-21、THESIS-37。
- **未实机验收**：系统设置、运行状态、新建宿主机工作区对话、新建脚本定时任务、能力页宿主机 Skills、首启引导待用户冒烟。
