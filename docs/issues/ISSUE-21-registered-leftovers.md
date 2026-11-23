# ISSUE-21 各 issue 交付记录中登记的零散遗留：逐项决策与落地

| 字段          | 值                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                         |
| 领取人 / 分支 | `claude/elated-bun-500e1e`                                                                                                                     |
| 优先级        | P2（A 组）/ P3（B、C 组）                                                                                                                      |
| 类型          | 汇总：缺陷、掉线逻辑决策、测试与收敛欠账                                                                                                       |
| 依赖          | 无；A3 建议在用户推送 main、CI 重新运行之后再看                                                                                                |
| 阻塞          | 无                                                                                                                                             |
| 预计改动路径  | 视拍板而定，见各项“位置”                                                                                                                       |
| 需用户决策    | **是**：逐项拍板；B 组按审查口径（掉线逻辑先请用户决定、意图信号默认保留、删除前 `git grep -w` 交叉核实含 `tests/` `docs/`）                   |
| 来源          | 2026-11-23 待办汇总：ISSUE-05、09、11、14、15、16、18、19 交付记录的“范围外登记 / 遗留登记”与镜像排查；用户拍板“把未立项的遗留汇总成 ISSUE-21” |

行号以 `ec7a6c9` 为准，领取时按语义重新定位。每项都可以单独拍板为“做”、“不做（写明理由）”或“拆成独立 issue”。

## A 组：渠道与可靠性（影响行为，建议优先）

| #   | 问题                                                                                                                                            | 位置                                                               | 来源     | 建议候选                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| A1  | 飞书客户端未连接时抛普通 `Error('Feishu client is not connected')`，这是发送前就确定的拒绝，却会被 outbox 状态机标成 `uncertain`、封住整个 turn | `src/feishu.ts:1863`                                               | ISSUE-19 | 改抛 ISSUE-19 引入的 `ChannelPreSendRejection`（`src/channel-errors.ts`），补测试            |
| A2  | iLink 返回非零错误码（例如持久化的 context_token 已失效）仍按普通错误落 `uncertain`；token 实际有效期没有文档                                   | `src/wechat.ts` `assertWeChatApiSuccess`、`src/wechat-outbound.ts` | ISSUE-19 | 先实机观察 token 失效时 iLink 的返回码，再决定是否把特定错误码视为确定拒绝；不确定则维持现状 |
| A3  | 2026-11-22 推送 `ccd3b3d` 触发的 CI（`.github/workflows/ci.yml`）在 “Agent runner self-test” 一步失败，与镜像发布无关，未排查                   | `.github/workflows/ci.yml`、`npm run self-test`                    | 镜像排查 | 用户推送 main 后看新一次 CI 结果；仍失败则按日志定位                                         |
| A4  | 在微信里执行 `/new` 时，日志文案写作 `Auto-created isolated conversation agent for Feishu IM chat`，渠道名不准                                  | `src/index.ts:12168`                                               | ISSUE-16 | 文案改为渠道无关，或带上实际渠道类型                                                         |
| A5  | Web 供应商表单的自定义环境变量是“一行一个 `KEY=value`”，`ANTHROPIC_CUSTOM_HEADERS` 只能填一个请求头，多个头无法配置                             | `web/src/components/settings/`、`src/schemas.ts`                   | ISSUE-18 | 拆成独立 issue（涉及表单与 schema），或在文档里写明限制                                      |

## B 组：没有调用方的路径与掉线逻辑（删除前须用户确认）

| #   | 问题                                                                                                                                                                                          | 位置                                                                                                                | 来源     | 建议候选                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| B1  | `claimNextChannelTurnRun` 生产零调用，只有 `tests/channel-reliability-store.test.ts` 在用（4 处）；ISSUE-14 的 worker 走的是按 ID 认领                                                        | `src/channel-reliability-store.ts:1228`                                                                             | ISSUE-14 | 有专门测试，属意图信号：保留并在注释写明用途，或连测试一起删除       |
| B2  | `enqueueIsolatedScheduledTask` 在 `src/` 没有调用方，只有两个测试文件在用；`claimScheduledRun` 在现行 V2 路径（总带 `durableRun`）下实际不生效                                                | `src/task-scheduler.ts:869`、`:920`；`tests/routes-tasks-contract.test.ts`、`tests/task-scheduler-contract.test.ts` | ISSUE-16 | 先核实 V2 下是否还有任何路径会走到，再决定保留注释还是下线           |
| B3  | `agent_reply` 的完整回复广播仍在产出（`broadcastToWebClients` → `src/web.ts:1725`），但前端只消费 `notice=true` 的警告，完整回复已由 `new_message` 承载（`web/src/stores/chat.ts:1646` 注释） | `src/index.ts:8474-8480`、`src/web.ts:1725`、`web/src/components/layout/AppLayout.tsx:141`                          | ISSUE-06 | 只有生产者没有消费者：停止广播完整回复、保留 notice 警告，或维持现状 |

## C 组：收敛与测试欠账（不急）

| #   | 问题                                                                                                                                                              | 位置                                                                                               | 来源     | 建议候选                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| C1  | workspace-memory 能力的 HMAC 签名内容在宿主与 runner 各构造一份，签名一致性只靠注释约束                                                                           | `src/workspace-memory-capability.ts:157`、`container/agent-runner/src/workspace-memory-auth.ts:32` | ISSUE-11 | 把签名内容构造收进 `shared/` 并纳入 `make sync-types` 同步  |
| C2  | 一行式错误信息提取（`err instanceof Error ? err.message : String(err)` 一类）约 75 处没有统一                                                                     | 全仓                                                                                               | ISSUE-11 | 抽公共函数逐步替换，或不做                                  |
| C3  | `scripts/check-stream-event-sync.sh` 只检查 stream-event、image-detector、channel-prefixes，没有覆盖 Makefile `_check-sync` 里的 `canonical-json`、`model-suffix` | `scripts/check-stream-event-sync.sh`、`Makefile:75`                                                | ISSUE-11 | 脚本补上两组，或删掉脚本只保留 Makefile 检查                |
| C4  | `tests/scope-check-contract.test.ts` 缺非 ASCII 路径的用例，防止 `-c core.quotepath=false` 被重构时静默去掉                                                       | `tests/scope-check-contract.test.ts`                                                               | ISSUE-15 | 补一个中文路径夹具用例                                      |
| C5  | auth 路由的头像上传缺少负向测试（建议补 `/avatar` 返回 400 的用例）                                                                                               | `src/routes/auth.ts`、`tests/`                                                                     | ISSUE-09 | 补测试                                                      |
| C6  | 旧版 `/api/config/user-im` 微信热重载路径没有接 context_token 持久化                                                                                              | `src/index.ts`（`saveUserWeChatConfig` 那一支）                                                    | ISSUE-19 | 按 CLAUDE.md 兼容层只做兼容，建议不做                       |
| C7  | 图片、文件的 outbox payload 只存 `fileName`/`contentHash`，没有路径和字节，崩溃后无法重投附件                                                                     | `src/index.ts` `sendImWithRetry`、`sendTaskImageWithRetry`、`sendTaskFileWithRetry`                | ISSUE-14 | 有需求时另开 issue 扩展 payload；目前转 failed 的行为可接受 |

## 已核实不再成立（不纳入）

- ISSUE-05 登记的 `RESULT_FILE_PREFIXES` 中 `install_skill_result_`、`uninstall_skill_result_`、`list_tasks_result_`、`ckqclaw_owner_profile_result_` 四项“没有写入点”：现在这四类回执经 `src/ipc/task-dispatch.ts` 都有写入，名单完整性由 `tests/result-file-prefixes-consistency.test.ts` 锁定（`src/ipc/watcher.ts:655-683` 注释写明）。

## 验收标准

- 每一项都有用户拍板结论，写进交付记录：做、不做（理由）、或拆成的新 issue 编号。
- 拍板为“做”的项各有测试或实机证据；B 组删除项删除前已用 `git grep -w` 交叉核实。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

（领取后填写）
