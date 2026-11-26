# 任务立项：THESIS-24 裁 Bug 报告

> 立项日期：2026-11-26｜base：`48903d0`（main tip，personal-slim v1.1 任务池合入后）｜分支：`claude/thesis-24-drop-bug-report`
> 来源：[docs/issues4/THESIS-24-drop-bug-report.md](issues4/THESIS-24-drop-bug-report.md)、[personal-slim 方案 P4](issues4/task-personal-slim-plan.md)

## 0. 需求采访结论

- **目标**：侧栏与"关于"页不再有"报告问题"入口；`/api/bug-report` 下线（`GET /capabilities`、`POST /generate`、`POST /submit`）。
- **完成条件**：三个接口 404；路由文件、挂载、请求 schema、前端对话框与两处入口、两个专属测试文件全部移除；`docs/API.md`、`CLAUDE.md` 不再列该功能；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；前端可达性契约（THESIS-15）通过。
- **约束**：方案 §3 八条裁剪原则；不改 `sdkQuery`（仍有 `/recall`、对话标题、AI 解析定时任务三个调用方）；不动 browse；不改表结构与迁移链；不做范围外清理。
- **需用户决策**：无（方案 P4 已定）。

## 1. 执行前核实（base `48903d0`）

| 项          | 复核结论                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端路由    | `src/routes/bug-report.ts` 564 行；仅被 `src/web.ts:79`（import）与 `:229`（`app.route('/api/bug-report', ...)`）引用。                                                                                            |
| 请求 schema | `src/schemas.ts:793-809` 的 `BugReportGenerateSchema`、`BugReportSubmitSchema` 与 `MAX_SCREENSHOT_BASE64_LENGTH` 仅被该路由使用，无其他引用。                                                                      |
| 脱敏工具    | `sanitizeLogs` 定义在路由文件内，生产侧只被同文件 `/generate` 调用；测试侧只被 `tests/bug-report-sanitize.test.ts` 导入，随功能一并删除。                                                                          |
| 前端        | `web/src/components/common/BugReportDialog.tsx` 497 行；入口只有 `UnifiedSidebar.tsx`（import、`showBugReport` state、按钮、对话框）与 `AboutSection.tsx`（同四项）。无 `components/common/index` 再导出。         |
| 测试        | 专属测试 `tests/bug-report-sanitize.test.ts`、`tests/thesis-02-bug-report-capability.test.ts`；`tests/api-route-caller-contract.test.ts` 动态扫描 `src/routes` 与 `/api` 调用方，删除后自动收敛，无需改断言。      |
| 文档        | `docs/API.md:32`（路由表行）、`:493`（"监控与问题报告"标题）、`:519-523`（问题报告接口块）；`CLAUDE.md:293` 的 `RECALL_MODEL` 说明含"Bug 报告摘要"。`docs/ACL-MATRIX.md`、`README.md`、`web/package.json` 无引用。 |
| 前端可达性  | `BugReportDialog` 只被上述两个入口引用；删除入口后文件不可达，THESIS-15 契约会锁定。                                                                                                                               |
| `sdkQuery`  | 删除本路由后剩余调用方为 `src/index.ts`（2 处）、`src/routes/tasks.ts`、`src/agent-profile-generator.ts`（THESIS-25 另裁），不在本包范围。                                                                         |

与 issue "预计改动路径"的差异：`web/src/api/**`、`docs/ACL-MATRIX.md`、`README.md` 经核实无需改动；`src/schemas.ts` 为实际需要同步的文件。

## 2. 方案（TDD）

### 2.1 Red

新增 `tests/thesis-24-drop-bug-report.test.ts`：

1. 以 THESIS-06 的 `createAppForTest` + mock auth 方式请求 `GET /api/bug-report/capabilities`、`POST /api/bug-report/generate`、`POST /api/bug-report/submit`，断言 404。
2. 断言 `src/routes/bug-report.ts` 不存在；`src/web.ts` 无 import 与挂载；`src/schemas.ts` 无 `BugReport` 与 `MAX_SCREENSHOT_BASE64_LENGTH`。
3. 断言 `web/src/components/common/BugReportDialog.tsx` 不存在；`UnifiedSidebar.tsx` 与 `AboutSection.tsx` 无 `BugReportDialog`、`showBugReport`、"报告问题"与 lucide `Bug` 图标导入；`web/src` 无 `/api/bug-report` 字面量。
4. 断言 `docs/API.md` 无 `/api/bug-report` 与"问题报告"；`CLAUDE.md` 无"Bug 报告摘要"。

在 base 上运行该测试应因功能仍存在而失败（Red），且失败点对应上述断言，而非测试装配错误。

### 2.2 Green

1. 删除 `src/routes/bug-report.ts`；移除 `src/web.ts` 的 import 与挂载。
2. 删除 `src/schemas.ts` 的 Bug Report 分节（两个 schema 与长度常量）。
3. 删除 `web/src/components/common/BugReportDialog.tsx`。
4. `UnifiedSidebar.tsx`：删 `Bug` 图标导入、`BugReportDialog` 导入、`showBugReport` state、侧栏按钮块、对话框渲染。
5. `AboutSection.tsx`：删 `Bug` 图标导入、`BugReportDialog` 导入、`useState`、按钮块、对话框渲染；"开源地址 & 作者 & 报告问题"注释改为"开源地址 & 作者"。
6. 删除两个专属测试文件。
7. `docs/API.md`：删路由表行、问题报告接口块，标题"监控与问题报告"改为"监控"。
8. `CLAUDE.md`：`RECALL_MODEL` 说明删除"Bug 报告摘要"。

### 2.3 Refactor / 门禁

- `git grep -n -i -E "bug-?report|BugReport" -- src web/src tests web/tests docs/API.md CLAUDE.md` 只应剩本任务计划/交付与历史任务池文档，运行时代码与当前参考文档零命中。
- `npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。
- `frontend-reachability-contract` 与 `api-route-caller-contract` 作为前端裁净与路由收敛的机器证据。

## 3. 任务拆解

| #   | 任务       | 主要文件                                                                                  | 独立验收                                     |
| --- | ---------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| T1  | 立项与 Red | plan、`.gatescope.json`、issue/README 状态、`tests/thesis-24-drop-bug-report.test.ts`     | 新契约在 base 上失败                         |
| T2  | 后端删除   | `src/routes/bug-report.ts`、`src/web.ts`、`src/schemas.ts`                                | 三接口 404；类型检查通过                     |
| T3  | 前端删除   | `web/src/components/common/BugReportDialog.tsx`、`UnifiedSidebar.tsx`、`AboutSection.tsx` | 对话框文件不存在；两处入口零命中；可达性通过 |
| T4  | 测试与文档 | 两个专属测试、`docs/API.md`、`CLAUDE.md`                                                  | 新契约通过；文档零命中                       |
| T5  | 门禁与交付 | 全范围                                                                                    | verify 六步全绿；check-scope 通过            |

回滚点：base `48903d0`；每个提交可单独 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-24-drop-bug-report-plan.md`、`docs/issues4/**`、`docs/审查记录.md`、`docs/API.md`、`CLAUDE.md`、`src/routes/bug-report.ts`、`src/web.ts`、`src/schemas.ts`、`web/src/components/common/BugReportDialog.tsx`、`web/src/components/layout/UnifiedSidebar.tsx`、`web/src/components/settings/AboutSection.tsx`、`tests/thesis-24-drop-bug-report.test.ts`、`tests/bug-report-sanitize.test.ts`、`tests/thesis-02-bug-report-capability.test.ts`。

与 issue "预计改动路径"的差异：未列经核实无需改动的 `web/src/api/**`、`docs/ACL-MATRIX.md`、`README.md`；增列 `src/schemas.ts` 与立项/审查/交付簿记文件。

## 5. 验收条件

1. `/api/bug-report/*` 三个接口返回 404；路由文件、挂载、schema 零残留。
2. 侧栏与"关于"页无"报告问题"入口；`BugReportDialog` 文件删除；前端可达性契约通过。
3. `docs/API.md`、`CLAUDE.md` 不再列该功能；`docs:check` 通过。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 新契约用例在 base 上失败、实现后通过（非空转）。
6. 人工冒烟（用户）：侧栏与"关于"页无"报告问题"；其余侧栏功能正常。

## 6. 非目标

- 不动 `sdkQuery` 及其其余调用方（`/recall`、对话标题、AI 解析定时任务、Agent Profile 生成）。
- 不动 browse（`src/routes/browse.ts`、`DirectoryBrowser`）。
- 不改表结构、迁移链与 `CURRENT_SCHEMA_VERSION`；不读写 `data/`。
- 不清理与本功能无关的既有死代码或文档漂移。
- 不推送、不合并 main。

## 7. 风险与回滚

- 纯删除；唯一行为面变化是三个接口与两处 UI 入口消失，属本任务目标。
- `sanitizeLogs` 是安全工具但只服务本功能，随路由删除；其测试同步删除，符合 issue 要求。
- `api-route-caller-contract` 的 `KNOWN_GAPS` 为空，删除路由与 Web 调用方后两侧集合同步收敛，无需白名单。
- 回滚：`git revert <提交号>`；无数据、schema 与外部依赖变更。
