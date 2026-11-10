# 任务 Y 立项：会话窗口「提炼记忆」按钮（全文手动采集入自动记忆）——交接文档

> **状态**：2026-11-10 用户批准立项（规划会话完成两项设计裁决，见 §1）。实现未开始，新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行，无需重新排查。事实均带文件行号（2026-11-10 取证，基线 `18b9125`；行号漂移以符号名为准）。
> **回滚点**：立项提交本身（`.gatescope.json` 的 base=立项提交的父 HEAD `18b9125`；实现 diff 基线=立项提交）。
> **环境备注**：宿主 python3 已装 `mem0ai==2.2.1`；`data/config/auto-memory.json` 已配好可用端点（llm=bigmodel coding `paas/v4`+glm-5.3-flash，embedder=`paas/v4`+Embedding-3，0o600）；侧车链路真机已验证（init/add/search/list/delete_all 全通，多工作区并存已修复）。新窗口无需重复环境排查。

---

## 0. 一句话结论

自动记忆基础设施已全通（任务 W 管理面 + 任务 X 端点配置 + 两修复），但记忆只能靠 Agent 模型自主调 `auto_memory_add`。本任务在**聊天窗口 header 加「提炼记忆」按钮**：点击 → 确认框显示将提炼的条数/字数 → 服务端拉该会话全部文本历史 → 经既有侧车 `add` 通路送 mem0 提炼（一次 LLM 提炼 + embedding）→ 回执 toast。零新增依赖、不动 DB schema、不碰敏感区、不做批次 4/5（自动采集/自动召回仍为待批范围）。

## 1. 目标与用户决策（2026-11-10 已拍板，无需再问）

1. **采集范围 = 全部历史**（上限 **400 条 / 60k 字符**，超出保留最新部分；`context_reset` 分隔行剔除但跨会话内容保留——按「对话全文」字面语义，确认框文案明示）。
2. **触发交互 = 确认框显示条数后执行**（点按钮 → preview → ConfirmDialog 显示 N 条/约 X 字/一次模型调用提示 → 确认才产生成本）。
3. **权限模型**：capture=workspace 写操作（`canModifyGroup`，与删除同级，404 隐藏）；preview=读操作（`canAccessGroup`）。前端按钮 `canModifyWorkspaceConfig` 门控（与 header 既有按钮一致）。
4. **limit 服务端固定**（400 条/60k 字），不接受客户端传入——防成本滥用。
5. **非目标（防蔓延，勿顺手做）**：批次 4 每轮自动采集、批次 5 自动召回注入、per-user 记忆隔离、范围选择菜单（当前会话/全部）、附件与图片参与提炼、服务端预算表。

## 2. 已取证事实（新会话无需重做）

### 2.1 后端消息读取链（全部实测）

| #   | 事实                                                                                                                                                                                                                                               | 证据                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `getMessagesPage(chatJid, before?, limit=50)`：`WHERE chat_jid [AND timestamp<before] ORDER BY timestamp DESC LIMIT`——**最新在前**，需反转为时间正序                                                                                               | `src/db.ts:11757`；消息历史路由先例 `src/routes/groups.ts:2313-2434`（`limit+1` 算 hasMore、`before/after/agentId` 参数）                                                                                |
| 2   | 消息行**无 role 字段**：角色=`is_from_me ? 'assistant' : 'user'`（db 归一化 `normalizeMessageRow` db.ts:2706）；`sender='__system__'`+`content='context_reset'` 为会话分隔行（groups.ts:2062-2092）、`sender='__billing__'` 为配额通知——**均剔除** | `src/types.ts:403-428`（NewMessage）、`src/config.ts:13-17`（ASSISTANT_NAME）                                                                                                                            |
| 3   | **无 per-session 消息查询**（消息只按 chat_jid+时间检索；`sessions` 表是 SDK session id 单值映射非历史清单）                                                                                                                                       | 全 src/ grep 取证；`src/db.ts:670-675`（sessions 表 DDL）                                                                                                                                                |
| 4   | agent 子会话虚拟 jid：`` `${jid}#agent:${agentId}` ``                                                                                                                                                                                              | `src/routes/groups.ts:2353`                                                                                                                                                                              |
| 5   | `callSidecar(group, 'add', {messages:[{role,content}], metadata})` 现成可用（args 不透明直通）；`AutoMemorySidecarOp` 含 'add'；侧车入库前机械 redact（messages+metadata）                                                                         | `src/routes/auto-memory.ts:142-165`（callSidecar）、`auto-memory-sidecar-manager.ts:46-53`、`auto-memory-ipc.ts:124-149`（add 入参契约）、`container/agent-runner/python/auto_memory_sidecar.py:733-753` |
| 6   | `resolveWorkspace(c, workspaceJid, 'read'\|'write')`：read→canAccessGroup、write→canModifyGroup、未知/无权统一 404 隐藏                                                                                                                            | `src/routes/auto-memory.ts:103-131`                                                                                                                                                                      |
| 7   | 超时语义：manager 每请求 60s 超时**杀子进程**（下次调用 respawn，既有 M2 语义）；web server requestTimeout 10min                                                                                                                                   | `src/auto-memory-sidecar-manager.ts:82,526-554`、`src/web.ts:3293-3302`                                                                                                                                  |
| 8   | `/workspaces/*` 已挂 authMiddleware + 64KB bodyLimit——新端点自动继承，无需另挂                                                                                                                                                                     | `src/routes/auto-memory.ts:64-75`                                                                                                                                                                        |
| 9   | 错误回执先例：`unavailableReceipt`（503 not_configured/unavailable）、`invalidArgs`（400）；POST+LLM 先例 `agent-profiles.ts:212-231`                                                                                                              | `src/routes/auto-memory.ts:205-213` 等                                                                                                                                                                   |
| 10  | mem0 add 回执形状：`{results:[{event,memory,…}], intercepted?:[…]}`（attach_intercepted 注入）——added/intercepted 计数从这取                                                                                                                       | `auto_memory_sidecar.py`（attach_intercepted + add 分支）                                                                                                                                                |

### 2.2 前端事实

| #   | 事实                                                                                                                                                                   | 证据                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 11  | ChatView header 按钮区 968-1111 行；「工作区设置」「渠道绑定」按钮=复用模板（plain button + lucide icon + `hidden sm:inline` label + `canModifyWorkspaceConfig` 门控） | `web/src/components/chat/ChatView.tsx:1049-1072`（模板）、`:241`（flag 派生自 group.can_modify，注释声明后端 ACL 为唯一真相源） |
| 12  | 会话身份在 scope：`groupJid`（prop）、`activeAgentTab`（当前 agent 子会话，URL `?agent=` 镜像）                                                                        | `ChatView.tsx:84,181-183,363-366`                                                                                               |
| 13  | ConfirmDialog danger/loading 模式 + sonner toast 先例（清除上下文确认 1368-1381）                                                                                      | `ChatView.tsx:1368-1381,615`                                                                                                    |
| 14  | auto-memory store 集中全部 `/api/auto-memory/*` 调用；action 约定=actionError+throw、JID 编码                                                                          | `web/src/stores/auto-memory.ts`（任务 W+X 既有 action 族）                                                                      |
| 15  | **前端默认超时 8s 不够提炼**：`api.post(path, body, timeoutMs?)` 第三参可传自定义超时——capture 必须 90_000                                                             | `web/src/api/client.ts:3,86-91`                                                                                                 |

## 3. 方案设计

### 3.1 批次 1：后端两端点（扩展 `src/routes/auto-memory.ts`）

共享组装函数（两端口复用）：

```ts
function assembleCaptureMessages(chatJid: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  chars: number;
};
// getMessagesPage(jid, undefined, 400) → 反转正序 → 剔除 __system__/__billing__/空内容
// → 角色映射 is_from_me?'assistant':'user' → 60k 字符预算从最新往回累积、截断更早消息
```

| 端点                                                                     | 行为                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auto-memory/workspaces/:workspaceJid/capture/preview?agentId=` | ACL read；组装但不调侧车，返回 `{messages:N, chars:M}`（成本预览）                                                                                                                                                                                                                          |
| `POST /api/auto-memory/workspaces/:workspaceJid/capture`                 | Body `{agentId?}`；ACL write（404 隐藏）；agentId 时用虚拟 jid（§2.1-4）；空会话 400 `invalid_args`；`callSidecar(group,'add',{messages, metadata:{source:'chat_capture', agentId?, capturedAt}})` → `{ok:true, captured:N, added:M, intercepted:K}`；未配置 503（既有 unavailableReceipt） |

测试（`tests/auto-memory-routes.test.ts` 扩展，先见红）：401/404/read-write 两 ACL 面、role 映射与系统/计费行剔除、时间正序、400 上限、60k 截断保尾部、agentId 虚拟 jid、metadata.source、receipt 计数汇总、not_configured 503、preview 不触发侧车调用（sidecarCalls 断言）。消息 seed 用 db 既有写入函数（探索报告 storeMessageDirect，db.ts:2739；实现时以实际导出名为准）。

### 3.2 批次 2：前端按钮 + store（TDD）

- `web/src/stores/auto-memory.ts` 加 `previewCapture(workspaceJid, agentId?)` 与 `captureConversation(workspaceJid, agentId?)`——后者 `api.post` **传 timeoutMs 90_000**（§2.2-15，测试钉住）；失败 actionError+throw（既有约定）。
- `web/src/components/chat/ChatView.tsx`：header 1049-1072 模式加 `BrainCircuit`「提炼记忆」按钮（`canModifyWorkspaceConfig` 门控）；点击 → preview → ConfirmDialog（文案：将把该会话 **N 条文本消息（约 X 字，含跨会话历史）** 送入自动记忆提炼，产生一次模型调用）→ 确认执行（in-flight 禁用防重入）；成功 toast「提炼完成：捕获 N 条，新增 M 条记忆（K 处疑似凭据已脱敏）」；失败 toast(actionError)。按钮 busy 态处理超过 8s 的等待（宪法前端四状态）。
- 测试（`tests/auto-memory-frontend.test.ts` 扩展）：store 两 action（api.post 调用参数含 90_000 断言）、ChatView 文件断言（按钮门控、ConfirmDialog、不直连 `/api/auto-memory`）。

### 3.3 批次 3：文档同步 + 收尾

- `docs/API.md` 自动记忆小节加 preview/capture 两端点；`docs/ACL-MATRIX.md` §4.6 表加两行（preview=read / capture=write）。
- `npm run verify` 六步 → `node scripts/check-scope.mjs` → 单提交 `feat: 记忆 - 会话全文提炼入自动记忆按钮（任务Y）`（push 由用户显式发起）。

## 4. 执行顺序（TDD，每步先写测试见红再实现）

1. **批次 1**：`tests/auto-memory-routes.test.ts` 新用例见红 → 组装函数 + preview/capture 两端点。
2. **批次 2**：`tests/auto-memory-frontend.test.ts` 新用例见红 → store 两 action + ChatView 按钮/确认/回执。
3. **批次 3**：API.md/ACL-MATRIX 同步（docs:check 会拦）→ verify → check-scope → 单提交。

## 5. 文件清单（= `.gatescope.json` allow）

新增：`docs/task-y-chat-capture-plan.md`（本文档）
修改：`src/routes/auto-memory.ts`、`web/src/stores/auto-memory.ts`、`web/src/components/chat/ChatView.tsx`、`tests/auto-memory-routes.test.ts`、`tests/auto-memory-frontend.test.ts`、`docs/API.md`、`docs/ACL-MATRIX.md`
（不动 `src/db.ts`（getMessagesPage 现成）、`src/index.ts`、任何 schema/依赖；批次 4/5 不做。）

## 6. 风险与边界

1. **ChatView.tsx 热点文件（约 1423 行）**——仅 header 局部插入，锚点（1049-1072 按钮区）用文件读断言钉住；不重构无关代码（宪法 1.5）。
2. **提炼时长与前端超时**——60k 字一次 LLM 提炼可能 10-60s：capture 调用必须 timeoutMs 90_000（测试钉住）；manager 60s 超时杀侧车为既有语义（下次 respawn）；确认框/失败文案明示「对话过长可能超时，可稍后重试」。
3. **成本可见性**——确认框前置显示条数/字数；400 条/60k 字服务端封顶单次成本；limit 不收客户端值。
4. **角色映射与内容简化**——is_from_me→assistant、系统/计费行剔除、仅文本 content（attachments/图片不参与）：确认框文案明示「文本消息」。
5. **「全部历史」跨会话语义**——context_reset 行剔除但其前内容保留：文案明示「含跨会话历史」（用户 2026-11-10 拍板）。
6. **mem0 additive-only**——重复提炼同段历史大多 hash 判重、可能少量近似条目：任务 W 管理页可删，兜底已存在。
7. **权限双面**——preview=read、capture=write 同路由族分段语义，测试分别钉 401/404/200。
8. **零新增依赖**（宪法 4）；key/对话内容不落日志（宪法 3——组装函数与路由不得 logger.info 消息内容）；测试全走临时目录/mock。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`（diff 全在 §5 清单内）。
- 真机验收（用户执行，实现/审查分离）：聊天页点「提炼记忆」→ 确认框显示 N 条/X 字 → 执行 → toast 回执（新增 M 条）→ 设置「自动记忆」tab 列表出现新条目、搜索可命中 → 非 owner 账号看不到按钮、preview/capture 请求 404 → 未配置环境（清掉配置）点按钮 → 明确 503 提示。
- `.gatescope.json` 随立项提交落档（task=任务Y，base=`18b9125`，allow=§5 清单）；实现会话**不得扩宽**，确需扩宽在提交信息说明理由并由用户复核。
