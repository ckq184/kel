# 任务立项：THESIS-10 个人用户（一）：单账号收口（注册、邀请、用户管理、审计）

> 立项日期：2026-11-24｜base：`44bab75`｜分支：`claude/thesis-10-single-account`
> 来源：[docs/issues2/THESIS-10-single-account.md](issues2/THESIS-10-single-account.md)（方案 §8 E1、§7）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **D-E2 = ① 保留单账号登录**：登录、登出、改密、个人资料、会话管理、头像、登录限流原样保留。
- **D-D2 = ② 删掉登录限流设置界面**：注册策略页随注册功能一起删除；两项登录限流设置不再出现在设置页。后端 `/api/config/system` 字段、默认值（5 次 / 15 分钟）与 `MAX_LOGIN_ATTEMPTS`、`LOGIN_LOCKOUT_MINUTES` 环境变量保留，需要时改环境变量并重启。`SystemSettingsSection` 只保留 `runtime` 分组。
- **D-E5 = ② 裁剪前用旧界面禁用/删除其他账号**：这是用户在本包合并/部署前执行的数据操作，不是代码改动。已核实 V-E6：`DELETE /api/admin/users/:id` 是软删除（`users.status='deleted'`、清会话、断 IM 渠道），不删除其工作区与渠道账号；IM 连接检查 `status === 'active'`，禁用/删除后重启不会重连。代理不读写 `data/`。
- **V-E5 = 本包改写**：「管理员纯宿主机模式」文案里「普通成员仍固定使用 Docker」在单账号下不再成立，随本包删除。THESIS-13 继续负责整体产品定位文档改写。
- **D-E4 = ② 已定**：停止 `logAuthEvent` 写入；`auth_audit_log` 表与写入函数由 THESIS-14 统一删除。
- **破坏性变更已确认**：`GET /api/auth/register/status`、`POST /api/auth/register`、`GET|PUT /api/config/registration`、`/api/admin/*` 全部 12 个接口由可用变为 404。按宪法第二节第 2 条在立项时明确确认。

## 1. 关键事实（开工前核实，main `44bab75`）

- **注册入口有两处**：`LoginPage.tsx` 的注册页签，以及 `App.tsx` 的 `/register` 路由 → `RegisterPage.tsx`（只做 `<Navigate to="/login?tab=register" />`）。issue 只列了前者；后者一并删除，否则留下无入口但可直达的死路由与死文件。
- **注册后端**：`src/routes/auth.ts` 的 `/register/status`、`/register` 及其 `RegisterSchema`、`registerUserWithInvite`、`registerUserWithoutInvite`、`getRegistrationConfig` 导入；`src/routes/config.ts` 的 `GET|PUT /registration`；`src/runtime-config.ts` 的 `registration.json` 读写；`src/schemas.ts` 的 `RegisterSchema`、`RegistrationConfigSchema` 随端点删除后无调用方，一并删除（超出 issue 预计路径，按范围声明登记）。
- **管理接口**：`src/routes/admin.ts`（12 个接口）整文件删除，`src/web.ts` 的 import 与 `app.route('/api/admin', adminRoutes)` 一并删除。`src/middleware/auth.ts` 的 `usersManageMiddleware`、`inviteManageMiddleware`、`auditViewMiddleware` 与权限定义保留给 THESIS-11。
- **审计写入**：`src/routes/auth.ts` 10 处、`src/routes/config.ts` 2 处（`system_settings_updated`、`host_integration_updated`）。删除后 `logAuthEvent` 函数保留为孤儿导出，由 THESIS-14 删除。
- **前端整文件**：`pages/UsersPage.tsx`、`components/users/` 4 个文件、`stores/users.ts`、`settings/RegistrationSection.tsx`；另加 `pages/RegisterPage.tsx`。
- **前端入口**：`App.tsx` 的 `/users`、`/register` 路由与懒加载；`SettingsPage.tsx` 的 `registration`/`users` 标签、`canManageUsers`、`RegistrationSection`、`UsersPage`、`SystemSettingsSection scope="security"`；`SettingsNav.tsx` 的 `managementItems` 只留「运行状态」；`LoginPage.tsx` 的注册页签、状态请求与表单；`stores/auth.ts` 的 `register` 动作。
- **范围收敛**：`SettingsTab` 联合类型去掉 `registration`、`users`；`SystemSettings` 类型与 `SystemSettingsSection` 去掉 `maxLoginAttempts`、`loginLockoutMinutes` 及 `security` 分组；`SystemSettingsSection` 不再需要 `scope` 参数（只剩 `runtime` 一个调用方）。
- **测试面**：
  - `tests/frontend-load-error-visibility.test.ts` 的 UsersPage 用例随文件删除。
  - `tests/routes-system-settings-security.test.ts:176` 的「admin host update logs names...」改为断言不再写审计记录。
  - 同文件末尾两个用例（提升成员为 admin、重新激活 admin）以 `/api/admin/users/:id` 为**测试主体**，不是夹具；管理接口删除后这两条产品路径不存在，用例随接口删除。宿主模式迁移/清理的覆盖仍由该文件其余用例保留。这是对 issue「改为直接写库」措辞的偏差，交付记录登记。
  - `web/src/utils/chat-route-preload.test.ts` 的 `/register` 样例路径换成仍存在的 `/setup`。
- **文档**：`docs/API.md` 的 `/api/admin` 模块行、注册 Public 两条、`/api/config/registration`、管理 10 条；`docs/ACL-MATRIX.md` 的注册 2 行与用户/邀请/审计相关行；`CLAUDE.md` §3.2 的 `/login`、`/register` 与 `/users` 行。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-10-single-account.test.ts`
   - 路由：`createAppForTest` 断言注册 2 条、`/api/config/registration` 2 条、`/api/admin/*` 12 条全部 404；
   - 审计：真实登录 → 登出 → 改密后 `queryAuthAuditLogs()` 总数不增加（初始为 0）；
   - 源码契约：登录页无注册入口；`App.tsx` 无 `/users`、`/register`；设置导航「管理后台」只有运行状态；`SettingsPage.tsx` 无注册策略页与 `scope="security"`；D-D2 ② 的限流字段不再出现在前端；V-E5 文案已改写；文件不存在的断言；文档不再列已删接口。
   - 先跑该用例确认因目标功能仍存在而失败。
2. **Green**：按范围表删除后端端点、管理路由、审计调用、前端文件与入口；收敛设置页与类型。
3. **协调测试**：删 UsersPage 用例；改写审计用例；删两个 admin 用户管理用例；替换 preload 样例路径。
4. **文档**：同步 `docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` §3.2；跑 `npm run docs:check`。
5. **清扫（方案 §11.4）**：图标 `UserPlus`/`UserCog`、`useUsersStore`、`RegistrationSection`、`/api/admin`、`/api/auth/register`、`/api/config/registration`、`maxLoginAttempts`/`loginLockoutMinutes` 前端引用全部无残留；`SettingsTab` 死类型删除。
6. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-10-single-account.md`、`docs/issues2/README.md`、`docs/thesis-10-single-account-plan.md`、`docs/审查记录.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md`、`src/routes/auth.ts`、`src/routes/config.ts`、`src/routes/admin.ts`、`src/runtime-config.ts`、`src/web.ts`、`src/schemas.ts`、`web/src/App.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/pages/RegisterPage.tsx`、`web/src/pages/UsersPage.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/components/settings/RegistrationSection.tsx`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/SystemSettingsSection.tsx`、`web/src/components/settings/types.ts`、`web/src/components/users/**`、`web/src/stores/users.ts`、`web/src/stores/auth.ts`、`web/src/utils/chat-route-preload.test.ts`、`tests/**`。

其中 `src/schemas.ts`、`web/src/pages/RegisterPage.tsx` 超出 issue 的预计改动路径：前者是注册端点删除后的死 schema，后者是 `/register` 死路由的落地页；按「扩宽范围只能改声明」登记。

## 4. 验收条件

1. 首次启动只有「创建账号」一步；之后登录页没有注册入口；`/login?tab=register` 落回登录页签；`/register`、`/users` 落回工作台（无路由兜底）。
2. 设置页「管理后台」只有「运行状态」，运行状态页功能不变；两项登录限流设置不再出现在界面，后端字段、默认值与环境变量保留。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；方案 §11.4 清扫检查项通过。
4. 登录、登出、改密、个人资料、会话管理、头像回归通过；登录/登出/改密/系统设置/宿主机集成都不再写 `auth_audit_log`。
5. 首启创建账号、登录、登出、改密、渠道账号页由用户人工冒烟。
6. D-E5 ② 的用户操作在合并/部署前完成：旧版界面「用户与访问」里禁用或删除其他 `active` 账号。

## 5. 非目标

- 不去掉登录（D-E2 ①）；不动权限体系与角色（THESIS-11）、强制改密（THESIS-12）、产品定位文档（THESIS-13）。
- 不动 `src/db.ts` 与表结构；`invite_codes`、`auth_audit_log` 的读写函数与 `registerUserWithoutInvite` 留作孤儿，由 THESIS-14 删除。
- 不动 IM 侧访问控制（机器人主人、白名单、响应对象、激活方式、IM 命令的主人约束）。
- 不读写 `data/`；D-E5 ② 的账号处理由用户执行。

## 6. 风险与回滚

- 审计写入停掉后，登录、改密、系统设置与宿主机集成的变更不再留痕；单账号产品里属预期，日后重新对外开放需恢复审计。
- 关闭注册与管理接口是破坏性 API 变更；旧客户端/书签访问会得到 404。
- 存量其他 `active` 账号若未在合并前禁用/删除，仍可登录并看到自己名下的工作区；用户管理界面删除后无界面可再禁用（D-E5 ② 的前置操作）。
- **回滚**：`git revert <提交号>`；`src/routes/admin.ts` 与前端文件随 revert 恢复。
