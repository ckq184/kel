# THESIS-06 用量（一）：用量分析页与 `/api/usage` 下线

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | THESIS-06 会话 / `claude/thesis-06-usage-page`                                                                                                                                                                                                                                                                                                                                                                                  |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 裁剪（页面层，方案 L1）                                                                                                                                                                                                                                                                                                                                                                                                         |
| 依赖          | 无。但**开工前 D-F3 必须拍板**：五张表的历史数据要留存的话，得在本包之前导出（本包会删掉 `/api/usage/export.csv`）                                                                                                                                                                                                                                                                                                              |
| 阻塞          | THESIS-07                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 可并行        | ✅ 01、02、03、04、05、15。⚠️ 12（`stores/auth.ts`、`SettingsPage.tsx`）；13（`CLAUDE.md` §3.2 相邻行、`docs/ACL-MATRIX.md`）。❌ 07、08、09（依赖本包）；10、11（同改 `App.tsx`、`stores/auth.ts`、`src/web.ts`）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                                                                           |
| 预计改动路径  | `web/src/pages/UsagePage.tsx`、`web/src/stores/usage.ts`、`web/src/components/usage/**`、`web/src/utils/usage-format.ts`、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`web/src/components/layout/nav-items.ts`、`web/src/pages/ChatPage.tsx`、`web/src/stores/auth.ts`、`web/package.json`、`web/package-lock.json`、`src/routes/usage.ts`、`src/web.ts`、`CLAUDE.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`tests/**` |
| 需用户决策    | **是**：D-F3（历史数据能否丢弃；不能丢就先导出）                                                                                                                                                                                                                                                                                                                                                                                |
| 来源          | 方案 §6（L1、T1）、§11.2、§11.3                                                                                                                                                                                                                                                                                                                                                                                                 |

## 目标

主导航和聊天页不再有用量入口；`/usage` 路由与 `/api/usage` 下线。对话、定时任务、运行状态页不受影响。

## 范围（锚点为 `d6e04aa`）

| 部分   | 内容                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面层 | 删除 `UsagePage.tsx`（1,292）、`stores/usage.ts`（660）、`components/usage/` 两个文件（168）、`utils/usage-format.ts`（13）                                                                                                       |
| 入口   | `App.tsx` 的懒加载（:72-73）、占位组件 `UsageRouteFallback`（:94）、`/usage` 路由（:206-209）；主导航 `nav-items.ts:25`；聊天页"用量统计"菜单 `ChatPage.tsx:298-301`；登录状态变化时的 store 重置 `stores/auth.ts:97`、:116、:134 |
| 旧地址 | `SettingsPage.tsx` 的 `LEGACY_TAB_ROUTES` 里 `usage: '/usage'`（:68）：删除该条，旧地址落到默认标签或工作台（方案 §11.4 第 3 条）                                                                                                 |
| 后端   | 删除 `src/routes/usage.ts`（六个只读接口，225 行）与挂载 `src/web.ts:80`、:233                                                                                                                                                    |
| 依赖   | `recharts` 只被 `UsageTrendChart.tsx` 引用，从 `web/package.json` 删除，执行 `npm install` 更新 `web/package-lock.json`                                                                                                           |
| 文档   | `docs/API.md` 用量 7 行；`docs/ACL-MATRIX.md` 1 行；`CLAUDE.md` §3.2 路由表的 `/usage` 行与兼容重定向列表里的 `usage`→`/usage`（审核补充，方案原清单漏列）                                                                        |

## 非目标

- 不停记账（THESIS-07），不动 `usage` 流事件与 `messages.token_usage` 的写入，聊天气泡本包不改。
- 不删表（THESIS-14）。
- 不动运行状态页（`src/routes/monitor.ts` 不引用用量数据，已核实）。

## 需用户决策（领取前拍板）

| #    | 问题                                     | 选项                     | 说明                                                                                       |
| ---- | ---------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| D-F3 | 用量、单价、邀请码、审计五张表的历史数据 | ① 可以丢弃；② 先导出留存 | 选 ② 时，由用户在本包开工前用 `/api/usage/export.csv` 或直接从数据库导出；代理不读 `data/` |

## 执行前核实

- 测试影响（方案 §6.6）：删除或改写 `tests/frontend-usage-experience.test.ts`、`tests/routes-usage.test.ts`；`tests/frontend-settings-information-architecture.test.ts`、`tests/frontend-product-terminology.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts` 各有引用（后者可能断言兼容重定向）。
- `src/web.ts:1889` 的 `event.eventType === 'usage'` 属于流事件广播，与页面无关，不动；执行时确认。
- 对 `useUsageStore`、`UsagePage`、`formatCost`、`/api/usage` 做一次 `git grep`，范围包含 `tests/`、`web/`、`docs/`。

## 实现步骤（TDD）

1. **Red**：源码契约用例：主导航、聊天页、`App.tsx` 源码不再出现 `/usage`；路由用例：六个 `/api/usage` 接口返回 404。
2. **Green**：按范围表修改。
3. **前端清扫**：方案 §11.4 七项检查，尤其是 `recharts` 和 `BarChart3` 等图标导入。

## 验收条件

1. 访问 `/usage` 落到工作台；主导航与聊天页菜单没有用量入口。
2. 六个 `/api/usage` 接口返回 404。
3. `make typecheck`、`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 方案 §11.4 清扫检查项通过。

## 风险与回滚

- 本包之后，账本仍在写入，但没有读取界面，直到 THESIS-07 停记账。
- **回滚**：`git revert <提交号>`，`web/package-lock.json` 一并回滚。

## 交付记录

（交付时填写）
