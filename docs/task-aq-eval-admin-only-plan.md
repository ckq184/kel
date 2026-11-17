# 任务 AQ 立项：「评测」页整页收紧为 admin-only（manage_system_config）

> **状态**：方案已经用户确认（2026-11-17），待执行。
> **排查会话**：ZCode（2026-11-17，上一任务 AP 后的用户追问 + 定点勘察）。

---

## 0. 一句话结论

推翻任务 AB 立项时「离线 Runs 全员可见」的 ACL 决策：「评测」页（含离线评测 Tab1）与 `GET /api/eval/runs`、`/runs/:id`、`/comparison` 三个只读端点全部收紧为 `manage_system_config`（对齐 Monitor 页先例）。决策变更轨迹以本文档与代码注释留档，task-ab 历史文档不改写。

## 1. 现状坐标（已核实）

- `web/src/App.tsx:187-194`：/eval 路由无 AuthGuard、无 requiredPermission（:184-186 注释写明全员可见）
- `src/routes/eval.ts:33/43/50`：三端点仅 `authMiddleware`；同文件 :239 `/turns` 与 :175 `/runs/trigger` 已有 `systemConfigMiddleware` 先例
- `web/src/components/layout/nav-items.ts:26`：评测导航项无权限过滤（`NavItem` 无权限字段，`filterNavItems` 只按 billing 过滤）
- `web/src/pages/EvalPage.tsx:2288-2299`：tabs 数组 member 分支仅「离线评测」；其余 tab/端点（turns/datasets/harness/trigger）本就 admin-only
- WS 进度广播（`src/web.ts` `safeBroadcast` adminOnly=true 按 admin 角色过滤）已不达 member，无需动
- 测试：`tests/eval-routes.test.ts` 用 `x-test-user` 头构造 ADMIN/MEMBER（:103-127）；:255 有 member 403 断言先例；:164-229 的 MEMBER 200/404/400 用例需改

## 2. 方案

### 2.1 后端（TDD）

测试先行（`tests/eval-routes.test.ts`）：
- `any logged-in user can list runs`（:164）→ 拆为 admin 200（断言原样）+ member 403
- `/runs/:id` 三用例：`returns run with items`（:178 MEMBER 200）→ ADMIN 头；`unknown run id is 404`（:193）→ ADMIN 头 + 新增 member 403 用例；401 用例不动
- `/comparison` 同法：`places requested runs side by side`（:205）→ ADMIN；`missing ids query is 400`（:221）→ ADMIN + 新增 member 403；401 不动

实现（`src/routes/eval.ts`）：三端点加 `systemConfigMiddleware`；头注释 :22-25 ACL split 描述同步改。

### 2.2 前端

- `web/src/App.tsx`：/eval 包 `<AuthGuard requiredPermission="manage_system_config">`（monitor 先例 :174-183）；注释更新
- `web/src/pages/EvalPage.tsx`：头注释更新；tabs 数组删 member 分支（整页 admin-only 后恒四项）；`canManageSystem` 保留驱动 `EvalRunsPanel canTrigger`（页面守卫为纵深防御）
- `web/src/components/layout/nav-items.ts`：`NavItem` 加 `requiredPermission?: string`；评测项标注；`filterNavItems(billingEnabled, hasPermission?)` 过滤
- `web/src/components/layout/UnifiedSidebar.tsx`（:64 调用处）与 `BottomTabBar.tsx`（:15，新增 useAuthStore 权限选择器）：传入 `hasPermission`

### 2.3 文档同步

- `AGENTS.md:53`：评测页描述改「整体仅 manage_system_config」
- `CLAUDE.md:353-355`：同口径更新
- `docs/ACL-MATRIX.md` §6 补 `/api/eval/*` 行（评测 API 原缺席矩阵）

## 3. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | member 失去离线评测入口（用户可见功能移除） | 即需求本身；导航项同步隐藏 |
| R2 | member 旧标签页收 403 错误横幅 | 刷新即被 AuthGuard 拦截，不做迁移逻辑 |
| R3 | WS 按 admin 角色 vs REST 按权限的既有口径差异 | 本次不动（行为不变），本文档注明 |
| R4 | nav 权限字段为新增通用机制 | 缺省不过滤，向后兼容；tsc 兜底 |
| R5 | 三处文档漂移 | 同批更新 + docs:check |

## 4. 验收标准

1. `tests/eval-routes.test.ts`：三端点 401（未登录）/ 403（member）/ 200·404·400（admin）全形状覆盖，全绿
2. `npm run verify` 六步全过；`node scripts/check-scope.mjs` 过
3. 权限行为以测试用例为判定依据（浏览器双账号目检不可行，同任务 AP 原因）

## 5. 执行步骤

0. 立项（本文档 + `.gatescope.json`，base=65d1753）→ 立项 commit
1. 后端 TDD（§2.1）
2. 前端收紧（§2.2）
3. 文档同步（§2.3）
4. 验收（§4）→ 任务 commit（push 由用户显式发起）
