# 任务立项：THESIS-11 个人用户（二）：去掉权限体系（E2a）

> 立项日期：2026-11-25｜base：`e0ac865`｜分支：`claude/thesis-11-drop-permissions`
> 来源：[docs/issues2/THESIS-11-drop-permissions.md](issues2/THESIS-11-drop-permissions.md)（方案 §8 E2a、审核更正 S4）

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-E1 = ②a 只去权限**：删权限名、权限模板、`requirePermission` 及 4 个派生中间件、`manage_group_env` 判断、前端权限门；保留 `role` 列、admin 语义与数据归属判断。不去 E2b/E3。
- **D-E7 = ① 原权限中间件挂载点换成 `adminRoleMiddleware`**：20 处挂载（`src/routes/config.ts` 16、`src/routes/monitor.ts` 4）仍要求 admin 角色。唯一账号恒为 admin，行为不变；存量普通成员账号仍被拦住，与现状「admin 才能改系统配置」一致。
- **产品定位**：个人自托管、单账号、不考虑多人使用。本包删除用户可感知的权限体系；`role` 与数据归属作为内部不变量保留。答辩口径为「产品面个人化 + 内部防御性边界」，彻底去除角色/归属列入 E2b/E3 未来工作。
- **范围决策**：`CLAUDE.md` 的权限说明本包同步；产品定位整体改写留 THESIS-13。多用户隔离类测试保留（数据归属逻辑未动）。THESIS-16「个人版界面表面收口」（角色标签、成员共享 UI、管理员措辞）作为后续建议登记在交付记录，本次不建 issue、不动界面角色文案。
- **破坏性变更确认**：用户对象响应不再返回 `permissions` 字段；原先持有 `manage_system_config` 的普通成员账号将失去系统配置接口访问权（D-E7 ① 有意为之）。单账号下无用户可感知变化。

## 1. 关键事实（开工前核实，main `e0ac865`）

- **权限定义**：`src/permissions.ts` 五个权限名与 `PERMISSION_TEMPLATES`；`normalizePermissions`、`getDefaultPermissions`、`resolveTemplate`、`hasPermission`。`src/types.ts` 的 `Permission`、`PermissionTemplateKey`，以及 `AuthUser` / `User` / `UserPublic` / `UserSessionWithUser` / `InviteCode` 的 `permissions` 字段。
- **中间件**：`src/middleware/auth.ts` 的 `requirePermission` 与派生的 `systemConfigMiddleware`、`usersManageMiddleware`、`inviteManageMiddleware`、`auditViewMiddleware`；`adminRoleMiddleware` 保留。`systemConfigMiddleware` 20 处挂载（`config.ts` 16、`monitor.ts` 4）；`adminRoleMiddleware` 已有 5 处（均在 `config.ts`）。
- **直接权限判断**：`src/routes/groups.ts:522` 的辅助函数与 `:2478`、`:2518` 两处 `manage_group_env`。owner/admin 归属判断保留。
- **响应字段**：`src/routes/auth.ts:81` 与 `src/db.ts` 的 `toUserPublic` 都返回 `permissions`。
- **db / schema 依赖**：`src/db.ts` 从 `permissions.ts` 导入 `getDefaultPermissions`、`normalizePermissions`，用于 `mapUserRow`、`createUser`、`updateUserFields` 与邀请码孤儿函数；`src/schemas.ts` 导入 `ALL_PERMISSIONS` 定义孤儿 `AdminCreateUserSchema`、`AdminPatchUserSchema`、`InviteCreateSchema`。删 `permissions.ts` 必须同步改这两个文件，不改表结构。
- **前端**：`web/src/stores/auth.ts` 的 `Permission` 联合类型与 `hasPermission`；`AuthGuard` 的 `requiredPermission` / `requiredAnyPermissions`；`App.tsx` 的 `/monitor` 权限守卫；`SettingsPage` / `SettingsNav` 的 `canManageSystemConfig`；`AppearanceSection` / `SystemSettingsSection` / `MonitorPage` 的 `hasPermission`；`nav-items` 的 `requiredPermission` 与 `filterNavItems`；`BottomTabBar` / `UnifiedSidebar` 的 `filterNavItems`；`web/tests/e2e/mobile-chat-harness.tsx` 的 `permissions` 夹具。
- **测试**：`asSystemSettingsTestUser` 注入权限 JSON；`routes-system-settings-security.test.ts` 4 个 member + `manage_system_config` 用例；`system-settings-per-user-echo.test.ts` 3 个；`frontend-settings-information-architecture.test.ts` 断言 `requiredPermission`；`frontend-monitor-uncertain-release.test.ts` 断言 `canManageSystem` 轮询；`routes-messages-acl.test.ts` 注释提到 `requirePermission`。
- **已在 main 删除的部分**：`src/routes/pricing.ts` 随 THESIS-08 删除；`src/routes/admin.ts` 随 THESIS-10 删除。本包无这两处残留。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-11-drop-permissions.test.ts`
   - 路由：admin 登录后 `GET /api/config/system`、`GET /api/config/appearance`、`GET /api/status/channel-outbox/uncertain` 返回 200；member 登录后同接口返回 403；`GET /api/auth/me` 的用户对象不含 `permissions`。
   - 源码契约：`src/permissions.ts` 不存在；`src` 不再出现 `requirePermission`、`PERMISSION_TEMPLATES`、四个派生中间件、五个权限名与 `manage_group_env`；`src/types.ts` 无 `Permission` 联合类型；`src/db.ts` / `src/schemas.ts` 无旧权限 helper；`web/src` 无 `Permission`、`hasPermission`、`requiredPermission`、`canManage*`；`App.tsx` 的 `/monitor` 使用 `requireAdmin`。
   - 先跑该用例，确认源码契约与「`/api/auth/me` 无 permissions」断言失败。
2. **Green 后端**：删 `src/permissions.ts`；清 `src/types.ts` 的权限类型与字段；`middleware/auth.ts` 删 `requirePermission` 与 4 个派生、保留 `adminRoleMiddleware`；`config.ts` / `monitor.ts` 20 处挂载换 `adminRoleMiddleware`；`groups.ts` 删 `manage_group_env` 判断（保留 owner/admin）；`db.ts` / `schemas.ts` 清权限 helper 与孤儿 schema；`routes/auth.ts` 与 `db.ts` 的 `toUserPublic` 去 `permissions`。
3. **Green 前端**：删 `stores/auth.ts` 的 `Permission` / `hasPermission` / `user.permissions`；`AuthGuard` 的权限 props；`App.tsx` 的 `/monitor` 改 `requireAdmin`；`SettingsPage` / `SettingsNav` 改按 admin 角色显隐（`canAccessSystemSettings`，不再用 `canManage*`）；`AppearanceSection` / `SystemSettingsSection` / `MonitorPage` 去权限门；`nav-items` 去 `requiredPermission` / `filterNavItems`，`BottomTabBar` / `UnifiedSidebar` 直接使用导航项；e2e 夹具去 `permissions`。
4. **测试同步**：`asSystemSettingsTestUser` 改为只按角色注入；两个系统设置测试的 member + permission 用例改 admin；`frontend-settings-information-architecture` 与 `frontend-monitor-uncertain-release` 的断言改角色/无权限门；`routes-messages-acl` 注释更新。
5. **文档**：`docs/ACL-MATRIX.md` 的权限层改为 admin 角色与数据归属；`CLAUDE.md` §3.2 `/monitor` 行与 §8；`docs/API.md` 的权限表述；`npm run docs:check`。
6. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-11-drop-permissions.md`、`docs/issues2/README.md`、`docs/thesis-11-drop-permissions-plan.md`、`docs/审查记录.md`、`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`src/permissions.ts`、`src/types.ts`、`src/middleware/auth.ts`、`src/db.ts`、`src/schemas.ts`、`src/routes/config.ts`、`src/routes/monitor.ts`、`src/routes/groups.ts`、`src/routes/auth.ts`、`web/src/stores/auth.ts`、`web/src/components/auth/AuthGuard.tsx`、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/pages/MonitorPage.tsx`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/SystemSettingsSection.tsx`、`web/src/components/settings/AppearanceSection.tsx`、`web/src/components/layout/nav-items.ts`、`web/src/components/layout/BottomTabBar.tsx`、`web/src/components/layout/UnifiedSidebar.tsx`、`web/tests/e2e/mobile-chat-harness.tsx`、`tests/**`。

其中 `src/db.ts`、`src/schemas.ts` 超出 issue 的预计改动路径：两者仍从 `src/permissions.ts` 取 helper，删该文件必须同步清理；`docs/API.md` 是 README 要求的随包文档行；`docs/审查记录.md` 是两轮审查落档。均按「扩宽范围只能改声明」登记。

## 4. 验收条件

1. 唯一账号（admin）登录后能看到全部页面，包括系统配置与运行状态；普通成员账号访问原权限接口返回 403。
2. `GET /api/auth/me` 的用户对象不含 `permissions`；前端类型无 `Permission`、`hasPermission`、`requiredPermission`、`canManage*`。
3. 后端无 `requirePermission`、`PERMISSION_TEMPLATES`、`manage_group_env`、四个派生中间件与五个权限名；20 处挂载均为 `adminRoleMiddleware`。
4. `role` 判断、数据归属判断、表结构均无改动；`users.permissions` 列保留给 THESIS-14。
5. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；`npm run docs:check` 通过。
6. 多用户隔离类测试保留且通过；权限夹具改为只按角色注入。

## 5. 非目标

- 不去角色（E2b），不去数据归属（E3），不改表结构。
- 不动强制改密（THESIS-12）、产品定位文档整体改写（THESIS-13）、界面角色标签与成员共享 UI（THESIS-16，本次只在交付记录登记建议）。
- 不动 IM 侧访问控制、`task.permissions`（任务操作权限）与宿主执行权限。
- 不读写 `data/`；D-E5 ② 的存量账号处理仍由用户执行。

## 6. 风险与回滚

- 旧客户端或缓存可能仍期待 `permissions` 字段；Web 前端同包更新，单账号下无实际影响。
- 原先持有 `manage_system_config` 的普通成员账号失去系统配置访问权（D-E7 ① 有意为之）。D-E5 ② 的存量账号清理仍未书面确认，需在合并/部署前完成。
- `groups.ts` 的 `manage_group_env` 判断移除后，非 admin owner 可读写自己工作区的 env（owner 边界保留）。
- `db.ts` 的邀请码/注册孤儿函数同步简化，无调用方；`invite_codes` / `auth_audit_log` 表与权限列由 THESIS-14 删除。
- **回滚**：`git revert <提交号>`；`src/permissions.ts` 与前端权限门随 revert 恢复。
