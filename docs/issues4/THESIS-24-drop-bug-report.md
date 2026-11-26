# THESIS-24 裁 Bug 报告

| 字段          | 值                                                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                 |
| 领取人 / 分支 | claude/thesis-24-drop-bug-report                                                                                                                                                                                                                                                                       |
| 优先级        | P2                                                                                                                                                                                                                                                                                                     |
| 类型          | 裁减（功能下线）                                                                                                                                                                                                                                                                                       |
| 依赖          | 无                                                                                                                                                                                                                                                                                                     |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                     |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 24 行                                                                                                                                                                                                                                                        |
| 预计改动路径  | `src/routes/bug-report.ts`、`src/web.ts`、`web/src/components/common/BugReportDialog.tsx`、`web/src/components/layout/UnifiedSidebar.tsx`、`web/src/components/settings/AboutSection.tsx`、`web/src/api/**`、`tests/**`、`web/tests/**`、`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md`、`README.md` |
| 需用户决策    | 否（方案 P4 已定）                                                                                                                                                                                                                                                                                     |
| 来源          | 方案 P4、§6                                                                                                                                                                                                                                                                                            |

## 目标

侧栏与"关于"页不再有"报告问题"入口；`/api/bug-report` 下线。

## 现状（`248c7cb`）

- 后端：`src/routes/bug-report.ts`（约 560 行），挂载在 `src/web.ts:79`（import）与 :229。接口：`GET /capabilities`、`POST /generate`（调 `sdkQuery` 整理报告）、提交（本机 `gh` 向写死的上游仓库开 issue，或返回预填链接）。
- 前端：`BugReportDialog.tsx`（约 520 行），入口在 `UnifiedSidebar.tsx` 与 `AboutSection.tsx`。
- 测试：`tests/bug-report-sanitize.test.ts`、`tests/thesis-02-bug-report-capability.test.ts`，以及可能引用该路由的契约测试（`tests/api-route-caller-contract.test.ts` 等）。
- 文档：`CLAUDE.md` §9 `RECALL_MODEL` 一行列了"Bug 报告摘要"。

## 非目标

- 不动 `sdkQuery`（仍有 `/recall`、对话标题、AI 解析定时任务三个调用方）。
- 不动 browse（选宿主机目录要用）。

## 执行前核实

- `git grep -n -i -E "bug-?report|BugReport" -- src web/src tests web/tests docs` 列全引用；只被本功能使用的工具函数（如日志脱敏）一并删除，被别处使用的保留。

## 实现步骤（TDD）

1. **Red**：`/api/bug-report/*` 返回 404；`web/src` 无 `BugReportDialog`；侧栏与"关于"页无入口。
2. **Green**：删后端路由文件、挂载、前端组件与入口、两个专属测试文件；同步路由契约测试。
3. 同步 `docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` `RECALL_MODEL` 说明、`README.md`（若提到）。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；第二轮方案 §11.4 的前端裁净检查（THESIS-15 可达性契约）通过。
2. **人工冒烟（用户）**：侧栏与"关于"页无"报告问题"；其余侧栏功能正常。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

- **提交**：`fa7d89f`（立项）、`d243a8c`（实现）、`c169264`（审查处置），交付簿记随本提交（分支 `claude/thesis-24-drop-bug-report`，基于 main `48903d0`）。
- **实现**：删除 `src/routes/bug-report.ts`（564 行）与 `src/web.ts` 的 import/挂载；删除 `src/schemas.ts` 的 `BugReportGenerateSchema`、`BugReportSubmitSchema` 与 `MAX_SCREENSHOT_BASE64_LENGTH`；删除 `web/src/components/common/BugReportDialog.tsx`（497 行）及 `UnifiedSidebar`、`AboutSection` 两处入口；删除 `tests/bug-report-sanitize.test.ts`、`tests/thesis-02-bug-report-capability.test.ts`；`docs/API.md` 删路由行与问题报告块、标题改为“监控”，`CLAUDE.md` 的 `RECALL_MODEL` 去掉“Bug 报告摘要”。
- **验证**：`npm run verify` 六步全绿（369 文件，3029 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 17 个路径全在声明范围内（含交付簿记）；`npm run docs:check` 158 个 Markdown；新契约 9 例在 base 上全失败、实现后全通过；`frontend-reachability-contract` 与 `api-route-caller-contract` 通过。
- **偏差**：issue 预计路径中的 `web/src/api/**`、`docs/ACL-MATRIX.md`、`README.md` 经核实无需改动；实际增列 `src/schemas.ts`。`CLAUDE.md` 共 44 行 diff，除 `RECALL_MODEL` 一行外均为 Prettier 表格对齐。
- **范围外登记**：`src/agent-profile-generator.ts:30` 注释仍以 bug-report 作对照，该文件由 THESIS-25 整文件删除，本包不碰；`scripts/gate-pre-commit.mjs:5-8` 注释与 `.gatesecretsignore:17` 仍提 `src/routes/bug-report.ts` / `tests/bug-report-sanitize.test.ts`，属 git hooks 与 secret 扫描配置，按 AGENTS §2 需用户单独批准，登记延后。
- **未实机验收**：待用户冒烟侧栏与“关于”页无“报告问题”，其余侧栏功能正常。
