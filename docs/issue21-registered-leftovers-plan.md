# 任务立项：ISSUE-21 各 issue 交付记录中登记的零散遗留

> 立项日期：2026-11-23｜base：`638d0c7`（本地 main tip，ISSUE-17 合并提交）｜分支：`claude/elated-bun-500e1e`
> 来源：`docs/issues/ISSUE-21-registered-leftovers.md`

## 0. 需求采访结论（2026-11-23）

- **目标**：ISSUE-21 登记的 15 项遗留逐项有结论；拍板为“做”的项落地并有测试或可复现的证据。
- **完成条件**：15 项结论写进交付记录；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：B 组按审查口径处理（意图信号默认保留，删除前 `git grep -w` 交叉核实，范围含 `tests/`、`docs/`）；修改共享类型后执行 `make sync-types`；不改数据库 schema；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 项  | 复核结论                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 成立且范围更大。飞书能力变更（`send_card` 等）经 `deliverFeishuCapabilityMutation`（`src/feishu-capability-outbox.ts:51`）走 outbox，`execute` 链上有 3 处发送前拒绝都抛普通 `Error`：`src/im-manager.ts:804`、`src/im-channel.ts:396`、`src/feishu.ts:1863`        |
| A2  | 成立。`assertWeChatApiSuccess`（`src/wechat.ts:152`）抛普通错误；哪些错误码属于确定拒绝需要实机观察                                                                                                                                                                 |
| A3  | **本地复现**。`npm run self-test:agent-runner` 报 `does not provide an export named 'buildBackgroundTaskSummaryPrompt'`：`scripts/self-test-agent-runner.ts` 导入的两个函数随 ISSUE-10（`c812578`）截断续写链路一起删除，脚本测的是已下线逻辑。CI 第 62-63 行调用它 |
| A4  | 成立，位置漂移到 `src/index.ts:12083`；没有测试或文档依赖这句文案                                                                                                                                                                                                   |
| A5  | 成立。`web/src/components/settings/ProviderEditor.tsx` 的自定义环境变量是一行一个 `KEY=value`                                                                                                                                                                       |
| B1  | 成立，并发现同类：`claimNextChannelTurnRun`（`src/channel-reliability-store.ts:1228`，测试 4 处）与 `claimNextChannelOutbox`（`:1740`，测试 7 处）生产零调用，都是共享认领逻辑的薄包装，生产走 `claim*ById`                                                         |
| B2  | 成立。生产 3 条调度路径（`src/task-scheduler.ts` isolated/script/group）全部带 `durableRun`；`claimScheduledRun`（`:869`）只能经 `enqueueIsolatedScheduledTask`（`:920`，仅测试调用）进入；`db.claimTaskForRun` 与 `running_until`/`runner_id` 列只由它写入         |
| B3  | 成立。完整回复广播有 2 处生产者：`src/index.ts:8411`、`src/ipc/image-delivery.ts:354`；前端只在 `web/src/components/layout/AppLayout.tsx:141` 消费 `notice=true`；`docs/API.md:585` 列有 `agent_reply`                                                              |
| C1  | 成立。`src/workspace-memory-capability.ts:36` `mutationPayload` 与 `container/agent-runner/src/workspace-memory-auth.ts:20` 内联构造逐字相同                                                                                                                        |
| C2  | 成立，现约 94 处（src 53、web 36、runner 5）                                                                                                                                                                                                                        |
| C3  | 成立。`scripts/check-stream-event-sync.sh` 缺 canonical-json、model-suffix 两组，`scripts/sync-stream-event.sh` 与 Makefile `_check-sync` 都有                                                                                                                      |
| C4  | 成立。`tests/scope-check-contract.test.ts` 无非 ASCII 路径用例                                                                                                                                                                                                      |
| C5  | 成立。`POST /api/auth/avatar`（`src/routes/auth.ts:738`）无路由级测试                                                                                                                                                                                               |
| C6  | 成立。`src/index.ts` `reloadUserIMConfig` 的 wechat 分支未传 `contextTokens`                                                                                                                                                                                        |
| C7  | 成立。`src/index.ts` 图片、文件 outbox payload 只含 `fileName`/`contentHash`                                                                                                                                                                                        |

没有需要剔除的项。

## 2. 用户决策（2026-11-23，全部按推荐）

| 项  | 决策                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- |
| A1  | **做**：3 处都改抛 `ChannelPreSendRejection`                                                            |
| A2  | **拆成独立 issue**：ISSUE-23                                                                            |
| A3  | **做**：删除过时脚本、`self-test:agent-runner` 命令与 CI 步骤；`npm run self-test` 保留为构建加全量测试 |
| A4  | **做**：文案改为渠道无关，日志字段带上 `channel`                                                        |
| A5  | **拆成独立 issue**：ISSUE-24                                                                            |
| B1  | **做（保留）**：两个函数都保留，注释写明是测试入口、生产按 ID 认领                                      |
| B2  | **拆成独立 issue**：ISSUE-25；本 issue 只在代码里加注释指向它                                           |
| B3  | **做**：停止 2 处完整回复广播，保留 notice 警告；同步 `docs/API.md`；加防回潮测试                       |
| C1  | **做**：签名载荷收进 `shared/workspace-memory-payload.ts`，纳入同步与检查                               |
| C2  | **不做**：一行表达式本身清楚，全仓替换改动面大、易与并行分支冲突，收益低                                |
| C3  | **做**：同步检查脚本补 canonical-json、model-suffix（及 C1 新增的一组）                                 |
| C4  | **做**：补中文路径夹具用例                                                                              |
| C5  | **做**：补 `/avatar` 未知 target 返回 400、未登录 401 的用例                                            |
| C6  | **不做**：按 CLAUDE.md，Legacy user-im 只做兼容，新功能走 `/api/channel-accounts`                       |
| C7  | **不做**：转 failed 的行为可接受，有需求时再开 issue                                                    |

## 3. 实现方案

1. **A1**：`src/im-manager.ts`、`src/im-channel.ts`、`src/feishu.ts` 三处“未连接”改抛 `ChannelPreSendRejection`（错误信息不变）。测试：三处抛出的错误类型；`deliverFeishuCapabilityMutation` 在 `execute` 抛该错误时 outbox 行落 `failed` 而非 `uncertain`。
2. **A3**：删除 `scripts/self-test-agent-runner.ts`；`package.json` 删 `self-test:agent-runner`，`self-test` 改为 `npm run build:all && npm test -- --run`；`.github/workflows/ci.yml` 删对应步骤。测试：契约断言脚本、命令与 CI 步骤都不再引用已删除文件。
3. **A4**：`src/index.ts` 日志改为 `Auto-created isolated conversation agent for IM chat`，字段加 `channel: getChannelType(sourceJid)`。测试：源码断言不再出现 `for Feishu IM chat`。
4. **B1**：`src/channel-reliability-store.ts` 两个函数加注释。不改行为。
5. **B2**：`src/task-scheduler.ts` `claimScheduledRun`/`enqueueIsolatedScheduledTask` 加注释指向 ISSUE-25。不改行为。
6. **B3**：删除 `src/index.ts`、`src/ipc/image-delivery.ts` 两处不带 notice 的 `broadcastToWebClients`；`src/web.ts`、`AppLayout.tsx`、`chat.ts` 相关注释同步；`docs/API.md` 写明 `agent_reply` 只用于 notice 警告。测试：防回潮断言所有 `broadcastToWebClients(` 调用都带 `notice: true`。
7. **C1 + C3**：新建 `shared/workspace-memory-payload.ts`（导出 `buildWorkspaceMemoryMutationPayload`，依赖同目录 `canonical-json.js`），`make sync-types` 同步到 `src/` 与 runner；宿主与 runner 改为导入它；`scripts/sync-stream-event.sh`、`scripts/check-stream-event-sync.sh`、Makefile `_check-sync` 纳入；检查脚本补 canonical-json、model-suffix。测试：副本逐字节一致；宿主签发、runner 签名、宿主校验端到端通过；两侧不再内联构造。
8. **C4**：`tests/scope-check-contract.test.ts` 加中文文件名夹具：声明内放行、声明外拦截并打印原文路径。
9. **C5**：新测试覆盖 `/api/auth/avatar` 未知 target 返回 400 且不改用户、未登录 401。

## 4. 任务拆分与回滚点

| 任务 | 内容           | 验收                                            | 回滚点   |
| ---- | -------------- | ----------------------------------------------- | -------- |
| T1   | A1             | 未连接的飞书变更 outbox 行落 `failed`           | 立项提交 |
| T2   | A3 + A4        | `self-test` 可运行；日志文案渠道无关            | T1 提交  |
| T3   | B1 + B2 + B3   | 注释到位；完整回复不再广播，notice 仍可见       | T2 提交  |
| T4   | C1 + C3        | 签名载荷单一来源，同步检查覆盖 shared/ 全部副本 | T3 提交  |
| T5   | C4 + C5        | 两组新用例通过                                  | T4 提交  |
| T6   | 门禁与交付落档 | verify 全绿、check-scope 通过、issue 已完成     | T5 提交  |

## 5. 非目标

- 不改 iLink 错误码分类（ISSUE-23）、供应商表单（ISSUE-24）、旧调度租约簇与 DB 列（ISSUE-25）。
- 不替换一行式错误提取（C2）、不给 Legacy user-im 接 token 持久化（C6）、不扩展附件 payload（C7）。
- 不为 runner 新写冒烟测试；不改数据库 schema。
