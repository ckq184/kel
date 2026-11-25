# THESIS-12 个人用户（三）：去掉强制改密

| 字段          | 值                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                     |
| 领取人 / 分支 | `claude/thesis-12-drop-forced-password-change`                                                                                                                                                                             |
| 优先级        | P3                                                                                                                                                                                                                         |
| 类型          | 裁剪（死机制）                                                                                                                                                                                                             |
| 依赖          | THESIS-10；若执行 THESIS-11，则在 11 之后（同改 `src/middleware/auth.ts`、`AuthGuard.tsx`）                                                                                                                                |
| 阻塞          | THESIS-13                                                                                                                                                                                                                  |
| 可并行        | ✅ 01、03、04、05、07、09、15。⚠️ 02（`src/routes/auth.ts`）；06、08（`SettingsPage.tsx`、`stores/auth.ts`）。❌ 10、11（本包依赖它们）；13（依赖本包）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `src/middleware/auth.ts`、`src/routes/auth.ts`、`src/reset-admin.ts`、`src/types.ts`、`web/src/components/auth/AuthGuard.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/stores/auth.ts`、`tests/**`                      |
| 需用户决策    | **是**：D-E3                                                                                                                                                                                                               |
| 来源          | 方案 §8（D-E3、T3）                                                                                                                                                                                                        |

## 目标

去掉 `must_change_password` 机制。单账号下它没有任何触发点：首启创建账号和命令行重置密码都把它设为 `false`（`src/routes/auth.ts:169`、`src/reset-admin.ts:32`、:48），唯一会置为真的路径是管理员在用户管理里给别人重置密码，而这条路径已在 THESIS-10 删除。

## 范围（锚点为 `d6e04aa`）

- 后端：`authMiddleware` 的改密闸门（`src/middleware/auth.ts:122-134`）；登录与 `/me` 响应里的强制改密状态；创建用户时写入该字段的代码（列本身保留）。后端约 34 处引用。
- 前端：`AuthGuard` 的改密跳转；`SettingsPage.tsx` 里 `mustChangePassword` 相关的默认标签与旧地址拦截（:97、:161）。前端约 21 处引用。
- 测试：约 43 行。

## 非目标

- 不删 `users.must_change_password` 列（THESIS-14 按 D-F2 处理）。
- 不改普通的改密功能（设置页"安全"标签的 `SecuritySection`）。

## 需用户决策（领取前拍板）

| #    | 问题                                | 选项           | 方案默认 |
| ---- | ----------------------------------- | -------------- | -------- |
| D-E3 | 强制改密机制 `must_change_password` | ① 去掉；② 保留 | ①        |

选 ② 则本 issue 取消。去掉还能消除第一轮排查过的"桌面端登录循环"困惑（交付档 §9）。

## 执行前核实

- **V-E4**：去掉之后，`authMiddleware` 的改密闸门、`AuthGuard` 与设置页的改密跳转如何收敛。
- 存量数据里如果有 `must_change_password = 1` 的账号，去掉闸门后该账号可以直接使用，不再被拦。确认可以接受。

## 实现步骤（TDD）

1. **Red**：登录响应与 `/me` 不再出现强制改密状态；改密专用的跳转与拦截不再存在；普通改密回归用例保持通过。
2. **Green**：删除后端闸门与前端跳转。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：登录后不会被强制跳转；在设置页改密后用新密码登录。

## 风险与回滚

- **回滚**：`git revert <提交号>`。

## 交付记录

- **提交**：立项 `247bff3`、Red `fdbd21c`、实现 `6728e02`、审查处置 `bcdc8c0`、交付（本提交）。
- **验证**：`npm run verify` 6/6 全绿（365 文件，3009 通过 / 23 跳过 / 0 失败，33.6s）；`node scripts/check-scope.mjs` 20 路径全在 `.gatescope.json` 声明范围内。独立规格审查与代码质量审查均通过（零阻塞），详见 `docs/审查记录.md` 的 THESIS-12 节。
- **与 issue 描述的偏差**：
  1. 实际改动路径比 issue 的「预计改动路径」多出 `src/web.ts`（两处 WebSocket 闸门）、`src/db.ts`（仅重复的 `toUserPublic` 响应映射）、`web/src/components/settings/SettingsNav.tsx`、`web/src/pages/LoginPage.tsx`、`web/src/api/client.ts`、`web/tests/e2e/mobile-chat-harness.tsx` 与 `tests/message-bubble-duration-only.test.tsx`；均属同一机制的落地处，已随立项计划与 `.gatescope.json` 登记。
  2. 测试改动少于 issue 估计的「约 43 行」：`users.must_change_password` 列、`src/db.ts` 的 DB 映射与写入辅助、`User` / `UserSessionWithUser` 均按非目标保留，因此 `createUser` 的 DB 行夹具字段无需删除；仅删两个 `UserPublic` 响应夹具字段，并新增 5 条契约/回归用例。
  3. WebSocket 闸门删除只由源码契约覆盖，未补行为级 WS 用例（与立项计划验收第 3 条一致）。
  4. 旧库中 `must_change_password = 1` 的账号在改密/命令行重置后不再清零该列；当前无消费者，列由 THESIS-14 按 D-F2 处理。
  5. `docs/task-thesis-lite-delivery.md` 是历史交付档案，仍描述旧的强制改密流程，本次不改写。
- **待用户验收**：人工冒烟——登录后不被强制跳转；在设置页改密后用新密码登录。
- **方案台账**：个人用户专题尚未收口（THESIS-13 未完成），按 README 第一节第 6 步留待 13 交付时统一更新。
