# 任务 thesis-lite：毕设精简裁剪方案

> **文件定位**：本仓库（Personnal-agent-thesis）的裁剪执行方案，交接档。由主仓评估会话产出（2026-11-17），用户已逐项裁决，执行会话按批次落地。
> **行号基准**：本文所有 `文件:行号` 均基于裁剪前的原始树（HEAD = `bf0eba1`）。**前序批次提交后行号必然漂移**——执行时以 import 语句 / 函数名 / 挂载路径等符号为锚点 grep 重新定位，禁止盲信行号。
> **配套文档**：`docs/task-thesis-lite-handoff.md`（环境状态与执行纪律，开工前先读）。

---

## 1. 背景与目标

主仓 `Personnal-agent-main` 为 30 万行级项目（含测试），直接用于本科毕设答辩风险过高：体量远超本科水平、且含大量研究级模块（评测中心 / RSI 演化 / mem0 侧车）答辩时无法讲清。本副本从主仓 bf0eba1 复制而来，目标：

- 删掉难讲解、易翻车、演示脆弱的模块，保留可演示、可讲清的核心
- 预计净删 5~7 万行（含测试）
- 每批改动后 `npm run verify` 全绿、独立 commit、可单独 revert

## 2. 用户裁决记录（已定，不再讨论）

| #   | 裁决项                         | 结论                                                                     |
| --- | ------------------------------ | ------------------------------------------------------------------------ |
| 1   | 渠道范围                       | **保留 Web + 飞书 + QQ + 微信，砍钉钉**                                  |
| 2   | 计费/用量                      | **砍 billing 订阅体系，保留用量统计（UsagePage）+ 自定义模型定价**       |
| 3   | 监控页 MonitorPage             | **保留**                                                                 |
| 4   | 浏览器操控                     | **保留**（agent-browser + 容器内无头 Chromium CDP）                      |
| 5   | Electron 桌面端                | **保留**                                                                 |
| 6   | 能力扩展（Skills/MCP/Plugins） | **保留**（探索发现与核心深耦合，且是好章节；早期"建议砍"的判断已被推翻） |

## 3. 保留 / 删除总表

### 保留（答辩章节映射）

多用户认证与权限矩阵（UsersPage / 邀请码 / 审计日志）、Web 流式聊天（Markdown / mermaid / 终端渲染 / 会话分享图）、工作区与文件管理、**容器隔离 Agent 运行时（核心亮点）**、**浏览器操控**（`container/Dockerfile:18,112`、`container/entrypoint.sh`、`src/agent-capabilities.ts`、`scripts/install-host-tools.sh:103-111`，与被裁模块零交集）、Agent 人设（agent-profiles）、飞书/QQ/微信三渠道（卡片流式 / 绑定配对 / channel-accounts 管理）、定时任务调度与渠道推送、能力扩展（Skills / MCP / Plugins，CapabilitiesPage）、工作区记忆库（MemoryPage + `memory_recall` 事件，**≠ 被删的 auto-memory**）、Token 用量统计 + 自定义模型定价、运行监控（MonitorPage）、Electron 桌面端、verify / CI / Docker 发布工程基建。

### 删除

| 模块                     | 涉及主文件                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 评测中心 + RSI 演化      | routes/eval.ts、eval-{store,dataset,trigger}.ts、harness-{adapter-store,evolve-trigger,probe,proposer}.ts、recall-judge.ts、turn-observer.ts、observability-config.ts、EvalPage.tsx、scripts/eval-\* |
| auto-memory（mem0 侧车） | auto-memory-{ipc,config,sidecar-manager}.ts、routes/auto-memory.ts、runner auto-memory-context.ts + python 侧车、前端 auto-memory 全家                                                               |
| billing 订阅体系         | billing.ts、routes/billing.ts、BillingPage + components/billing/\* + stores/billing.ts                                                                                                               |
| 钉钉渠道                 | dingtalk\*.ts 三件、dingtalk-stream 依赖、prompts/channels/dingtalk.md                                                                                                                               |
| 边缘 API                 | routes/browse.ts（宿主机文件浏览，**非浏览器操控**）、routes/bug-report.ts                                                                                                                           |
| 过程文档                 | docs/ 下 41+ 份 task-_/TASK-_ 等过程记录                                                                                                                                                             |

### 全局安全线（硬约束）

1. **`src/db.ts` 一字不动**——billing/usage/auto_memory_recall 等表与列留着不用，保证 75 版 schema 迁移链完好；只删调用方（如 index.ts 里的 billing cleanup 定时任务）。
2. 每批收尾：`make typecheck` → 该批相关测试子集 → `npm run verify` 六步全绿 → 单独 commit。
3. **全程不 push**（副本 `.git/config` 带 origin 与代理配置，禁止使用）。
4. 禁止 `git commit --no-verify`；hooks 已随 `.git` 复制生效。
5. stream-event 类型改动必须跑 `make sync-types` 同步三侧副本（typecheck 内含同步校验）。
6. `memory_recall`（工作区记忆）与 `usage`（用量统计）事件**保留**，只删 `auto_recall`。

## 4. 分批执行

### 批次 0：立项（不删码）

- 本方案文档已落档（即本文件）；重置 `.gatescope.json`：`task = thesis-lite`、`base = bf0eba1`（pin 当前 HEAD）、allow 覆盖全树（大重构；先读 `scripts/check-scope.mjs` 确认 allow 的语义格式再写）。
- commit：`docs: 立项 - 毕设精简裁剪（thesis-lite）`

### 批次 1：评测 / RSI 全家

**删除文件**：

- 后端：`src/routes/eval.ts`、`src/eval-store.ts`、`src/eval-dataset.ts`、`src/eval-trigger.ts`、`src/harness-adapter-store.ts`、`src/harness-evolve-trigger.ts`、`src/harness-probe.ts`、`src/harness-proposer.ts`、`src/recall-judge.ts`、`src/turn-observer.ts`、`src/observability-config.ts`（后两者仅被评测链引用，删前 grep 确认无保留方消费者）
- 脚本：`scripts/eval-auto-recall.ts`、`scripts/eval-harness-evolve.ts`、`scripts/eval-harness-probe.ts`、`scripts/eval-langfuse.mjs`、`scripts/eval/auto-recall-golden.json`
- 前端：`web/src/pages/EvalPage.tsx`
- package.json：`eval:auto-recall` / `eval:harness-evolve` / `eval:harness-probe` / `eval:langfuse` 四条 scripts
- 测试（13 个）：eval-auto-recall-metrics、eval-frontend、eval-harness-evolve、eval-harness-probe、eval-routes、eval-store、eval-trigger、harness-adapter-store、harness-evolve-trigger、harness-probe、harness-proposer、recall-judge、turn-observer

**清理点（锚点，行号为 bf0eba1 基准）**：

- `src/web.ts`：import evalRoutes / injectEvalTriggerDeps（:70-71）；挂载 `/api/eval`（:292）；`broadcastEvalRunLog/Complete`（:3209-3217）；`createAppForTest` 与 `startWebServer` 里的 `injectEvalTriggerDeps`（:3264-3273、:3280-3289）。**注意保留 `injectMonitorDeps` 与 DockerPull 广播（监控页保留）**
- `src/index.ts`：import turn-observer / buildHarnessAdapterInput / startRecallJudgeScheduler（:476-478）；processGroupMessages 主路径 turnObserver tap（:7140-7156，含 buildHarnessAdapterInput）；`#agent:` 会话路径 tap（:15248-15262）；main() 里 `startRecallJudgeScheduler()`（:20721-20723）
- `src/container-runner.ts`：import buildHarnessAdapterInput（:18）；ContainerInput.harnessAdapter 类型字段（:403-411）；Docker/Host 两路注入（:1872、:2909）
- runner：删 `container/agent-runner/src/harness-adapter-turn.ts`；`index.ts` 的 import/re-export（:52/:54）与 decorate 调用（:1886-1889、:2313-2316）；`types.ts` 的 harnessAdapter 字段（:212-218）；测试 `tests/harness-adapter-injection.test.ts`
- 前端：`web/src/App.tsx`（lazy import :71-73、route :184-196）；`web/src/components/layout/nav-items.ts`（评测项 :29-35 + FlaskConical import）

**完成标准**：三侧 typecheck 绿（`make typecheck`）+ 根测试套绿 + 前端 build 绿。

### 批次 2：auto-memory（mem0 侧车）

**删除文件**：

- 宿主：`src/auto-memory-ipc.ts`、`src/auto-memory-config.ts`、`src/auto-memory-sidecar-manager.ts`、`src/routes/auto-memory.ts`
- runner：`container/agent-runner/src/auto-memory-context.ts`、`container/agent-runner/python/auto_memory_sidecar.py`
- 脚本：`scripts/builtin-mcp-catalog.mjs`（唯一职责 = 钉 mem0ai 版本；删前 grep 确认无他处引用）
- 前端：`web/src/stores/auto-memory.ts`、`web/src/components/settings/AutoMemorySection.tsx`、`AutoMemoryEndpointCard.tsx`、`web/src/components/chat/CaptureMemoryDialog.tsx`、`CaptureMessagePicker.tsx`
- 测试（8+fixture）：auto-memory-config、auto-memory-frontend、auto-memory-input-narrowing、auto-memory-ipc、auto-memory-routes、auto-memory-secret-filter、auto-memory-sidecar-manager、auto-recall-context；`tests/fixtures/fake-auto-memory-sidecar.mjs`

**清理点**：

- `src/index.ts`：import（:20-26）；IPC watcher `case 'auto_memory':` 分支（:12228-12235）；关停 `closeAutoMemorySidecarManager()`（:19679）
- `src/web.ts`：import autoMemoryRoutes（:52）；挂载 `/api/auto-memory`（:275）
- `src/container-runner.ts`：import getAutoMemoryHostConfig（:17）；`buildAutoMemoryInput`（:351-362）；ContainerInput.autoMemory 类型字段（:386-392）；两路注入（:1871、:2908）；**python 目录挂载 /app/python（:1532-1538）**
- runner `mcp-tools.ts`：McpContext.autoMemory（:62-65）；AUTO*MEMORY*\* 常量（:222-223）；`callAutoMemory`（:324-373）；`promoteIdempotencyKey` / `summarizeAutoMemoryAddResult`（:504、:539）；`auto_memory_search` / `auto_memory_add` / `memory_promote` 注册块（:2790-2896）
- runner `index.ts`：import loadAutoMemoryRecallTurnContext（:82）；冷启动第三路（:1758-1777）与 `emitAutoRecallObservation`（:1819-1861）；首轮装饰（:1893-1895）；热轮对应块（:2250-2273、:2300-2307、:2320-2322）；McpContext 构造 `autoMemory`（:4094）
- runner `pi-index.ts`（生产入口）：import（:34）、加载（:310-316）、prompt 拼接（:324）、`auto_recall` 发射（:331-358）、`ctx.autoMemory`（:504）
- runner `types.ts`：ContainerInput.autoMemory（:226-236）
- runner `workspace-memory-runtime.ts`：WRITE_TOOLS 里 `mcp__ckqclaw__auto_memory_add` / `memory_promote` 两目（:10-11）
- runner `prompts/memory-system.workspace.md`：:36-50 引用 auto_memory 工具的段落
- **stream-event**：`shared/stream-event.ts` 删 `'auto_recall'` 事件（:28）与 `autoRecall` 字段（:360-366）→ `make sync-types`（`memory_recall`、`usage` 勿动）
- `src/routes/groups.ts`：auto-memory-recall 端点（:1612-1686）与序列化字段（:406）
- `container/Dockerfile`：mem0ai 安装块（grep `MEM0AI`）；`scripts/install-host-tools.sh` mem0ai 段（:127-142，**agent-browser 段 :103-111 保留**）
- `.gatesecretsignore`：失效白名单行
- 前端：`ChatView.tsx`（:60/:140/:185 的 import 与调用、:1389-1391 开关传参、:1444 `<CaptureMemoryDialog>`）；`WorkspaceInteractionModeDialog.tsx` 的 autoMemoryRecall props；`stores/chat.ts` 的 `updateAutoMemoryRecall`（:2385-2396，**`memory_recall` 事件处理 :1082-1116 / :1587-1591 保留**）；`SettingsPage.tsx`（:23-24/:44/:160/:269/:285）；`SettingsNav.tsx`（:48-51）
- 连带测试修正：`load-sensitive-budget-contract.test.ts`（:60/:75/:80 枚举三个 auto-memory 测试文件）、`frontend-settings-information-architecture.test.ts`（:26 断言 auto-memory 导航项）、`container-runner-plugin-mount.test.ts`（:1058-1075 python 挂载断言）、`mcp-memory-promote-idempotency.test.ts`（:62-75 工具注册断言）
- 注意：`features/workspace-memory/model.ts` 的 `WorkspaceSummary` 类型被 AutoMemorySection 引用——删 AutoMemorySection 后 model.ts 本体保留（MemoryPage 用）

**完成标准**：同批次 1 + `make sync-types` 后 `git diff` 无残留差异。

### 批次 3：砍 billing（留 usage / pricing）

**删除文件**：`src/billing.ts`、`src/routes/billing.ts`、`web/src/pages/BillingPage.tsx`、`web/src/components/billing/*`（17 文件）、`web/src/stores/billing.ts`；测试：frontend-billing-navigation 及 routes/billing 相关。

**保留（勿动）**：`routes/usage.ts`、`routes/pricing.ts`、`usage-service.ts`、`task-usage.ts`、`custom-pricing-store.ts`、`kaboo-pricing.ts`、`stores/usage.ts`、`stores/model-pricing.ts`、`ModelPricingSection`、`UsagePage`、`components/usage/*`、recharts 依赖、`feishu-usage-display.ts`；index.ts 的 usage 事件记录链（recordUsageEvent 包装 :2400-2410、落账 :7699）与 db.ts 的 updateLatestMessageTokenUsage 调用（:7675/:7681/:15594/:15600）。

**清理点（billing 闸门全摘）**：

- `src/web.ts`：import billingRoutes 与 checkBillingAccess（:67、:75-78）；挂载 `/api/billing`（:289）；handleWebUserMessage 的 checkBillingAccess 闸（:616-650）
- `src/index.ts`：import billing 系（:467-474）；`broadcastBillingUpdate`（:543）；IM 路径闸（:7032-7049）与 usage 后二次校验（:7708-7713）；agent 会话路径闸（:17091-17106）；定时器：订阅过期（:20188-20193）、billing 相关 cleanup 调用（:20222-20235 中 cleanupOldDailyUsage/cleanupOldBillingAuditLog 两调用，**db.ts 函数本体不动**）；`setUserConcurrentLimitChecker` 的 billing 分支（:20361-20378，改为不限流或默认上限，二选一，倾向"不设 checker"最简）
- `src/task-scheduler.ts`：import billing（:100）；两处闸（:1081-1084、:1773-1780）
- `src/routes/`：groups.ts checkGroupLimit（:21）、config.ts checkImChannelLimit（:139）、files.ts checkStorageLimit（:24）、mcp-servers.ts checkMcpServerLimit（:8）——全部改为放行（删调用）
- `src/routes/usage.ts`：:16 对 billing.js 的 import——**执行时先核实实际用了哪些符号**，属 admin 用量查询的 billing 依赖则简化该部分（未知项，不猜测，发现超出预期即按宪法第 5 条停下确认）
- 前端：`App.tsx`（lazy :54、route :205-212）；`nav-items.ts`（billing 项 :36、`requiresBilling` 字段 :17 与过滤 :44-47）；`AppLayout.tsx`（import :10、loadBillingStatus + billing_update 监听 :46-61）；`UnifiedSidebar.tsx`（:6/:58/:64-67）；`BottomTabBar.tsx`（:3/:13/:18-21）；`SettingsPage.tsx`（billing tab：:29/:38/:66/:121/:151/:218-221）；`SettingsNav.tsx`（:82-85/:133）；`MessageBubble.tsx` `__billing__` 系统消息渲染（:347/:408）与 `stores/chat.ts` 对应 sender（:957）。**ChatPage :299-304 用量统计菜单入口保留**

**完成标准**：同批次 1；重点回归：web 端登录 → 聊天 → 用量页仍可用。

### 批次 4：钉钉渠道

**删除文件**：`src/dingtalk.ts`、`src/dingtalk-reply-parser.ts`、`src/dingtalk-streaming-card.ts`、`container/agent-runner/prompts/channels/dingtalk.md`、根 package.json 依赖 `dingtalk-stream`（删后跑 `npm install` 更新 lockfile）；测试：dingtalk-group-message-ack、dingtalk-reply-parser、dingtalk-streaming-card。

**清理点（只摘 dingtalk 分支；QQ / 微信 / 飞书与全部共享 channel-\* 基建不动）**：

- `src/im-channel.ts`：dingtalk import 与 createDingTalkChannel 分支（:25-29 一带）
- `src/im-manager.ts`：import（:25）与 getUserDingTalkConfig（:38）
- `src/channel-account-connectivity.ts`：dingtalk 分支（:110 一带）
- `src/im-channel-capabilities.ts`：dingtalk thread-map（:26 一带）
- `src/runtime-config.ts`：dingtalk.json 读写段（:3455-3647 内 dingtalk 部分）
- `src/routes/config.ts`：/user-im/dingtalk 端点（:3021/:3056/:3146）；/user-im/status 的 dingtalk 状态（:2502-2508 内）
- `src/index.ts`：connectUserDingTalk（:19213）；legacy 同步 dingtalk 分支（:19419）；reload/disconnect 处理器（:19875/:19883）；webDeps `isUserDingTalkConnected`（:20049-20053）；ensureLegacyDefaultChannelAccount dingtalk 分支（:20871-20882）
- 前端：`web/src/constants/im.ts`、`components/settings/channel-meta.tsx`、`ChannelAccountsManager` 表单 schema 中的 dingtalk 项
- 测试修正：channel-account-\*（13 个）与 im-manager-\*（4 个）中的 dingtalk facet 用例删除/修正；**执行时另核实** `channel-account-migration.ts` 是否含 dingtalk 分支（摸底未确认）

**完成标准**：同批次 1；渠道账号页（设置→消息渠道）不再出现钉钉选项，飞书/QQ/微信功能不受影响。

### 批次 5：browse / bug-report + 收尾

- **前置确认**：grep `web/src` 无 `/api/browse`、`/api/bug-report` 消费（若发现有消费，本项跳过并在交付说明中报告）
- 删 `src/routes/browse.ts`、`src/routes/bug-report.ts` + 挂载（web.ts :59/:69/:280/:291）+ 测试（routes-browse-\*、bug-report-sanitize）
- `scripts/verify.mjs` :74 failHint 引用的已删文档路径改写
- `.gatesecretsignore` 再次清理失效行

### 批次 6：文档大扫除 + 终验

**删除文档**（过程记录，对毕设无用）：

- 41 份 `docs/task-*` / `TASK-*-ACCEPTANCE.md`
- `docs/auto-memory-secret-filter-spec.md`、`docs/auto-memory-sidecar-ownership-plan.md`（auto-memory 设计档）
- `docs/REMAINING-WORK.md`、`docs/miniclaw-migration-cleanup.md`、`docs/审查记录.md`

**保留文档**：constitution.md、workflow.md、API.md、ACL-MATRIX.md、workspace-memory-v2.md、runtime-migration.md、agent-first-architecture-plan.md、PROMPT-SKILL-RUNTIME-TEST-PLAN.md（skills 保留）、claude-code-plugin-automation-design.md（plugins 保留）、本方案与交接档。

**改写文档**（删被裁模块段落）：

- `README.md`：产品定位、核心功能、渠道段、路线图（:28-29/:36/:88-103/:245-280 一带）
- `AGENTS.md`：:40-43（eval 命令）、:51-54（技术栈/目录/敏感区中 auto-memory、harness、四渠道描述）
- `CLAUDE.md`：:23/:66-69/:87-93/:133-157/:159-166/:167-222（钉谈部分）/:230/:239-241/:243/:251-276/:290-291/:302/:334-362/:421-433
- `docs/API.md`：被删路由行（:30-41/:70/:99/:155/:271-275/:374-399 一带）
- `docs/ACL-MATRIX.md`：billing / auto-memory / eval 权限行（:25/:61-66/:158-173/:229-233 一带）
- `web/src/utils/chat-route-preload.test.ts`（:18 `/memory` 用例数据核对）
- **文档改动须过 `npm run docs:check`**（md 内链接有效性）

**终验**：

1. `npm run verify` 六步全绿
2. `node scripts/check-scope.mjs` 通过
3. `make build` + `npm --prefix web run test:e2e`
4. `make dev` 人工冒烟：登录 → 聊天流式回复 → 浏览器操控工具 → 用量页 → 监控页 → 渠道页（无钉钉）→ 桌面端启动
5. 统计裁剪前后行数对比，写入交付说明

## 5. 风险与回滚

- 每批独立 commit，出问题 `git revert <批次commit>`；整体回退到 bf0eba1 也可
- 执行时核实项（不猜测，发现异常即停）：
  - routes/usage.ts 对 billing 的实际依赖面（批次 3）
  - channel-account-migration.ts 是否含 dingtalk 分支（批次 4）
  - db-upgrade-safety.test.ts / db-folder-unique-rebuild-order.test.ts / task-continuation-scheduler.test.ts 对 `auto_memory_recall` 列（v74）的断言——db.ts 不动，理论上应仍绿（批次 2 验证）
  - `observability-config.ts`、`builtin-mcp-catalog.mjs` 删除前的全仓引用复查
- Windows 平台基线说明（AGENTS.md 提及的 54 用例 skip）在本机（macOS）不适用

## 6. 摸底附录（批次 4 共享文件分类）

channel-\* 文件中**纯共享基建（保留，勿删）**：channel-account-routing / -secrets、channel-address、channel-admission、channel-card-finalization、channel-conversation-kind、channel-mount-service、channel-native-context、channel-outbox-delivery / -runtime-scope、channel-output-correlation、channel-pairing、channel-prefixes（src 与 shared 双份）、channel-reliability-recovery / -store、channel-session-owner、channel-turn-registry、channel-turn-runtime。

**含被删渠道分支需改不可整删**：im-channel.ts、im-manager.ts、im-channel-capabilities.ts、channel-account-connectivity.ts、channel-account-migration.ts（待核实）、im-downloader.ts（channel 联合类型）、runtime-config.ts、web-context.ts（WebDeps）、types.ts（provider 联合类型）。
