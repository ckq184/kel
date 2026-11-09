# 任务 U：综述改造模块回退（保留 mem0）

> **文档定位**：用户 2026-11-09 批准的回退立项，自包含交接。建议注入语：
> **「阅读 docs/task-u-survey-rollback-plan.md，开工。」**
> **基线（回滚点）**：`6674b68`（stash 了任务 S/T WIP 后的干净 HEAD）。**模式**：TDD 存量收缩、每任务一提交、交付报告附六门禁证据。

## 0. 一句话结论

摘除《Personal Agent 技术解析》综述驱动的改造模块（步骤 0 供应链治理的 MCP 三件套、步骤 1 审批门禁、步骤 2 shell 红线、步骤 4A loop guard、步骤 5 SearXNG 搜索轨、任务 B 审批通知/Web 审批页/IM 决定），**保留 mem0 记忆系统全链**（步骤 3）。git 历史起点 `7f41d5b` 基线快照已含全部改造，无「改造前」提交可回退——本任务为手工摘除。

## 1. 用户已确认的裁决（2026-11-09）

1. **完整回退，含安全后果**：移除后 send_file、bash、浏览器等所有工具调用不再有人工确认环节直接执行；无人值守任务失去重复刹车（loop guard），可能空转到硬超时。
2. **S/T WIP 处置**：`git stash push -u` 先保存任务 S/T 未提交改动，回退提交后 `stash pop` 恢复（已核实与手术文件零 diff 冲突）。

## 2. 摘除范围（按 REMAINING-WORK.md §0 步骤表）

| 步骤   | 模块                                                                                                                      | 处置                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1      | 架构级审批门禁（runner `approval/{policy,extension}.ts`、文件协议、`pending_approvals` 表、`/api/approvals`、策略加载）   | 整体摘除，DB 走 v72 前向迁移删表                |
| 2      | Shell 红线拦截（`approval/shell-policy.ts`）                                                                              | 随门禁摘除                                      |
| 4A     | 重复刹车（`approval/loop-guard.ts`）                                                                                      | 随门禁摘除（用户确认接受空转风险）              |
| 任务 B | 审批通知/Web 审批页/IM `/approve` `/deny`/飞书卡片决定                                                                    | 整体摘除（通知基建 Turn Outbox 保留——通用设施） |
| 0      | 供应链治理 MCP 三件套（playwright-mcp、mcp-searxng、mcp-server-fetch 的 catalog 条目、安装、Dockerfile 预装、smoke 探针） | 摘除；catalog 缩至 mem0ai 单条目（mem0 承重）   |
| 5      | SearXNG 搜索轨（`deploy/searxng/`、Makefile 目标、`docs/BUILTIN-MCP.md`、web-fetch 提示词引用）                           | 摘除                                            |

**保留清单**：mem0 全链（`auto-memory-*`、sidecar、IPC、catalog mem0ai 条目、`install_mem0ai`、Dockerfile mem0ai 段）、agent-browser 原生浏览器轨与 Chromium 基建（非综述步骤）、builtin-skills 轨、任务 A 续跑（零硬耦合）。

## 3. 关键手术点（侦查已核实行号）

- Runner：`pi-runtime.ts` L59–76 resolve 函数 + L110–133 注册块（「缺失即拒启」）；`pi-index.ts` L454–475 安装块；遗留 `index.ts` L3956–3977 镜像块；`types.ts` L219–235 `approvalPolicy` 双镜像字段。
- 宿主：`index.ts` 通知扇出 L3046–3159、`/approve` `/deny` L3802–3860、启动接线 L20004–20005；`web.ts` 路由 L274 + broadcast L3000–3034；飞书卡回调 `feishu.ts` L3361–3396。
- DB：baseline 建表 L540–555、CRUD L14677–14774；v72 `DROP TABLE IF EXISTS pending_approvals`（循 v66→v67 先例）；`CURRENT_SCHEMA_VERSION` 71→72，`db-upgrade-safety.test.ts` 钉死字面量同 commit 更新。
- `shared/stream-event.ts` 删 approval 类型段后 `make sync-types` 同步三副本（src / web / runner）。

## 4. 明确不做

- **data/ 不触碰**（宪法敏感区）：磁盘残留的 `data/ipc/*/approvals/` 与旧表数据由 v72 迁移在下次启动清理（自带 VACUUM INTO 预迁移备份）。
- 历史 task-_/TASK-_ 审计文档按任务 O 裁决保留原样，只在 REMAINING-WORK.md 追加台账。
- 不动：`pi-mcp-loader.test.ts`（fixture 字符串）、agent-browser 轨、builtin-skills 轨、任务 A 续跑。

## 5. 验收

1. `make typecheck` 三侧全过，runner build 不再产出 `approval/` 产物。
2. `npm test -- --run` 审批族测试删除后 0 失败文件；v72 迁移有测试覆盖。
3. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
4. 真机冒烟（用户侧）：`make dev` 启动 → 会话正常对话 → 工具调用直接执行不挂起 → Web 侧栏无「审批」入口 → `/approvals` 404。
