# THESIS-11 个人用户（二）：去掉权限体系（E2a）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 领取人 / 分支 | claude/thesis-11-drop-permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 类型          | 裁剪（权限体系，方案 E2 拆分后的 E2a）                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 依赖          | THESIS-10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 阻塞          | THESIS-12、THESIS-13（三者都改 `src/middleware/auth.ts`、`AuthGuard.tsx` 一带，串行）                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 可并行        | ✅ 01、04、07、15。⚠️ 03、09（前端权限门涉及的文件未逐一核实）；05（`src/routes/groups.ts`）。❌ 02、06、08（同改热点文件）；10（本包依赖它）；12、13（依赖本包）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                                                                                                                                                                                                               |
| 预计改动路径  | `src/permissions.ts`、`src/types.ts`、`src/middleware/auth.ts`、`src/routes/config.ts`、`src/routes/monitor.ts`、`src/routes/groups.ts`、`src/routes/pricing.ts`（若 THESIS-08 未做）、`src/routes/auth.ts`（用户响应字段）、`web/src/stores/auth.ts`、`web/src/components/auth/AuthGuard.tsx`、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/components/settings/SettingsNav.tsx` 及其他带权限门的前端文件（约 25 个）、`web/tests/e2e/mobile-chat-harness.tsx`、`docs/ACL-MATRIX.md`、`tests/**` |
| 需用户决策    | **是**：D-E1（做到哪一层，新增 ②a）、D-E7（权限中间件替换为什么，本次审核新增）                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 来源          | 方案 §8（E2、T2），审核更正 S4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 目标

去掉权限名、权限模板与按权限显隐的入口。唯一账号登录后能看到全部页面，包括系统配置与运行状态。`role` 列和 admin 语义保留，唯一账号恒为 admin。

## 为什么只做 E2a（审核更正 S4）

方案原来的 E2"去角色与权限"只统计了权限中间件和前端权限门（约 450 行）。核实后发现角色判断的规模大得多：后端有 86 处 `role === 'admin'` 或 `role !== 'admin'`，分布在 `src/index.ts`、`src/routes/groups.ts`、`src/routes/tasks.ts`、`src/ipc/task-ops.ts`、`src/ipc/task-dispatch.ts`、`src/container-runner.ts`、`src/routes/monitor.ts` 等文件；"管理员主工作区"相关标识有 69 处引用；主机执行、脚本任务、管理员纯宿主机模式都按角色判定。对唯一账号来说，角色判断恒为真，留着没有功能代价，这和方案不做 E3 的理由相同。所以拆成 E2a（本包）和 E2b（去角色，不建议，未立项）。

## 范围（锚点为 `d6e04aa`）

| 部分         | 内容                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限定义     | `src/permissions.ts`：五个权限名与四个权限模板 `PERMISSION_TEMPLATES`；`src/types.ts:660` 一带的权限联合类型                                                                                                                                                                                      |
| 中间件       | `src/middleware/auth.ts:151-170`：`requirePermission` 与派生的 `systemConfigMiddleware`、`usersManageMiddleware`、`inviteManageMiddleware`、`auditViewMiddleware`。挂载点：`src/routes/config.ts`（28 处引用）、`src/routes/monitor.ts`（5）、`src/routes/pricing.ts`（2，若 THESIS-08 已删则无） |
| 直接权限判断 | `manage_group_env`：`src/routes/groups.ts:522`、:2466-2518                                                                                                                                                                                                                                        |
| 接口字段     | 用户对象的 `permissions` 字段从接口响应与前端类型中移除；`users.permissions` 列留给 THESIS-14 按 D-F2 处理                                                                                                                                                                                        |
| 前端         | `stores/auth.ts:8-11` 的权限联合类型；`AuthGuard` 的 `requiredPermission`；`App.tsx` 的权限守卫（如 `/monitor` 要求 `manage_system_config`）；设置页与导航的 `canManage*`；`web/tests/e2e/mobile-chat-harness.tsx:21` 用户夹具的 `permissions` 字段                                               |
| 文档         | `docs/ACL-MATRIX.md` 的权限层（用户管理、邀请、审计、系统配置）；`CLAUDE.md` §3.2 `/monitor` 行的"需要 `manage_system_config`"与 §8 的"独立 Permission Middleware"（也可留给 THESIS-13 一并改写，立项时定）                                                                                       |

保留：`adminRoleMiddleware`（`src/middleware/auth.ts:161`，按角色判断，`src/routes/config.ts` 挂载 5 处）、所有 `role === 'admin'` 判断、`canExecuteOnHost`、`canAccessGroup` 等数据归属判断。

## 非目标

- 不去角色（E2b），不去数据归属（E3）。
- 不改表结构。
- 不动强制改密（THESIS-12）。

## 需用户决策（领取前拍板）

| #    | 问题                         | 选项                                                                                                 | 审核建议 |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| D-E1 | 做到哪一层                   | ① E1 单账号（本包不做）；②a E2a 去权限；②b E2b 再去角色；③ E3 再去数据归属                           | ②a       |
| D-E7 | 原权限中间件的挂载点换成什么 | ① 换成 `adminRoleMiddleware`（仍要求 admin 角色）；② 只留 `authMiddleware`（任何已登录账号都可访问） | ①        |

D-E7 的理由：D-E5 选 ① 时，库里的其他账号**仍然可以用原密码登录**（登录只检查 `status === 'active'`，`src/routes/auth.ts:284`）。选 ② 会让存量的普通成员账号拿到系统配置权限；选 ① 时行为与现在的"admin 才能改系统配置"一致。

## 执行前核实

- **V-E1**：权限中间件挂载点的全集，以及"普通成员得到 403"一类测试怎么处置（D-E7 选 ① 时多数应保持成立）。
- **V-E2**：前端约 25 个文件、约 90 处权限门里，哪些改为始终可见，哪些随页面已在 THESIS-10 删除。注意区分权限门（本包处理）和 `role === 'admin'` 判断（保留）。
- **V-D2**：前端联合类型里的权限名去掉后，是否还有其他消费者。

## 实现步骤（TDD）

1. **Red**：源码契约用例：后端不再出现 `requirePermission`、`PERMISSION_TEMPLATES` 与 `manage_group_env`；前端不再出现 `requiredPermission` 与 `canManage*`；唯一账号（admin）能访问原先按权限保护的全部接口。
2. **Green**：按范围表修改，按 D-E7 替换挂载点。
3. **测试同步**：`tests/helpers/route-test-user.ts` 的 `asSystemSettingsTestUser` 会注入权限 JSON，相关用例改为只按角色注入。
4. **前端清扫**：方案 §11.4 第 4 条（权限判断与 store 字段）。

## 验收条件

1. 唯一账号登录后能看到全部页面，包括系统配置与运行状态。
2. `make typecheck`、`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 非目标未被实现：角色判断、数据归属判断、表结构均无改动。

## 风险与回滚

- 涉及文件多（约 30 个源文件与数十个测试文件），按后端、前端拆成两到三个提交。
- **回滚**：`git revert <提交号>`。

## 交付记录

- **提交**：立项 `e805fdd`、Red `8b6a309`、后端 `b5edc8e`、前端 `d19b99c`、文档 `ad3a97f`、审查处置 `dfdd6ce`、交付（本提交）。
- **验证**：`npm run verify` 6/6 全绿（364 测试文件，3004 通过 / 23 跳过 / 0 失败，38.7s）；`node scripts/check-scope.mjs` 74 路径全部在声明范围内；`make typecheck`、`make build`、`npm run docs:check` 通过。23 skipped 为基线既有，本包未新增 skip。
- **实现范围**：删 `src/permissions.ts` 与权限类型/字段/helper；`requirePermission` 及 4 个派生中间件删除；20 处 `systemConfigMiddleware` 挂载（config 16、monitor 4）换 `adminRoleMiddleware`；`groups.ts` 删 `manage_group_env` 判断（owner/admin 归属保留）；前端删 `Permission`/`hasPermission`/`requiredPermission`/`canManage*`，`/monitor` 改 `requireAdmin`；`/api/auth/me` 不再返回 `permissions`；`db.ts`/`schemas.ts` 的权限 helper 与孤儿 schema 同步清理（不改表结构）。
- **偏差与登记**：
  - `src/db.ts`、`src/schemas.ts` 超出 issue 预计路径，但两者从 `src/permissions.ts` 取 helper，删该文件必须同步清理；`.gatescope.json` 已声明，表结构未动。
  - `groups.ts` 去掉 `manage_group_env` 后，非 admin 的 owner 可读写自己工作区的 env（owner 边界保留）；`toPublicContainerEnvForUser` 的角色 mask 已随删除，GET/PUT 对称按 owner 边界返回；新增两条路由回归用例。
  - 43 处测试夹具 `permissions: []` 为惰性字段，已随审查处置清理；`task.permissions` 未动。
  - 角色判断、数据归属判断、`src/db-schema/`、依赖与 `container/` 均未改；`users.permissions` / `invite_codes.permissions` 列保留给 THESIS-14。
- **后续建议（THESIS-16，本次不建 issue）**：个人版界面表面收口——个人资料页「管理员/普通成员」标签、MCP「成员访问/共享给成员」UI、「仅管理员/管理员纯宿主机模式/创建管理员」等文案；内部 role/归属保留，按方案 B 另立小包。
- **合并/部署前置（THESIS-10 遗留）**：D-E5 ②「用旧版界面禁用或删除其他 active 账号」仍未书面确认；D-E7 ① 下这些账号仍被 admin 角色拦住系统配置，但可登录并看到自己名下的工作区。代理不读写 `data/`。 **2026-11-25 结案**：本机只读核实只有 1 个账号（admin、active），D-E5 ② 无需处理；见 [issues4 README 第四节](../issues4/README.md#四部署前置与用户操作代理不能代办)。
- **人工冒烟（用户）**：唯一 admin 账号登录 → 设置页系统配置/运行状态全部可见可用；member 账号访问原权限接口 403；`GET /api/auth/me` 无 `permissions`；工作区 env owner 读写正常；登录/登出/改密/渠道账号页回归。
- **审查**：两轮独立审查均通过，详见 `docs/审查记录.md` THESIS-11 段。
