# ISSUE-08 死代码批 1：孤儿函数、局部死代码、类成员（不涉及 DB）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
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

（领取后填写）
