# THESIS-20 去角色（后端）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 类型          | 裁减（去掉管理员/成员角色）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 依赖          | THESIS-19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 阻塞          | 23、26、27、28 至 33                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 可并行        | ⚠️ 21（`src/routes/auth.ts` 不同区域）、22（`src/index.ts`、`src/runtime-config.ts` 不同区域）、24（`src/web.ts`）、25（`src/routes/agent-profiles.ts`）。❌ 其余（口径见 [README 第三节](README.md#三并行关系与执行顺序)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 预计改动路径  | `src/middleware/auth.ts`、`src/web-context.ts`、`src/host-execution-policy.ts`、`src/task-acl.ts`、`src/routes/{config,monitor,groups,tasks,files,browse,mcp-servers,skills,auth,agents,agent-profiles,workspaces}.ts`、`src/ipc/**`、`src/task-scheduler.ts`、`src/container-runner.ts`、`src/index.ts`、`src/db.ts`（按角色过滤的 SQL）、`src/mcp-utils.ts`、`src/agent-profile-policy.ts`、`src/agent-profile-runtime.ts`、`src/claude-context-resolver.ts`、`src/agent-capability-preview.ts`、`src/admin-host-only-runtime.ts`、`src/runtime-config.ts`、`src/types.ts`、`src/web.ts`、`container/agent-runner/src/**`（`isAdminHome` 改名）、`tests/**`、`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md` |
| 需用户决策    | **是**：D-R1、D-R2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 来源          | 方案 P1、§4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 目标

后端不再有"管理员/成员"概念：所有按角色分支的代码收敛为"已登录的唯一账号"一条路径。安全边界不变——宿主机执行仍要求 owner 存在且 active，非主工作区的 Agent 仍不能创建脚本任务或宿主机任务。

## 现状（`248c7cb`）

- `adminRoleMiddleware`（`src/middleware/auth.ts:134`）挂载 25 处：`src/routes/config.ts` 21、`src/routes/monitor.ts` 4。`tests/thesis-11-drop-permissions.test.ts` 按数量钉死。
- `hasHostExecutionPermission`（`src/web-context.ts:298`）= `role === 'admin'`，46 处引用；`canExecuteOnHost`（`src/host-execution-policy.ts:18`）运行前复查 owner。
- `canAccessGroup` 等（`src/web-context.ts:309` 起）有未读取的 `role` 参数，调用方传了 47 处。
- `isAdminHome` 69 处（后端 12 文件、runner 7 行）：主工作区且 owner 为 admin。真实用途是 Agent 能力边界（`src/task-acl.ts:12` 的注释写明防提示词注入）。
- `adminHostOnlyMode`：设置项与 `ADMIN_HOST_ONLY_MODE` 环境变量，按 `role = 'admin'` 过滤的 SQL 在 `src/db.ts`；`isAdminHostOnlyOwner` 在 `src/index.ts:3188`、:3263。
- MCP `memberAccess`（`admin_only`/`shared`）：`src/routes/mcp-servers.ts`、`src/mcp-utils.ts:330` 起、`src/container-runner.ts` 的 `allowAdminOnlySystemMcp`；持久化在 `data/mcp-servers/system/servers.json`。
- 宿主机 Skills 只对 admin 可见：`src/routes/skills.ts` 223–330、`src/agent-profile-policy.ts` 36–56、`src/agent-profile-runtime.ts`。
- 首启引导：`setupStatus` 只在 admin 时返回（`src/routes/auth.ts:201` 一带）。
- 启动时按角色把主工作区强制为宿主机或容器模式、按角色决定主工作区名（`web:main` 或 `web:home-{id}`）：`src/index.ts` 4285–4307、`src/db.ts` 8025–8060。
- 估算：后端约 420 行角色判断，约 455 行在角色分支块内。

## 非目标

- 不删 `users.role` 列；新建账号仍写入 `admin`，保持存量数据形态一致（D-R1）。
- 不改数据归属检查的语义（`canAccessGroup` 等保留，只去掉未用的 `role` 参数）。
- 不改 IM 侧访问控制（方案 §3 第 2 条）；`/reset-owner` 应急路由只去掉其中的角色判断。
- 不改前端（THESIS-21）；不改 `toUserPublic` 的返回字段（THESIS-21 在前端去掉依赖后再删）。
- 不改设置键与环境变量名 `adminHostOnlyMode`、`ADMIN_HOST_ONLY_MODE`。

## 需用户决策（领取前拍板）

| #    | 问题                        | 选项                                                              | 建议 |
| ---- | --------------------------- | ----------------------------------------------------------------- | ---- |
| D-R1 | `users.role` 列             | ① 保留列、不再读取，新建账号仍写 `admin`；② 下一轮另立迁移删列    | ①    |
| D-R2 | MCP `memberAccess` 存储字段 | ① 读时忽略、不再写入，旧 json 里的值留着无害；② 启动时清洗旧 json | ①    |

## 执行前核实

- 区分三类"像角色判断"的代码，逐处登记：① 纯角色判断（删）；② 实为宿主机执行闸门（改为"owner 存在且 active"，保留）；③ 实为主工作区判断（`isAdminHome` → `isHome`，保留）。
- 无 owner 的工作区（`created_by` 为空）目前被拒绝宿主机执行，保持不变。
- 启动时按角色重写主工作区执行模式的逻辑：确认改为"唯一账号的主工作区"后，存量数据不会被再改一次（幂等）。

## 实现步骤（TDD）

1. **Red**：`authMiddleware` 之外不再有角色中间件；宿主机执行在 owner 停用时仍被拒；非主工作区 Agent 仍不能建脚本任务；MCP 系统服务对唯一账号可用、`memberAccess` 不再出现在响应里；`setupStatus` 对唯一账号返回。更新 `tests/thesis-11-drop-permissions.test.ts` 与 `tests/thesis-13-personal-docs.test.ts` 的钉死断言。
2. **Green**：按"执行前核实"的三类逐处改；`isAdminHome` 全仓改名 `isHome`（含 runner）。
3. 文档：`docs/ACL-MATRIX.md` 的 admin 角色层改写为"登录会话 + 宿主机执行闸门 + 数据归属 + IM 侧访问控制"；`CLAUDE.md` §8、`docs/API.md`、`README.md` 同步。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n -E "adminRoleMiddleware|hasHostExecutionPermission|isAdminHome|memberAccess" -- src container/agent-runner/src` 无结果（存储兼容读取处若保留 `memberAccess` 字面量，须有注释并在交付记录列出）。
3. **人工冒烟（用户）**：系统设置、运行状态页可用；新建宿主机工作区并对话；新建脚本定时任务并运行；MCP 系统服务在 Agent 里可用；首启引导（用新数据目录）能走完。

## 风险与回滚

- 本包触及宿主机执行安全边界。若 THESIS-19 未合入，禁止开工。
- 回滚：`git revert <提交号>`（多提交时回滚区间）。

## 交付记录

（待填）
