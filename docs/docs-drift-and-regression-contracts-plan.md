# 文档漂移修正与防回归契约测试立项（ISSUE-13）

> 任务来源：`docs/issues/ISSUE-13-docs-drift-and-regression-contracts.md`（审查报告 §11、§13 防回归建议）。
> 回滚点：`eb1768c`（开工前 HEAD，见 `.gatescope.json` 的 `base`；分支 `issue-13`）。
> 需用户决策：无（issue 标注"否"）。范围裁定按 issue 原文执行，见下"范围与遗留"。

## 范围与遗留

issue 的 A（文档漂移）中有 4 个子项被 issue 原文显式挂到未完成 issue 的结论上，
本次**不做**，登记为遗留（由对应 issue 的实现提交顺带更新文档）：

| 遗留子项                                                        | 等待             | 原因                                                |
| --------------------------------------------------------------- | ---------------- | --------------------------------------------------- |
| A.1 `CLAUDE.md` "上下文窗口声明"行（常见修改入口表）            | ISSUE-04         | issue 依赖字段明示该项等 04 结论                    |
| A.2 `docs/API.md:77` `GET\|PUT /:jid/mcp` "不持久化"描述        | ISSUE-07 第 2 项 | 0410/删路由两案都会改写该行，先改必返工             |
| A.2 `/api/config/user-im/*` "旧客户端兼容"标注                  | ISSUE-11         | 11 决定兼容层去留，标注随结论定                     |
| A.2 `docs/API.md` uncertain outbox "人工放行"（528-536 行一带） | ISSUE-07 第 4 项 | 补 Web 入口 vs 保留 curl+写清文档，两案文档改法不同 |

本次执行的子项：A.2（补 4 条未文档化路由、投影接口标注用途）、A.3（WEB_PORT）、
A.4（11 个环境变量）、A.5（三处过时注释）、B（三个防回归契约测试）。

## 目标（What & Why）

1. **文档对齐现状**（真相源是代码）：4 条有 Web 调用方却未写进 `docs/API.md` 的
   路由补录并同步 ACL；两条无调用方的投影接口在 API.md 声明用途（治理/运维）；
   `WEB_PORT` 默认值按 `src/config.ts:61` 统一为 3001；11 个代码读取但未文档化的
   环境变量补入 `CLAUDE.md` §9；三处与事实不符的注释改为如实描述。
2. **防回归契约测试**（宪法第 9 条"规范代码化"，落在 `npm run verify` 第 4 步
   vitest 内，不改动六步结构）：
   - **B.1 StreamEvent 生产者覆盖**：`shared/stream-event.ts` 的每个
     `StreamEventType` 在 runner（pi-runner/pi-index/mcp-tools）或宿主 `src/`
     中至少一个生产者，否则必须进白名单（每条注 issue 号）；
   - **B.2 IPC 类型双向覆盖**：`mcp-tools.ts` 发出的每个 IPC `type` 在
     `src/index.ts` 有处理分支，反向每个处理分支有发送方，否则白名单；
   - **B.3 路由与调用方双向一致**：Web 调用的每个 `/api/...` 路径必须有后端路由；
     后端路由无 Web 调用方时必须在 `docs/API.md` 声明（存在即声明用途），否则白名单。
   - 白名单条目随对应 issue 完成而删除；测试断言白名单不包含已不成立的条目
     （防白名单腐化）。失败信息提示"删除生产者/路由时必须同步处理消费端/调用方"。

## 非目标

- 不修改任何路由、IPC、事件的生产/消费行为（除三处纯注释修正）。
- 不修改 `scripts/verify.mjs` 六步结构（由 `tests/verify-gate-contract.test.ts` 锁定）。
- 不处理上表 4 个遗留子项；不修改 `shared/stream-event.ts`（测试只读它）。
- 不给 4 条补录路由新增行为测试（路由本身已有实现与测试，本次只补文档）。

## 修改文件范围

| 文件                                                         | 改动                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `CLAUDE.md`                                                  | §9 表：`WEB_PORT` 3000→3001；补 11 个环境变量行                           |
| `README.md`                                                  | 第 238 行 `WEB_PORT` 默认值 3000→3001                                     |
| `docs/API.md`                                                | 补 4 条路由；投影接口两行标注用途与"Web 暂无调用方"                       |
| `docs/ACL-MATRIX.md`                                         | §4.3 补 `delete-impact` 一句（其余 3 条已被路由族通配行覆盖，不改）       |
| `src/group-queue.ts`                                         | 仅注释：`isActiveRunnerTask` 注释去掉"message loop 在用"的不实说法        |
| `src/db.ts`                                                  | 仅注释：`claimTaskRunNotificationById` 注释去掉"targeted recovery"        |
| `web/src/stores/chat.ts`                                     | 仅注释：`sendMessage` 内 streaming 清理路径注释更正（agent_reply 无订阅） |
| `tests/stream-event-producer-contract.test.ts`（新增）       | B.1                                                                       |
| `tests/ipc-type-bidirectional-contract.test.ts`（新增）      | B.2                                                                       |
| `tests/api-route-caller-contract.test.ts`（新增）            | B.3                                                                       |
| `docs/issues/ISSUE-13-*.md`、`docs/issues/README.md`、本文件 | 领取登记与立项落档                                                        |

## 方案与测试设计

### A.2 补录的 4 条路由（均已核实实现与 Web 调用方）

| 路由                                           | 语义（依据源码）                                                                                        | ACL 归属                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `POST /api/agent-profiles/:id/runtime-cleanup` | 重试 Agent 配置变更后遗留的运行时清理（quiesce 失败时 UI 提示重试）；`runtime_cleanup_pending` 时可重试 | §3 `/api/agent-profiles/*` 已覆盖            |
| `PUT /api/config/claude/default`               | 设置所有继承型 Agent 的默认模型配置；切换会停稳相关 Runner，失败 503 带 `persisted`                     | §6 Provider 行（manage_system_config）已覆盖 |
| `GET /api/groups/:jid/delete-impact`           | 删除工作区前的渠道绑定/任务影响面检查；要求 `canDeleteGroup`，仅 `web:` 工作区                          | §4.3 补一句                                  |
| `POST /api/tasks/purge`                        | 回收站任务批量永久删除（revision CAS；script 任务仅 admin；有活跃 run 时 409）                          | 定时任务语义，§10 已有同源 IPC 面；不改      |

投影接口（API.md 197-201 行一带）标注：`/:jid/runtime-sessions` 与
`/:jid/channel-mounts` 为治理/运维投影（仅 owner/管理员），当前 Web UI 未调用。

### A.4 环境变量（默认值均经源码取证）

`RECALL_MODEL`（未设置回落默认模型）；`CKQCLAW_ASSISTANT_NAME`/`ASSISTANT_NAME`
（别名链，默认 `CKQClaw`）；`ALLOW_LEGACY_UNSIGNED_COOKIE`（默认 false，旧 cookie
在线升级开关）；`CORS_ALLOW_LOCALHOST`（默认 true，WS Origin 额外放行 localhost）；
`CKQCLAW_WEB_URL`/`PUBLIC_BASE_URL`/`WEB_BASE_URL`（三者择一生效，渠道卡片外部
trace 链接 base，未设置不生成）；`CONTAINER_MAX_OUTPUT_SIZE`（默认 10485760）；
`EXTERNAL_CLAUDE_DIR`（默认空）；`ADMIN_HOST_ONLY_MODE`（默认 false）；
`MAIN_AGENT_CONTEXT_SOURCE`（默认 `host_claude`）；`CKQCLAW_MIGRATION_BACKUP_DIR`
（默认 `<db目录>/migration-backups`）。其中 runtime-config 读取的 4 个注明
"Web 持久设置 > 环境变量 > 默认值"的优先级归属。

### B.1 生产者扫描口径（已全仓取证）

- 类型词汇表：正则提取 `shared/stream-event.ts` 的 `StreamEventType` 联合成员。
- 生产者扫描：`container/agent-runner/src/runtime/pi/pi-runner.ts`、
  `pi-index.ts`、`mcp-tools.ts` + 宿主 `src/**/*.ts`（排除 `src/stream-event.types.ts`
  同步副本与 `*.test.ts`），匹配 `eventType: '<type>'` 字面量构造
  （全仓核实无动态 `eventType` 赋值的生产路径）。
- 现状：9 类有生产者（text_delta、thinking_delta、tool_use_start、tool_progress、
  tool_use_end、usage、status、compact_boundary、task_progress，与审查 §4.1 一致），
  15 类缺口进白名单：`raw_sdk_event`→ISSUE-02/10；`tool_result`、`task_start`、
  `task_updated`、`task_notification`→ISSUE-03/10；`context_audit`→ISSUE-07(5)/10；
  `hook_started/progress/response`、`init`、`permission_denied`、`memory_recall`、
  `notification`、`prompt_suggestion`、`todo_update`→ISSUE-10。

### B.2 IPC 双向扫描口径（已全仓取证）

- 发送方（`mcp-tools.ts`）：`type: '<lit>'`（排除 `as const` 内容块字面量，只剩
  请求类型）∪ `callAgentBuilder('<lit>'`（7 个 agent*profile*_/agent*capability*_）。
- 处理方（`src/index.ts`）：`switch (data.type)` 顶层 `case`（按花括号深度过滤嵌套
  的 operation 分支）∪ `data.type === '<lit>'` 条件分支。
- 现状与审查一致：仅 `refresh_groups` 有处理无发送 → 白名单挂 ISSUE-07 第 8 项。

### B.3 路由/调用方扫描口径

- 后端路由：`src/web.ts` 的 `app.route('<prefix>', <var>)` 挂载表 + 各
  `src/routes/*.ts` 的 `<var>.<method>('<path>'`（容忍换行与泛型）+ web.ts 内联
  3 条 `app.<method>('/api/...')`。
- Web 调用方：`web/src/**/*.{ts,tsx}` 的 `api.<method>(\`...\`)`、`apiFetch(...)`
字面量/模板串；`:param`、`${...}`归一为`\*` 后按段匹配（尾部通配吸收多段）。
- 已知缺口白名单：`PUT /api/channel-accounts/:id/paired-chats/:jid`（Web 侧调用、
  后端无路由）→ ISSUE-06 第 3 项。实现期若扫描出新缺口：登记交付记录并逐条挂
  issue 号，不静默放行。

### 白名单治理（三个测试共用约定）

- 每条白名单必须注 issue 号；对应 issue 完成后删条目。
- 测试反向断言：已有生产者/发送方/路由的条目不得留在白名单（防腐化）。
- 失败信息包含指引："删除生产者/路由时必须同步处理对应消费端/调用方，或挂 issue
  进白名单"。

## 风险与应对

- **B.3 误报**（模板串拼接路径、动态方法）：实现期用全量扫描输出逐条人工核对；
  确属调用方缺陷的进白名单挂 issue，不放宽匹配规则来"制造通过"。
- **B.1/B.2 源码扫描脆弱**：以"结构锚点存在"为前置断言（如 `switch (data.type)`
  恰好 1 处、StreamEventType 块存在），锚点漂移时测试红并提示更新扫描器，
  而不是静默漏扫。
- 文档改动执行 `npm run docs:check`；不触碰 `shared/stream-event.ts`，无需 sync-types。

## 验收标准（对齐 issue）

- `npm run docs:check` 与 `npm run verify` 通过；三个契约测试落地，白名单每条有
  issue 号；`node scripts/check-scope.mjs` 通过。
- 白名单"可红性"验证：实现期临时删一条白名单/注一个假缺口，确认测试确实变红
  （证据记入交付记录），再复原。
