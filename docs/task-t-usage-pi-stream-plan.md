# 任务 T 立项：修复用量分析数据断流 — Pi 运行时补发 usage 流事件 + 用量页自动刷新

> **状态**：2026-11-09 用户批准执行；runner 侧 + 前端已落地（全量测试绿），§6 隔离任务宿主侧路由已补（见 §6 完成记录），待门禁收尾。
> **回滚点**：`3ec8257`（任务T提交前 HEAD，已写入 `.gatescope.json`；其间插入的用户自有提交：任务U 综述回退 `55eeea2`、任务O 收尾 `1276f01`、任务S 立项 `3ec8257`，均不触碰本任务文件；runner 侧 WIP 始于 `6674b68`）。
> **创建**：2026-11-09。实现会话：ZCode（本地 macOS arm64）。

---

## 0. 一句话结论

生产 runner 已切换为 Pi 运行时，但 Pi 路径**从不产生 `eventType:'usage'` 流事件**，而宿主所有用量/计费/配额落库只由该事件驱动 → `usage_events`/`usage_records` 自 Pi 上线起零新增，用量分析页数据冻结。修复 = 在 Pi 路径把整轮 assistant 消息的 usage 聚合后，于最终输出前补发一条与 Claude 路径同构的 usage 流事件（宿主零改动）；另按用户要求给 `/usage` 页补自动刷新。

## 1. 现象与背景

- `/usage` 用量分析页数据不再更新（含全渠道：Web/IM/定时任务）。
- 同步停摆面：用量统计、`messages.token_usage` 重建、配额账（monthly/daily usage）、钱包扣费。

## 2. 根因链（代码取证，新会话无需重做）

| #   | 环节                                                                                                                | 证据（file:line）                                                                                                 |
| :-- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | 生产入口固定为 Pi：`pi-index.ts` fail-fast 非 Pi 配置                                                               | `src/container-runner.ts:2781`（`dist/pi-index.js`）；`pi-index.ts:438-442`                                       |
| 2   | `mapPiEvent` 不构造 `{type:'usage'}` RuntimeEvent → `pi-runner.ts` 的 `case 'usage'` 映射是死代码                   | `runtime/pi/pi-session.ts:51-155`；`runtime/pi/pi-runner.ts:128-144`（claude-runtime.ts 亦无 usage → 双侧死代码） |
| 3   | `publishResult` 发最终输出时丢弃 `RuntimeResult.usage`                                                              | `runtime/pi/pi-runner.ts:246-269`（ContainerOutput 无 usage 字段）                                                |
| 4   | 宿主写入点全部以 `streamEvent.eventType === 'usage'` 为条件                                                         | `src/index.ts:7447/:7850/:15666/:15865` → `writeUsageRecords`（:2394）→ `usage-service.ts:121 recordUsageEvent`   |
| 5   | 次要缺陷：现有 `usageFromMessage` 只取**最后一条** assistant 消息 usage，工具调用多轮场景漏计                       | `runtime/pi/pi-session.ts:31-49,130-151`                                                                          |
| 6   | 次要（前端）：`UsagePage` 仅挂载/URL 变化/手动按钮时拉取，常开不自动刷新（对照 `UsageBars.tsx:64-96` 已有轮询模式） | `web/src/pages/UsagePage.tsx:407-412`                                                                             |

Pi `AssistantMessage`（pi-ai `types.d.ts:362-392`）每条自带 `usage:{input,output,cacheRead,cacheWrite,cacheWrite1h?,reasoning?,cost}`、`model`/`responseModel`、`timestamp`/`durationMs` —— 数据在 runner 内可得，只是未被转发。

## 3. 方案（初始前提「宿主 `src/` 零改动」已被 §6 打破并修订：最终含 `src/task-usage.ts` 新增 + `src/task-scheduler.ts` 一处接入，见 §6）

### 3.1 `runtime/types.ts`：`RuntimeUsage` 增加两个可选字段

`eventId?: string`（宿主账本幂等键种子）与 `modelUsage?: Record<string, {…同名字段}>`（按模型归因）。runner 内部契约，非三侧同步类型，不触发 `make sync-types`。

### 3.2 `pi-session.ts`：`agent_end` 整轮聚合（替换只取最后一条的 `usageFromMessage`）

新增导出纯函数 `aggregatePiTurnUsage(messages, sessionId)`：

- 遍历本轮全部 `role==='assistant'` 且带 usage 的消息；
- **reasoning 从 output 拆分**：Pi 语义 `reasoning ⊂ output`（pi-ai types.d.ts:286-291 注释明示），宿主口径两者不重叠（参照 Claude 路径 `assistant-usage.ts:218-229` 的拆分），`output = output - reasoning`（下限 0）；
- **cacheWrite1h 不重复累计**：Pi 注释明示其为 `cacheWrite` 的子集（拆分口径而非增量），只取 `cacheWrite`；
- `modelUsage` 按 `responseModel || model || 'unknown'` 分桶；root 总量为各桶之和；
- `durationMs = Σ message.durationMs`（缺省 0），`numTurns = assistant 消息数`；
- `eventId = pi:<sessionId>:<首条 assistant 的 timestamp>`（跨 runner 重放/会话恢复稳定，宿主 `usage_events` 主键幂等去重）。

### 3.3 `pi-runner.ts`：`publishResult` 在最终输出前发 usage 流事件

`result.usage` 存在时，先 `emit({status:'stream', streamEvent:{eventType:'usage', usage:{eventId, 六类 token, costUSD, durationMs, numTurns, modelUsage}}})` 再发 success/error（与 Claude 路径顺序一致：先落账本再出结果）。`case 'usage'` 死映射保持不动（最小范围）。

### 3.4 `web/src/pages/UsagePage.tsx`：自动刷新

仿 `UsageBars.tsx:64-96`：`setInterval`（60s）+ `visibilitychange`（仅 visible 时拉取），只刷 `loadStats(query)`（filters 低频不动）；store 已有 requestId 竞态丢弃（`stores/usage.ts:606-607,641-664`），天然防重。

## 4. 测试与验收

- **TDD 先行**：`tests/pi-usage-stream.test.ts` 新建（聚合正确性：多消息求和/reasoning 拆分/cacheWrite1h 子集/分桶/空轮；发射契约：usage 先于 success、字段形状对齐 `shared/stream-event.ts:401-426`、eventId 幂等稳定）；`tests/frontend-usage-experience.test.ts` 扩展（自动刷新存在性断言，沿用源检查模式）；§6 缺口补 `tests/task-usage-routing.test.ts`（宿主侧路由 + DB 落库 + eventId 幂等）。
- **门禁**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。
- **真机验收（用户执行，实现/审查分离）**：`make dev` → 发一轮对话 → 打开 `/usage` 或点「刷新数据」→ 当日新增记录且 token/费用 > 0。

## 5. 风险与边界（立项时已知）

1. **计费正确性（钱）**：reasoning/cacheWrite 双计会多扣费 → 拆分逻辑由测试锁定；eventId 幂等防重复落账。
2. **重试边界**：Pi `agent_end` 可带 `willRetry` 重跑；重放场景同 eventId 被宿主去重，**宁少计不多计**（安全方向）。
3. **中断轮口径**：interrupted 轮已产生的 API 用量照发照计（与 Claude 路径一致）。
4. **归因降级**：model 缺失时宿主落 `unknown` 桶（`kaboo-pricing.ts:304-306`），总量统计不受影响。
5. **已知局限（本任务不做，如需另立任务）**：子代理 token 未透出（`PiSubAgentAdapter` 无 usage），只计主循环；Pi 期间历史用量从未产生，无法回补。
6. **前端轮询压力**：60s 一次轻量 SQL 聚合（无缓存层），页面不可见时跳过，可忽略。

## 6. 验收发现缺口（2026-11-09 取证，同日已修复）：隔离定时任务 usage 未落库

> 发现会话：任务 U（综述回退）真机冒烟后的日志/DB 取证。本节自包含，新会话无需重做侦查。

**现象**：runner 侧修复生效（定时任务轮已在日志产生 usage 事件），但隔离任务（`context_mode='isolated'`）的 usage **只进日志、不落库**——`usage_events`/`usage_records` 仅出现 web 会话行。

**证据链**：

- 定时任务 `6a3bf2`（新浪新闻汇总，once 15:00+0800）→ task_run `0217ec`（backfill，07:00:00.010Z–07:01:34.429Z，success）。
- Runner 日志 `data/groups/main/logs/host-2026-11-09T07-01-34-459Z.log:41`：`eventType:'usage'`，eventId `pi:01a1bf1b-…:1794207602196`，in 55,679 / out 3,230 / cacheRead 50,112，glm-5.3-flash，4 turns。
- DB `usage_events` 仅有两行 web 来源（05:22:33Z、06:25:13Z，sessionId `01a1be4f-…`）；上述 eventId 查无（未落库）。

**根因（已定位到行）**：`src/task-scheduler.ts` `runTaskInner` 的流回调（原 :1356-1360）对 `status==='stream'` 只做 `deps.broadcastStreamEvent`（WebSocket 广播），`eventType==='usage'` 事件无人消费；群聊路径的 `writeUsageRecords`（`src/index.ts:7447` 等 4 处）只挂在 `processGroupMessages`/`processAgentConversation` 两个循环上，隔离任务（`context_mode='isolated'` → `runTaskInner` 直跑 runner，不进群聊循环）天然绕开。**本缺口打破 §3「宿主 src/ 零改动」前提，已按下述方案修订。**

**修复（TDD，2026-11-09 完成）**：

1. 新增 `src/task-usage.ts`：`recordIsolatedTaskUsage(streamedOutput, context)` —— `eventType==='usage'` 的流事件路由进 `recordUsageEvent`（usage-service 唯一账本入口），`source='task'`，非 usage 输出返回 null 不触碰账本。
2. `src/task-scheduler.ts` `runTaskInner` 流回调接入（broadcast 之后、结果定稿之前），try/catch + warn：账本失败不杀任务运行（与群聊路径同口径）。
3. **userId 归属口径（对 §6.1 初稿的修订）**：`workspaceOwnerId ?? taskOwnerId ?? 'system'` —— 计费/配额归**任务执行所在工作区的 owner**，而非任务创建者。依据 `runTaskInner` 内既有 scoping 原则（task-scheduler 原 :1017-1026 注释：admin 跨组创建的任务必须按成员工作区计费/门禁，taskOwnerId 仅作展示归因）+ 群聊路径同构（`effectiveGroup.created_by`）。若按初稿取 `created_by`，admin 创建的跨组任务会因 admin 计费豁免而漏扣成员工作区费用。
4. 幂等：复用 runner 提供的 eventId（`pi:<sessionId>:<timestamp>`）作 `usage_events` 主键；任务重试/续跑/流重放同 key 去重，宁少计不多计（同 §5-2）。
5. 测试：`tests/task-usage-routing.test.ts`（4 用例：source='task' 落库含模型行与 num_turns、同 eventId 重放 inserted=false 且行数不增、非 usage 输出/终态结果零触碰、无 owner 回退 system），沿用 `usage-accounting.test.ts` 的临时 DB 模式。
6. 验收补充（§4 扩项，用户真机执行）：跑一个 isolated 定时任务 → `usage_events` 新增 `source='task'` 行 → `/usage` 页来源归因可见 `task`。
7. 立项程序：`.gatescope.json` 任务声明已补（task=任务T，base=`55eeea2`，allow 覆盖 runner/宿主/测试/文档路径），与既有 WIP 一并按 Golden Path 收尾（verify 六步 + check-scope + 单提交）。
