# 任务立项：ISSUE-12 结构重构 —— 镜像函数收敛与巨型函数拆分

> 类型：纯重构，不改变行为。依赖 ISSUE-02、03、05、08、10（均已合入 main）。
> 基线 `29ee7f0`（开工前 HEAD，`.gatescope.json` base pin）。
> 工作分支：`issue-12-structural-refactor`；合入 main 由用户决定。

## 0. 用户拍板（2026-11-21 需求采访，三项全采推荐方案）

1. **镜像函数 5 处语义分歧 → 参数化保留现状**：公共模块以策略字段/构造参数承接全部分歧（见 §7.2 表），A/B 两侧行为逐字节不变，严格符合"纯重构不改行为"约束。后续如要统一语义，另立行为变更 issue。
2. **提交批次顺序 → 风险递增**：导出收窄（纯样式热身）→ 渠道三函数 → `initDatabase` → IPC 两函数 → `AgentProfilesPage` → 镜像函数压轴。每波交付后输出交付报告并等用户批准再启动下一波（workflow 阶段 9）。
3. **第 4 项样板代码 → 三项都做**：`canAccessGroup`+404 helper（31 处）、zod 400 四写法收敛（33 处）、tests `asUser`/`createUser` 收敛（19 个文件），排在末尾波次。

## 1. 现状实测（基线 29ee7f0，行号已逐个重核）

ISSUE-12 文档中的行数是审查 R2 时点（基线 `3f34cf7`）的估计，ISSUE-02/03/05/08/10 合入后已漂移，本计划全部以下表为准：

| 函数                                        | 位置                                | 当前行区间  | 当前行数 | issue 基线行数 |
| ------------------------------------------- | ----------------------------------- | ----------- | -------- | -------------- |
| `processGroupMessages`（A，群聊）           | src/index.ts                        | 5009-8288   | 3280     | 3634           |
| `processAgentConversation`（B，Agent 会话） | src/index.ts                        | 12820-15391 | 2572     | 2907           |
| `createFeishuConnection`                    | src/feishu.ts                       | 1121-3781   | 2661     | ≈2659          |
| `createQQConnection`                        | src/qq.ts                           | 388-2159    | 1772     | —              |
| `createWeChatConnection`                    | src/wechat.ts                       | 456-1564    | 1109     | —              |
| `initDatabase`                              | src/db.ts                           | 459-2562    | 2104     | ≈2110          |
| `processTaskIpc`                            | src/index.ts                        | 10482-12819 | ≈2338    | 2351           |
| `startIpcWatcher`                           | src/index.ts                        | 9053-10349  | 1297     | 1288           |
| `AgentProfilesPage`                         | web/src/pages/AgentProfilesPage.tsx | 199-2191    | 1993     | 2126           |

数字勘误（相对 issue 描述）：

- "41 个 useState" → 当前 **39 个调用点**（22 个直接 `useState(` + 16 个单行泛型 `useState<T>(` + 1 个跨行泛型；ISSUE-04 删过 1 个编辑态）。issue 的 41 是写文档时点的全文出现次数（含 import 行）。
- "488 个仅本文件内使用的导出" → 当前双层口径实测 **490 个**（src/ 1713 + web/src 643 导出名中，文本层 `grep -rwn` 全仓零外部命中者），差异来自 02~11 合入期的代码变动。
- "约 9 组对齐块、重复约 2000 行" → 逐块核实为 **39 组镜像块**（9 组是宏观归并；单 M30 一块就含 8 个可独立抽取的子段），min 侧合计 ≈2190 行，扣除薄适配后**预计可删约 1900 行**。旧估计成立但粒度过粗。
- `canAccessGroup` 后接 404："约 25 次"对应 `'Group not found'` 一类；实际 404 共 **31 处**（另有刻意的 403×9 处与非 return 用法×6 处，不能统一）。

## 2. 提交单元总则（所有波次通用）

1. **每次提交只拆一个单元**；提交信息首行 `refactor: 范围 - 摘要`（样板波次用 `style:`/`test:`，均符合 commit-msg 钩子）。
2. **回滚点**：每单元提交前的 HEAD 即回滚点（`.gatescope.json` base pin 29ee7f0 为整任务回滚点）；验收失败先 revert 再修正方案，禁止在污染状态上堆改。
3. **行为不变**：单提交内只做"剪切-粘贴-接线"，不改任何表达式、日志文案、SQL 文本、回执字符串、响应体字面量；门控表达式原文搬运；`git diff -w` 应呈现纯移动。
4. **每单元提交前后跑 `npm run verify`（六步 fail-fast）+ `node scripts/check-scope.mjs`**；涉及测试锚点迁移的单元，锚点测试修改与代码搬迁**同提交**。
5. **行数台账**：每单元提交信息与最终交付记录写明前后文件/函数行数变化（issue 验收标准）。
6. **实机冒烟**：Web/飞书/QQ/微信对话与定时任务冒烟需真实渠道凭证，本会话不可用时如实登记、交付报告列出待用户点验清单。
7. **源码文本契约测试**是最大破坏面（约 15 个测试直接 `read('src/index.ts'|'src/db.ts'|'web/src/pages/AgentProfilesPage.tsx')` 锚定内容）：每单元搬迁前先列出受影响锚点，搬迁与改锚同提交，verify 兜底。

## 3. 波 1：导出收窄（风险最低，热身批次）

范围：490 个"仅本文件内使用"的 `export` 去掉多余 `export` 关键字（符号本体保留——它们在文件内部仍被使用，不是死代码）。

方法（双层口径，缺一不可）：

1. **文本层**：对文件 F 的每个导出名 N，`grep -rwn "N" src web/src tests scripts electron shared container --include=*.ts --include=*.tsx -l`，排除 F 与 node_modules；零命中 ⇒ 候选。这层能抓到 `await import('../src/db.js')` + 属性访问的动态引用（db.ts 有约 110 个测试文件动态引用，只看 import 图的工具必错）。
2. **import 图层**：解析 `import`/`export ... from`/`export *`/`import * as`/`import('…')`/`vi.mock('…')`；`import * as ns` 与 `export * from` 视作"全部被引用"（保守）；非字面量动态 import（全仓仅 4 处）人工复核。
3. 两层都为空才可收窄。每名删除前再跑一次单名 grep（秒级，防基线清单过时）。

排除名单（不收窄，除非另立拍板）：

- barrel 文件（re-export 本身就是用途）；
- `shared/stream-event.ts` / `src/stream-event.types.ts` / `web/src/stream-event.types.ts` 三份逐字节同步副本（要动必须三份同提交并过 `scripts/check-stream-event-sync.sh`，默认整组跳过）；
- `src/index.ts` 的 7 个候选：它是 `"main": "dist/index.js"` 入口，仓外无消费者声明（本仓为应用非库）后单列一批处理。

分批：每批 ≤20 个名字、**单文件单提交**；顺序 type/interface → const → function。web 侧 `tsconfig` 开了 `noUnusedLocals`，若去 export 后 tsc 报"never used"说明该符号应整体删除——出现即停下按删除前交叉核实口径处理（grep 调用方 + tests/docs 搜索），不在本波顺手删。

范围声明扩宽：波 1 开工前用临时脚本（本地一次性，不入库）生成候选文件清单，随波 1 首个提交把文件清单显式加入 `.gatescope.json` allow 并在提交信息说明（扩宽留痕，复用 ISSUE-10 的 8 条扩宽先例）。

## 4. 波 2：渠道三函数拆分

原则：**外层门面不动**——三个 `Connection` 类型（feishu.ts:175-193、qq.ts:302-339、wechat.ts:144-166）与回调注册接口（`ConnectOptions` feishu.ts:97-164、`QQConnectOpts` qq.ts:277-300、`WeChatConnectOpts` wechat.ts:116-142）零改动；`src/im-channel.ts` 是唯一工厂调用方，不改；原文件继续 re-export 全部现有导出（tests 直接 import 的 8+2+5 个符号不动）。门面方法体从"闭包直调"改为"委托新模块"。

### 4.1 feishu.ts（工厂 2661 行 → 原地剩约 380-450 行；文件 3781 → 约 1500）

提交单元（低闭包 → 重连簇 → durable 顺序）：

| #    | 新模块                              | 吸收行区间（现文件）                  | 职责                                                       | 接口要点                                                                                                                                                                           |
| ---- | ----------------------------------- | ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `src/feishu-bot-info.ts`            | 1410-1499                             | bot open_id 拉取+指数退避+lazy refetch                     | `createFeishuBotInfoRefresher(getClient)`                                                                                                                                          |
| 2.2  | `src/feishu-media.ts`               | 1500-1608 + 头部 338-369              | 图片/文件下载                                              | 纯函数，client 显式传参                                                                                                                                                            |
| 2.3  | `src/feishu-backfill.ts`            | 2877-2988 + 3068-3099                 | message.list 翻页回填                                      | `runFeishuBackfill(getClient, progress, reason)`                                                                                                                                   |
| 2.4  | `src/feishu-outbound.ts`            | 1609-1756 + 3460-3665                 | 底层发送、卡片/post 决策、sendImage/sendFile               | `createFeishuSender(getClient, progress)`；sendMessage 图片附件失败必须抛出（im-send-strict-ack 锚定）                                                                             |
| 2.5  | `src/feishu-events.ts`              | connect 内 3230-3398                  | 5 个事件注册                                               | `buildFeishuEventHandlers(...)`；**connect() 仍恰好 new 一个 EventDispatcher、注册同样 5 键、syncGroups 先于 wsClient.start**（feishu-durable-inbox.test.ts:71-81/211 直测该结构） |
| 2.6  | `src/feishu-ws-lifecycle.ts`        | 1364-1408 + 3100-3186 + connect WS 段 | 健康监控、重连、SDK 私有状态探查                           | `createFeishuWsLifecycle(state)`；reconnecting/disconnectedChecks 等收进 state 对象；探查失败静默降级语义保留                                                                      |
| 2.7  | `src/feishu-inbox.ts`               | 1160-1354 + 1758-1816 + 2989-3067     | durable Inbox：进度/心跳/恢复/认领/信封解析                | `createFeishuInboxController(...)`；`reliabilityAccountId`（1126）与 `inboxOwner`（1127 含 randomUUID）推导原样保留——持久键，改了会静默失效跨实例去重/游标恢复                     |
| 2.8  | `src/feishu-inbound-admission.ts`   | 1947-1963 + 2236-2384                 | 受众门、mention 门（fail-closed）、路由准入、P2P bootstrap | 纯决策函数                                                                                                                                                                         |
| 2.9  | `src/feishu-inbound-attachments.ts` | 2434-2662                             | 白名单后附件下载/引用替换                                  | `downloadFeishuInboundAttachments(getClient, refs, opts)`                                                                                                                          |
| 2.10 | `src/feishu-command-dispatch.ts`    | 1965-2235                             | 斜杠指令+follow-up 模式+durable 重排队                     | `dispatchFeishuCommand(input)`，connectOptions 回调显式参数化                                                                                                                      |

原地保留：1121-1158 状态装配、F11a/F11j 主管道壳、3187-3778 connection 门面、syncGroups。**claim 生命周期不变量**：`processClaimedIncomingMessage` 每条提前 return 必须命中且仅命中 complete/ignore/failClaimedInbox 之一（建议 2.7 提交附带表驱动测试锁定后再动刀）。

### 4.2 qq.ts（工厂 1772 行 → 原地剩约 200-250 行；文件 2159 → 约 600）

| #    | 新模块              | 吸收行区间          | 职责                                              | 接口要点                                                                                                                                |
| ---- | ------------------- | ------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 2.11 | `src/qq-token.ts`   | 505-601             | getAppAccessToken singleflight                    | `createQQTokenManager(config)`                                                                                                          |
| 2.12 | `src/qq-api.ts`     | 603-685             | apiRequest/getGatewayUrl                          | `createQQApi(tokens)`                                                                                                                   |
| 2.13 | `src/qq-media.ts`   | 437-497 + 711-1205  | 上传缓存、分片上传、持久重试、图片/文件、附件下载 | `createQQMediaSender(api)`；**qqPartFinishPersistentRetry 的 setTimeout 归 media sender 所有，不绑 WS stop 链**（现状即如此，原样保留） |
| 2.14 | `src/qq-ws.ts`      | 1206-1525           | 心跳、identify/resume、重连调度、看门狗           | `createQQWsSession(...)`；ws/sessionId/lastSequence/重连预算**整簇内聚**，禁止只抽一半（1312-1315 防双计数注释随段走）                  |
| 2.15 | `src/qq-inbound.ts` | 1529-1951           | **C2C/群 217+206 行逐字镜像合一**                 | `processQQInboundMessage(kind: 'c2c'\|'group', ...)`，差异只在 chat id 来源字段与 jid 前缀；净省约 180 行                               |
| 2.16 | `src/qq-stream.ts`  | 498-503 + 2114-2147 | 流式消息端点 + msg_seq/lastIncomingMsgId          | 门面继续转发（im-channel.ts:533-534/550 经 connection.getNextMsgSeq/getLastIncomingMsgId 消费）；disconnect 清理语义保留                |

### 4.3 wechat.ts（工厂 1109 行 → 原地剩约 150-200 行；文件 1564 → 约 620）

| #    | 新模块                   | 吸收行区间          | 职责                                         | 接口要点                                                                                                                 |
| ---- | ------------------------ | ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2.17 | `src/wechat-api.ts`      | 513-602             | dispatcher、headers、apiPost、长轮询         | `createWeChatApiClient(config, deps, publishState)`；fetch/now/random 注入链原样传导（wechat-connection-lifecycle 锚定） |
| 2.18 | `src/wechat-outbound.ts` | 603-677 + 1330-1549 | 发消息/图片/文件/typing                      | `createWeChatSender(api, contextTokens)`                                                                                 |
| 2.19 | `src/wechat-media.ts`    | 678-800             | CDN 下载解密、媒体项处理                     | 近纯函数                                                                                                                 |
| 2.20 | `src/wechat-inbound.ts`  | 802-1053            | 入站管线                                     | `createWeChatInboundProcessor(deps)`                                                                                     |
| 2.21 | `src/wechat-poller.ts`   | 1054-1230           | 健康标记、失败退避、长轮询循环、可取消 sleep | `createWeChatPoller(...)`；stopping/running/connected/pollPromise 内聚                                                   |

### 4.4 明确不做（非目标）

- 不统一三渠道 Connection 接口形状（connect 返回 boolean/void、stop/disconnect 不对称是既有设计，im-channel 适配器已归一）。
- 不把三渠道入站管线强行套同一骨架（飞书已 durable-inbox 化且多两道门，仅概念同构；QQ/微信侧概念对齐只在各自文件内做合一）。
- 跨渠道的 rejectTimestamps/dedup 实例化等零散同构（约 80-100 行）不在本波强收敛，登记到交付记录供后续 issue。

## 5. 波 3：initDatabase 拆分（db.ts 459-2562）

**结构事实**：不存在 `if (version < N)` 链或迁移数组；75% 语句是无门控幂等操作（`CREATE IF NOT EXISTS`/`ensureColumn`/无条件 backfill），每次启动重放；有门控的历史迁移段约 15 段，**五种异构门控**对全新库语义不同（`?? '0'` 新库执行 / `curVer &&` 新库跳过 / 结构探测与版本号无关等）。因此**不能**抽成统一注册表，只能按原顺序调用一串具名 step 函数。

| #   | 新模块（`src/db-schema/`）      | 吸收行区间                        | 内容                                                                              |
| --- | ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| 3.1 | `core-tables.ts`                | 531-779                           | 会话/任务/状态/路由表族                                                           |
| 3.2 | `auth-tables.ts`                | 794-866                           | users/invite/user_sessions/auth_audit_log/pinned                                  |
| 3.3 | `agent-profile-tables.ts`       | 885-1018 + 1708-1844              | agents/agent_profiles/Builder 表族 + prompt 四段拆分                              |
| 3.4 | `usage-tables.ts`               | 1020-1086 + 1594-1674 + 2058-2129 | 用量表族 + v27→v28/v50→v51 历史迁移                                               |
| 3.5 | `task-tables.ts`                | 1088-1177                         | scheduled/task_runs 列 + 幂等 backfill                                            |
| 3.6 | `migrations-legacy-rebuilds.ts` | 1178-1592                         | registered_groups folder 重建（含 ORDERING CONTRACT 注释 1183-1190）+ v16→v17/v22 |
| 3.7 | `migrations-data-reconcile.ts`  | 1343-1360 + 1931-2056             | 投递列/assertSchema/backfill/用户名小写/绑定重建                                  |
| 3.8 | `migrations-channel-trims.ts`   | 2261-2555                         | v74→v77 渠道退役/billing/死列三大 trim 段                                         |

约束：

- **编排壳**：`initDatabase` 剩约 180-220 行——开连接+PRAGMA/备份门/FK（459-530 原地保留，顺序敏感）→ 按原行序逐个调用 step → 2559-2561 版本回写（唯一写入点）。step 调用顺序 = 原段落出现顺序，一段不换位。
- **门控原文搬运**：五种异构风格表达式逐字保留（含 `?? '0'`、`curVer &&`、结构探测），统一门控风格会改变全新安装行为。
- **`DbMigrationContext`**：`{ db, rawSchemaVersionBeforeInit, ensureColumn, assertSchema, tableExists, hasColumn, getRouterStateInternal }` 显式传参（step 模块不得依赖 db.ts 模块级 `db` 变量，那是未导出的单连接）。
- **head pin 不触发**：`tests/db-upgrade-safety.test.ts:507` 锚定的是 `CURRENT_SCHEMA_VERSION === 77` 常量值，版本不动、无新 migration ⇒ 不触发 CLAUDE.md 的同提交更新义务（已在分析中核实）。
- 锚点测试：`tests/frontend-settings-information-architecture.test.ts:76-77` 断言 `read('src/db.ts')` 含 `'DROP TABLE IF EXISTS group_members'`——该语句保留在 db.ts 编排壳内**或**同提交改锚新模块，二选一，提交信息写明。
- 两处注释失真（781-785"每段迁移按 schema_version 门控"、2557-2558"短路跳过迁移区"）随编排壳一并订正，属注释修正不改行为，提交信息说明。
- 验收网：86 个调用 `db.initDatabase()` 的行为测试全绿即顺序不变性的证据。

## 6. 波 4：IPC 两函数拆分（index.ts 9053-12819）

先决：4 个 turn 级 registry（`activeTurnOutputs` 1079、`activeAgentBuilderTurns` 1106、`activeChannelTurns` 1111、`activeChannelOutboxScopes` 1116）与 `registeredGroups` 等模块级单例若不先外迁，新 IPC 模块与 index.ts 会 import 环。**单元 4.1 先外迁**为 `src/host-state.ts`（或 `src/ipc/turn-state.ts`），index.ts 保留引用/转发的最小改动。

| #    | 新模块（`src/ipc/`）               | 吸收行区间（index.ts）    | 内容                                                                                                                          |
| ---- | ---------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | `src/host-state.ts`                | 1071-1116 registry 声明   | turn 级注册表外迁（防 import 环）                                                                                             |
| 4.2  | `src/ipc/watcher.ts`               | 9053-9206 + 10130-10348   | startIpcWatcher 主体 + 目录扫描/身份解析/命名空间善后                                                                         |
| 4.3  | `src/ipc/message-delivery.ts`      | 9207-9730                 | messages 侧 send_message 分支（526 行）                                                                                       |
| 4.4  | `src/ipc/image-delivery.ts`        | 9731-10085                | messages 侧 send_image 分支（355 行）                                                                                         |
| 4.5  | `src/ipc/task-dispatch.ts`         | 10482-10741 + switch 壳   | processTaskIpc 签名 + ACL 谓词 + actor 构建器 + 分发壳                                                                        |
| 4.6  | `src/ipc/task-ops.ts`              | 11218-12124（10 个 case） | 任务生命周期族（schedule/pause/resume/cancel/update/restore/run_task_now/stop_task_run/list_task_runs/list_tasks，约 907 行） |
| 4.7  | `src/ipc/file-delivery.ts`         | 12459-12808               | send_file 工件投递族（350 行）                                                                                                |
| 4.8  | `src/ipc/memory-owner-ops.ts`      | 10743-11079               | workspace_memory + ckqclaw_owner_profile + 两个 actor 构建器                                                                  |
| 4.9  | `src/ipc/feishu-capability-ops.ts` | 12126-12275               | feishu_capability 族                                                                                                          |
| 4.10 | `src/ipc/builder-ops.ts`           | 11081-11216               | Agent Builder 族                                                                                                              |
| 4.11 | `src/ipc/skill-registry-ops.ts`    | 12277-12457               | install/uninstall_skill + register_group                                                                                      |

约束：

- 分发壳可表驱动（switch→查表等价改写）或最保守（保留 switch 原文、每 case 体替换为一次函数调用）；倾向保守版，提交信息写明。
- **`install_skill`/`uninstall_skill` 自算 tasksDir 的历史行为（12332、12409 不用形参 `tasksDir`）原样保留，不顺手修正**——修它是行为变更。
- 锚点测试同提交迁移：`result-file-prefixes-consistency`（RESULT_FILE_PREFIXES 与 writeTaskResult 字面量）、`ipc-type-bidirectional-contract`（断言 index.ts 中 `switch (data.type)` 恰 1 处→扫描目标换新模块）、`feishu-capability-outbox.test.ts:375-392`（case 切片）、`turn-outcome.test.ts:200-222`、`workspace-interaction-runtime.test.ts:196-208`（frozenIpcMode 切片）。
- `startIpcWatcher`/`processTaskIpc` 名称自 `src/index.ts` 继续 re-export（或调用点改 import），启动调用点不变；index.ts 预计净减约 3500 行（与波 6 叠加后另计）。

## 7. 波 5：AgentProfilesPage 拆分（组件 199-2191，39 useState）

惯例对齐：hooks 放 `web/src/hooks/`（范本 `useDeleteWorkspace.ts`），组件放 `web/src/components/agents/`（已有 7 个），页面保持 `AgentProfilesPage` 具名导出（App.tsx lazy 入口）。

| #    | 新文件                                             | 形态       | 迁移内容（当前行号）                                                                                                |
| ---- | -------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 5.1  | `hooks/useUnsavedNavigationGuard.ts`               | hook       | 202-220、550-588（useBlocker/useBeforeUnload/?create=1 效应）                                                       |
| 5.2  | `hooks/useHostSkillAutosave.ts`                    | hook       | 277-288、593-613、832-1008 全部 handler（含超时对账/竞态守卫 ref，逐字保留）                                        |
| 5.3  | `hooks/useAgentRuntimePolicy.ts` + utils           | hook+utils | 99-188 常量与纯函数、389-475、614-663                                                                               |
| 5.4  | `hooks/useAgentProfileForm.ts`                     | hook       | 246-320 表单 state 簇、477-517 回填 effect（**依赖数组刻意只含 [draftMode, selected?.id]，不补全**）、519-548 dirty |
| 5.5  | `components/agents/AgentCreatePanel.tsx`           | 组件       | JSX 1276-1379 + 695-759 handlers                                                                                    |
| 5.6  | `components/agents/AgentDraftSummary.tsx`          | 组件       | 164-171、1445-1472、1806-1894                                                                                       |
| 5.7  | `components/agents/AgentIdentitySection.tsx`       | 组件       | JSX 1476-1711 + 头像 handlers 1010-1065                                                                             |
| 5.8  | `components/agents/AgentCapabilitiesSection.tsx`   | 组件       | JSX 1896-1999                                                                                                       |
| 5.9  | `components/agents/AgentProfilesSidebar.tsx`       | 组件       | JSX 1176-1272 + 相关 handlers                                                                                       |
| 5.10 | `components/agents/AgentDeleteMigrationDialog.tsx` | 组件       | JSX 2118-2188 + 1107-1172                                                                                           |

锚点测试逐单元同提交改 `read()` 目标：`frontend-agent-capability-experience`（五步标签正则、`onHostModeChange={handleHostSkillsModeChange}`、`void persistHostSkillPolicy(`）、`frontend-agent-create-workspace`（aside/main 结构、create 路由效应）、`frontend-unsaved-navigation`（`useBlocker(shouldBlockNavigation)`）、`frontend-product-terminology`、`frontend-settings-information-architecture`、`pi-runtime-settings-and-credentials`。安全网：`agent-profiles-page-dom.test.tsx` 7 个 DOM 用例（含延迟失败不回滚新选中智能体的竞态用例）。

ISSUE-04 保留的 `storedAutoCompactWindow/Percentage` 透传 state（267-271）是刻意存续兼容，**不得当死代码清理**。完成后页面剩约 600-700 行。

## 8. 波 6：镜像函数收敛（压轴）

### 8.1 前置：runAgent 泛化（单元 6.0）

B 侧 14717-14855 的 139 行内联 runner 启动本质是 index.ts:8396 `runAgent` 缺 agentId 泛化。先给 runAgent 加 `{ agentId?, getSessionId, onNewSessionId }`，A/B/terminal-warmup 三处共用，B 侧内联块整体删除。不先做这步，抽 M32 会把启动分歧固化。

### 8.2 公共模块（4 个）

1. **`ChannelTurnRuntimeSet`**（扩展 `src/channel-turn-runtime.ts` 或新文件 `src/channel-turn-governance.ts`）：承接 M7/M8/M9/M11/M16/M36 的"多 runtime 集合编排"（startCold/admitWarm/completeForOutput/scopeForOutput/terminalizeOnExit）。聚合参数 `ChannelTurnContext = { logicalChatJid, queueKey, scopeKey, routeKey, agentId?, interactionMode, defaultInputTurnId, replySourceImJid(): string|null, deps }`——A 传 chatJid/folder，B 传 virtualChatJid/virtualJid/agentId。
2. **`src/conversation-indicator-ledger.ts`**（或并入 processing-indicator.ts）：M6 四张表+clear 闭包（A 122 行/B 101 行），jid 回退策略作构造参数。`processing-indicator-host-contract` 的"两侧各 1 份"断言改为"公共层 1 份+两适配层各调用一次"。
3. **`src/streaming-card-lifecycle.ts`**：M12/M13/M24/M35，策略参数 `suppressOnRetry: boolean`（A true/B false）、`usagePatchMode: 'target-ref'|'pending-flag'`。
4. **`src/reply-projection-delivery.ts`**（或扩展 reply-delivery.ts）：M25/M27/M30/M37/M38，持久化后端注入 `persistence: 'sendMessageOutcome'|'storeDirectBroadcast'`；A 的附件双投递/卡重建/scheduled 关联、B 的标题升级/spawn close/静态 IM 兜底以可选子步骤参数注入。

### 8.3 语义分歧参数化对照表（拍板①：全部参数化，不选边）

| 分歧                  | A 现状                                    | B 现状                                | 参数化方式                                                                                             |
| --------------------- | ----------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 建卡 retry 静默       | `retryAttempt>0 → undefined`（5681-5688） | 无此判断（13361-13369）               | `suppressOnRetry`                                                                                      |
| ledger 载荷键         | `complete({sentReply})`（5525）           | `complete({replyDelivered})`（13232） | `completePayloadKey`（经 `complete(result?: unknown)` 落账，键名参数化；**不统一、不做 DB 兼容读取**） |
| 中断保存 commitCursor | 不 commit                                 | 直接 commit                           | `commitCursorOnInterrupt`                                                                              |
| silent-success 判定   | `!sentReply`（7585）                      | `!isCursorCommitted()`（15017）       | `silentSuccessProbe`                                                                                   |
| 路由切换 cursor 校验  | 有新旧校验（M17）                         | 无（异步轮转简化版）                  | A 侧 M17 留在薄适配层，不进公共模块                                                                    |

### 8.4 迁移顺序（每块一提交）

6.0 runAgent 泛化 → 6.1 indicator ledger → 6.2 card lifecycle → 6.3 reply projection delivery → 6.4 ChannelTurnRuntimeSet → 6.5 A 侧（processGroupMessages 调用编排换公共层，保留 M1/M2 群聊守卫与 A-1~A-14 scheduled/task 语义）→ 6.6 B 侧（保留 B-1~B-14 agent 状态机语义）→ 6.7 锚点测试收口 + 死参数清理。

预计：A 3280 → 约 1100-1300 行，B 2572 → 约 600-800 行，公共层约 2300-2600 行，全仓净减约 1900 行。

风险缓冲：镜像块读写 40+ 局部可变量（streamingAccumulatedText/sentReply/replySourceImJid/currentInputCursor…），抽离前先把两侧状态收编为显式状态对象（随 6.5/6.6 各自提交内完成，不单独成提交）；全局单例（registeredGroups/activeImReplyRoutes/activeRouteUpdaters…）经 deps 注入，键空间差异（folder vs virtualChatJid）体现在 ChannelTurnContext。锚点测试 `reply-delivery-host-contract`（indexOf 切片 B 函数结构）、`turn-outcome`、`group-queue-context-overflow-removal`（锁 A-13 分支）同步改锚。

## 9. 波 7：样板三项（拍板③：全做）

1. **canAccessGroup+404 helper**：`src/web-context.ts` 新增 `groupAccessDeniedResponse(c, user, group, message)`，收敛 31 处（'Group not found'×25、'IM group not found'×4、'Task not found'×2）；403×9 处与非 return×6 处**保持原样**（403/404 并存是刻意语义）。
2. **zod 400 收敛**：新文件 `src/routes/validation-response.ts`，`zodBadRequest(c, failure, style)` 四分支逐字复刻 A（'Invalid request'+format，9 处）/B（'Invalid request body'+format，15 处）/C（+issues，2 处）/D（无 details，7 处）四形状；`groups.ts:550-567` 的 E（独立 code+field_errors）**保留独立实现**。不做语义归一。
3. **tests helper 收敛**：新 `tests/helpers/route-test-user.ts`，三个具名函数（`asRouteTestUser`（变体 1，12 文件）/`asOwnerProfileRouteUser`（变体 2）/`asSystemSettingsTestUser`（变体 3））+ `createTestUserRow`（3 文件）；各文件 `afterEach` 的 env 清理保留在原文件；附防回潮契约（仿 ISSUE-11 的 no-duplicate-helpers 契约：全仓 `function asUser` 定义数=0）。

## 10. 实施顺序总表（含回滚点语义）

波 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8（交付落档）。每波交付后暂停，输出交付报告（四门禁证据 + 行数台账 + 偏差），等用户批准再开下一波；波内单元连续提交但每单元独立验收（verify 全绿才提交）。任一单元三次修复仍红即触发无进展判定，按宪法第四节回退并升级用户。

## 11. 验收标准（与 issue 一致）

- 所有测试通过（verify 第 4 步全量 vitest，当前基线 337 文件 2701+ 过 0 败 77 skip）；实机冒烟通过（或如实登记待用户点验）。
- 交付记录写明每次提交前后的文件行数和函数行数变化。
- 每波四门禁证据：① 测试 ② 类型检查 ③ 构建（`npm run verify` 一键覆盖）④ `node scripts/check-scope.mjs`。

## 12. 非目标

- 不统一镜像 5 处语义分歧（参数化保留；统一属行为变更，另立 issue）。
- 不统一 403/404 响应码语义与 zod 四种响应形状（helper 参数化逐字复刻）。
- 不统一三渠道 Connection 接口形状。
- 不修 `install_skill` 自算 tasksDir 的历史行为。
- 不做 initDatabase 门控风格统一、不加新 migration、不动 `CURRENT_SCHEMA_VERSION`。
- 不删 ISSUE-04 保留的透传 state 与任何"意图信号"。
- 不做性能优化、新功能、文档重写。
- 跨渠道入站骨架强收敛（飞书除外）、stream-event 三副本收窄：登记后续 issue。

## 13. 风险与缓解

| 风险                                   | 缓解                                                       |
| -------------------------------------- | ---------------------------------------------------------- |
| 约 15 个源码文本契约测试锚定单文件内容 | 每单元先列锚点清单，搬迁与改锚同提交；verify 兜底          |
| 镜像块 40+ 可变闭包状态网              | 6.5/6.6 内先收编为显式状态对象再抽；参数爆炸即预警停下升级 |
| 新模块与 index.ts import 环            | 4.1 registry 先外迁；通道侧原文件 re-export 不动           |
| QQ WS 重连互递归簇                     | 2.14 整簇迁移，禁止半抽                                    |
| db 五种异构门控                        | 原文搬运，86 个行为测试做顺序不变性验收网                  |
| autocrlf 幻影 diff                     | 复用 ISSUE-10/15 排除法：逐个 `git diff` 证实零内容差异    |
| 满载轮负载敏感用例翻红                 | 先冷却复测再定性（load-sensitive-budget 契约）             |
| 实机冒烟本会话不可用                   | 如实登记，交付报告列待用户点验清单                         |

## 附录 A：镜像块清单（39 组，A=processGroupMessages 5009-8288，B=processAgentConversation 12820-15391）

相似度：L1=逐字/仅标识符不同；L2=结构同、键或参数不同；L3=结构同、细节实质差。

| #   | 职责                                | A 区间                     | B 区间                  | 相似度 | 关键差异                                                                     |
| --- | ----------------------------------- | -------------------------- | ----------------------- | ------ | ---------------------------------------------------------------------------- |
| M1  | group 解析+cursor 拉取              | 5009-5039                  | 12833-12851             | L2     | B 无 activation_mode 守卫与孤儿清理                                          |
| M2  | owner gate                          | 6235-6254                  | 12853-12878             | L3     | B 入口唯一收口；A 中段二道门                                                 |
| M3  | agentProfile/session-reset+历史注入 | 5114-5198                  | 12924-12977             | L3     | A 三分支；B 单 startsFreshSession；B 持 per-agent sessionId                  |
| M4  | 引用 id+prompt/images 组装          | 5200-5216                  | 12978-12992             | L1     | —                                                                            |
| M5  | IM 回复路由 sticky owner            | 5066-5103                  | 12993-13030             | L3     | A 整批同源；B 取末条 source；键 chatJid vs virtualChatJid                    |
| M6  | typing/processing 四表+clear        | 5255-5376                  | 13046-13146             | L1     | 被契约测试锚定"两侧各 1 份"                                                  |
| M7  | 流式 Jid+ChannelTurnRuntime 冷启动  | 5441-5467                  | 13147-13174             | L2     | B 无 chatJid 回退；卡键 `#agent:${agentId}`                                  |
| M8  | completeChannelRuntimesForOutput    | 5468-5551                  | 13175-13257             | L2     | **载荷键 sentReply vs replyDelivered（分歧②）**                              |
| M9  | scopeForOutput                      | 5552-5568                  | 13258-13274             | L1     | —                                                                            |
| M10 | executionDisposition≠execute        | 5569-5621                  | 13275-13334             | L3     | B 恢复 agent 状态机                                                          |
| M11 | retryAttempt+卡 reservation         | 5622-5643                  | 13335-13354             | L1     | —                                                                            |
| M12 | 流式卡创建+累积状态                 | 5676-5719                  | 13361-13395             | L3     | **A retry 静默建卡（分歧①）；usage patch target-ref vs pending-flag**        |
| M13 | rollbackIdleCardReservation         | 5720-5746                  | 13396-13422             | L1     | —                                                                            |
| M14 | AdmittedWarmInput+turn coordinator  | 5748-5803                  | 13423-13481             | L2     | B 无 ipcReplyTurnTracker                                                     |
| M15 | finalizeProactiveOutputCoordinators | 5804-5822                  | 13482-13499             | L2     | —                                                                            |
| M16 | warm admission 回调                 | 5824-5967                  | 13501-13634             | L3     | A 有 cursor 校验+scheduled 记账；B 多 2 张 ack 投影表                        |
| M17 | 新消息路由切换                      | 5969-6163                  | 13635-13727             | L3     | **A 有 cursor 校验/卡重建（分歧⑤一侧）；B 异步轮转简化版**                   |
| M18 | activateProjectionForInput          | 6165-6201                  | 13729-13761             | L1     | —                                                                            |
| M19 | idleTimer                           | 5235-5253                  | 13763-13780             | L1     | 声明位置不同                                                                 |
| M20 | 状态账本+startBatch+commitCursor    | 6223-6284                  | 12906-12918+13782-13852 | L2     | B 独有 retryUnfinishedTurn 等；A 独有 ipcReplyTurnTracker/scheduledGroupRuns |
| M21 | notifyProactiveTailInterruption     | 5650-5675                  | 13803-13830             | L1     | —                                                                            |
| M22 | onOutput 前半                       | 6310-6368+8459-8496        | 13854-13956             | L3     | B 独立闭包合并 A 分散逻辑；B providerFailure 删 session                      |
| M23 | stream usage 计价+merge             | 6370-6412                  | 13958-14001             | L1     | 持久化位置不同                                                               |
| M24 | answerProjection+broadcast+卡喂入   | 6413-6511                  | 14002-14047             | L3     | A 有卡失效重建/error 冻结防刷屏；B 无（卡不轮换）                            |
| M25 | 中断即时保存 interrupt_partial      | 6513-6584                  | 14049-14131             | L3     | **A 不 commitCursor；B commit（分歧③）**                                     |
| M26 | usage 持久化+rebuild                | 6717-6755                  | 14133-14169             | L1     | —                                                                            |
| M27 | Proactive final 恢复+收尾           | 6805-6952                  | 14177-14262             | L3     | A 多 scheduled 终局投递                                                      |
| M28 | providerFailure                     | 6764-6803                  | 14264-14292             | L2     | B 设 retryUnfinishedTurn                                                     |
| M29 | primary answer 判定                 | 6954-7008                  | 14294-14344             | L1     | —                                                                            |
| M30 | result 持久化与投递                 | 7010-7511                  | 14346-14708             | L3     | **持久化后端不同**；A 附件双投递/scheduled 关联；B 标题升级/spawn close      |
| M31 | error 标记+catch                    | 7513-7521                  | 14711-14975             | L2     | B 有 catch 兜底                                                              |
| M32 | runner 启动                         | 委托 runAgent（8396-8600） | 内联 14717-14855        | L3     | **6.0 泛化后 B 整块删除**                                                    |
| M33 | unrecoverable_transcript 重置       | 7841-7878                  | 14870-14903             | L2     | —                                                                            |
| M34 | stop/closed 结局解析                | 7815-7928                  | 14905-14961             | L3     | A 拆两处带 scheduled 投影                                                    |
| M35 | finally 卡五分支收尾                | 7559-7610                  | 14992-15038             | L2     | **silent-success 判定分歧④**                                                 |
| M36 | finally channelTurnRuntimes 清算    | 7612-7708                  | 15040-15343             | L3     | B deterministicTerminalError/commitCursor+notify                             |
| M37 | finally 保存中断内容                | 7719-7743                  | 15160-15212             | L3     | A sendMessage+shutdown 去重；B storeDirect+broadcast                         |
| M38 | finally 兜底 partial                | 7745-7770                  | 15214-15302             | L3     | B 另做静态 IM 兜底投递                                                       |
| M39 | finally 注册表清理+notice           | 7529-7550+8006-8020        | 14987-14991+15365-15387 | L2     | B 多 ipcWatcher unwatch                                                      |

单侧独有：A 侧 14 块（5017-5032 守卫、5043-5064 终态过滤、5105-5112 owner 学习、5218-5233 taskId、5383-5435 ipcReplyTurnTracker+scheduledGroupRuns、6203-6221 通知选任务、6338-6342 记账回调、6586-6715 SDK Task 台账（约 130 行）、scheduled 投影散布子块、7930-8004 退出标记、8022-8029 终态判定、8031-8255 late-error 确定性分类（约 225 行）、8257-8277 OOM 复位）；B 侧 14 块（kind 校验、virtualChatJid、spawn 空批 error、home 解析、updateAgentStatus、last_im_jid 回写、providerFailure deleteSession、标题升级、spawn closeStdin、物理确认 commit、proactive 强制 commit、静态 IM 兜底、spawn 结果回注、endStatus 恢复）。两侧独有块**全部留在薄适配层**，不进公共模块。

## 附录 B：镜像收敛的既有模块复用（不重复造轮子）

底层原语已模块化，重复的是**调用编排**：`channel-turn-runtime`（补 RuntimeSet 编排）、`channel-reliability-store`（不动）、`turn-output-coordinator`（补 bind 工厂）、`reply-delivery`（M30 编排放这里或新模块）、`proactive-final-recovery`/`channel-card-finalization`/`stream-card-feeder`/`turn-outcome`（已共用）、`group-queue`（M22/M32 共用）、`processing-indicator`（M6 上移为 Ledger）、index.ts 已共享的投递函数（sendImWithRetry 2338 等，只编排放新层）。
