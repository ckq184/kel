# 任务立项：THESIS-06 用量（一）：用量分析页与 `/api/usage` 下线

> 立项日期：2026-11-24｜base：`5ccf1b3`｜分支：`claude/thesis-06-usage-page`
> 来源：[docs/issues2/THESIS-06-usage-page.md](issues2/THESIS-06-usage-page.md)（方案 §6 L1、§11.2、§11.3、§11.4）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：主导航与聊天页不再有用量入口；`/usage` 路由与 `/api/usage` 下线；设置页 `?tab=usage` 旧地址回落到默认标签。记账、`usage` 流事件、聊天气泡、运行状态页均不动。
- **完成条件**：`/api/usage` 六个只读接口全部 404；页面层 4 组文件删除；`recharts` 从 `web/` 依赖移除；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不动 `data/` 与表结构；不停记账（THESIS-07）；不动聊天气泡（THESIS-09）；不动 `src/web.ts` 的 `eventType === 'usage'` 流事件广播（:1889）。
- **D-F3（历史数据）**：**推迟到 THESIS-14 前导出**。五张表的数据到 THESIS-14 才删除，届时用户直接从 `data/db/messages.db` 用 `sqlite3` 导出（覆盖五张表）；本包不阻塞、不读 `data/`。注：`/api/usage/export.csv` 只覆盖 `usage_records`、上限 1 万行、日期窗口 ≤365 天，不作为留存主路径。

## 1. 关键事实（开工前核实，main `5ccf1b3`）

- **锚点无漂移**：`App.tsx:72-73` 懒加载、`:94` `UsageRouteFallback`、`:204-210` `/usage` 路由；`nav-items.ts:25`；`ChatPage.tsx:298-301`；`stores/auth.ts:4/97/116/134`；`SettingsPage.tsx:47/68/150`；`src/web.ts:80/233`，与 issue 所列 `d6e04aa` 行号一致。
- **`SettingsTab` 还有一处类型声明**：`web/src/components/settings/types.ts:106` 的联合类型含 `'usage'`。方案 §11.2 明确要求同步"标签类型"，本包一并删除；`SettingsPage.tsx` 的 `VALID_TABS`、`sectionTitle` 与 `LEGACY_TAB_ROUTES` 同步删 `usage`。删后 `?tab=usage` 不在 `VALID_TABS`，落入 `defaultTab`（管理员 `claude`，普通用户 `profile`）。
- **整文件删除 5 个**：`web/src/pages/UsagePage.tsx`、`web/src/stores/usage.ts`、`web/src/components/usage/UsageTrendChart.tsx`、`web/src/components/usage/format.ts`、`web/src/utils/usage-format.ts`；后端 `src/routes/usage.ts`。图标 `BarChart3` 仅 `nav-items.ts`、`ChatPage.tsx`、`UsagePage.tsx` 使用，前两处随入口删除。
- **依赖**：`recharts` 全仓仅 `UsageTrendChart.tsx` 引用（`web/package.json`、`web/package-lock.json`），删除后跑 `npm install` 更新 lockfile。
- **测试面**：整文件删除 `tests/frontend-usage-experience.test.ts`（344 行）、`tests/routes-usage.test.ts`（293 行）；改 `tests/frontend-settings-information-architecture.test.ts`（`/usage` 路由与旧地址断言）、`tests/frontend-product-terminology.test.ts`（扫描列表含 `UsagePage.tsx`）、`tests/issue11-compat-and-duplicate-convergence.test.ts`（`formatCost`/`stores/usage.ts`/`UsagePage` 断言）。
- **不属于本包**：`src/usage-service.ts`、`src/task-usage.ts`、`src/index.ts`/`task-scheduler.ts` 的记账调用、`MessageBubble.tsx`/`token-usage-presentation.ts`/`stores/chat.ts` 的气泡显示、`src/web.ts:1889` 的 `usage` 流事件广播、五张表的写入与表结构。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-06-usage-page-removal.test.ts`
   - 路由：用 `createAppForTest` 断言 `/api/usage/{stats,models,filters,records,export.csv,users}` 六条 GET 全部 404；
   - 源码契约：`App.tsx`/`nav-items.ts`/`ChatPage.tsx` 不含 `/usage`，`SettingsPage.tsx` 不含 `usage: '/usage'` 且 `VALID_TABS` 不含 `'usage'`，`stores/auth.ts` 不引用 `useUsageStore`；
   - 文件不存在：`UsagePage.tsx`、`stores/usage.ts`、`components/usage/**`、`utils/usage-format.ts`、`src/routes/usage.ts`；
   - 依赖：`web/package.json` 无 `recharts`；文档：`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` 不再列 `/api/usage`、`/usage`。
2. **Green**：按范围表删除文件与入口；`web/package.json` 去 `recharts` 后 `npm install`。
3. **协调测试**：删除两个旧测试文件；按上文改写三个测试的残留断言。
4. **文档**：`docs/API.md`（路由表 1 行 + 用量 6 条 + 小节标题）、`docs/ACL-MATRIX.md` 1 行、`CLAUDE.md` §3.2 路由表与兼容重定向列表各 1 行；跑 `npm run docs:check`。
5. **清扫（方案 §11.4）**：可达性、死导出、入口、权限与事件、依赖、文案与测试、图标与样式逐项核对。独立审查补漏：删除只服务用量页导出兜底的 `downloadTextFile` 与 `DownloadError` 导出（`web/src/utils/download.ts`），以及唯一设置点已随导航项删除的 `hideOnMobile` 字段与 `BottomTabBar` 过滤分支。
6. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-06-usage-page.md`、`docs/issues2/README.md`、`docs/thesis-06-usage-page-plan.md`、`docs/审查记录.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md`、`web/src/pages/UsagePage.tsx`、`web/src/stores/usage.ts`、`web/src/components/usage/**`、`web/src/utils/usage-format.ts`、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/components/layout/nav-items.ts`、`web/src/components/layout/BottomTabBar.tsx`、`web/src/pages/ChatPage.tsx`、`web/src/stores/auth.ts`、`web/src/components/settings/types.ts`、`web/src/utils/download.ts`、`web/package.json`、`web/package-lock.json`、`src/routes/usage.ts`、`src/web.ts`、`tests/frontend-usage-experience.test.ts`、`tests/routes-usage.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`tests/frontend-product-terminology.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts`、`tests/thesis-06-usage-page-removal.test.ts`。

其中 `web/src/utils/download.ts` 与 `web/src/components/layout/BottomTabBar.tsx` 是独立审查发现的 §11.4 第 2 项死代码补漏，超出 issue 的预计改动路径，按"扩宽范围只能改声明"登记；详见交付记录。

## 4. 验收条件

1. 访问 `/usage` 落到工作台（无路由 → 404 兜底/工作台）；主导航与聊天页菜单无用量入口。
2. 六个 `/api/usage` 接口返回 404。
3. `make typecheck`、`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 方案 §11.4 七项清扫检查通过（`recharts`、`BarChart3`、`SettingsTab` 死类型、旧地址重定向均无残留）。

## 5. 非目标

- 不停记账（THESIS-07），不动 `usage` 流事件与 `messages.token_usage` 写入。
- 不删表、不动 `src/db.ts`（THESIS-14）；不动模型单价（THESIS-08）。
- 不改聊天气泡与飞书摘要（THESIS-09）。
- 不读不写 `data/`；不处理历史数据导出（D-F3 已定为 THESIS-14 前由用户执行）。
- 不改 `README.md` 的导航描述（THESIS-13 产品定位统一改写；本包只同步 issue 明确列出的三份文档）。

## 6. 风险与回滚

- 本包之后账本仍在写入，但没有读取界面，直到 THESIS-07 停记账；属方案预期。
- 旧书签 `/settings?tab=usage` 回落到默认标签，不再 302 到 `/usage`；`/usage` 本身落到应用兜底。
- **回滚**：`git revert <提交号>`，`web/package-lock.json` 一并回滚。
