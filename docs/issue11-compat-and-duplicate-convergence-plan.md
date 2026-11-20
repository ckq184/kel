# ISSUE-11 立项计划：兼容层下线与重复实现收敛

> 任务来源：`docs/issues/ISSUE-11-compat-and-duplicate-convergence.md`（审查报告 §7、§8、§14.2）。
> 立项基线：main `5d76afb`（开工前 HEAD，`.gatescope.json` base pin）。
> 立项日期：2026-11-20。领取分支：`issue-11`。

---

## 1. 现状取证摘要（2026-11-20 全仓核实，行号为当前 main 实测）

两路只读探查代理对 issue 全部主张逐条交叉核实（搜索范围含 `src/`、`web/src`、`container/`、`tests/`、`docs/`、`scripts/`、`electron/`）。结论：

- **A 部分主张成立**：13 条 user-im 死门面路由与 7 个旧入口全仓确无调用方（仅 `docs/API.md` 散文、`docs/dead-code-review-r2.md` 记载与 1 个幂等测试引用）；WS `send_message` 无任何发送方。
- **四处增补事实**（issue 原文未覆盖，已在需求采访中向用户报告）：
  1. `PUT /user-im/bindings/:imJid` 与 `reset-allowlist` 在 `/api/channel-accounts` **无等价物**（该门面只管账号 CRUD，不管 imGroup 绑定写与 allowlist 解锁）；`GET /user-im/status` 也无直接等价端点。
  2. `/agents` 写路由与 `/sessions` 版**已行为分叉**（sessions 版多 `main` 特判、`kind !== 'conversation'` 限定、响应 `{session, agent}` 双键）；前端写路径已全走 `/sessions`，agents 写路由仅 `tests/routes-agents-acl.test.ts` 引用。
  3. 头像上传实际**三套**同构实现（issue 只列两套）：`src/routes/config.ts:1959`、`src/routes/auth.ts:769`、`src/routes/agent-profiles.ts:337`。
  4. `web:{folder}` 旧格式串**运行时仍在活跃制造**（`src/index.ts` 多处）；WhatsApp 前端残留已被先前任务清光，仅剩 `phoneNumber` 死字段三处声明（无读写）。
- **B 部分核实**：`markNativeContextWorkspace` 分叉属实（config 版经 `resolveWorkspaceForBinding` 把旧格式折叠到注册 jid 再写 `native_thread` 标记；agents 版直查失败即静默 no-op）；`buildCustomEnv` 校验分叉属实（ProviderEditor 允许小写 key/空 value/不 trim + 第三方默认键拦截；Setup 版仅大写/非空/trim）；错误提取 11 份命名副本行为差异属实，且 `McpServerDetail` 版会把 API 错误文案吞成兜底文案（`web/src/api/client.ts:63-67` 抛普通对象非 Error 实例）；`resolveWorkspaceJid` 实为三份（`src/index.ts:17412` 私有版、`src/channel-mount-service.ts:332` 导出版、`src/workspace-attribution.ts:22` 镜像版）；`formatCost`/`safeStorage`/`nowIso`/`normalizeForCanonicalJson`/`stripOneMillionSuffix` 为逐字重复；`OAuthUsageBucket` 双声明字段完全一致（TS 声明合并合法，纯冗余）；计费 pattern 归一化两处（`src/db.ts:12693` 私有 + `src/routes/pricing.ts:77/:106` 内联）语义逐字等价，409 唯一性预检全靠该语义恒等；`shared/` 复制式同步机制现成（`scripts/sync-stream-event.sh` + `make sync-types` + Makefile `_check-sync` 哨兵），runner 侧无法跨项目 import（tsconfig `rootDir` 限定），复制式收敛完全可行。
- `include_claude_preset` 前置已解除：ISSUE-04 ④B 已下线 UI，并把「`prompt_mode`/`includeClaudePreset` 契约层彻底下线」显式留给本 issue；宿主计算（`src/index.ts:2143`、`src/task-scheduler.ts:257`）与 runner 线缆声明（`container/agent-runner/src/types.ts:249`）仍在。

## 2. 用户决策（2026-11-20 拍板，八项全部按推荐）

| #   | 决策点                                                                     | 拍板结果                                                                                                                                          |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A 部分总闸：兼容期是否结束                                                 | **已结束，全案下线**（同时确认删除 `send_message` 处理器及其独有 `/sw` `/spawn` 命令——全仓无发送方可达）                                          |
| 2   | A.3 `/agents` 别名写路由（5 条）                                           | **直接删除**（ACL 测试同步迁移到 `/sessions` 等价路由或改断言 404；`GET /agents` 保留）                                                           |
| 3   | A.1 `bindings/:imJid` 与 `reset-allowlist`（channel-accounts 无等价物）    | **原地保留这两条**（现行活 API 非死门面；仅删 13 条死路由 + 迁移 status/feishu）                                                                  |
| 4   | A.5 `include_claude_preset` 清理范围                                       | **契约层彻底下线**（ContainerInput 字段 + 宿主两处计算 + runner 线缆声明 + 前端类型全删；DB `prompt_mode` 列与 profile API 字段留给 ISSUE-09/10） |
| 5   | A.6 Settings 旧 tab 重定向（实际 7 显式 + 1 隐式，超 CLAUDE.md 声明 3 条） | **全保留 + 补声明 + 补测试**（CLAUDE.md 声明更新为实际清单；测试补锁定全部映射）                                                                  |
| 6   | B.1 `markNativeContextWorkspace` 分叉                                      | **取 config 折叠版**（旧格式串仍活跃产生，折叠防丢 `native_thread` 标记；收敛为单一共享实现）                                                     |
| 7   | B.5 `buildCustomEnv` 校验分叉                                              | **严格合成版**（仅大写 key + 非空 value + trim 存储 + 保留可选第三方默认键拦截参数；ProviderEditor 行为收紧，存量已存数据不动）                   |
| 8   | B.9 头像第三套（agent-profiles.ts，issue 预计路径未列）                    | **一并收敛**（三套路由复用共享 helper；`src/routes/agent-profiles.ts` 随立项扩入 gatescope 供复核）                                               |

不在决策清单内、按 issue 指示直接处理并在交付记录写明所选行为的项：`resolveWorkspaceJid` 改调导出版、错误提取统一到 `utils/error.ts` 共享版、计费归一化收敛、`nowIso`/`requireDatabase`/`OAuthUsageBucket`、跨进程函数纳入 `shared/`。

## 3. 实施方案

### 3.A 兼容层下线（提交 1）

**A1 user-im 门面收敛（`src/routes/config.ts` 2499-3700 区域）**

- 删 13 条死路由：QQ 7 条（test GET/PUT/POST、pairing-code、paired-chats GET/PUT/DELETE）、微信 5 条（qrcode GET/POST、qrcode-status、disconnect 等，以代码实测为准）、`GET /user-im/feishu`。
- 迁移后删 `GET /user-im/status`：前端两处改调 `GET /api/channel-accounts` 并按 provider 派生连接布尔（对齐原 status 语义）——`web/src/components/chat/ChatView.tsx:263`（own-home 30s 轮询）、`web/src/hooks/useConnectedChannels.ts:14`（CreateTaskForm/TaskDetail 渠道过滤）。
- 迁移后删 `PUT /user-im/feishu`：`web/src/pages/SetupProvidersPage.tsx:208` 改走 `POST /api/channel-accounts`（新建）/ `PATCH /:id`（更新）写凭据；`syncLegacyUserImFacade` 已单向镜像回 `saveUserFeishuConfig`，迁移后消除第二真源。
- **保留**：`PUT /user-im/bindings/:imJid`、`POST /user-im/bindings/:imJid/reset-allowlist` 原地不动（拍板 #3）；`docs/API.md` 将这两条从「门面」改标为正式路由。
- 区域内失去调用方的死辅助/死类型逐个 grep 复核同删。

**A2 旧入口 7 条删除**

- `POST /api/tasks/parse`（tasks.ts:1251）、`GET /tasks/:id/logs`（:929）、`POST /tasks/:id/run`（:869）、`GET /api/config/claude`（config.ts:776）、`PUT /claude/custom-env`（:1590）、`GET/PUT /api/config/feishu`（:1779/:1794）。
- `tests/routes-tasks-contract.test.ts:1132-1163` 幂等用例同步处理（删或迁至现行任务入口，以现行入口是否已有等价幂等契约为准）。

**A3 `/agents` 写路由 5 条删除（agents.ts:414-1673）**

- `POST/PATCH/DELETE /:jid/agents(/:agentId)`、`PUT/DELETE /:jid/agents/:agentId/im-binding(/:imJid)`；`GET /agents` 保留。
- `tests/routes-agents-acl.test.ts` 写用例迁移到 `/sessions` 等价路由（保持 ACL 矩阵语义；sessions 版更严格属预期行为）。
- agents.ts 内仅被写路由使用的辅助随删（其余归 B1 收敛）。

**A4 WS `send_message` 处理器删除（web.ts:1311-1500）**

- 含 WS 版 `/clear`、独有 `/sw` `/spawn` 命令、WS 自维护鉴权（含与 HTTP 已分叉的 `role !== 'admin'` host 判定）。前端只发 `terminal_*`，全仓无发送方。
- `web/src/api/ws.ts` 通用 send 保留（`terminal_*` 仍用）。

**A5 前端残留与契约层下线**

- `phoneNumber` 死字段删：`web/src/stores/channel-accounts.ts:56/:84`、`src/types.ts:268`。
- `include_claude_preset` 契约层彻底下线（拍板 #4）：删 `src/index.ts:2143`、`src/task-scheduler.ts:257` 两处计算、`src/agent-profile-prompts.ts:6-11` helper、`src/container-runner.ts:384` 契约字段、`container/agent-runner/src/types.ts:249` 线缆声明、`web/src/types.ts:65`、`web/src/stores/agent-profiles.ts:75/:91`。
- 测试同步：`tests/agent-profiles-db.test.ts:218/:321`、`tests/mcp-runtime-secret-boundary.test.ts:384`、`tests/provider-scheduled-fallback.test.ts:70`、`tests/routes-agent-profiles.test.ts:1270` 等断言点（实现时 grep `includeClaudePreset` 全仓逐点处理）。
- **不动**：DB `prompt_mode` 列、profile API `prompt_mode` 字段、表单 payload、`AgentPromptVersionHistory.tsx:104` 读点（ISSUE-09/10 范围）。

**A6 Settings 旧 tab 重定向（拍板 #5）**

- `SettingsPage.tsx` 不改；`CLAUDE.md:91` 声明从 3 条扩为实际清单（7 显式 + automation 隐式特判）；`tests/frontend-settings-information-architecture.test.ts` 补锁 groups/agent-profiles/memory/usage 四条映射。

**A 文档同步**

- `docs/API.md`：`/agents` 别名段改写（写路由删、GET 保留）、GET claude、PUT custom-env、user-im 门面段改写、config/feishu、run/logs/parse、`send_message` 段删；`tests/api-route-caller-contract.test.ts` 按其双向契约机制同步。
- `docs/ACL-MATRIX.md`：`/agents` 兼容 Mount 行、`send_message` 两行、:103「/clear 的 HTTP 与 WebSocket 分支」提法。

### 3.B 重复实现收敛（提交 2）

**B1 markNativeContextWorkspace 统一 + 路由辅助收敛**

- 折叠版（config 语义，含 `resolveWorkspaceForBinding`）提取为共享导出，落点首选 `src/channel-mount-service.ts`（两路由文件已共同依赖；deps 结构不匹配则新建 `src/routes/group-binding-helpers.ts`）。
- `getConversationKind`、`fetchLiveChatInfo`、`hasConsistentChannelAccount`、`refreshAgentLastImJid` 收敛为单一实现；`updateWorkspaceGroup`/`applyRegisteredGroupUpdate` 取**有守卫版**（`if (groups[jid])`，不凭空建缓存条目）；`detach*IfLast` 两版签名不同，统一签名并保留调用适配——均按「取更健壮语义」原则，交付记录写明每项选择。
- agents 侧 `markNativeContextWorkspace` 调用点获得折叠语义（拍板 #6 的行为变化）。

**B2 resolveWorkspaceJid 收敛**

- `src/index.ts:17412` 私有版删 → 改调 `src/channel-mount-service.ts:332` 导出版；`src/workspace-attribution.ts:22` 镜像版同改（语义一致零变化）。边缘行为变化：同 folder 多候选且第一个未注册时从「返回 null」变为「跳过未注册候选继续找」——更健壮，交付记录写明。

**B3 `/api/groups` 双 store 统一数据源**

- 首选方案 A：`useGroupsStore` 改为 `useChatStore` groups 状态的投影（组件 API 不变，数据单源；chat store 保持 owner：并发去重 + currentGroup）。
- 若实现受阻（循环依赖等）降级方案 B：groups store `loadGroups` 转调 chat store 同一 loader 共享缓存，chat store 的 `createFlow/renameFlow/togglePin/deleteFlow` 四流同步广播 groups store。
- 顺带简化 `web/src/stores/agent-profiles.ts:326-327`、`SystemSettingsSection.tsx:524-525` 的双 `loadGroups` 调用（若方案 A 使其自然冗余）。
- 新增测试锁：改名/置顶/删除后两 store 一致（ISSUE-06 依赖项的正式关闭）。

**B4 错误提取 11 份收敛到共享版**

- `web/src/utils/error.ts` `extractErrorMessage` 加可选 `fallback` 参数（无 fallback 保持现行为）。
- 11 份命名副本全部替换：`components/users/utils.ts:3`、`AgentPromptAssistant.tsx:40`、`MemoryPage.tsx:126`、`AgentProfilesPage.tsx:589`、`SetupPage.tsx:14`、`stores/users.ts:117`、`stores/usage.ts:535`、`ChannelAccountsManager.tsx:1146`、`QrOnboardingPanel.tsx:488`、`McpServerDetail.tsx:531`（各自兜底文案经 fallback 参数保留不变）。
- 统一行为（交付记录写明）：`Error.message` 优先 → 对象 `.message` → `String(err)`；**不 trim**；顺带修复 `McpServerDetail` 吞 API 文案真 bug。
- 保留并登记：`utils/download.ts:25`（HTTP Response 特化版）、`components/settings/types.ts:135` `getErrorMessage`（settings 区 trim+fallback 语义）；数十处一行式 `err instanceof Error ? …` 不在本 issue 11 份清单内，登记残留。

**B5 formatCost / safeStorage / buildCustomEnv**

- `formatCost` → 新 `web/src/utils/usage-format.ts`；`safeStorage` → 新 `web/src/utils/safe-storage.ts`（原文件保留 re-export 以防外部 import）；`UsageTrendChart.tsx`/`UsagePage.tsx`/`routeRestore.ts`/`workspaceLastAgent.ts` 改调。
- `buildCustomEnv` 严格合成版（拍板 #7）→ 新 `web/src/utils/custom-env.ts`：仅大写 key、value 非空、trim 存储、`RESERVED_ENV_KEYS` 拦截、可选 `manageThirdPartyDefaults` 第三方默认键拦截、重复 key 检测、任一错误整包作废。`ProviderEditor.tsx` 行为收紧（拍板项）；`SetupProvidersPage.tsx` 传无拦截（现行为不变）。
- 测试锁严格校验（小写拒/空值拒/trim/拦截参数）。

**B6 nowIso / requireDatabase**

- 新 `src/store-helpers.ts`：`nowIso` 导出共享；`requireDatabase(db, storeLabel)` 参数化**保住三条现有抛错文案**。`memory-store.ts`、`owner-profile-store.ts`、`channel-reliability-store.ts` 改调。
- `channel-reliability-store.ts:246` `isoNow`（可注入时钟的增强版）保留，登记非副本。

**B7 OAuthUsageBucket**：删 `src/runtime-config.ts:3399` 冗余声明（保 :250 注释版），同文件声明合并消失、类型不变。

**B8 计费 pattern 归一化**：`src/db.ts:12693` `normalizePricingPattern` 导出；`src/routes/pricing.ts:77/:106` 两处内联改调。409 行为不变（两版本就逐字等价）；契约测试锁单一实现。

**B9 头像三套收敛（拍板 #8）**

- 新 `src/routes/avatar-upload.ts`：共享 multipart 字段读取、`AVATAR_MAX_FILE_BYTES` 校验、MIME→扩展名映射、错误文案、写盘 `DATA_DIR/avatars`；reap 策略参数化（config 全局前缀 / auth 用户前缀+保护另一 target / agent-profiles profile 前缀）。
- 三路由改调共享 helper，各自保留鉴权与落库差异（appearance config / user fields / profile 行）。行为不变；MIME 大小写不归一维持现状（登记）。

**B10 跨进程函数纳入 shared/**

- 新 `shared/canonical-json.ts`（`export normalizeForCanonicalJson`）+ `shared/model-suffix.ts`（`export stripOneMillionSuffix`）；`scripts/sync-stream-event.sh` 加两段（目标 `src/` + `container/agent-runner/src/` 各 2 份）；Makefile `_check-sync` 哨兵列表加 4 个新目标路径；`make sync-types` 同步并 cmp 验证。
- 消费方改 import 各自本地副本：`src/workspace-memory-capability.ts`、`container/agent-runner/src/workspace-memory-auth.ts`（canonical）；`src/runtime-config.ts`、`container/agent-runner/src/context-window.ts`（suffix，本地版删）。host 侧统一 export 修饰。
- `tests/agent-runner-context-window.test.ts` import 路径同步（或 context-window 保留 re-export）。
- HMAC payload 构造两份同构（`workspace-memory-auth.ts:29-45` vs `workspace-memory-capability.ts:52-67`）不在 issue 范围，交付记录登记。

### 3.提交切分

按 issue 原文「A、B 两部分可分两次提交」：

1. `refactor: ISSUE-11 A - …`（兼容层下线 + 文档同步 + A 相关测试）
2. `refactor: ISSUE-11 B - …`（重复实现收敛 + 契约测试 + B 相关测试）
3. `docs: ISSUE-11交付落档 - …`（独立审查两轮结论 + issue 状态/交付记录 + README 行 + 审查记录落档）

## 4. 测试与验收

- **行为锁定新增**：markNativeContextWorkspace 折叠行为（旧格式 `web:{folder}` → 注册 jid 写 `native_thread`）；buildCustomEnv 严格校验；groups store 增删改名置顶后两 store 一致；channel-accounts status 派生逻辑；SettingsPage 重定向全量映射。
- **源码唯一性契约测试**（新 `tests/no-duplicate-helpers-contract.test.ts`，宪法第 9 条机审落点）：`markNativeContextWorkspace`/`resolveWorkspaceForBinding`/`normalizeForCanonicalJson`/`stripOneMillionSuffix`/`normalizePricingPattern`/`formatCost`/`safeStorage`/`buildCustomEnv`/`nowIso`/`OAuthUsageBucket` 定义唯一；错误提取命名副本封禁（白名单：`utils/error.ts`、`settings/types.ts`、`utils/download.ts`）；已删路由不复活（`src/web.ts` 无 `send_message` 入站注册、config.ts 无死门面路径注册等 grep 断言）。
- **既有测试同步**：`routes-tasks-contract`（幂等用例）、`routes-agents-acl`（写用例迁 sessions）、`api-route-caller-contract`（API.md↔路由）、`frontend-settings-information-architecture`（补锁）、`agent-profiles-db`/`mcp-runtime-secret-boundary`/`provider-scheduled-fallback`/`routes-agent-profiles`/`pi-runtime-settings-and-credentials`（includeClaudePreset 断言点）、`agent-runner-context-window`（import 路径）、`runtime-appearance-config`/`frontend-agent-identity`（头像收敛后照跑）。
- **验收标准（issue 原文）**：`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过；合并行为有测试锁定，分叉实现的最终选择在交付记录写明；`docs/API.md`、`docs/ACL-MATRIX.md` 同步更新。

## 5. 范围与约束（`.gatescope.json`）

- `task`：issue11-compat-and-duplicate-convergence（本计划）；`base`：`5d76afb`（开工前 main HEAD）。
- `allow`：§3 全部涉及路径（含新文件 `src/avatar-upload.ts`、`src/store-helpers.ts`、`src/canonical-json.ts`、`src/model-suffix.ts`、`container/agent-runner/src/canonical-json.ts`、`container/agent-runner/src/model-suffix.ts`、`shared/canonical-json.ts`、`shared/model-suffix.ts`、`web/src/utils/usage-format.ts`、`web/src/utils/safe-storage.ts`、`web/src/utils/custom-env.ts`、两个新测试文件）+ 拍板 #8 扩入的 `src/routes/agent-profiles.ts` + 文档四件（API.md、ACL-MATRIX.md、CLAUDE.md、审查记录）+ issue/README/本计划 + `Makefile`、`scripts/sync-stream-event.sh` + `.gatesecretsignore`（新测试 fixture 如需白名单，ISSUE-04 先例）。
- 实现中发现需改 allow 外文件：按 ISSUE-04 先例在实现提交中扩声明并在提交信息注明，供立项批准者复核。
- **非目标**：DB `prompt_mode` 列与 profile API 字段删除（ISSUE-09/10）；HMAC payload 构造统一（登记）；一行式错误提取全局清扫（登记）；`GET /agents` 与 `GET /sessions` 本身的重复（登记，GET /agents 按 issue 保留）；MIME 大小写归一（登记）；DB 零改动、零新增依赖。

## 6. 风险与应对

- **行为变化已拍板明示**：agents 侧 markNativeContextWorkspace 获折叠语义；ProviderEditor env 校验收紧；resolveWorkspaceJid 边缘场景更健壮；/agents 写路由 404（外部脚本若有依赖会断——兼容期已由用户确认结束）；WS send_message 入口消失（全仓无发送方已核实）。
- **删除面大**：每处删除前以 `git grep -w` 复核调用方（含 tests/、docs/），失去调用方的辅助/类型逐个确认同删；`api-route-caller-contract` 双向契约测试兜底 API.md 与实际路由一致。
- **`web/src/stores/chat.ts` 多 issue 冲突文件**（03/06/08/10/11）：当前无并行会话，交付时提示后续 issue 合入前 rebase。
- **shared 同步**：新 shared 文件后必跑 `make sync-types`，`_check-sync` 哨兵补齐防 dev 流程漏同步；两侧 cmp 验证逐字一致。
- **测试假绿**：includeClaudePreset 删除涉及 5 个测试断言点，逐个改断言而非删用例；load-sensitive 预算用例若满载翻红按冷却复测定性流程处理。
- **敏感纪律**：不把凭据/端点/模型名写入测试或日志；env fixture 一律假值。
