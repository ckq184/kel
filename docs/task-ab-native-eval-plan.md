# 任务 AB 立项：原生评测中心（存档+聚合+看板，全内嵌）——交接文档

> **状态**：2026-11-11 用户批准立项（裁决见 §1，含对 langfuse 源码分析的取舍结论 §8）。实现未开始，新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行。事实均带文件行号（2026-11-11 取证，基线 `58c5061`；行号漂移以符号名为准）。
> **回滚点**：立项提交的父 HEAD `58c5061`（`.gatescope.json` 的 base；实现 diff 基线=立项提交）。
> **取代关系**：本任务**取代任务 AA**（`docs/task-aa-agent-observability-plan.md`，langfuse 外部栈路线，立项后未实现即转向）——AA 文档头部需加「已被任务 AB 取代」标注（批次 5）。已建成组件的去留见 §1-4。
> **前置条件**：评测 v2 已真机验收（`scripts/eval-auto-recall.ts` 零依赖 langfuse 客户端 + golden set + 指标函数，19 用例锁定；langfuse compose 栈按需起可用，提交 `fde3968`/`79cbc4a`）。

---

## 0. 一句话结论

把评测体系的「记分员+看台」从外部 langfuse 栈收编为 CKQClaw 原生能力：新建独立 `data/db/eval.db`（三张表，**不动 messages.db、不升 schema v74**），离线评测 run 与真实对话 turn 观测统一落库；runner 仅新增一个**无内容** `auto_recall` 流事件使召回注入可见；v1 含 glm-flash judge（版本化+熔断）；web 管理台新增「评测」页（离线 Runs 对比 + 真实对话 trace，后者仅 admin）。数据归仓、零新增运行时依赖、无常驻容器、默认关。

## 1. 已拍板裁决（2026-11-11 用户确认，无需再问）

1. **原生 eval.db 替代 langfuse 默认路径**：SQLite 新文件 `data/db/eval.db`（WAL，库内自版本化），服务器（写 obs）与脚本（写 runs）双进程安全；不碰 messages.db。
2. **看板 ACL**：「真实对话 trace」tab 仅 `manage_system_config` 权限（admin，对齐 Monitor 页先例 §2-4）；「离线 Runs」tab 所有登录用户可见。
3. **langfuse 组件保留为可选导出**：`scripts/eval-auto-recall.ts` 的 `--langfuse` 旗标与 `scripts/eval-langfuse.mjs` 起栈命令原样保留（代码已测、零维护成本），默认路径全走 eval.db；栈退役不常驻。
4. **v1 含 judge**（沿 AA 裁决）：`recall_utilized` 判分只评「注入过召回的 turn」，异步批量，独立开关默认关。
5. **内容模式默认=脱敏后全文**（沿 AA 裁决）：`full`（过 `redactLogMessage`）/`metadata`（零对话文本）可配。
6. **观测全局开关**（沿 AA 裁决）：`data/config/observability.json` 缺文件即整链路 no-op。
7. **吸收 langfuse 四点**（源码分析结论，§8 有完整取舍表）：judge 版本化落库（prompt hash+模型）、连续失败熔断（阈值 5，warn-once）、score 语义常量注册表、确定性 hash 采样钩子（v1 全量、钩子预留）。

## 2. 已取证事实（新会话无需重做）

| #   | 事实                                                                                                                                                            | 证据                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 评测 v2 组件可直接复用：指标纯函数/golden set/零依赖 langfuse 客户端/19 用例，真机验收（datasets 幂等、scores 裸数组、ingestion trace-create 等 v4 契约已踩平） | `scripts/eval-auto-recall.ts`、`tests/eval-auto-recall-metrics.test.ts`、验收记录（提交 `79cbc4a`） |
| 2   | 路由挂载先例：`app.route('/api/<前缀>', xxxRoutes)`，集中注册于 web.ts                                                                                          | `src/web.ts:269-276`（auth/groups/memory/auto-memory/config/tasks/skills…）                         |
| 3   | admin 页权限先例：`<AuthGuard requiredPermission="manage_system_config">` 包路由元素；lazy import 页面                                                          | `web/src/App.tsx:172-177`（/monitor）、`:68-69`                                                     |
| 4   | 侧边栏导航先例：nav-items.ts + UnifiedSidebar.tsx                                                                                                               | `web/src/components/layout/nav-items.ts`、`UnifiedSidebar.tsx`                                      |
| 5   | turn 生命周期宿主汇聚点：TurnOutputCoordinator / ActiveTurnOutputRegistry；runner stdout 路由 host-ipc-output-router。**挂点行号批次 4 开工二次取证**           | `src/turn-output-coordinator.ts:67,410`、`src/host-ipc-output-router.ts`                            |
| 6   | usage 数据源：`insertUsageRecord`（model/tokens/cost/duration）；调用方在流处理/输出落库路径，批次 4 定位                                                       | `src/db.ts:3576`                                                                                    |
| 7   | 流事件类型真相源：eventType 联合含 `'memory_recall'`（displayLevel detail + isSynthetic 的每轮快照事件先例）；改动后必须 `make sync-types`                      | `shared/stream-event.ts:27,290`、AGENTS.md §2                                                       |
| 8   | 前端事件容忍性：chat store 有前缀路由与 default 分支——新 eventType 预计被忽略，**批次 4 验证** `web/src/stream-event.types.ts` 与 switch default                | `web/src/stores/chat.ts:1077-1124`                                                                  |
| 9   | 宿主脱敏真相源（full 模式复用）：`redactLogMessage`                                                                                                             | `src/logger.ts:54`                                                                                  |
| 10  | judge LLM 端点：`getAutoMemoryHostConfig().llm`（glm-flash，OpenAI 兼容）已配置可用；host 配置文件先例（env 优先+文件+缺省关+0o600）                            | `src/auto-memory-config.ts`                                                                         |
| 11  | SQLite 已在依赖内（better-sqlite3 ^12.10）；WAL 多进程写为既有能力，主库已用 WAL。**运行时依赖零新增成立**                                                      | `package.json`、`src/db.ts`                                                                         |
| 12  | 表格/页面先例：MonitorPage、MemoryPage（Radix 表格 + 筛选，前端文件断言+DOM 测试先例）                                                                          | `web/src/pages/`、`tests/agent-governance-section-dom.test.tsx` 等                                  |

## 3. 方案设计

### 3.1 数据流（目标形态）

```
离线评测执行器 scripts/eval-auto-recall.ts ──默认写──▶ eval.db（eval_runs / eval_run_items）
                                     └──可选导出──▶ langfuse（--langfuse，既有路径不动）
runner ──无内容 auto_recall 事件──▶ 宿主 turn-observer ──写──▶ eval.db（obs_turns）
agent 运行时（每轮 turn 元数据/usage/脱敏内容，异步有界队列，默认关）──┘
                                                    │
              GET /api/eval/runs|runs/:id|comparison|turns ──▶ web「评测」页
                                                    │
              recall-judge（异步批，默认关）──写 judge 列──▶ obs_turns
```

### 3.2 eval.db schema（`src/eval-store.ts` 自版本化，PRAGMA user_version=1）

- `eval_runs(id TEXT PK, name, kind TEXT DEFAULT 'recall', k INTEGER, config_json, summary_json, judge_prompt_hash, judge_model, created_at)`——一次离线评测一行；summary 存聚合结果（复算可校验）。
- `eval_run_items(id INTEGER PK, run_id REFERENCES eval_runs, query_id, category, expected_json, retrieved_json, recall REAL, hit INTEGER, mrr REAL, precision REAL, latency_ms INTEGER, note)`。
- `obs_turns(turn_id TEXT PK, session_id, workspace_jid, folder, channel, interaction_mode, auto_recall_enabled INTEGER, recall_injected INTEGER, recall_hit_count INTEGER, recall_latency_ms INTEGER, input_text, output_text, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER, judge_used INTEGER, judge_reasoning, judge_error, judge_prompt_hash, judge_model, created_at)`——input/output 在 metadata 模式为 NULL；judge 列由批次 5 补写。
- **SCORE_DEFINITIONS 常量注册表**（导出）：recall/hit/mrr/precision/recall_injected/recall_utilized/turn_latency_ms/turn_tokens 的名称·类型·范围，前后端共用。

### 3.3 新模块（全部宿主侧）

- `src/eval-store.ts`：开库/建表/自版本迁移；类型化 upsertRun(+items)、insertTurn/updateTurn、聚合查询（run 对比、turns 筛选分页）；导出 SCORE_DEFINITIONS。
- `src/observability-config.ts`：`data/config/observability.json` `{enabled, contentMode?: 'full'|'metadata', judge?: {enabled}}` + env `CKQCLAW_OBSERVABILITY_*` 覆盖；缺文件=关（§1-6）。
- `src/turn-observer.ts`：单例；`onTurnStart/onStreamEvent/onTurnComplete`；内部有界队列（1000）+ 批量写 eval.db；**公开方法全同步、内部全 catch、绝不上抛**；full 模式内容过 `redactLogMessage`。
- `src/recall-judge.ts`：扫「已完结且 recall_injected=1 且 judge_used IS NULL」的 turn，批量调 glm-flash 结构化判分 → 写 `judge_used/judge_reasoning/judge_prompt_hash/judge_model`；连续失败 5 次熔断（warn-once，复位靠重启或 config 变更）；judge 自身直调端点不经对话通道——**天然无自指循环**（代码注释钉住）。
- `src/routes/eval.ts`：`GET /runs`、`GET /runs/:id`（含 items）、`GET /comparison`（多 run 指标并排）、`GET /turns`（admin 权限中间件，分页+workspace/channel 筛选）。

### 3.4 前端

`web/src/pages/EvalPage.tsx`（lazy）：Tab1「离线评测」= run 列表（时间/k/总体指标）→ 详情（逐条 expected vs retrieved + note）→ 多选对比；Tab2「真实对话」（仅 `manage_system_config`）= obs_turns 表（工作区/渠道/召回注入/judge/耗时/token 筛选）→ 行展开（full 模式脱敏全文 + judge reasoning）。路由 `/eval`（App.tsx，沿 §2-3 先例），侧边栏入口（nav-items.ts）。

## 4. 执行顺序（TDD，每批次先写测试见红再实现）

1. **批次 1 存储底座**：`tests/eval-store.test.ts` 见红（临时目录真 SQLite：建表/自版本/写入/聚合/双连接并发写）→ `src/eval-store.ts` + `src/observability-config.ts`。
2. **批次 2 评测落库+API**：`tests/eval-routes.test.ts` 见红（401/权限/形状）→ 执行器默认写 eval-store（`--langfuse` 可选导出保留）→ `src/routes/eval.ts` + `src/web.ts` 挂载。
3. **批次 3 看板前端**：前端测试见红（文件断言+DOM，沿 §2-12 先例）→ `EvalPage.tsx` + App.tsx 路由 + nav-items 入口。
4. **批次 4 观测接线**：先二次取证挂点（§2-5/6/8）→ `tests/turn-observer.test.ts` + 扩展 `tests/auto-recall-context.test.ts` 见红 → `shared/stream-event.ts` 加 `'auto_recall'` + `make sync-types` → runner 三调用点 emit（复用 memory_recall 模式，**零用户内容**）→ `src/turn-observer.ts` 接 turn 生命周期 + auto_recall 事件 → 前端容忍性验证（§2-8）。contract 钉死：观测关=no-op 零写库、异常不上抛、metadata 模式无文本。
5. **批次 5 judge+文档+门禁**：`tests/recall-judge.test.ts` 见红（mock LLM：结构化解析/只评注入过的/熔断/失败记账）→ `src/recall-judge.ts`（§3.3，含 hash 采样钩子 `sampleByTurnId(turnId, rate)` 预留）→ AA 文档标取代 + AGENTS.md（§2 架构/命令表加配置说明）+ CLAUDE.md（配置节）→ `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - 原生评测中心（任务AB）`（push 由用户发起）。

## 5. 文件清单（= `.gatescope.json` allow；实现期确需扩宽按宪法流程改声明并在提交信息说明）

新增：`docs/task-ab-native-eval-plan.md`、`src/eval-store.ts`、`src/observability-config.ts`、`src/turn-observer.ts`、`src/recall-judge.ts`、`src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-store.test.ts`、`tests/eval-routes.test.ts`、`tests/turn-observer.test.ts`、`tests/recall-judge.test.ts`、`tests/eval-frontend.test.ts`
修改：`docs/task-aa-agent-observability-plan.md`（标取代）、`scripts/eval-auto-recall.ts`（默认原生落库）、`src/web.ts`（路由挂载）、`src/turn-output-coordinator.ts`、`src/host-ipc-output-router.ts`、`src/container-runner.ts`（turn 元数据，若取证后挂点不同以此三者为准调整）、`src/index.ts`（scheduled turn 元数据，同上）、`shared/stream-event.ts`、`container/agent-runner/src/auto-memory-context.ts`、`container/agent-runner/src/index.ts`、`container/agent-runner/src/pi-index.ts`、`tests/auto-recall-context.test.ts`、`tests/eval-auto-recall-metrics.test.ts`（如受影响）、`web/src/App.tsx`、`web/src/components/layout/nav-items.ts`、`web/src/stream-event.types.ts`（sync-types 产物源头）、`web/src/stores/chat.ts`（仅当 default 分支不容忍新事件时最小改动）、`AGENTS.md`、`CLAUDE.md`
（不动：messages.db schema、runner 依赖与密钥边界、`scripts/eval-langfuse.mjs`、评测 v2 的 langfuse 导出路径。）

## 6. 风险与边界

1. **双进程写 eval.db**：服务器（obs）与脚本（runs）并发——WAL+busy_timeout 兜底，批次 1 测试覆盖双连接并发；仍属新风险面（主库从未被脚本进程写过，本设计正是为此独立文件）。
2. **隐私**：obs_turns 存脱敏后对话全文——默认关 + metadata 可切 + trace tab 仅 admin（§1-2/5）；看板行展开明示「脱敏后内容」。
3. **前端工作量**：批次 3 是最大块，全复用 Monitor/Memory 先例压风险；若超预算可先交 Tab1 再补 Tab2（一次提交内不分批提交）。
4. **三侧类型同步**：auto_recall 走 `make sync-types`；前端容忍性是待验证假设（§2-8）。
5. **挂点漂移**：批次 4 开工先按符号二次取证（§2-5/6）；scheduled turn 与交互 turn 的元数据完整性差异如实落库（缺字段 NULL，不造默认值）。
6. **观测成本**：随主服务常驻（每轮一行写库+偶发批量 judge 调用），比 langfuse 栈轻两个量级；默认关由用户权衡开启。
7. **judge 偏差**：LLM 评估固有；版本列+reasoning 落库供人工抽查；熔断防故障放大。
8. **日志纪律**：observer/judge 的 warn-once 只带计数与错误类别，不带对话内容与密钥。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`。
- 真机验收（用户执行）：
  1. `npm run eval:auto-recall -- --k 5` 与 `-- --k 10` 各一次 → 「评测」页 Tab1 出现两条 run，可进详情、可并排对比；
  2. 写 `data/config/observability.json`（enabled, contentMode=full）重启 → web 聊两轮（一轮聊记忆相关话题触发自动召回）→ Tab2 出现两条 turn：recall_injected/token/耗时齐全，full 模式可见脱敏后消息与回答；member 账号看不到 Tab2；
  3. `judge.enabled=true` → 再聊一轮相关话题 → 稍候该 turn 出现 judge_used 与 reasoning；
  4. 删配置重启 → 对话零差异、eval.db 无新增 obs 行；
  5. `contentMode=metadata` → obs 行无对话文本但指标齐全；
  6. IM 渠道（飞书/Telegram 任一）行为一致。

## 8. 与 langfuse 架构对照（防未来窗口重复纠结；2026-11-11 源码分析结论）

| langfuse 组件                                    | 本方案等价物                                         | 取舍理由                                       |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| Evaluator/Version 版本化                         | judge_prompt_hash+judge_model 落库                   | 拿版本化收益，不付配置系统成本                 |
| EvaluationRule 规则引擎（filter/sampling/delay） | 一条硬编码规则：judge 只评 recall_injected=1 的 turn | 单一场景无需可配置引擎                         |
| 确定性采样                                       | sampleByTurnId(turnId, rate) hash 钩子（v1 全量）    | 个人体量全量；钩子保证将来抽样可复现           |
| S3 快照隔离 + 独立 eval 队列                     | obs_turns 行即快照；同进程异步批                     | 单机无需跨进程快照与队列                       |
| CODE 沙箱执行器 / DecisionModel                  | 无（唯一执行器=judge）                               | 「用户上传评测代码」是平台场景，CKQClaw 不需要 |
| EvaluatorBlockReason 熔断                        | 连续失败 5 次 warn-once 熔断                         | fail-closed 思想的最小实现                     |
| ScoreConfig 注册表                               | SCORE_DEFINITIONS 常量                               | 防命名漂移的最小形态                           |
| ClickHouse+分析面板                              | SQLite+EvalPage                                      | 量级匹配（个人部署每天几百 turn）              |
| 防自指循环（environment 标记）                   | 天然免疫（judge 直调端点不走对话通道）               | 架构差异的免费收益                             |
