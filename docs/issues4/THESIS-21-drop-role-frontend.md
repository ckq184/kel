# THESIS-21 角色只留管理员（前端）与公开用户字段

| 字段          | 值                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                      |
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

（待填）
