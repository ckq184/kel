# THESIS-21 去角色（前端）与公开用户字段

| 字段          | 值                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                      |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                           |
| 优先级        | P1                                                                                                                                                                                                                                                          |
| 类型          | 裁减（前端角色门与文案）                                                                                                                                                                                                                                    |
| 依赖          | THESIS-19；issues3 的 THESIS-16 已合入                                                                                                                                                                                                                      |
| 阻塞          | 无                                                                                                                                                                                                                                                          |
| 可并行        | ✅ 22、26、28 至 33。⚠️ 20（`src/routes/auth.ts` 不同区域）、23（`web/src/App.tsx`、`SettingsPage.tsx`）、24、25、27（共用的前端页面与侧栏）（口径见 [README 第三节](README.md#三并行关系与执行顺序)）                                                      |
| 预计改动路径  | `web/src/App.tsx`、`web/src/components/auth/AuthGuard.tsx`、`web/src/stores/auth.ts`、`web/src/types.ts`、`web/src/components/**`、`web/src/pages/**`、`src/routes/auth.ts`（仅 `toUserPublic`）、`src/types.ts`、`tests/**`、`web/tests/**`、`docs/API.md` |
| 需用户决策    | 否                                                                                                                                                                                                                                                          |
| 来源          | 方案 P1；与 issues3 THESIS-16 分工                                                                                                                                                                                                                          |

## 目标

前端不再根据角色显隐页面或控件；登录与 `/me` 的公开用户对象不再返回 `role` 等多用户字段。

## 与 THESIS-16 的分工

THESIS-16（issues3）只改文案；如果它在本轮拍板前已经按 D-U2 ① 隐藏了 MCP"成员访问"控件，本包把隐藏的代码连同 `memberAccess` 相关类型一并删除。资料页角色标签若 THESIS-16 已删，本包跳过。领取时先读 THESIS-16 的交付记录。

## 现状（`248c7cb`）

- `web/src/App.tsx:173` 起的 `requireAdmin` 路由守卫；`AuthGuard.tsx:82` 起按角色决定是否跳转首启引导。
- 约 11 个文件里的局部 `isAdmin`（宿主机模式、工作区创建、任务、设置、Agent 能力），前端合计约 133 行角色相关代码。
- MCP 成员访问控件：`AddMcpServerDialog.tsx`、`McpServerDetail.tsx`、`McpServerCard.tsx`、`McpServersPage.tsx`。
- `toUserPublic`（`src/routes/auth.ts:74`）返回 `role`、`status`、`disable_reason`、`notes`、`deleted_at`。

## 非目标

- 不改后端角色判断（THESIS-20）。
- 不改 IM 侧"允许成员""所有允许成员"（指 IM 群成员）。
- 不拆分大组件（方案 §8）。

## 执行前核实

- 若 THESIS-20 尚未合入：后端仍返回 `role`，前端删掉角色判断后对唯一 admin 账号显示不变；`toUserPublic` 字段要等 THESIS-20 合入后再删（本包最后一个提交）。
- `git grep -n -E "isAdmin|requireAdmin|\\.role\\b|memberAccess" -- web/src` 重新定位，结果与现状表不一致时以 grep 为准。

## 实现步骤（TDD）

1. **Red**：`web/src` 非测试文件不再出现 `requireAdmin`、`memberAccess`、`role === 'admin'`；`GET /api/auth/me` 与登录响应不含 `role`、`disable_reason`、`notes`、`deleted_at`。
2. **Green**：删前端角色门与控件；删 `toUserPublic` 多余字段与前端类型。
3. 同步 `docs/API.md` 的用户对象说明；THESIS-15 的可达性契约兜底孤儿文件。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：登录后所有页面可达（含运行状态）；新建工作区可选宿主机模式；新建 MCP 后在 Agent 里可用；设置页无角色字样。

## 风险与回滚

- 只改展示与响应字段；回滚为 `git revert <提交号>`。

## 交付记录

（待填）
