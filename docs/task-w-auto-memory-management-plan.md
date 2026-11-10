# 任务 W 立项：自动记忆管理（侧车 list + 管理 API + 设置页 UI）——交接文档

> **状态**：2026-11-10 用户批准立项方向**路线 A**（保留本地自托管 mem0 侧车 + Qdrant，移植 OpenDot 管理层设计；对比与决策记录见 §1）。实现未开始，新窗口按 §4 顺序 TDD 执行。
> **用途**：新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行，无需重新排查。所有事实均带文件行号（2026-11-10 本机 macOS arm64 双仓取证；行号若漂移以符号名为准）。
> **回滚点**：立项提交本身（`.gatescope.json` 的 base=立项提交的父 HEAD `7249b6b`——即任务外品牌文案单独提交；实现 diff 基线=立项提交）。
> **参考仓**：`/Users/xy/Desktop/workspace/OpenDot_副本`（同源姊妹项目，**只读参考，任何文件不入本任务 diff**）。

---

## 0. 一句话结论

自动记忆层（mem0 侧车）当前**只能存不能管**：`delete`/`delete_all` 在侧车协议里存在但任何调用方都够不着，且无 list 操作、无 HTTP API、无 UI。本任务在不动 DB schema、零新增依赖、数据不出机的前提下，补齐三件事：侧车 `list` 操作、宿主管理 HTTP API（status/list/search/delete/清空）、设置页管理 UI；自动采集与每轮自动召回注入列为**待批准可选批次**（§3.4/§3.5），per-user 记忆隔离 deferred 另行立项（§3.6）。

## 1. 目标与用户决策（2026-11-10）

1. **路线决策（用户已拍板）**：对比 OpenDot 四层记忆架构后选**路线 A**——保留本地侧车（自托管、数据不出机、零新增依赖、不动 DB schema），移植其管理层模式；不走 OpenDot 的 Mem0 Platform 云 API 路线。
2. **待新窗口开工前向用户确认的两项**（不得自行拍板，宪法第 6 条）：
   - ① **权限模型**：管理 API 与设置页分区按 v2 记忆路由同款 `authMiddleware`（登录即可，`src/routes/memory.ts:62` 先例），还是按任务 V 先例 `systemConfigMiddleware`（`manage_system_config`，`src/middleware/auth.ts:176`）？默认建议前者（自动记忆是 workspace 维度数据，v2 同类），**该决策联动 §3.3 的 tab 归组（VALID_TABS vs SYSTEM_TABS）**。
   - ② **可选批次 4（自动采集）/批次 5（自动召回注入）是否纳入本轮**：不确认则只做核心批次 1-3 + 收尾（§5 清单即此范围）；纳入则按 §3.4/§3.5 扩宽 `.gatescope.json` 声明并由用户复核。
3. **非目标（防蔓延，勿顺手做）**：换 Mem0 云 API、per-user 记忆隔离（§3.6）、自动层↔v2 层迁移工具、mem0ai 版本升级、侧车配置 UI 化（llm/embedder 端点配置仍走 `data/config/auto-memory.json` 手工文件）、批次 4/5 的任何实现。

## 2. 已取证事实（新会话无需重做）

### 2.1 CKQClaw 自动记忆层现状（全部实测核对）

| #   | 事实                                                                                                                                                   | 证据                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | 侧车 op 分发链只有 `add/search/get/delete/delete_all`（无 `list`/`get_all`）；search/get **出站有 secret redact**（`redact_json_strings`）             | `container/agent-runner/python/auto_memory_sidecar.py:465-517`                                    |
| 2   | 宿主侧车管理器 `KNOWN_OPS={add,search,get,delete,delete_all}`；每 workspace 懒 spawn、串行队列、60s 超时杀子进程、10min 空闲停、崩溃预算 3 次带冷却自愈 | `src/auto-memory-sidecar-manager.ts:80-91`（常量与白名单）、`:233-248`（call）、`:510-538`（超时） |
| 3   | **runner IPC 白名单只有 `{search, add, get}`**——delete/delete_all 从任何运行路径不可达（管理缺口的根源）                                                | `src/auto-memory-ipc.ts:33`                                                                       |
| 4   | 数据目录按执行模式二分：container → `data/extra/{folder}/auto-memory`；host → `data/groups/{folder}/extra/auto-memory`（两者绝不混淆，已有表测试钉死）   | `src/auto-memory-ipc.ts:69-77`（autoMemoryDataPath）、`tests/auto-memory-ipc.test.ts`             |
| 5   | 侧车命名空间：collection=`ws-{folder}`、user_id=`workspace:{folder}`（init 握手时绑定，op 调用不再传 user_id——search 用 `filters={"user_id":…}`）        | `src/auto-memory-ipc.ts:79-91`（buildSidecarConfig）、`auto_memory_sidecar.py:490-496`            |
| 6   | IPC 派发：`case 'auto_memory'` 从 IPC 目录命名空间推导 folder+executionMode（不信模型声明）；结果文件前缀 `auto_memory_result_`                          | `src/index.ts:12231-12245`、`:11308`                                                              |
| 7   | 配置：env `CKQCLAW_AUTO_MEMORY` → `data/config/auto-memory.json` → 默认禁用；llm+embedder 必须成对合法；30s 缓存。**本机该文件不存在 → 功能当前未启用**   | `src/auto-memory-config.ts:15-17,59-78,80`                                                         |
| 8   | agent 工具 `auto_memory_add/search`（模型主动调用）、`memory_promote`（自动层→v2）；写工具受 `memoryWriteEnabled` 门控且子代理只读                      | `container/agent-runner/src/mcp-tools.ts:2987-3139`、`workspace-memory-runtime.ts:6-12`           |
| 9   | v2 精选层与自动层是**两套独立系统**：v2 走 `src/routes/memory.ts` + SQLite；本任务只动自动层，不碰 v2                                                    | `docs/workspace-memory-v2.md`、`src/routes/memory.ts:75-204`                                      |
| 10  | mem0ai 版本钉死 2.2.1（wheel SHA256 治理）；Python 侧车同时预装进容器镜像                                                                                 | `scripts/builtin-mcp-catalog.mjs`、`container/Dockerfile:171-187`                                 |

### 2.2 OpenDot 可移植模式（参考仓路径，只读借鉴不搬代码）

| 模式                             | OpenDot 证据                                                                                              | 移植方式                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 设置页记忆管理区（开关+凭据+列表） | `web/src/components/settings/Mem0PrivateSection.tsx`（247 行，tab `mem0-private`）                         | 结构照搬：状态卡 + 管理操作区；凭据部分换成本机配置文件引导                  |
| 记忆管理 API（key 不回显）        | `src/routes/mem0-private.ts`：GET 状态 / PUT\|DELETE 凭据 / PUT dots 策略                                  | 本任务五端点见 §3.2；status 只报 enabled/available，端点信息永不回传         |
| 每日预算 + 熔断                   | `src/mem0-resource-controls.ts`（`MINICLAW_MEM0_DAILY_BUDGET` 默认 100）                                   | 批次 4 采集预算沿用同值 100                                                  |
| 召回超时降级                      | `src/mem0-private-recall.ts`（超时 100–10000ms 默认 1500）                                                  | 批次 5 轮首注入超时预算同值 1500ms，超时静默降级                             |
| 采集状态机（≤3 重试/24h 过期）    | `src/mem0-private-capture.ts`（914 行）                                                                     | 批次 4 只取语义骨架，不搬其 Product 会话绑定                                 |
| 不可信上下文注入框架              | `product-runtime.ts:1620-1658`（召回以用户轮上下文注入，绝不进 system 通道）                                | 批次 5 注入框架同原则（防提示词注入）                                         |

**明确不移植**（深绑定 OpenDot 专有概念）：Mem0 云 API 传输层、per-owner AES-GCM 凭据加密（本地不出网无此需求）、admission 谓词（JOIN 其专有会话表）、Personal Memory（绑定 Goal/Durable 运行时）、Owner Profile（绑定 Home/内置 Dot）。

### 2.3 本仓可复用模式（照抄即可）

| 模式                     | 位置                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由挂载 + docs 机审联动 | `src/web.ts:49-67`（import）、`:268-284`（app.route）；**新路由文件必须同时进 `docs/API.md:19-38` 模块索引与 `docs/ACL-MATRIX.md` §6，否则 verify 的 docs:check 直接红**（任务 V 已验证） |
| v2 路由鉴权先例          | `src/routes/memory.ts:62-75`：`authMiddleware` + `bodyLimit 64KB`；`:219-222` 旧端点 410 退役写法                                                           |
| admin 权限中间件         | `src/middleware/auth.ts:176`：`systemConfigMiddleware = requirePermission('manage_system_config')`（待确认项①的二选一）                                     |
| 设置页 tab 注册 5 处      | `web/src/components/settings/types.ts:130-152`（SettingsTab 联合）、`web/src/pages/SettingsPage.tsx:28-59`（VALID_TABS/**SYSTEM_TABS 受 canManageSystemConfig gating**）、`:106-116`、`:138-161`、`:252-274`、`SettingsNav.tsx:33-89` |
| 前端列表卡片 / 删除确认  | `web/src/components/settings/ProviderList.tsx:158-357`；`web/src/components/common/ConfirmDialog.tsx`（`confirmVariant="danger"`）                          |
| 前端小 store / API 客户端 | `web/src/stores/model-pricing.ts`（任务 V 新范本）；`web/src/api/client.ts:84-103`                                                                          |
| 协议 fake 与管理器测试   | `tests/fixtures/fake-auto-memory-sidecar.mjs`（camelCase 漂移即拒）、`tests/auto-memory-sidecar-manager.test.ts`（657 行范本）                              |
| python 自测              | `auto_memory_sidecar.py --self-test`（188-312 行，20+ 红绿用例，新 op 必须加用例）                                                                          |

## 3. 方案设计

### 3.1 批次 1：侧车 `list` 操作（管理层地基）

- `auto_memory_sidecar.py` op 链新增分支（仿 `search`，`:488-496`）：`memory.get_all(user_id=user_id)`，args 支持 `{limit?, offset?}`（**mem0 2.2.1 `get_all` 的分页参数与返回包装形态未实测——实现第一步先写临时取证脚本跑一次真实调用确认；不确定即标 TODO 问用户，禁止猜测**）；结果**必须过出站 `redact_json_strings`**（与 search/get 同款，防旧存量明文泄露）；`--self-test` 加红绿用例。
- `src/auto-memory-sidecar-manager.ts` `KNOWN_OPS` 加 `'list'`。
- fake fixture 与 `tests/auto-memory-sidecar-manager.test.ts` 同步 list 用例（协议形态、分页、redact、unknown-op 拒绝）。

### 3.2 批次 2：宿主管理 HTTP API（新文件 `src/routes/auto-memory.ts`，挂 `/api/auto-memory`）

| 方法/路径                                                      | 行为                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/auto-memory/status`                                    | `{enabled, available, reason?}`——enabled 来自 config；available 用一次轻量 `list` 探测（复用侧车降级返回）   |
| `GET /api/auto-memory/workspaces/:workspaceJid/memories`         | `?limit=&offset=` 分页列表 → 侧车 `list`（limit 默认 20、上限 100，防大集合全量拉取）                        |
| `GET /api/auto-memory/workspaces/:workspaceJid/memories/search`  | `?q=&limit=` → 侧车 `search`（q 1-500 字符，limit 1-50，复用 `buildOpArgs` 既有校验语义）                    |
| `DELETE /api/auto-memory/workspaces/:workspaceJid/memories/:memoryId` | → 侧车 `delete`（404 语义由 mem0 结果判定；幂等直通）                                                  |
| `DELETE /api/auto-memory/workspaces/:workspaceJid/memories`      | → 侧车 `delete_all`（**破坏性操作：API 直通幂等、UI 层二次确认**，无软删除——不动 DB schema 是本任务边界）    |

- **workspaceJid → folder+executionMode 解析必须与 IPC 派发同源**：从 `src/auto-memory-ipc.ts` 导出共享 resolver（`autoMemoryDataPath`/`buildSidecarConfig` 已在此文件），路由侧优先复用 db.ts 既有 group 查询函数（只读 import，不改 db.ts；确无现成函数才把 `src/db.ts` 加入清单并在提交说明）。两模式数据目录错位是最高危缺陷，`tests/auto-memory-ipc.test.ts` 的 `autoMemoryDataPath` 表已钉死。
- 失败 receipts 沿用 coded 风格：`not_configured`/`unavailable`/`invalid_args`/`not_found`（对齐 `src/auto-memory-ipc.ts` 既有码）。
- 权限：待确认项①（默认 `authMiddleware` + bodyLimit，v2 同款）。
- **文档同步（verify 会拦）**：`docs/API.md` 模块索引 + 端点小节；`docs/ACL-MATRIX.md` §6 加行。

### 3.3 批次 3：设置页管理 UI

- 新 tab `key='auto-memory'`、label「自动记忆」（lucide 图标如 `BrainCircuit`），注册 §2.3 所列 5 处；**归组联动待确认项①**：`authMiddleware` → VALID_TABS（登录可见）；`systemConfigMiddleware` → SYSTEM_TABS（canManageSystemConfig gating）。
- `web/src/components/settings/AutoMemorySection.tsx`：
  - 状态卡三态降级——未配置（`enabled=false`，展示 `data/config/auto-memory.json` 配置引导文案，不渲染管理区）/ 已启用 / 侧车不可用（`available=false,reason`，管理操作禁用）。**本机现状即未配置态，此态不可白屏。**
  - workspace 选择器 + 记忆分页列表（展示 memory 文本、创建时间、metadata 中 sessionId/turnId）+ 关键字搜索 + 单条删除 + 清空（`ConfirmDialog confirmVariant="danger"` 二次确认，危险色）。
- store `web/src/stores/auto-memory.ts`：仿 `model-pricing.ts`（load/invalidate、mutate-then-reload、行级失败不覆盖列表 error）。
- 前端测试源检查 + store 单测；`tests/frontend-settings-information-architecture.test.ts` 导航断言同步（契约锁）。

### 3.4 批次 4（可选，待批准）：自动采集（OpenDot evidence routing 思路）

- `src/index.ts` 轮完成锚点（assistant 终态回答落库处）：组装本轮 user+assistant 消息 → 入侧车 add 队列（复用 manager 串行队列）；**排除定时任务轮与子代理轮**；metadata 带 `{sessionId, turnId}`（批次 3 UI 已按此展示来源）。
- `src/auto-memory-config.ts` 扩展可选键 `capture: {enabled(默认 false——隐私优先), dailyBudget(默认 100，OpenDot 同值), maxMessagesPerTurn}`，向后兼容（缺省即关），既有 config 测试扩展。
- `container/agent-runner/prompts/memory-system.workspace.md` 同步措辞（自动采集后模型不必每轮手动 add）。
- 新测试 `tests/auto-memory-capture.test.ts`：默认关、排除范围、预算耗尽降级。
- **本批次最高风险**：`src/index.ts` 约 2 万行热点文件，锚点定位先写定位测试再动；每轮一次 LLM 提炼调用的成本需在文档明示。

### 3.5 批次 5（可选，待批准）：每轮自动召回注入（OpenDot freeze-once 模式）

- 新 `container/agent-runner/src/auto-memory-context.ts`（仿 `workspace-memory-context.ts`）：轮首以用户消息为 query 走既有 IPC `search`，**超时预算 1500ms，超时/不可用静默降级，绝不阻塞轮次**；注入按不可信用户上下文框架（OpenDot 同原则，防提示词注入）。
- 双入口接线 `container/agent-runner/src/index.ts` + `src/pi-index.ts`；`prompts/memory-system.workspace.md` 同步（search 工具定位改为兜底深查）。
- `container/agent-runner/tests/pi-auto-memory-wiring.test.ts` 扩展 + 新 context 单测。

### 3.6 deferred（另行立项，本轮不做）：per-user 记忆隔离

需扩展 IPC 协议携带**宿主可验证**的用户身份（不能信 runner 声明），且存量 `workspace:{folder}` 共享池的迁移策略（保留共享 or 拆分）是独立设计题，部分渠道的用户映射天然模糊。立项时再出设计子文档。

## 4. 执行顺序（TDD，每步先写测试见红再实现）

1. **批次 1**：python `--self-test` 加 list 用例见红 → 侧车实现（**先做 mem0 get_all 取证**）→ manager KNOWN_OPS + fake + `tests/auto-memory-sidecar-manager.test.ts` 用例。
2. **批次 2**：`tests/auto-memory-routes.test.ts`（鉴权 401/JID 解析/两模式数据目录/not_configured 降级/404/分页边界）见红 → `src/routes/auto-memory.ts` + `auto-memory-ipc.ts` 导出 resolver + `src/web.ts` 挂载 + API.md/ACL-MATRIX 同步。
3. **批次 3**：`tests/auto-memory-frontend.test.ts`（5 处注册点/三态降级/store actions/清空确认）+ 导航契约测试同步 见红 → store + Section + 注册实现。
4. **收尾**：`npm run verify` 六步 → `node scripts/check-scope.mjs` → 单提交 `feat: 记忆 - 自动记忆管理API与设置页（任务W）`（push 由用户显式发起）。
5. （若批准批次 4/5：各追加一轮「测试见红→实现→verify」，并先扩宽 `.gatescope.json` 由用户复核。）

## 5. 文件清单（= `.gatescope.json` allow；核心范围=批次 1-3+收尾）

新增：`src/routes/auto-memory.ts`、`web/src/components/settings/AutoMemorySection.tsx`、`web/src/stores/auto-memory.ts`、`tests/auto-memory-routes.test.ts`、`tests/auto-memory-frontend.test.ts`、`docs/task-w-auto-memory-management-plan.md`（本文档）
修改：`container/agent-runner/python/auto_memory_sidecar.py`、`src/auto-memory-sidecar-manager.ts`、`src/auto-memory-ipc.ts`、`src/web.ts`、`tests/fixtures/fake-auto-memory-sidecar.mjs`、`tests/auto-memory-sidecar-manager.test.ts`、`web/src/components/settings/types.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/pages/SettingsPage.tsx`、`tests/frontend-settings-information-architecture.test.ts`、`docs/API.md`、`docs/ACL-MATRIX.md`
（批次 4 文件：`src/index.ts`、`src/auto-memory-config.ts`、`tests/auto-memory-config.test.ts`、`tests/auto-memory-capture.test.ts`、`container/agent-runner/prompts/memory-system.workspace.md`；批次 5 文件：`container/agent-runner/src/auto-memory-context.ts`、`container/agent-runner/src/index.ts`、`container/agent-runner/src/pi-index.ts`、`container/agent-runner/tests/pi-auto-memory-wiring.test.ts`——**均不入 allow，批准后扩宽声明**。）

## 6. 风险与边界

1. **mem0 2.2.1 `get_all` 形态未实测**（分页参数、results 包装）——实现第一步取证，不确定标 TODO 问用户（宪法第 6 条）。
2. **两执行模式数据目录错位**=最高危缺陷——路由解析必须与 IPC 派发同源（§3.2），`autoMemoryDataPath` 表测试钉死。
3. **delete_all 破坏性**——UI danger 二次确认；API 幂等直通；无软删除（不动 DB schema 是任务边界，宪法第 2 条）。
4. **导航契约锁**——`frontend-settings-information-architecture.test.ts` 加 tab 不同步声明则 verify 红。
5. **未配置降级态**——本机 `data/config/auto-memory.json` 不存在，UI 三态不可白屏；status 的 available 探测失败必须返回 reason 而非 500。
6. **权限联动**——待确认项①决定 tab 归组与路由中间件，开工先问。
7. **侧车时延**——list 必带分页；管理操作走既有串行队列（60s 超时）；status 探测失败要有短超时预算，不能拖死设置页。
8. **出站 secret redact 覆盖 list**——与 search/get 同款（旧存量明文防泄露，任务 F 语义延续）。
9. **敏感区纪律**——不触碰 `data/` 实数据与任何密钥值；密钥/端点不落日志、不进 API 响应；零新增运行时依赖（宪法第 4 条）；参考仓 OpenDot_副本 任何文件不入 diff。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`（diff 全在 §5 清单内）；python 侧车改动另跑 `python3 container/agent-runner/python/auto_memory_sidecar.py --self-test`。
- 真机验收（用户执行，实现/审查分离）：配置 `data/config/auto-memory.json`（llm+embedder 成对）→ `make dev` → 设置页「自动记忆」显示已启用 → 与 agent 对话产生若干自动记忆 → 列表分页可见（抽查 [REDACTED] 效果）→ 搜索命中 → 单条删除后 IPC 侧 `auto_memory_search` 不再返回该条 → 清空走二次确认 → agent 正常对话不受影响（工具链回归）。
- `.gatescope.json` 已随立项提交落档（task=任务W，base=`7249b6b`，allow=§5 核心范围）；实现会话**不得扩宽**，确需扩宽（含批次 4/5）在提交信息说明理由并由用户复核。
