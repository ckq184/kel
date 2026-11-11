# 任务 AA 立项：agent 内评测集成（LLM 可观测性 + judge）——交接文档

> **⚠️ 已被任务 AB 取代（2026-11-11）**：本任务的 langfuse 外部栈路线已被 `docs/task-ab-native-eval-plan.md`（原生评测中心：eval.db + 内嵌看板）取代——立项后未实现即转向，本文档仅存档设计裁决与取证结论。AA 中的可复用结论（脱敏/默认关/judge 版本化）已被 AB §1 吸收；langfuse 评测 v2 组件（`scripts/eval-auto-recall.ts` 的 `--langfuse` 可选导出与 `scripts/eval-langfuse.mjs`）保留为可选路径。后续开发一律以 AB 文档为准。

> **状态**：2026-11-11 用户批准立项（三项设计裁决已拍板，见 §1）。实现未开始，新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行。事实均带文件行号（2026-11-11 取证，基线 `79cbc4a`；行号漂移以符号名为准）。
> **回滚点**：立项提交的父 HEAD `79cbc4a`（`.gatescope.json` 的 base；实现 diff 基线=立项提交）。
> **前置条件**：评测 v2 已就绪（`scripts/eval-auto-recall.ts` 零依赖 langfuse 客户端 + 本机 langfuse compose 栈 `npm run eval:langfuse -- up`，栈已验收：dataset/run/scores 全链路通，提交 `fde3968`/`79cbc4a`）。

---

## 0. 一句话结论

把评测体系从「离线 golden set」延伸进 agent 真实运行时：宿主侧新增一个**零依赖 trace 导出器**，把每轮真实对话（turn）以 langfuse trace 形式写入本机 langfuse 实例——内容脱敏、默认关、栈不在零影响；runner 仅新增一个**无内容**的 `auto_recall` 流事件让「每轮注入了什么」可见；v1 含 LLM-as-judge 判「回答是否真的用上了注入的记忆」。离线召回率（dataset run）与真实对话质量（trace + judge score）从此在同一 langfuse 项目里对照。

## 1. 已拍板裁决（2026-11-11 用户确认，无需再问）

1. **架构 = 宿主侧导出器**（不是 runner 内嵌 langfuse SDK）：host 是全部外发集成的主人（任务 W 既有原则），runner 保持零外部依赖、零密钥；trace 数据源=宿主已收到的 turn 生命周期输出（stream events + 最终输出 + token usage），**无需 runner 上报对话内容**。runner 唯一改动=批次 3 的内容无关事件。
2. **内容模式默认 = 脱敏后全文**（`contentMode: 'full'`）：用户消息与回答过 `src/logger.ts:54 redactLogMessage`（与日志同源规则）后进 trace；可配置切 `metadata-only`（只带指标不带文本）。
3. **v1 含 LLM-as-judge**（`recall_utilized` 判分）：异步批量、只评「注入过召回的 turn」、独立开关默认关。
4. **开关粒度 = 全局**：`data/config/langfuse.json` 缺文件即关（对齐任务 Z「默认关」哲学）；工作区级排除后续有需要再加。

## 2. 已取证事实（新会话无需重做）

| #   | 事实                                                                                                                                                                                         | 证据                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 零依赖 langfuse REST 客户端已存在并在评测 v2 真机验收（ingestion trace-create / dataset-run-items / scores 裸数组 / datasets 按名幂等；Basic auth；207 部分成功容忍）                        | `scripts/eval-auto-recall.ts`（createLangfuseClient 及 payload 构造器，含 19 用例锁定）                    |
| 2   | stream 事件类型真相源：`shared/stream-event.ts` eventType 联合含 `'memory_recall'`（runner 每轮快照事件先例：displayLevel detail + isSynthetic）                                             | `shared/stream-event.ts:27,290`；runner 侧 `container/agent-runner/src/index.ts` emitWorkspaceMemoryRecall |
| 3   | turn 生命周期宿主侧汇聚点：TurnOutputCoordinator / ActiveTurnOutputRegistry（turn 输出编排）；runner stdout 事件路由 host-ipc-output-router。**精确挂点行号新窗口开工前二次取证**            | `src/turn-output-coordinator.ts:67,410`、`src/host-ipc-output-router.ts`                                   |
| 4   | token usage 落库：`insertUsageRecord`（含 model/tokens/cost/duration）；调用方在流处理/输出落库路径（新窗口定位）                                                                            | `src/db.ts:3576`                                                                                           |
| 5   | 宿主脱敏真相源：`redactLogMessage`（日志同源）；runner 另有 redactSensitive（runner 侧不需要）                                                                                               | `src/logger.ts:54`、`container/agent-runner/src/utils.ts:19`                                               |
| 6   | host 配置文件先例（env 优先+文件兜底+缺省关+0o600 写入）：auto-memory-config                                                                                                                 | `src/auto-memory-config.ts`（任务 X 写通道）                                                               |
| 7   | 前端事件容忍性：chat store 事件分流有前缀路由与 default 分支——新 eventType 预计被忽略不渲染，**需新窗口确认** `web/src/stream-event.types.ts` 与 switch default 行为                         | `web/src/stores/chat.ts:1077-1124`、`web/src/stream-event.types.ts`                                        |
| 8   | shared/stream-event 改动必须 `make sync-types` 三侧同步                                                                                                                                      | AGENTS.md §2 目录结构说明                                                                                  |
| 9   | langfuse 栈生命周期命令已就绪（up 自动 .env+INIT\_\* 预置+写 eval 配置；down 保留卷）；观测用的配置文件与评测配置分离（`langfuse.json` vs `eval-langfuse.json`），同一实例同一项目可共用 key | `scripts/eval-langfuse.mjs`、验收记录（acceptance-2：17 items/17 traces/68 scores）                        |
| 10  | judge 可用的 LLM 端点配置：`getAutoMemoryHostConfig().llm`（glm-flash，OpenAI 兼容）已就绪                                                                                                   | `src/auto-memory-config.ts`、验收环境 glm-5.3-flash                                                        |

## 3. 方案设计

### 3.1 数据流（目标形态）

```
runner（每 turn）──stdout 流事件──▶ host
   │  auto_recall 事件（无内容：hits/latency/on）   │
   │                                                ├─▶ 既有路径（DB/UI/渠道）不动
   └──────────────── 宿主唯一新增汇聚点 ─────────────┤
                                                    ▼
                                   src/langfuse-trace-exporter.ts（单例）
                                     有界队列 → 批量 ingestion/scores
                                     redact 全文或 metadata-only
                                     栈不可达=丢弃+计数，绝不阻塞 turn
                                                    │
                                                    ▼
                              本机 langfuse（compose，观测期常驻）
                              trace(turn) + score(latency/tokens/recall_injected)
                              judge 异步批 → score(recall_utilized)
```

### 3.2 新模块（均为 src/ 宿主侧）

- `src/langfuse-client.ts`：从 `scripts/eval-auto-recall.ts` **提升**（非复制）零依赖客户端；script 改 import 此模块。观测只用 ingestion/scores 两个方法（dataset 族留给 script）。
- `src/langfuse-observability-config.ts`：`data/config/langfuse.json` `{url, publicKey, secretKey, enabled, contentMode?: 'full'|'metadata', judge?: {enabled?: boolean}}` + env 覆盖（`CKQCLAW_LANGFUSE_*`）；缺文件=整链路 no-op（§6-3）。
- `src/langfuse-trace-exporter.ts`：单例；`recordTurnStart/recordStreamEvent/recordTurnComplete`；内部有界队列（1000）+ 定时/批量 flush；payload 构造纯函数可单测；**所有公开方法同步返回、内部全 catch**。
- `src/langfuse-recall-judge.ts`：扫描「已完结且 recall_injected=true」的 trace 缓冲，批量调 glm-flash 结构化判分（复用 auto-memory llm 端点配置），写 `recall_utilized`（BOOLEAN，comment=reasoning）；失败静默跳过记账。

### 3.3 trace 模型（对齐 langfuse：score 挂 trace、run 幂等）

- trace：`id=turnId`（CKQClaw 既有）、`sessionId`、`name=turn:<workspace名>`（scheduled 任务 `scheduled:<taskId>`）、`metadata={workspaceJid, folder, channel, interactionMode, autoRecallEnabled}`、`input/output`（redact 后全文或省略）。
- 规则 score（host 直接算）：`turn_latency_ms`、`turn_output_tokens`/`turn_input_tokens`（NUMERIC）、`recall_injected`（BOOLEAN）。
- judge score：`recall_utilized`（BOOLEAN）。
- 不建 dataset——真实对话流不是实验；与离线 dataset run 共存于同项目便于对照。

## 4. 执行顺序（TDD，每批次先写测试见红再实现）

1. **批次 1（通道底座）**：`tests/langfuse-trace-exporter.test.ts` 见红 → client 提升至 `src/langfuse-client.ts`（script 改引用）+ config 模块 + exporter（队列/flush/redact/contentMode/关=no-op 零网络/异常不上抛，mock fetch 全覆盖）。
2. **批次 2（host 接线）**：先取证 turn 挂点（§2-3/4 的二次定位）→ contract 测试（「exporter 任何异常不影响 turn 输出路径」+ trace payload 形状）见红 → 在 turn-output-coordinator / host-ipc-output-router / container-runner 落接线（turn 开始/流事件/完结+usage）。scheduled turn 同样导出。
3. **批次 3（召回可见性）**：`shared/stream-event.ts` 加 `'auto_recall'` → `make sync-types` → runner 三调用点（`auto-memory-context.ts` 返回 {injected, hitCount, latencyMs} + index/pi-index emit，复用 memory_recall 事件模式，**零用户内容**）→ host exporter 映射 trace metadata + `recall_injected` score → 前端容忍性验证（§2-7）。扩展 `tests/auto-recall-context.test.ts`。
4. **批次 4（judge + 文档 + 门禁）**：`tests/langfuse-recall-judge.test.ts` 见红（mock LLM 端点：结构化解析/失败跳过/只评注入过的）→ `src/langfuse-recall-judge.ts` → AGENTS.md（§2 架构一行 + 配置说明）+ CLAUDE.md（配置节）→ `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - agent 内评测集成（任务AA）`（push 由用户发起）。

## 5. 文件清单（= `.gatescope.json` allow；实现期确需扩宽按宪法流程改声明并在提交信息说明）

新增：`docs/task-aa-agent-observability-plan.md`、`src/langfuse-client.ts`、`src/langfuse-observability-config.ts`、`src/langfuse-trace-exporter.ts`、`src/langfuse-recall-judge.ts`、`tests/langfuse-trace-exporter.test.ts`、`tests/langfuse-recall-judge.test.ts`
修改：`scripts/eval-auto-recall.ts`（client 提升后改引用）、`src/container-runner.ts`、`src/turn-output-coordinator.ts`、`src/host-ipc-output-router.ts`、`src/index.ts`（scheduled turn，若取证后挂点不同以此为准调整）、`shared/stream-event.ts`、`container/agent-runner/src/auto-memory-context.ts`、`container/agent-runner/src/index.ts`、`container/agent-runner/src/pi-index.ts`、`tests/auto-recall-context.test.ts`、`tests/eval-auto-recall-metrics.test.ts`（import 路径）、`web/src/stream-event.types.ts`（sync-types 产物源头，以生成链路为准）、`web/src/stores/chat.ts`（仅当 default 分支不容忍新事件时最小改动）、`AGENTS.md`、`CLAUDE.md`
（不动：DB schema、runner 依赖、`data/` 任何运行时数据、评测 v2 既有行为。）

## 6. 风险与边界

1. **秘密边界（宪法第 3/4 条）**：langfuse key 只进宿主进程与 0o600 配置；runner 零密钥零新依赖（客户端零依赖手写，运行时依赖冻结不破）。
2. **隐私**：默认关；full 模式内容一律过 `redactLogMessage`（与日志同源）；metadata-only 可切；langfuse 为本机 compose，数据不出机器——但栈内明文存储属实，验收文案向用户明示。
3. **可靠性**：exporter 有界队列满/flush 失败=丢弃+计数+周期 warn-once；**绝不上抛、绝不 await 进 turn 路径**（contract 测试钉死）；栈未起时零影响（对话照常）。
4. **常驻成本**：观测开启意味着 langfuse 栈常驻（约 2-3GB 内存）；按需开栈+ exporter 自动丢弃也合法——文档明示由用户权衡。
5. **三侧类型同步**：`auto_recall` 事件走 `make sync-types`；前端未知事件容忍性是**待验证假设**（§2-7），不容忍则最小改动 chat.ts。
6. **接线点漂移**：§2-3/4 行号会漂，以符号（TurnOutputCoordinator/ActiveTurnOutputRegistry/insertUsageRecord）为准，批次 2 开工先二次取证。
7. **judge 成本与偏差**：仅评注入过的 turn、每 turn 一次 glm-flash 调用、默认关；judge 自身准确性属 LLM 评估，score comment 保留 reasoning 供人工抽查。
8. **日志纪律**：exporter/judge 的 warn-once 不得携带对话内容或密钥（redact 后亦不带内容——只带计数与错误类别）。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`。
- 真机验收（用户执行，栈常驻期间）：
  1. 写 `data/config/langfuse.json`（enabled, contentMode=full）→ web 聊两轮（其中一轮聊记忆相关话题触发自动召回）→ langfuse UI 出现 2 条 trace，含 metadata/usage/`recall_injected` score，full 模式可见脱敏后消息与回答；
  2. `judge.enabled=true` → 再聊一轮相关话题 → 稍候出现 `recall_utilized` score（comment 有 reasoning）；
  3. 删配置文件（或 enabled=false）重启 → 对话零差异、零网络外发（exporter no-op）；
  4. 配置开但栈 down → 对话照常，宿主日志出现一次 warn-once 后不再刷屏；
  5. `contentMode=metadata` → trace 无对话文本但指标齐全；
  6. IM 渠道（飞书/Telegram 任一）行为一致。
