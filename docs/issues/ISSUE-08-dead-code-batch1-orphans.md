# ISSUE-08 死代码批 1：孤儿函数、局部死代码、类成员（不涉及 DB）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 领取人 / 分支 | zcode-issue08 会话（main 分支）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 类型          | 删除死代码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 依赖          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 阻塞          | ISSUE-12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 预计改动路径  | `src/channel-mount-service.ts`、`src/middleware/auth.ts`、`src/runtime-config.ts`、`src/db.ts`（仅 `getAuthAuditLogs`）、`src/index.ts`、`src/routes/**`、`src/container-runner.ts`、`src/usage-service.ts`、`src/feishu-streaming-card.ts`、`src/group-queue.ts`、`src/task-scheduler.ts`、`container/agent-runner/src/types.ts`、`container/agent-runner/src/utils.ts`、`container/agent-runner/src/runtime/pi/pi-runner.ts`（仅一处 import）、`container/agent-runner/tests/fixtures/**`、`shared/image-detector.ts` 及其两份同步副本、`web/src/utils/group-utils.ts`、`web/src/stores/chat.ts`、`web/src/stores/usage.ts`，以及相应的 `tests/**` |
| 需用户决策    | 否：清单中的每一项都已核实，没有调用方，也没有意图信号                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 来源          | 审查报告 §6.1、§6.4、§14.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 删除清单

以下每一项都已用 `git grep -w` 在全仓核实过，只出现在定义处。

**一、二阶孤儿：调用方在 64d6d7b 中被删，函数本身留了下来**

- `src/channel-mount-service.ts:115` 的 `isImChannelJid`、`:336` 的 `toRoutingMode`
- `src/middleware/auth.ts:161` 的 `requireAnyPermission`
- `src/runtime-config.ts`：
  - 类型：`ClaudeThirdPartyProfilePublic`（`:315`）、`LocalClaudeCodeStatus`（`:2660`）
  - 函数：`readLocalOAuthCredentials`（`:2672`）、`writeStoredState`（`:1101`）、`resolveActiveProfile`（`:1763`）、`randomProfileId`（`:1983`）、`getCustomEnvForProfile`（`:2180`）
- `container/agent-runner/src/types.ts:358-397` 的 `SessionEntry`、`SessionsIndex`、`ImageMediaType`、`SDKUserMessage`、`ParsedMessage`，以及 `runtime/pi/pi-runner.ts:4` 中对应的无用 import
- `container/agent-runner/src/utils.ts` 的 `summarizeToolResult`（`:162`）、`sanitizeFilename`（`:215`）、`generateFallbackName`（`:226`）、`formatLocalNow`（`:417`）
- `src/db.ts:12271` 的 `getAuthAuditLogs`

**二、局部死代码**

- `src/index.ts:3229` 的 `sendImWithFailTracking`
- `src/index.ts:6385` 的 `previousSessionForRotation`：从未被赋值，连同 `:6442-6457` 的死分支一起删
- `src/routes/config.ts:2959` 的 `randomWechatUin` 副本（在用的那份在 `src/wechat.ts:298`）
- `src/container-runner.ts:1086` 的 `groupDir`、`src/usage-service.ts:145` 的 `user`
- 约 40 处无用 import，以 `npx tsc --noEmit --noUnusedLocals` 的输出为准

**三、类成员死代码**

- `src/feishu-streaming-card.ts` 的 `forceFlush`、`updateAuxiliary`、`replaceElement`、`enableStreamingMode`，以及 `currentMessageId` getter（`src/feishu-capability.ts:306` 里同名的是另一个函数，不要删）
- `src/group-queue.ts` 的以下 5 个方法：
  - `hasDirectActiveRunner`（`:961`）
  - `countActiveTaskRunners`（`:967`）
  - `isActiveRunnerTask`（`:1017`，它的注释写着“message loop 在用”，这已经不属实）
  - `getRunnerPid`（`:1285`）
  - `requestGracefulRestart`（`:1967`）
- `src/task-scheduler.ts:477` 的 `getSessions` 和 `:494` 的 `onWorkspaceCreated`：要同时删掉 `SchedulerDependencies` 里的字段，以及 `src/index.ts` 中注入它们的实现

**四、其他**

- `web/src/utils/group-utils.ts:4` 的 `DateSection`
- `shared/image-detector.ts:114` 的 `detectImageMimeTypeFromBase64`。删完后执行 `make sync-types`
- `container/agent-runner/tests/fixtures/fake-mcp-stdio-server.mjs`：孤儿 fixture，全仓没有任何引用
- `web/src/stores/chat.ts` 中的前端 `stopGroup` action（没有调用方；后端的 `/stop` 路由保留）
- `web/src/stores/usage.ts:670-679` 中的孤立 action：`refresh`、`setDays`、`setSelected*`

## 明确不在本批的项

| 条目                                                                                                  | 原因                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `container/agent-runner/src/utils.ts` 的 `extractSkillName`（`:192`）、`summarizeToolInput`（`:117`） | ISSUE-03 可能要把它们接回生产链路          |
| `validateClaudeProviderConfig`                                                                        | 意图信号，由 ISSUE-07 决定                 |
| hook、`raw_sdk_event`、todo 等事件消费簇                                                              | 由 ISSUE-10 负责，必须等 ISSUE-02、03 完成 |
| billing 残留、DB 列                                                                                   | 由 ISSUE-09 负责                           |
| 只有测试在调用的访问器和测试钩子                                                                      | 属于意图信号，保留                         |

## 方法要求

- 删除每一项之前，再用 `git grep -w <名称>` 复核一次，搜索范围要包括 `tests/` 和 `docs/`。
- 删除后执行 `make typecheck`。
- 删除前后各跑一次 `npx tsc --noEmit --noUnusedLocals`，确认报错条目只减不增。

## 验收标准

- `npm run verify` 和 check-scope 都通过。
- 删除清单逐项勾选，记录在交付记录里。如果有跳过的项，写明原因。

## 注意

- `src/index.ts` 也会被 ISSUE-02、03、05 修改，只是改的区域不同。开工前先 rebase 到最新的 main。

## 交付记录

- **提交**：立项 `cb9519b`（计划 `docs/dead-code-batch1-plan.md` + 范围声明，base=`eb1768c`）；实现 `e244bd2`（34 文件，+18/−679）；收尾见本提交。
- **四门禁证据**：① 测试 ② 类型检查 ③ 构建 —— `npm run verify` 六步全绿（6/6，总耗时 32.0s，含全量 vitest、三侧 typecheck、前后端+runner 构建）；④ diff 范围 —— `node scripts/check-scope.mjs` 通过（base→工作树 37 个路径全在 `.gatescope.json` 声明内）。附加：`npx tsc --noEmit --noUnusedLocals` 基线 56 条 → 7 条，按「文件+符号」归一对比**零新增**；删除符号全仓残留 grep 仅剩 `tests/channel-side-effect-ack-contract.test.ts` 的 `not.toContain` 断言（预期）。
- **删除清单逐项勾选**：
  - 一、二阶孤儿 22 项：全部完成 ✅（`isImChannelJid`/`toRoutingMode`、`requireAnyPermission`、runtime-config 2 类型 5 函数、runner 侧 5 类型 + `pi-runner.ts` import、runner utils 4 函数、`getAuthAuditLogs`）。
  - 二、局部死代码：`sendImWithFailTracking` ✅、`previousSessionForRotation` 连同死分支（`if` 改为直接 `if (!acceptedNewInput)`）✅、`randomWechatUin` 副本 ✅、`groupDir`/`user` ✅、无用 import：基线 56 条清理 49 条 ✅（见下方保留项）。
  - 三、类成员：`feishu-streaming-card` 4 方法 + `currentMessageId` getter ✅（连带清理仅被 `updateAuxiliary` 读写的 `lastAuxBeforeHash`/`lastAuxAfterHash` 字段与 card 创建处 2 行写入）；`group-queue` 5 方法 ✅；`SchedulerDependencies` 2 字段 + `src/index.ts` 两处注入 ✅（`web-context` 的 `getSessions` 是另一条活链路，保留）。
  - 四、其他：`DateSection` ✅、`detectImageMimeTypeFromBase64`（shared 删除 + `make sync-types` 同步两副本）✅、孤儿 fixture 整文件删除 ✅、前端 `stopGroup` action + 契约测试锚点改写 ✅（后端 `/stop` 路由未动）、usage store 7 个孤立 action（接口+实现）✅（`selected*` 状态字段仍被 `queryFromState` 读取，按 issue 范围保留）。
- **保留的 7 条 tsc 条目**：ISSUE-09 的 `UserBalance`/`safeParseJsonArray`；ISSUE-10 的 `STORAGE_CACHE_TTL`/`calculateDirSize`；qq-streaming-card 3 条（见偏差 ①）。
- **偏差与自纠**（详见 plan「实现偏差记录」）：
  1. **qq-streaming-card 3 项跳过**：`lastAuxFlushTime`/`AUX_FLUSH_INTERVAL`/`buildAuxPrefix` 的文件头注释写明「Rationale for keeping this dormant」（QQ 前缀稳定性），属任务池口径的意图信号且不在 issue 显式清单内——保留待用户决策。
  2. **`broadcastGroupCreated` 保留**：删除 `onWorkspaceCreated` 注入后发现它是 WS `group_created` 的唯一生产者，前端 `AppLayout.tsx:90` 仍在订阅（定时任务建工作区后刷新侧边栏）——属掉线逻辑口径。本批只删字段+注入+失效 import（issue 显式范围）。**待用户决策：补生产者（调度器接回 `onWorkspaceCreated`）还是连消费端一起下线。**
  3. **级联二阶孤儿 6 处一并清理**（tsc 复跑暴露后以输出为准）：上述 2 hash 字段及写入、`CURRENT_CONFIG_VERSION`、`ClaudeStoredProfileResolved`、`ClaudeProviderMode`。
  4. **范围较 issue 预计路径扩宽 9 个文件**（`src/web.ts`、`im-manager.ts`、`qq-streaming-card.ts`（最终未改，仅声明）、`file-manager.ts`、`channel-account-connectivity.ts`、`claude-context-resolver.ts`、`routes/{workspace-config,tasks,groups,auth,admin}.ts` 及契约测试）：均为 tsc 基线报出的无用 import 载体，其中 qq-streaming-card 实际零改动。
- **范围外新发现登记**：
  1. **ISSUE-05 交付记录转来的「4 个疑似多余 `RESULT_FILE_PREFIXES` 名单项」结论不成立**，本次未裁剪：`install_skill`/`uninstall_skill`/`list_tasks` 的 case 分支用 `fs.writeFileSync` 直接写 `*_result_` 文件（单行 grep `writeTaskResult(..., 'type', ...)` 匹配不到），`ckqclaw_owner_profile` 的 `writeTaskResult` 是跨行调用同样漏检。请以本记录更正 ISSUE-05 的登记。
  2. `db.ts` 的 `advanceSkippedTask`/`clearStaleTaskLeases`/`getDueTasks`：生产调用方在本批前后均为零（task-scheduler 的 import 本就未使用），但 `tests/task-restart-recovery.test.ts` 仍在调用——按「只有测试在调用=意图信号」保留函数本体，只删了 3 处无用 import；后续若裁剪该测试可一并评估这三个导出。
  3. usage store 的死字段 `scope`/`dataRange`（审查 §6.4 提及但不在本 issue 清单）：未动，现状保留在 `web/src/stores/usage.ts`，供后续 issue 评估。
