# THESIS-10 个人用户（一）：单账号收口（注册、邀请、用户管理、审计）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 领取人 / 分支 | claude/thesis-10-single-account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 类型          | 裁剪（账号体系，方案 E1，含 §7 全部内容）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 依赖          | 无。与 THESIS-02（`src/routes/auth.ts`、`src/routes/config.ts`）、THESIS-06 与 08（`App.tsx`、`SettingsPage.tsx`、`SettingsNav.tsx`、`src/web.ts`）有文件交集，按 README 波次串行                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 阻塞          | THESIS-11、12、13、14                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 可并行        | ✅ 01、03、07、09、15。⚠️ 04（`src/runtime-config.ts`）。❌ 02、05、06、08（同改热点文件）；11、12、13（依赖本包）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 预计改动路径  | `src/routes/auth.ts`、`src/routes/admin.ts`、`src/routes/config.ts`、`src/runtime-config.ts`（仅注册配置）、`src/web.ts`、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/pages/UsersPage.tsx`、`web/src/components/users/**`、`web/src/stores/users.ts`、`web/src/stores/auth.ts`、`web/src/pages/LoginPage.tsx`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/RegistrationSection.tsx`、`web/src/components/settings/SystemSettingsSection.tsx`（按 D-D2）、`web/src/utils/chat-route-preload.test.ts`、`CLAUDE.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`tests/**` |
| 需用户决策    | **是**：D-D2（两项登录限流设置挪到哪里）、D-E2（是否保留登录）、D-E5（存量的其他账号）。D-E4 已定 ②（停止审计写入）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 来源          | 方案 §8（E1、T1）与 §7（已并入），审核更正 m1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 目标

系统只有一个账号：首次启动时创建，之后不能注册、不能新增。设置页"管理后台"只保留"运行状态"。登录、登出、改密、个人资料、会话管理照常。

## 范围（锚点为 `d6e04aa`）

| 部分             | 内容                                                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册接口         | 删除 `GET /api/auth/register/status`（`src/routes/auth.ts:355`）、`POST /api/auth/register`（:371），以及 `registerUserWithInvite`、`registerUserWithoutInvite` 的导入（:33-34）                                                                                                                                      |
| 注册策略         | 删除 `GET`、`PUT /api/config/registration`（`src/routes/config.ts:1591`、:1605）与 `src/runtime-config.ts:2194-2252` 的 `registration.json` 读写                                                                                                                                                                      |
| 管理接口         | 删除 `src/routes/admin.ts`（1,192 行、12 个接口：用户增删改查、权限模板、邀请码、审计查询与导出）与挂载 `src/web.ts:225` 及其导入                                                                                                                                                                                     |
| 审计写入（D-E4） | 删除 `logAuthEvent` 的全部调用：`src/routes/auth.ts` 10 处、`src/routes/config.ts` 2 处（:1799 `system_settings_updated`、:2079 `host_integration_updated`）。`admin.ts` 的 16 处随文件删除                                                                                                                           |
| 前端整文件       | `pages/UsersPage.tsx`、`components/users/` 下 4 个文件、`stores/users.ts`、`settings/RegistrationSection.tsx`（合计约 1,490 行）                                                                                                                                                                                      |
| 前端入口         | `App.tsx` 的 `/users` 路由（:250 起）；`SettingsPage.tsx` 的 :23 导入、:82-86 的 `canManageUsers`、:109、:197、:247-254 注册策略页；`SettingsNav.tsx` 的 `managementItems` 只留"运行状态"；`LoginPage.tsx` 的注册页签（:17、:22、:28、:57、:122）；`stores/auth.ts` 的 `register` 动作（:57、:114-119）与注册状态类型 |
| D-D2             | 注册策略页里的 `SystemSettingsSection scope="security"`（`SettingsPage.tsx:251`，认证尝试上限、登录与注册限流时间）按 D-D2 迁移，并收敛 `scope` 联合类型（V-D1）                                                                                                                                                      |
| 测试夹具         | `tests/routes-system-settings-security.test.ts:556`、:582、:619 通过 `/api/admin/users/:id` 改角色，改为直接写库（已核实这是唯一以 `/api/admin` 为夹具的测试）；`web/src/utils/chat-route-preload.test.ts:15` 拿 `/register` 当样例路径，换成仍存在的路径                                                             |
| 文档             | `docs/API.md`（管理接口 10 行、注册 1 行、用户页 5 行）；`docs/ACL-MATRIX.md`（注册 2 行、用户管理相关行）；`CLAUDE.md` §3.2 路由表的 `/users` 行（审核补充）                                                                                                                                                         |

## 非目标

- 不去掉登录（除非 D-E2 改裁）。首启 `POST /api/auth/setup`（走 `createInitialAdminUser`，与注册无关，已核实）、登录、登出、个人资料、改密、会话管理、头像、登录限流原样保留。
- 不动权限体系与角色（THESIS-11）、强制改密（THESIS-12）、产品定位文档（THESIS-13）。
- 不动 IM 侧访问控制（机器人主人、白名单、响应对象、激活方式、IM 命令的主人约束）。
- 不改 `src/db.ts` 与表结构。本包之后 `invite_codes`、`auth_audit_log` 的读写函数和 `registerUserWithoutInvite` 成为孤儿导出，由 THESIS-14 统一删除。

## 需用户决策（领取前拍板）

| #    | 问题                         | 选项                                                                                                       | 方案或审核建议 |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| D-D2 | 两项登录限流设置去哪         | ① 挪到"执行与容量"页，分组改名为"执行、容量与安全"；② 删掉界面，保留后端设置与环境变量；③ 挪到"运行状态"页 | ①              |
| D-E2 | 是否保留登录                 | ① 保留单账号登录；② 完全去掉登录                                                                           | ①              |
| D-E5 | 存量数据里的其他账号及工作区 | ① 原样留在库里，唯一账号看不到它们；② 裁剪前在界面上删除这些账号；③ 迁移给唯一账号                         | ①              |

D-E5 选 ① 时要注意（审核补充）：方案写的是"唯一账号看不到它们"，但这些账号**自己仍然可以用原密码登录**（登录只检查 `status === 'active'`，`src/routes/auth.ts:284`），登录后看到的是它们自己名下的工作区。本包删掉用户管理界面后，就没有界面能再禁用它们。如果要阻止它们登录，只能选 ②，或者在本包之前用旧版界面把它们设为禁用。THESIS-11 的 D-E7 也与此相关。

D-E5 选 ② 时，用户要在本包**之前**用旧版界面处理（本包会删掉用户管理界面），并先核实 V-E6（删除账号是否连带删除其工作区与渠道账号）。存量情况代理不读，由用户确认。

关闭注册是对外接口的破坏性变更（`POST /api/auth/register` 从可用变为 404），按宪法第二节第 2 条须在立项时明确确认。

## 执行前核实

- **V-D5**：访问 `/login?tab=register` 落回登录页签。
- **V-E5**：设置页"管理员纯宿主机模式"的文案里"普通成员仍固定使用 Docker"在单账号下不再成立，本包或 THESIS-13 改写，立项时定。
- 对 `registerUserWith`、`RegisterStatus`、`useUsersStore`、`/api/admin`、`logAuthEvent`、`getRegistrationConfig` 做一次 `git grep`，范围包含 `tests/`、`web/`、`docs/`。

## 实现步骤（TDD）

1. **Red**：
   - 路由用例：`/api/auth/register`、`/api/auth/register/status`、`/api/config/registration` 与 `/api/admin` 的 12 个接口返回 404；
   - 源码契约用例：登录页没有注册入口；`App.tsx` 没有 `/users` 路由；设置导航"管理后台"只有运行状态；
   - 用例：登录、登出、改密之后 `auth_audit_log` 不新增记录；
   - 回归：首启创建账号、登录、登出、改密、个人资料、会话管理保持通过。
2. **Green**：按范围表修改。
3. **前端清扫**：方案 §11.4（`UserPlus`、`UserCog` 等图标导入，`manage_users` 等权限名的前端引用留给 THESIS-11）。

## 验收条件

1. 首次启动只有"创建账号"一步；之后登录页没有注册入口；访问 `/users` 落到工作台。
2. 设置页"管理后台"只有"运行状态"，运行状态页功能不变；两项登录限流设置按 D-D2 仍可配置。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；方案 §11.4 清扫检查项通过。
4. **人工冒烟（用户）**：首启创建账号 → 登出后重新登录 → 设置页"管理后台"只有"运行状态" → 改密后用新密码登录 → 渠道账号页正常。

## 风险与回滚

- **审计写入停掉后，登录、改密、系统设置与宿主机集成的变更都不再留痕。** 日后如果重新对外开放，需要恢复审计。
- **论文章节变化**："多用户认证与权限矩阵"一章需要改写（方案 §8.10），在 THESIS-13 落档。
- **回滚**：`git revert <提交号>`。

## 交付记录

（交付时填写）
