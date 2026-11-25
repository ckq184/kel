# 任务立项：THESIS-12 个人用户（三）：去掉强制改密

> 立项日期：2026-11-25｜base：`1454e51`｜分支：`claude/thesis-12-drop-forced-password-change`
> 来源：[docs/issues2/THESIS-12-drop-forced-password-change.md](issues2/THESIS-12-drop-forced-password-change.md)（方案 §8 D-E3、T3）

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-E3 = ① 去掉**：删除 `must_change_password` 的 HTTP/WS 闸门、API 响应字段、前端跳转与拦截、403 处理与导航禁用；普通改密（设置页「安全与设备」）原样保留。
- **存量数据可接受**：若旧库仍有 `must_change_password = 1` 的账号，去掉闸门后该账号可直接使用，不再被强制改密。单账号自托管场景用户已确认可接受；改密仍可在设置页主动做。
- **列本身保留**：`users.must_change_password` 的建表与迁移（`src/db-schema/`）、`User` / `UserSessionWithUser` 两个 DB 行类型、`src/db.ts` 的映射与写入辅助均不动，由 THESIS-14 按 D-F2 统一处理列。
- **附加范围**（issue 的「预计改动路径」未列，按「扩宽范围只能改声明」登记）：`src/web.ts` 两处 WebSocket 闸门、`web/src/components/settings/SettingsNav.tsx` 导航禁用、`web/src/pages/LoginPage.tsx` 登录后强制跳转、`web/src/api/client.ts` 的 403 跳转、`web/tests/e2e/mobile-chat-harness.tsx` 与 `tests/message-bubble-duration-only.test.tsx` 的 `UserPublic` 夹具字段。issue 正文按引用数（后端约 34、前端约 21）已涵盖这些位置，只是路径清单未逐一列出。

## 1. 关键事实（开工前核实，main `1454e51`）

- **已无真值写入**：全仓不存在 `must_change_password: true` 的写入；仅剩写入点均为 `false`——首启建号 `src/routes/auth.ts:163`、改密后清零 `:438`、命令行重置 `src/reset-admin.ts:32`、`:48`。唯一会置真的「管理员给他人重置密码」路径已随 THESIS-10 删除。
- **HTTP 闸门**：`src/middleware/auth.ts:121-134` 的 `canBypassForcedChange` 与 403 `PASSWORD_CHANGE_REQUIRED`；`AuthUser` 在 `:107` 注入该字段。
- **WS 闸门**：`src/web.ts:1119`（upgrade 拒绝）与 `:1277`（消息帧关闭连接），含两段解释性注释。
- **API 响应**：`src/routes/auth.ts:74-90` 的 `toUserPublic` 返回该字段；登录、`/me`、改密、资料更新等响应全部经它。
- **类型边界**：`src/types.ts:654`（`AuthUser`）与 `:690`（`UserPublic`）删字段；`:664`（`User`）与 `:718`（`UserSessionWithUser`）保留——列仍在，DB 层继续映射。
- **前端入口**：`AuthGuard.tsx:80-83` 强制跳 `/settings`；`LoginPage.tsx:43-44` 登录成功后按字段跳 `/settings`；`api/client.ts:57-62` 收到 `PASSWORD_CHANGE_REQUIRED` 跳 `/settings`；`SettingsPage.tsx:67-68、81、96、136、163、185` 强制安全标签、锁定系统设置、旧地址拦截与提示条；`SettingsNav.tsx:88、98、116、154-156、163` 禁用除安全外的全部导航；`stores/auth.ts:11` 的 `UserPublic` 字段。
- **测试夹具**：`web/tests/e2e/mobile-chat-harness.tsx:21` 与 `tests/message-bubble-duration-only.test.tsx:37` 用 `UserPublic` 类型携带该字段，删类型字段后必须同步删除。其余 `tests/**` 的 `must_change_password: false` 是 `createUser` / DB 行夹具，保留。
- **文档**：`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` 均未描述该机制，无随包文档行需要同步。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-12-drop-forced-password-change.test.ts`
   - 路由：创建 `must_change_password: true` 的 admin 用户（DB 层字段仍在）→ 登录成功且响应 `user` 不含该字段；`GET /api/auth/me` 不含该字段；带 cookie 请求 `GET /api/config/system` 返回 200（当前返回 403 `PASSWORD_CHANGE_REQUIRED`）。
   - 回归：`PUT /api/auth/password` 用当前密码改新密码成功，随后用新密码登录成功。
   - 源码契约：`src/middleware/auth.ts`、`src/web.ts`、`src/routes/auth.ts`、`src/reset-admin.ts` 不含 `must_change_password` / `PASSWORD_CHANGE_REQUIRED`；`src/types.ts` 的 `AuthUser` 与 `UserPublic` 接口块不含该字段；`web/src/components/auth/AuthGuard.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/api/client.ts`、`web/src/pages/SettingsPage.tsx`、`web/src/components/settings/SettingsNav.tsx`、`web/src/stores/auth.ts` 不含 `must_change_password` / `mustChangePassword`；`src` 与 `web/src` 全树无 `PASSWORD_CHANGE_REQUIRED`。
   - 先跑该用例，确认因目标功能仍存在而失败。
2. **Green 后端**：删 HTTP 闸门与 `AuthUser` 注入字段；删两处 WS 闸门与注释；`toUserPublic` 去字段；首启建号、改密、`reset-admin` 三处 `false` 写入删除。
3. **Green 前端**：删 `AuthGuard` 跳转、`LoginPage` 强制跳转、`api/client` 的 403 跳转、`SettingsPage` 的强制安全标签 / 系统设置锁定 / 旧地址拦截条件 / 提示条、`SettingsNav` 的 `mustChangePassword` prop 与禁用逻辑、`stores/auth` 的字段；`canAccessSystemSettings` 收敛为 `isAdmin`。
4. **测试同步**：两个 `UserPublic` 夹具删除字段。
5. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。
6. **交付**：issue 与本索引改「已完成」并写交付记录；方案 §2 台账等 THESIS-13 完成后随个人用户专题统一改。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-12-drop-forced-password-change.md`、`docs/issues2/README.md`、`docs/thesis-12-drop-forced-password-change-plan.md`、`docs/审查记录.md`、`src/middleware/auth.ts`、`src/web.ts`、`src/routes/auth.ts`、`src/reset-admin.ts`、`src/types.ts`、`web/src/components/auth/AuthGuard.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/api/client.ts`、`web/src/pages/SettingsPage.tsx`、`web/src/components/settings/SettingsNav.tsx`、`web/src/stores/auth.ts`、`web/tests/e2e/mobile-chat-harness.tsx`、`tests/**`。

其中 `src/web.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/api/client.ts`、两个 `UserPublic` 夹具文件超出 issue 的预计改动路径：它们是同一机制的闸门、跳转与类型落地处，删除机制必须同步清理，按范围声明登记。

## 4. 验收条件

1. 登录响应与 `GET /api/auth/me` 的用户对象不含 `must_change_password`；`must_change_password = 1` 的存量账号可直接访问受保护接口。
2. 后端业务层（`src/middleware/auth.ts`、`src/web.ts`、`src/routes/auth.ts`、`src/reset-admin.ts`）与前端五个文件不再出现强制改密闸门、跳转、403 处理与导航禁用；普通改密回归通过。
3. WebSocket 不再按该字段拒绝连接或关闭消息（源码契约覆盖）。
4. `users.must_change_password` 列、`src/db-schema/`、`src/db.ts`、`User` / `UserSessionWithUser` 未改；列由 THESIS-14 处理。
5. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
6. **人工冒烟（用户）**：登录后不会被强制跳转；在设置页改密后用新密码登录。

## 5. 非目标

- 不删 `users.must_change_password` 列，不改 schema、迁移与 `src/db.ts` 映射（THESIS-14 按 D-F2 处理）。
- 不改普通改密功能与 `SecuritySection`。
- 不做 THESIS-13 的产品定位与访问边界文档整体改写。
- 不读写 `data/`。

## 6. 风险与回滚

- **存量被标记账号不再被拦**：旧库中若存在 `must_change_password = 1` 的账号，升级后可直接使用；用户已在 D-E3 ① 确认接受。单账号场景下该账号即账号本人，改密仍可主动进行。
- **破坏性 API 变更（已确认）**：用户对象响应不再返回 `must_change_password`。按宪法第二节第 2 条在立项时确认；Web 前端同包更新，单账号下无外部客户端影响。
- **回滚**：`git revert <提交号>`；闸门、跳转与字段随 revert 恢复，数据库无需变更。
