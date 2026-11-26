# THESIS-20 角色只留管理员（后端）实施计划

> 来源：[THESIS-20](issues4/THESIS-20-drop-role-backend.md)、[personal-slim 方案 §4](issues4/task-personal-slim-plan.md)。方案定范围与裁决，本文件定怎么落地。
> 依赖：THESIS-19 已完成（交付提交 `e82843d`，verify 六步全绿）。main 尚未合入 19，本分支先以临时合并 `ef7cb4d` 为基线开工；19 正式合入 main 后再同步。
> 基线：`4fd7096`（main `a0c29c2` 含 THESIS-19 正式合入 + 实现 `de6f7fa` 的同步合并）。
> 版本：v1（2026-11-26）。

## 1. 目标与完成条件

系统里只有一个角色：管理员（`role` 恒为 `admin`）。`member` 从类型、建表默认值、代码分支与测试夹具里消失；所有“是不是管理员”的判断删除，代码直接走管理员分支。非主工作区（Home Workspace）的 Agent 仍不能创建脚本任务或宿主机任务——这是防提示词注入的能力边界，不是角色。

完成条件（与 issue 验收一致）：

1. `UserRole` 只剩 `'admin'`；建表默认值 `'admin'`；读取历史 `member` 行按 `admin` 解释。
2. 后端不再出现 `adminRoleMiddleware`、`hasHostExecutionPermission`、`isAdminHome`、`'member'`（否定断言除外）。
3. 系统配置与运行状态接口只需登录；宿主机执行不再查角色，但仍拒绝不存在/非 active 的 owner。
4. 非主工作区 Agent 仍不能建脚本任务；主工作区 Skills 对唯一账号可见；`setupStatus` 对唯一账号返回。
5. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
6. 文档同步：`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md`。

## 2. 执行前核实：三类代码逐处登记

按 issue 要求把“像角色判断”的代码分三类。① 纯角色判断：删判断、保留管理员分支；② 宿主机执行闸门：不再看角色，保留 owner 存在与 active 状态检查；③ 主工作区判断：`isAdminHome` 收敛为 `isHome`。

### 2.1 ① 纯角色判断（删，保留管理员分支）

| 位置                                                                           | 现状                                                                    | 处理                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/types.ts` `UserRole`                                                      | `'admin' \| 'member'`                                                   | 只留 `'admin'`；`AuthUser`/`User`/`UserPublic` 等仍保留 `role` 字段         |
| `src/db-schema/auth-tables.ts` `users.role` 默认值                             | `DEFAULT 'member'`                                                      | 改 `DEFAULT 'admin'`（列保留；存量库不重建）                                |
| `src/db.ts` `parseUserRole`                                                    | `value === 'admin' ? 'admin' : 'member'`                                | 恒返回 `'admin'`（历史行按管理员解释），或内联删除                          |
| `src/db.ts` `ensureUserHomeGroup(userId, role, username)`                      | 按 role 决定 `web:main` / 容器或宿主机                                  | 去掉 role 参数；Home 恒宿主机、首个账号沿用 `web:main`                      |
| `src/middleware/auth.ts` `adminRoleMiddleware`                                 | `role !== 'admin'` 返回 403                                             | 删除导出；`src/routes/config.ts` 21 处、`monitor.ts` 4 处挂载删除           |
| `src/web-context.ts` `hasHostExecutionPermission`                              | `role === 'admin'`                                                      | 删除；调用方删除该判断（保留工作区归属与存在性检查）                        |
| `src/web-context.ts` `canAccessGroup/canModifyGroup/canDeleteGroup`            | 形参 `{ id, role }` 中 role 未被使用                                    | 形参收为 `{ id }`；全仓调用点同步                                           |
| `src/task-acl.ts` `TaskAclActor/TaskAclDeps`                                   | 携带 role，但判定不使用                                                 | 去掉 role 字段/参数                                                         |
| `src/routes/config.ts` `external-resources/rule`                               | 中间件 + 二次 `role !== 'admin'`                                        | 删除中间件与判断                                                            |
| `src/routes/monitor.ts` `/status`                                              | `isAdmin` 决定是否过滤群组                                              | 恒返回全部群组状态                                                          |
| `src/routes/groups.ts`                                                         | 列表 `admin_host_only_mode`、创建/更新 host 模式、env、删消息等角色分支 | 逐个走管理员分支；`adminHostOnlyMode` 设定逻辑保留                          |
| `src/routes/tasks.ts`                                                          | `canViewTask`、script/host 任务、列表的 admin 门                        | 删除角色门；保留工作区归属与 `isHome` 能力边界（见 2.3）                    |
| `src/routes/files.ts`、`src/routes/browse.ts`                                  | Host 工作区/本地目录的 admin 门                                         | 删除角色门；`purpose=mount` 保留 active 账号检查                            |
| `src/routes/skills.ts`                                                         | `discoverSkills/getSkillDetail` 按 `userRole` 决定宿主机 Skills         | 去掉 role 参数，宿主机 Skills 恒定合并                                      |
| `src/routes/auth.ts`                                                           | `setupStatus` 仅 admin 返回                                             | 恒返回；`ensureUserHomeGroup` 去掉 role 实参                                |
| `src/routes/agent-profiles.ts`、`src/agent-builder.ts`                         | `isUnauthorizedHostSkills` / host skills 的 admin 门                    | Host Claude 上下文与 Host Skills 不再按角色拒绝（单账号即可用）             |
| `src/agent-profile-policy.ts`                                                  | `isUnauthorizedHostClaudeContext/isUnauthorizedHostSkills`              | 删除两个判断与调用                                                          |
| `src/agent-profile-runtime.ts`                                                 | `canUseHostResources = owner.role==='admin' && active`                  | 改为 `owner.status === 'active'`                                            |
| `src/agent-capability-preview.ts`                                              | `ownerRole?: 'admin' \| 'member'`                                       | 类型改为 `UserRole`（`allowAdminOnlySystemMcp` 归 THESIS-37，本次不动语义） |
| `src/memory-service.ts`、`src/routes/memory.ts`、`src/ipc/memory-owner-ops.ts` | `WorkspaceMemoryActor.role` 未被使用                                    | 去掉 role 字段与构造参数                                                    |
| `src/web.ts`                                                                   | `safeBroadcast(adminOnly)`、WS 客户端 `role`、`canAccessGroup` 实参     | `adminOnly` 无调用方传 true，删除该参数与 session role 过滤；实参收敛       |
| `src/container-image-failure.ts`、`src/provider-failure.ts`、`src/index.ts`    | “联系管理员…”                                                           | 改为直接说明处理办法（拉取镜像 / 切换模型 / 核对附件等）                    |
| `src/routes/workspaces.ts`、`src/routes/workspace-config.ts`                   | `hasHostExecutionPermission`、role 实参                                 | 删除角色门 / 收敛实参                                                       |

**明确不动（归其他包）**：MCP 角色与可见性（`memberAccess`、仅管理员系统 MCP：`src/routes/mcp-servers.ts`、`agent-builder.ts` 的 `allowAdminOnlySystemMcp`、`container-runner.ts` 的 `ownerCanUseAdminOnlySystemMcp`、`agent-capability-preview.ts` 的 system MCP 过滤）归 THESIS-37；数据归属判定归 THESIS-34；IM 配置与渠道账号归 THESIS-22。

### 2.2 ② 宿主机执行闸门（去角色，留存在性与 active）

| 位置                                                 | 处理                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `src/host-execution-policy.ts` `canExecuteOnHost`    | 改为 `!!owner && owner.status === 'active'`（不再看 role）           |
| `src/index.ts` `isAdminHostOnlyOwner`                | 保留设置判断；owner 解析失败返回 false                               |
| `src/index.ts` 启动时 Home 执行模式重写              | Home 恒 `host`；删除 `owner.role` 分支                               |
| `src/index.ts` 新建工作区模式                        | `adminHostOnlyMode` 或 Docker 不可用时 `host`；删除 role 条件        |
| `src/db.ts` `forceActiveAdminRuntimesToHost`         | SQL 去掉 `u.role = 'admin'`，只保留 `u.status = 'active'`            |
| `src/routes/config.ts` Host 集成切换                 | `activeAdminFolders` 改为 active owner 的 folders，去掉 role 过滤    |
| `src/routes/groups.ts` 创建/更新 host 模式与额外挂载 | 删除角色门；保留 `adminHostOnlyMode`、容器模式与挂载路径校验         |
| `src/routes/tasks.ts` script/host 任务               | 删除 role 门；工作区归属与 `isHome` 能力边界仍由 IPC/runner 执行     |
| `src/routes/browse.ts`、`src/routes/files.ts`        | 本地目录/Host 工作区操作删除角色门；`purpose=mount` 保留 active 检查 |
| `src/container-runner.ts` 额外挂载                   | `canExecuteOnHost(currentOwner)` 保留（已去角色）                    |
| `src/task-scheduler.ts`、`src/index.ts` 执行前复查   | `canExecuteOnHost` 保留（已去角色）                                  |

**保持不变**：无 owner 的工作区仍拒绝宿主机执行（THESIS-34 再统一处理）；`adminHostOnlyMode` / `ADMIN_HOST_ONLY_MODE` 键名不变。

### 2.3 ③ 主工作区判断（`isAdminHome` → `isHome`）

| 位置                                                                   | 处理                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/index.ts` `runAgent` / `runGroupTask` 计算                        | `isHome = !!group.is_home`，删除 `isAdminHome`                     |
| `src/index.ts` `ContainerInput` 组装                                   | `isMain`/`isHome` 同取 `isHome`，删除 `isAdminHome` 字段           |
| `src/container-runner.ts` `ContainerInput`、`buildVolumeMounts`        | 删除 `isAdminHome` 字段/参数，全部改用 `isHome`                    |
| `src/container-runner.ts` `writeTasksSnapshot/writeGroupsSnapshot`     | 参数 `isAdminHome` 改名 `isHome`（Home 看全部，其他看自身）        |
| `src/task-scheduler.ts` 任务快照                                       | 同上                                                               |
| `src/ipc/file-delivery.ts`、`image-delivery.ts`、`message-delivery.ts` | 字段/参数 `isAdminHome` 改 `isHome`                                |
| `src/ipc/task-dispatch.ts`、`task-ops.ts`、`skill-registry-ops.ts`     | IPC 字段/参数改 `isHome`；脚本任务与跨组能力用 `isHome` 判定       |
| `src/ipc/watcher.ts`                                                   | `isAdminHome` 计算改为 `isHome = !!sourceGroupEntry?.is_home`      |
| `src/cross-group-acl.ts`                                               | `canSendCrossGroupMessage` 去掉 `isAdminHome` 参数，Home 直接放行  |
| `container/agent-runner/src/types.ts` `ContainerInput`                 | 删除 `isAdminHome`；`isHome` 为唯一 Home 标记（`isMain` 保留兼容） |
| `container/agent-runner/src/pi-index.ts`                               | `McpContext` 只填 `isHome: input.isHome ?? input.isMain ?? false`  |
| `container/agent-runner/src/mcp-tools.ts`                              | 删除 `McpContext.isAdminHome`；跨组/脚本判定改用 `isHome`          |

语义不变：Home Workspace 的 Agent 可跨组、可建脚本任务；非 Home 工作区仍被拒绝。单账号下 Home owner 恒为管理员。

## 3. 测试策略（TDD）

1. **Red 契约**：新增 `tests/thesis-20-drop-role-backend.test.ts`，在实现前失败：
   - `src/`、`container/agent-runner/src/` 中 `'member'`、`adminRoleMiddleware`、`hasHostExecutionPermission`、`isAdminHome` 零出现（仅允许否定断言/历史迁移 SQL 白名单）；
   - `UserRole` 只含 `'admin'`；建表默认值为 `'admin'`；
   - 两个账号（均为 admin）互相不能访问对方工作区（归属边界未回退）；
   - 非 Home 工作区仍不能建脚本任务（源码/行为契约）。
2. **夹具**：`tests/helpers/route-test-user.ts` 去掉 role 参数（或固定 `'admin'`）；各测试的 `role: 'member'` 改 `'admin'` 或删除字段。
3. **按行为改写的用例**：
   - `tests/thesis-11-drop-permissions.test.ts`：删除 member 403 用例与挂载数量钉死；改为“登录账号可访问”和“源码无 adminRoleMiddleware”。
   - 原先“member 被拒”的 admin 门用例（browse host mount、system settings 等）改为“唯一账号可用”；若原用例同时覆盖归属隔离，保留归属部分。
   - 以 member 作为“另一个账号”验证归属隔离的用例（`routes-*-acl`、`user-home-isolation` 等）保留两账号结构，role 改 admin，断言归属隔离不变。
4. **契约测试**：`tests/thesis-13-personal-docs.test.ts` 等钉死文案/符号的断言按新文档更新；`frontend-reachability` / `api-route-caller-contract` 若受路由挂载变化影响，随实现收紧。
5. **runner 测试**：`container/agent-runner` 相关测试的 `isAdminHome` 改 `isHome`，验证脚本任务门仍拒绝非 Home。

## 4. 任务拆解

| #   | 任务                | 主要文件                                                                                                                                                                               | 独立验收                                                                    |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| T1  | 立项                | 本文件、`.gatescope.json`                                                                                                                                                              | base 为同步 main 后的 `4fd7096`；check-scope 通过                           |
| T2  | Red 契约            | 新契约测试、`tests/helpers/route-test-user.ts`                                                                                                                                         | 新契约在 base 上失败，失败原因定位到角色残留                                |
| T3  | 类型与存储          | `src/types.ts`、`src/db-schema/auth-tables.ts`、`src/db.ts`、`src/reset-admin.ts`                                                                                                      | `UserRole` 只剩 admin；默认值与历史行解释正确                               |
| T4  | 中间件与纯角色判断  | `src/middleware/auth.ts`、`src/web-context.ts`、`src/routes/{config,monitor,groups,tasks,files,browse,skills,auth,agents,agent-profiles,workspaces,workspace-config}.ts`、`src/web.ts` | `adminRoleMiddleware`/`hasHostExecutionPermission` 零出现；路由行为用例通过 |
| T5  | 执行闸门与主工作区  | `src/host-execution-policy.ts`、`src/index.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`、`src/ipc/**`、`src/cross-group-acl.ts`、`container/agent-runner/src/**`            | `isAdminHome` 零出现；非 Home 脚本任务仍拒绝                                |
| T6  | 档案、Skills 与提示 | `src/agent-profile-*.ts`、`src/agent-builder.ts`、`src/agent-capability-preview.ts`、`src/memory-service.ts`、`src/container-image-failure.ts`、`src/provider-failure.ts`              | Host 资源对唯一账号可用；提示语可直接执行                                   |
| T7  | 测试全量收敛        | `tests/**`                                                                                                                                                                             | 全量 vitest 通过；无 `'member'` 残留（否定断言除外）                        |
| T8  | 文档                | `docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md`、`docs/issues4/*`、`docs/审查记录.md`                                                                                    | `npm run docs:check` 通过；文档不再描述 admin/member 双层                   |
| T9  | 门禁、审查与交付    | 全范围                                                                                                                                                                                 | verify 六步 + check-scope；两轮独立审查；三处状态同步                       |

回滚点：base `4fd7096`；实现提交 `de6f7fa` 可单独 `git revert`。

## 5. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、本文件、`docs/issues4/**`、`docs/审查记录.md`、`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md`、`src/types.ts`、`src/db.ts`、`src/db-schema/auth-tables.ts`、`src/reset-admin.ts`、`src/middleware/auth.ts`、`src/web-context.ts`、`src/web.ts`、`src/host-execution-policy.ts`、`src/task-acl.ts`、`src/cross-group-acl.ts`、`src/index.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`、`src/ipc/**`、`src/agent-profile-policy.ts`、`src/agent-profile-runtime.ts`、`src/agent-builder.ts`、`src/agent-capability-preview.ts`、`src/memory-service.ts`、`src/container-image-failure.ts`、`src/provider-failure.ts`、`src/routes/**`、`container/agent-runner/src/**`、`tests/**`。

与 issue 预计路径的差异：

- 增列 `src/cross-group-acl.ts`（`isAdminHome` 参数必须改名）；
- 增列 `src/agent-builder.ts`、`src/memory-service.ts`（同样是角色判断/Host 资源门）；
- 增列 `src/script-task-policy.ts`（脚本任务提示语“管理员宿主机工作区”改为 Home 工作区）；
- `src/routes/mcp-servers.ts` 与 MCP 可见性代码**不改**（THESIS-37），但因 `src/routes/**` 是 glob，实际 diff 不含该文件；
- 前端 `web/src/**` 不改（THESIS-21）。

## 6. 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n -E "adminRoleMiddleware|hasHostExecutionPermission|isAdminHome" -- src container/agent-runner/src tests` 零命中；`git grep -n "'member'"` 仅剩否定断言/历史迁移白名单（若有，逐条登记理由）。
3. `UserRole` 只含 `'admin'`；`users.role` 建表默认值 `'admin'`。
4. 两个 admin 账号的归属隔离用例通过；非 Home 工作区脚本任务拒绝用例通过。
5. `GET /api/config/system`、`GET /api/config/appearance`、`GET /api/status/channel-outbox/uncertain` 对唯一登录账号返回 200。
6. `GET /api/auth/me` 返回 `setupStatus`；能力页可见宿主机 Skills。
7. 人工冒烟（用户）：系统设置、运行状态、新建宿主机工作区对话、新建脚本定时任务、能力页 Skills、首启引导。

## 7. 风险与回滚

- 角色列与历史 `member` 行保留；读取恒为 `admin`，不写数据迁移。
- Host 执行闸门去掉角色后，仍靠 owner 存在 + active + 工作区/归属检查防越权；无 owner 工作区仍拒绝。
- `isAdminHome` 与 `isHome` 合并会改变 runner IPC 字段名；host 与 runner 同仓同版本，无跨版本兼容需求。
- MCP 可见性仍按现有 admin 语义保留，待 THESIS-37 统一删除。
- 回滚：`git revert` 任务提交区间。

## 8. 执行偏差（实现后补记）

1. **MCP 可见性未动**：`src/routes/mcp-servers.ts`、`agent-builder.ts` / `container-runner.ts` / `routes/agent-profiles.ts` 的 `allowAdminOnlySystemMcp`、`agent-capability-preview.ts` 的 `ownerRole`（类型收为 `'admin'`）保留，归 THESIS-37 统一删除。
2. **宿主机额外挂载保留 active 检查**：角色门删除后，`POST /api/groups` 的 `additional_mounts` 用新错误码 `HOST_MOUNT_ACCOUNT_INACTIVE` 拒绝非 active 账号；不再有 `HOST_MOUNT_ADMIN_REQUIRED`。
3. **工作区治理字段不再按角色裁剪**：`src/routes/workspaces.ts` 的 `owner_user_id`、`execution_mode`、运行时会话与挂载明细在通过 `canAccessGroup` 后恒返回；单账号下与先前 admin 视角等价。
4. **env 与消息删除走管理员分支**：`GET|PUT /api/groups/:jid/env` 去掉 admin bypass、保留工作区访问 + owner-only；删除消息去掉“非 admin 只能删自己的”限制（可访问群组内均可删）。
5. **Home 能力边界**：`isAdminHome` 全仓删除，`isHome` 成为唯一标记；`isMain` 兼容字段保留并取 `isHome` 值。非 Home 工作区仍由 IPC/runner 拒绝脚本任务与跨组投递。
6. **签名变更**：`ensureUserHomeGroup(userId, username?)`；`canExecuteOnHost` 只接收 `{ status }`；`canAccessGroup/canModifyGroup/canDeleteGroup` 只接收 `{ id }`；`canSendCrossGroupMessage(isHome, ...)`。
7. **测试夹具**：去掉 role 参数（`asRouteTestUser(userId, status?)`、`asSystemSettingsTestUser()` 等）。保留 `'member'` 的测试分三类白名单：
   - 历史 schema fixture（`channel-mounts-db`、`db-upgrade-safety`、`schema-v46-migration`、`schema-v69-agent-effort`）模拟旧库列默认值与旧行；
   - MCP 可见性契约（`mcp-runtime-secret-boundary`、`routes-mcp-server-isolation`、`routes-mcp-server-secrets`、`routes-agent-profiles` 的 `x-test-role` mock）待 THESIS-37 删除；
   - 前端角色契约（`frontend-agent-product-contract`、`agent-profiles-page-dom`）待 THESIS-21 删除。
   - `tests/thesis-20-drop-role-backend.test.ts` 的历史行回读用例（插入旧角色值、断言读回 admin）。
8. **提示语**：容器镜像、供应商失败与中断提示不再让用户“联系管理员”，改为直接给出可执行操作。
9. **任务权限响应**：`permissions.is_admin` 字段随角色判断删除；`web/src` 无消费方，API 文档未记录该字段。
10. **遗留迁移的 SQL 角色过滤**：`migrateSystemIMToPerUser` 仍用 `listUsers({ role: 'admin' })`，仅影响“旧库只有非 admin 行”的边界场景（`parseUserRole` 运行期读作 admin）；归 THESIS-22 统一处理。
11. **host-only 迁移范围扩大**：`forceActiveAdminRuntimesToHost` 现在迁移所有 active owner 的工作区与任务；对遗留多账号库是单向执行边界变化，升级说明需注明（单账号安装无差异）。
12. **源码扫描契约无白名单机制**：`tests/thesis-20-drop-role-backend.test.ts` 禁止 `src/`/runner 出现旧角色字面量；未来确需引用旧值的历史迁移只能显式改契约，当前实现下无例外。
