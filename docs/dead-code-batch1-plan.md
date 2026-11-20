# 死代码批 1 立项（ISSUE-08）：孤儿函数、局部死代码、类成员（不涉及 DB 迁移）

> 任务来源：`docs/issues/ISSUE-08-dead-code-batch1-orphans.md`（死代码与臃肿审查 R2 §6.1、§6.4、§14.2）。
> 回滚点：`eb1768c`（开工前 HEAD，见 `.gatescope.json` 的 `base`）。
> 需用户决策：否（issue 声明全部项已核实无调用方、无意图信号；本次开工前逐项复核结论一致）。

## 开工前逐项复核结论（2026-11-20）

- 删除清单全部项以 `git grep -w` 在全仓（含 `tests/`、`docs/`）复核：均只出现在定义处（或 issue 已注明的连带处），与审查结论一致。
- `npx tsc --noEmit --noUnusedLocals` 基线 **56 条**（留存于交付记录的对照表）；其中 4 条属其他 issue 范围，见「非目标」。
- tests/ 中无任何用例引用待删名称；唯二交集：
  - `tests/channel-side-effect-ack-contract.test.ts` 断言源码**不含** `sendImWithFailTracking`——删除后断言依然成立；
  - `tests/web-refresh-lifecycle-contract.test.ts:86-99` 以 `stopGroup: async (jid: string)` 为切片锚点并断言其函数体行为——删除前端 `stopGroup` 后需同步改写该用例（见方案第四批）。
- **ISSUE-05 交付记录转来的「4 个疑似多余 `RESULT_FILE_PREFIXES` 名单项」结论不成立，不裁剪**：`install_skill`/`uninstall_skill`/`list_tasks` 的 case 分支用 `fs.writeFileSync` 直接写 `*_result_` 文件（`src/index.ts:13068/13145/12782` 一带），`ckqclaw_owner_profile` 有跨行 `writeTaskResult` 调用（`src/index.ts:11455`，单行 grep 会漏检）。ISSUE-05 当时据单行 grep 误判，将在交付记录中登记更正。

## 目标（What & Why）

纯删除任务，零行为变化。按 issue 清单删除四批死代码：

1. **二阶孤儿**（64d6d7b 删了调用者留下的叶子）：`channel-mount-service.ts` 2 函数、`middleware/auth.ts` 1 函数、`runtime-config.ts` 2 类型 + 5 函数、`container/agent-runner/src/types.ts` 5 类型及 `pi-runner.ts:4` 连带 import、`container/agent-runner/src/utils.ts` 4 函数、`src/db.ts` 的 `getAuthAuditLogs`。
2. **局部死代码**：`src/index.ts` 的 `sendImWithFailTracking`、`previousSessionForRotation` 死变量连同死分支；`src/routes/config.ts` 的 `randomWechatUin` 副本；`src/container-runner.ts:1086` 的 `groupDir`、`src/usage-service.ts:145` 的 `user`；以及以 tsc 输出为准的无用 import 清理（见下方范围界定）。
3. **类成员死代码**：`feishu-streaming-card.ts` 4 方法 + `currentMessageId` getter（`feishu-capability.ts:306` 同名模块函数保留）；`group-queue.ts` 5 个零调用方法；`task-scheduler.ts` 的 `SchedulerDependencies.getSessions`/`onWorkspaceCreated` 两字段连同 `src/index.ts` 的注入。
4. **其他**：`web/src/utils/group-utils.ts` 的 `DateSection`；`shared/image-detector.ts` 的 `detectImageMimeTypeFromBase64`（删后 `make sync-types` 同步两副本）；孤儿 fixture `container/agent-runner/tests/fixtures/fake-mcp-stdio-server.mjs` 整文件删除；前端 `chat.ts` 的 `stopGroup` action（后端 `/stop` 路由保留）；`usage.ts` 的 7 个孤立 action（`refresh`、`setDays`、5 个 `setSelected*`）。

## 无用 import 清理的范围界定（以 tsc 基线 56 条为准）

**纳入**（52 条）：基线中除下列 4 条外的全部 TS6133/TS6196——含纯无用 import（`src/index.ts` 10 处、`src/web.ts` 7 处、`src/routes/*` 10 处、`im-manager.ts` 3 处、`task-scheduler.ts` 3 处、`feishu.ts`/`group-queue.ts`/`db.ts` 的 `GROUPS_DIR`/`file-manager.ts` 的 `logger`/`channel-account-connectivity.ts`/`claude-context-resolver.ts`/`middleware/auth.ts` 各 1 处），清单函数本体被 tsc 直接标出的 9 处，以及 `qq-streaming-card.ts` 3 处未用私有成员（`lastAuxFlushTime`、`AUX_FLUSH_INTERVAL`、`buildAuxPrefix`——属「局部死代码」类，不在 ISSUE-10 显式清单内）。

**排除**（4 条，属其他 issue，不动）：

| tsc 条目                                                                      | 归属                             |
| ----------------------------------------------------------------------------- | -------------------------------- |
| `src/db.ts(71)` `UserBalance` import、`src/db.ts(12628)` `safeParseJsonArray` | ISSUE-09（billing 残留）         |
| `src/file-manager.ts(9)` `STORAGE_CACHE_TTL`、`(301)` `calculateDirSize`      | ISSUE-10 第 1 项（存储用量缓存） |

**连带说明**：`task-scheduler.ts` 删 3 个无用 import 后，`db.ts` 的 `advanceSkippedTask`/`clearStaleTaskLeases`/`getDueTasks` 仍有 `tests/task-restart-recovery.test.ts` 在调用（意图信号），按 issue「明确不在本批」条款保留函数本体。

## 非目标

- 不动「明确不在本批」表中的任何项（`extractSkillName`/`summarizeToolInput`、`validateClaudeProviderConfig`、hook/raw_sdk_event 消费簇、billing/DB 列、只有测试调用的访问器）。
- 不删 ISSUE-09/10 归属的 4 条 tsc 条目（见上表）。
- 不裁剪 `RESULT_FILE_PREFIXES`（ISSUE-05 转来的疑点经复核不成立）。
- 不重构删除点周边代码、不整理 import 顺序、不更新审查报告 `docs/dead-code-review-r2.md` 的行号漂移（ISSUE-13 范围）。
- 4 个 scheduler 测试文件里 deps 对象中多余的 `getSessions: () => ({})` 字段：对象无类型标注（或 `as never`），删接口字段后既不报错也无行为，按最小范围原则不动。

## 修改文件范围

| 文件                                                                                                                                 | 改动                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/channel-mount-service.ts`                                                                                                       | 删 `isImChannelJid`、`toRoutingMode`                                                                                                                                                   |
| `src/middleware/auth.ts`                                                                                                             | 删 `requireAnyPermission` + 1 处无用 import                                                                                                                                            |
| `src/runtime-config.ts`                                                                                                              | 删 2 类型 + 5 局部函数                                                                                                                                                                 |
| `src/db.ts`                                                                                                                          | 删 `getAuthAuditLogs` + `GROUPS_DIR` 无用 import（其余不动）                                                                                                                           |
| `src/index.ts`                                                                                                                       | 删 `sendImWithFailTracking`、`previousSessionForRotation` 死分支、`schedulerDeps` 的 `getSessions`/`onWorkspaceCreated` 注入、`broadcastGroupCreated` import（连带）、10 处无用 import |
| `src/web.ts`                                                                                                                         | 删 `broadcastGroupCreated`（失去唯一调用方的连带孤儿）、7 处无用 import                                                                                                                |
| `src/routes/config.ts`                                                                                                               | 删 `randomWechatUin` 副本 + 4 处无用 import                                                                                                                                            |
| `src/routes/{workspace-config,tasks,groups,auth,admin}.ts`                                                                           | 各删无用 import                                                                                                                                                                        |
| `src/container-runner.ts`                                                                                                            | 删未用变量 `groupDir`                                                                                                                                                                  |
| `src/usage-service.ts`                                                                                                               | 删未用变量 `user`                                                                                                                                                                      |
| `src/feishu-streaming-card.ts`                                                                                                       | 删 4 方法 + `currentMessageId` getter                                                                                                                                                  |
| `src/qq-streaming-card.ts`                                                                                                           | 删 3 处未用私有成员                                                                                                                                                                    |
| `src/group-queue.ts`                                                                                                                 | 删 5 个零调用方法 + `exec` 无用 import                                                                                                                                                 |
| `src/task-scheduler.ts`                                                                                                              | 删 `SchedulerDependencies` 2 字段 + 3 处无用 import                                                                                                                                    |
| `src/im-manager.ts`、`src/feishu.ts`、`src/file-manager.ts`、`src/channel-account-connectivity.ts`、`src/claude-context-resolver.ts` | 各删无用 import（feishu 仅 `getStreamingSession` import，函数本体保留）                                                                                                                |
| `container/agent-runner/src/types.ts`                                                                                                | 删 5 类型                                                                                                                                                                              |
| `container/agent-runner/src/utils.ts`                                                                                                | 删 4 函数                                                                                                                                                                              |
| `container/agent-runner/src/runtime/pi/pi-runner.ts`                                                                                 | 删第 4 行连带无用 import                                                                                                                                                               |
| `container/agent-runner/tests/fixtures/fake-mcp-stdio-server.mjs`                                                                    | 整文件删除                                                                                                                                                                             |
| `shared/image-detector.ts`                                                                                                           | 删 `detectImageMimeTypeFromBase64`                                                                                                                                                     |
| `src/image-detector.ts`、`container/agent-runner/src/image-detector.ts`                                                              | 由 `make sync-types` 生成的同步副本                                                                                                                                                    |
| `web/src/utils/group-utils.ts`                                                                                                       | 删 `DateSection`                                                                                                                                                                       |
| `web/src/stores/chat.ts`                                                                                                             | 删 `stopGroup` action（接口 + 实现）                                                                                                                                                   |
| `web/src/stores/usage.ts`                                                                                                            | 删 7 个孤立 action（接口 + 实现；`selected*` 状态字段仍被 `queryFromState` 读取，保留）                                                                                                |
| `tests/web-refresh-lifecycle-contract.test.ts`                                                                                       | `stopGroup` 切片锚点及断言随 action 一并删除                                                                                                                                           |

### 范围相对 issue 预计改动路径的扩宽（供立项批准者复核）

1. `src/web.ts`：不在 issue 预计路径中，但两处改动必要——7 条无用 import 属「以 tsc 输出为准」条目（审查 §6.4 原文点名 `src/web.ts`）；`broadcastGroupCreated` 因 `onWorkspaceCreated` 注入删除而失去全仓唯一调用方，属同类二阶孤儿连带。
2. `src/im-manager.ts`、`src/qq-streaming-card.ts`、`src/file-manager.ts`、`src/channel-account-connectivity.ts`、`src/claude-context-resolver.ts`、`src/routes/workspace-config|tasks|groups|auth|admin.ts`：均为 tsc 基线报出的无用 import/局部死代码载体，且经核对不在 ISSUE-09/10 的显式删除清单内。
3. `tests/web-refresh-lifecycle-contract.test.ts`：issue 预计路径含「相应的 tests/\*\*」，此为删除 `stopGroup` 的必然连带。

## 方案

- 每删一项前已按 issue 方法要求完成 `git grep -w` 复核（结论见上）；实现时按文件分批删除，每批后跑 `npx tsc --noEmit` 观察级联（删除本体后新暴露的无用 import 一并清理，仍以 tsc 输出为准）。
- `previousSessionForRotation`：删 `:6385` 声明与 `:6442-6457` 整个 `if` 死分支（6 处引用全是声明与读取，无赋值）。
- `SchedulerDependencies`：删 2 字段 + `src/index.ts:19543` 的 `getSessions` 注入与 `:19569` 的 `onWorkspaceCreated: broadcastGroupCreated` 注入；`src/index.ts:19186` 的 `getSessions` 属 `startWebServer` web-context 依赖（`routes/groups.ts`、`web.ts` 在用），**保留**。
- `image-detector`：只改 `shared/image-detector.ts`，两副本靠 `make sync-types` 覆盖，不手改副本。
- `web-refresh-lifecycle-contract.test.ts`：删除以 `stopGroup` 为锚的 `stopped` 切片及其 2 条断言（`delete activeRuns[jid]`、`preserveThinking: false` 都在被删函数体内），用例名与保留的 `finished` 断言同步改写；不引入新锚点。
- TDD 说明：本任务为纯删除，无新增行为；确定性反馈 = 删除前后 `tsc --noUnusedLocals` 条目集合只减不增 + 全量 vitest 通过（含上述改写的契约用例）+ 三侧 typecheck/build。

## 风险与应对

- 误删在用符号 → 已全仓逐项 grep 复核；删除后再跑全量 grep 确认零残留引用 + 全量测试兜底。
- 删除后级联暴露新的无用 import → 以 tsc 复跑输出为准清理，记录前后对照。
- 同名符号误伤（`currentMessageId`、`randomWechatUin`、`stopGroup`、`getSessions`）→ 按"定义处所在文件"精确删除，同名异处一律保留（issue 已点名）。
- `main` 与 ISSUE-02/03 的文件交集（`src/index.ts`、`chat.ts`、`pi-runner.ts`、`group-queue.ts`）→ 这些 issue 均未开工，当前无并行冲突。

## 验收标准

- issue 删除清单逐项完成或有登记原因；`npm run verify` 六步与 `node scripts/check-scope.mjs` 通过。
- `npx tsc --noEmit --noUnusedLocals` 剩余条目 ⊆ 基线 56 条 −（本批已删 49 条），且新增为 0。

## 实现偏差记录（相对本 plan 初稿，供立项批准者复核）

1. **`src/qq-streaming-card.ts` 的 3 个 tsc 条目（`lastAuxFlushTime`、`AUX_FLUSH_INTERVAL`、`buildAuxPrefix`）跳过不删**（初稿曾纳入）：实现时细读发现该文件头注释明确写有「Rationale for keeping this dormant: QQ stream_messages 端点强制前缀稳定性」——属任务池 README 审查口径中的**意图信号**（注释写明设计动机），且这 3 项不在 ISSUE-08 显式清单内。按「默认保留、删除前必须经用户确认」跳过，3 条 tsc 报错随之保留。
2. **`src/web.ts` 的 `broadcastGroupCreated` 保留不删**（初稿曾作为连带孤儿删除）：删除 `onWorkspaceCreated` 注入后发现 `broadcastGroupCreated` 是 WS 消息 `group_created` 的唯一生产者，而前端 `web/src/components/layout/AppLayout.tsx:90` 仍在订阅（刷新侧边栏/任务列表）——属审查口径「掉线逻辑：消费者还在、生产者没了，不要直接删，先让用户决定」。本批只删 `SchedulerDependencies` 两字段 + `src/index.ts` 注入行与失效 import（issue 显式范围），函数与前端消费端原样保留，决策登记入 ISSUE-08 交付记录。
3. **级联二阶孤儿 6 处一并清理**（超出 issue 清单，属删除本体的必然连带，均由 tsc 复跑暴露后以输出为准清理）：`feishu-streaming-card.ts` 的 `lastAuxBeforeHash`/`lastAuxAfterHash` 字段声明与 card 创建处的两行写入（原仅被已删的 `updateAuxiliary` 读取）；`runtime-config.ts` 的 `CURRENT_CONFIG_VERSION` 常量（原仅被已删的 `writeStoredState` 使用）、`ClaudeStoredProfileResolved` 接口与 `ClaudeProviderMode` 类型（原仅被已删的 `resolveActiveProfile` 使用）。
4. tsc 基线 56 条的最终处置：清理 49 条、保留 7 条（ISSUE-09 的 `UserBalance`/`safeParseJsonArray`、ISSUE-10 的 `STORAGE_CACHE_TTL`/`calculateDirSize`、上述偏差 1 的 qq-streaming-card 3 条）；按「文件+符号」归一对比基线，新增为 0。
