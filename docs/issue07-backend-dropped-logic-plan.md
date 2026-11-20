# 后端掉线逻辑与意图项立项（ISSUE-07）：决策与落地

> 任务来源：`docs/issues/ISSUE-07-backend-dropped-logic-decisions.md`（审查报告 R2 §4.1、§4.3、§5、§14）。
> 回滚点：`2493eab`（开工前 HEAD，见 `.gatescope.json` 的 `base`）。
> 工作分支：`issue-07-backend-dropped-logic`（worktree `~/.zcode/worktrees/issue07`）。

## 需求采访结论（2026-11-20，用户逐项拍板）

12 项全部拍板；除第 5 项（只定方向、实现归 ISSUE-10）与第 12 项（无需决策）外，
其余 10 项在本任务内落地实现：

| #   | 条目                                  | 决策                                                                             |
| --- | ------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | 按用户的容器并发上限                  | **A 恢复**：加全局设置 `maxConcurrentContainersPerUser`，不依赖 billing          |
| 2   | `PUT/GET /api/groups/:jid/mcp` 假成功 | **A 改 410**：两路由返回 410 Gone + 说明                                         |
| 3   | 重启后 `retry_wait` Outbox 滞留       | **A 测试+文档**：写复现测试坐实现状、修正掉线注释与文档；补 worker 另立 ISSUE-14 |
| 4   | uncertain Outbox 无 Web 入口          | **A 加 Monitor 放行卡片**                                                        |
| 5   | `context_audit` 无生产者              | **A 宿主直接记快照**（方向登记，ISSUE-10 执行）                                  |
| 6   | `sdk_message_uuid` 恒为空             | **A 下线**：删读写链与回补簇，保留 text-hash 回退；物理删列登记 ISSUE-09         |
| 7   | `workspace_memory_outbox` 无限增长    | **A 停写+清理**：outbox 表下线；audit_events / tombstones 保留                   |
| 8   | IPC `refresh_groups` 有处理无生产者   | **A 删除 handler**（旧镜像仅多得一条 warn，不阻塞）                              |
| 9   | `file-text-extractor` 失去调用方      | **A 接回三渠道**：共享层下载+抽取一体 helper，三处拼标记点接入                   |
| 10  | “Auth Token 须配 Base URL”规则        | **A third_party 专属规则并入 schema** + 删零调用的旧函数                         |
| 11  | 三个“测试守护的不是生产路径”的函数    | **A 三个全删**（连同各自专属测试用例）                                           |
| 12  | runner 报错文案指向已删回滚路径       | 直接修文案（连带 `expected claude or pi` 一并修正）                              |

## 目标（What & Why）

按上述决策恢复掉线的公平性/可靠性逻辑、下线确认无消费者的链路、修复误导性契约，
每项均有测试锁定。核心动机：这些项要么是真实功能缺口（单用户占满容器、uncertain
turn 永久卡死、弱模型读不了 PDF/DOCX、third_party token 静默打官方端点），要么是
虚假资产（假成功路由、永空的 uuid、守护非生产路径的测试）。

## 非目标

- 不实现 channel outbox 后台 worker（登记为 ISSUE-14，另行立项）。
- 不执行第 5 项 `context_audit` 快照接入（本任务只把方向写入 ISSUE-10，由其执行）。
- 不为 `maxConcurrentContainersPerUser` 做 Web 设置 UI 渲染控件（settings API 读写
  回显已具备、env 可设；渲染控件需要时另立）。
- 不物理删除 `messages.sdk_message_uuid` 列与 `registered_groups` 三列（DB 迁移统一
  归 ISSUE-09；本任务只做代码层下线并登记）。
- 不改 `audit_events` / `tombstones` 语义（“可审计的忘记”设计承诺，保留）。
- 不重构 `src/index.ts` 其他区域；不动 shared/stream-event.ts（本任务无事件类型变更）。

## 修改文件范围

**后端 src/**：`index.ts`（项1 注入、项8 删 case、项6 多处）、`runtime-config.ts`
（项1 设置、项10 删函数）、`schemas.ts`（项1、项10）、`routes/groups.ts`（项2）、
`routes/config.ts`（项1 **范围扩宽**：`toSystemSettingsResponse` 回显
`maxConcurrentContainersPerUser`——批次B 实现后发现 GET 不回显使设置值无法读回，
一行补齐并加 `tests/system-settings-per-user-echo.test.ts` 锁定回显与合并语义）、
`types.ts`（项2 字段、项6 透传）、`db.ts`（项6 写链）、`session-workflows.ts`（项6
回补簇）、`reply-delivery.ts`（项6 判定）、`container-runner.ts`（项6 声明）、
`memory-store.ts`（项7）、`isolated-task-ipc.ts` / `workspace-interaction-runtime.ts` /
`agent-profile-runtime.ts`（项11）、`im-downloader.ts` / `feishu.ts` / `qq.ts` /
`wechat.ts` / `file-text-extractor.ts`（项9）、`channel-outbox-delivery.ts`（项3 注释）。

**runner**：`container/agent-runner/src/pi-index.ts`、`runtime-config.ts`（项12 文案）、
`types.ts`（项6 声明）。

**前端 web/**：`stores/monitor.ts`、`pages/MonitorPage.tsx`（项4，可选新组件
`components/monitor/UncertainOutboxCard.tsx`）、`stores/chat.ts`（项6 字段）。

**文档与 issue**：`docs/API.md`（项2/3/4）、`docs/workspace-memory-v2.md`（项7）、
`docs/issues/`（ISSUE-07 交付记录、README 索引、ISSUE-09/10 决策登记、ISSUE-14 新建）、
`docs/审查记录.md`（阶段6 结论）。

**测试**：修改 `agent-runtime-migration`、`isolated-task-ipc`、
`workspace-interaction-runtime`、`agent-profile-runtime`、`feishu-capability-outbox`、
`channel-outbox-delivery`、`session-workflows`、`reply-delivery`、
`ckqclaw-owner-profile-store`、`routes-groups-rebuild-memory`、
`schema-v65-workspace-memory`、`file-text-extractor`；新增
`group-queue-user-concurrency`、`groups-mcp-legacy-route`、
`channel-outbox-restart-retry-wait`、`frontend-monitor-uncertain-release`、
`unified-provider-third-party-baseurl`、`im-inbound-file-inline`、
`system-settings-per-user-echo`（项1 范围扩宽）。

## 方案与测试设计

### 项 1：恢复按用户并发上限（不依赖 billing）

- `src/runtime-config.ts`：`SystemSettings` 加
  `maxConcurrentContainersPerUser: number | null`（默认 `null` = 不限制；normalize
  允许 null 或 1..100；env `MAX_CONCURRENT_CONTAINERS_PER_USER`）；`src/schemas.ts`
  的 SystemSettingsSchema 同步可选字段。
- `src/index.ts` main() 重注入 checker（原注入点随 billing 删除，逻辑原样恢复、
  limit 来源改为全局设置）：`null` 放行 → `stripVirtualJidSuffix` →
  `registeredGroups[baseJid].created_by` → `getUserById`，admin 放行 → 统计
  `hasDirectActiveRunner(jid) + countActiveTaskRunners(jid)`，`userActive < limit`
  才允许。两个统计方法现成（`group-queue.ts:961/967`），`group-queue.ts` 不改。
- 测试（新增 `tests/group-queue-user-concurrency.test.ts`，mock `getSystemSettings`，
  沿用容器模式队列测试现成模式）：超限用户新会话不启动、未超限用户不受影响、
  admin 放行、设置为 null 时完全放行；host 模式不受影响由现有
  `group-queue-host-session-concurrency.test.ts` 回归保护。

### 项 2：mcp 假成功路由改 410

- `src/routes/groups.ts:2611-2680`：GET 与 PUT 均返回 410 + JSON 说明
  （该路由从未真正保存，MCP 配置请用工作区级配置）。
- `src/types.ts:204-205` 删 `RegisteredGroup.mcp_mode?/selected_mcps?`；
  `docs/API.md:77` 改为 410 说明。三列物理删除仍归 ISSUE-09。
- 测试（新增 `tests/groups-mcp-legacy-route.test.ts`）：两路由 410、响应体含说明。

### 项 3：outbox 重启滞留——复现测试与文档

- 新增 `tests/channel-outbox-restart-retry-wait.test.ts`：构造 pre-send 过期行 →
  `reconcileExpiredChannelOutbox` 翻转为 `retry_wait` → 无新入站触发时断言**当前
  行为**（不被认领、不被投递，测试注释引用 ISSUE-14 待 worker 修复）。
- `src/channel-outbox-delivery.ts:406` 注释改为如实描述：无后台 worker，重投依赖
  turn 重跑（同 idempotencyKey 再次进入 `deliverChannelOutboxItem`）或人工 resolve。
- `docs/API.md` uncertain 一节补充“重启后 `retry_wait` 不会被自动重投”。
- 新建 `docs/issues/ISSUE-14-channel-outbox-worker.md`（编号顺延，README 索引同步）。

### 项 4：Monitor 页 uncertain 放行卡片

- `web/src/stores/monitor.ts`：`uncertainItems` 状态、`loadUncertainOutbox()`、
  `resolveUncertainOutbox(id, resolution, expectedRevision, providerMessageId?)`
  （409 时重读列表）。
- `web/src/pages/MonitorPage.tsx`：新增卡片——列表（id/kind/updatedAt/摘要）+
  「标已投递（须填 providerMessageId）」「标失败」操作，挂现有 10s 轮询，空态隐藏；
  权限沿用页面现有 `manage_system_config` 守卫。
- 测试（新增 `tests/frontend-monitor-uncertain-release.test.ts`，沿项目前端源码
  断言风格）：store 方法存在且调对端点、页面渲染放行操作、CAS 参数完整传递。

### 项 5：context_audit 方向登记（不实现）

- 在 `docs/issues/ISSUE-10-*.md` 登记决策 A 及接入要点：宿主在
  `container-runner.ts:1737-1812`（容器）与 `:2747-2754`（宿主机）构造完成后调
  `recordRunContextSnapshot`；注意快照键 `agentId ?? 'main'` 与 agent-profiles
  预览读取键的对齐、宿主 audit 无 `sdkContextUsage`。

### 项 6：下线 sdk_message_uuid（代码层）

- `src/db.ts`：INSERT 列/meta 写链、`:5696` 读取删除；`ensureColumn` 保留
  （物理删列登记 ISSUE-09）。
- `src/index.ts`：`:15563/:15645/:7853` 等 operationKey 分支删 uuid 取值（保留
  `sha256(text)` 回退）；WS 载荷与 meta 写点（`:4614/:7514/:7881/:10657/:14172/
:14995/:15200/:15350/:15375/:16256/:16312`）逐一清理。
- `src/session-workflows.ts`：删 `:556-566` 回补循环及失去唯一消费者的
  `loadSessionAssistantUsage` / `consumeTranscriptLine` / `aggregateAssistantUsage`；
  `attachSessionWorkflowRuns` 其余逻辑保留。
- `src/reply-delivery.ts:170`：uncorrelated-lifecycle 判定删 `sdkMessageUuid` 条件。
- `src/container-runner.ts:445`、`container/agent-runner/src/types.ts:321`、
  `src/types.ts:412`、`web/src/stores/chat.ts:59/244/3065` 删声明与透传。
- 测试：`session-workflows.test.ts` 删/改回补用例（159-230）；`reply-delivery.test.ts`
  调整 projection 组用例。
- `docs/issues/ISSUE-09-*.md` 登记 `messages.sdk_message_uuid` 列入迁移批。

### 项 7：workspace_memory_outbox 停写与清理

- `src/memory-store.ts`：`appendAuditAndOutbox` 拆为只写 `audit_events`；删
  `workspace_memory_outbox` 建表、INSERT 与相关类型/函数；存量行清理（按 store
  自身 schema 机制加 DROP TABLE 迁移；若该 store 无版本机制则 ensureSchema 阶段
  幂等 DROP——实现时以现状为准，原则：旧库行必须被清理、新库不再建表）。
- `audit_events` / `tombstones` 不动。
- 测试：`ckqclaw-owner-profile-store`、`routes-groups-rebuild-memory`、
  `schema-v65-workspace-memory` 三处计数断言同步；新增源码断言 outbox 不再被写。
- `docs/workspace-memory-v2.md` 同步（outbox 已下线、audit 线保留）。

### 项 8：删除 IPC refresh_groups handler

- `src/index.ts:12982-13004` case 删除（default 分支 warn 兜底，旧镜像不阻塞）。
- `tests/feishu-capability-outbox.test.ts:371-389` 源码切片边界改用下一稳定锚点。

### 项 9：file-text-extractor 接回三渠道

- `src/im-downloader.ts` 新增共享 helper（复刻钉钉 `buildFileContentBlock` 模式，
  参照 26b9c8c^ 的 dingtalk.ts:325-368）：下载落盘后尝试抽取，成功则输出
  `[文件: 相对路径]` + 随机长度 fence 包裹的抽取文本（20KB 截断、UTF-8 边界安全、
  防注入）；失败或不支持的扩展名仅保留路径标记。文件名清洗沿用 `sanitizeImFilename`。
- 三处接入：`feishu.ts:2652` 附近、`qq.ts:1177` 附近（非图片分支）、
  `wechat.ts:778` 附近（`processFileItem`）。
- 测试（新增 `tests/im-inbound-file-inline.test.ts` + 既有
  `file-text-extractor.test.ts` 保留）：helper 成功内联/失败回退/截断/fence 注入
  防护；三渠道源码断言已接入。

### 项 10：third_party 专属 Base URL 规则 + 删旧函数

- `src/schemas.ts` `UnifiedProviderCreateSchema` superRefine 追加：
  `type==='third_party'` 且 `anthropicAuthToken` 非空且 `anthropicBaseUrl` 为空 →
  报错（第三方供应商使用 Auth Token 时必须配置 Base URL）。official 的 token-only
  （官方 Bearer）继续放行——这是现行有意语义。补设口（UnifiedProviderSecretsSchema）
  若具备 type 上下文则同样校验，否则在写入路径校验，实现时定。
- `src/runtime-config.ts:1944-1965` 删 `validateClaudeProviderConfig`（零调用方；
  另一条 http(s) 规则已被 `normalizeBaseUrl` 与 `ProviderBaseUrlSchema` 双重覆盖）。
- 测试（新增 `tests/unified-provider-third-party-baseurl.test.ts`）：official
  token-only 放行、third_party token-only 拒绝、third_party token+base_url 放行、
  third_party base_url-only 放行（本地网关无鉴权场景）。

### 项 11：删除三个测试守护函数

- `src/isolated-task-ipc.ts:60-72` + `tests/isolated-task-ipc.test.ts` 两个用例
  （101-147；其余用例守护生产路径，保留）。
- `src/workspace-interaction-runtime.ts:67-75` +
  `tests/workspace-interaction-runtime.test.ts` 两个用例（269-315）。
- `src/agent-profile-runtime.ts:337-364` + `tests/agent-profile-runtime.test.ts`
  一个用例（225-288）。`getWorkspaceRuntimeJids` 仍被使用，保留。
- 删除后全仓 `git grep -w` 复核零残留引用。

### 项 12：runner 报错文案修正

- `container/agent-runner/src/pi-index.ts:432-436`：改为指明
  `AGENT_RUNTIME=claude` 已不支持、应设为 `pi` 或删除该变量。
- `container/agent-runner/src/runtime-config.ts:20-22`：`expected claude or pi`
  改为 `expected pi`；`tests/agent-runtime-migration.test.ts:17` 断言同步。

## 风险与应对

- 项 6 下线后 operationKey 全走 text-hash 回退——原 uuid 本就恒空，无实际幂等变化。
- 项 1 新设置默认 null（不限制）→ 升级后默认行为不变。
- 项 7 清理为单表 DROP，即时完成；audit/tombstones 不受影响。
- 项 9 内联文本增加 prompt 长度——20KB 截断与钉钉时代同设计，强模型同时保留路径
  标记不受损。
- 项 2/8 为对外契约收紧（410/删 case）——前者全仓无调用方，后者旧镜像仅 warn。

## 验收标准

- 12 项决策全部落地（项 5 为方向登记）；每项有测试锁定；
  `npm run verify`（六步门禁）与 `node scripts/check-scope.mjs` 通过。
- 决定删除的项（6/8/11）经全仓 `git grep -w`（含 tests/ 与 docs/）复核无残留消费者。
