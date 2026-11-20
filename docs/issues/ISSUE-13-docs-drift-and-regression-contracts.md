# ISSUE-13 文档漂移修正与防回归契约测试

| 字段          | 值                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                      |
| 领取人 / 分支 | —                                                                                                                                                                                           |
| 优先级        | P3                                                                                                                                                                                          |
| 类型          | 文档修正与新增测试                                                                                                                                                                          |
| 依赖          | 文档部分中 CLAUDE.md“上下文窗口声明”那一行依赖 ISSUE-04；契约测试可以第一波就开工                                                                                                           |
| 阻塞          | 无                                                                                                                                                                                          |
| 预计改动路径  | `CLAUDE.md`、`README.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`src/group-queue.ts`（仅注释）、`src/db.ts`（仅注释）、`web/src/stores/chat.ts`（仅注释）、新增的 `tests/*-contract.test.ts` |
| 需用户决策    | 否                                                                                                                                                                                          |
| 来源          | 审查报告 §11、§13 防回归建议                                                                                                                                                                |

## A. 文档漂移

1. **`CLAUDE.md`**：“上下文窗口声明”那一行描述的行为在 Pi 下不成立。等 ISSUE-04 有结论后，按实际行为改写。
2. **`docs/API.md`**：
   - 第 77 行：`GET|PUT /:jid/mcp` 实际上并不持久化。按 ISSUE-07 第 2 项的结论更新。
   - `/api/config/user-im/*` 被标注为“旧客户端兼容”，但新版 Web 仍有 4 处调用。按 ISSUE-11 的进展更新。
   - 第 197-201 行列出的 runtime-sessions、channel-mounts 投影接口没有任何调用方，也没有测试。
   - 第 528-536 行说 uncertain outbox 可以由人工放行，但 Web 上没有这个入口。按 ISSUE-07 第 4 项更新。
   - 以下 4 条有 Web 调用方的路由没有写进文档：`POST /api/agent-profiles/:id/runtime-cleanup`、`PUT /api/config/claude/default`、`GET /api/groups/:jid/delete-impact`、`POST /api/tasks/purge`。
3. **`WEB_PORT` 默认值不一致**：`src/config.ts:61`、Makefile、README 第 162 行写的是 3001，CLAUDE.md §9 和 README 第 238 行写的是 3000。以代码为准统一。
4. **代码读取了、但没写进文档的环境变量**：
   - `RECALL_MODEL`
   - `CKQCLAW_ASSISTANT_NAME`、`ASSISTANT_NAME`
   - `ALLOW_LEGACY_UNSIGNED_COOKIE`
   - `CORS_ALLOW_LOCALHOST`
   - `CKQCLAW_WEB_URL`、`PUBLIC_BASE_URL`、`WEB_BASE_URL`
   - `CONTAINER_MAX_OUTPUT_SIZE`
   - `EXTERNAL_CLAUDE_DIR`
   - `ADMIN_HOST_ONLY_MODE`
   - `MAIN_AGENT_CONTEXT_SOURCE`
   - `CKQCLAW_MIGRATION_BACKUP_DIR`
5. **过时注释**（如果对应代码已被其他 issue 删除，就跳过）：
   - `src/group-queue.ts:1017` `isActiveRunnerTask` 的注释，称“message loop 在用”，已不属实
   - `src/db.ts` 中 `claimTaskRunNotificationById` 的注释，称“供 targeted recovery 使用”，实际没有 recovery 调用它
   - `web/src/stores/chat.ts:1878` 关于 `agent_reply` 的注释

## B. 防回归契约测试（纳入 `npm run verify` 的 test 步骤）

1. **StreamEvent 生产者覆盖**：`shared/stream-event.ts` 中的每个 `StreamEventType`，在 runner（`pi-runner.ts`、`pi-index.ts`、`mcp-tools.ts`）或宿主中都至少要有一个生产者。
2. **IPC 类型双向覆盖**：`container/agent-runner/src/mcp-tools.ts` 发出的每个 IPC `type`，在 `src/index.ts` 中都要有处理分支；反过来，宿主的每个处理分支也要有对应的发送方。
3. **路由与调用方双向一致**：Web 调用的每个 `/api/...` 路径都必须有后端路由。后端路由如果没有调用方，则必须在 `docs/API.md` 中声明用途（运维、兼容或外部调用）。

允许设置一个“已知缺口白名单”，**每条白名单都要注明对应的 issue 编号**。相关 issue 完成后，同步删掉对应的白名单条目。测试失败时，提示信息要告诉开发者：生产者被删除时，必须同时处理对应的消费端。

## 注意

- 修改文档后执行 `npm run docs:check`。
- 只新增测试文件，不修改 `scripts/verify.mjs` 的六步结构（这个结构由 `tests/verify-gate-contract.test.ts` 锁定）。

## 验收标准

- `npm run docs:check` 和 `npm run verify` 都通过。
- 三个契约测试已经落地，白名单中的每一条都有 issue 编号。

## 交付记录

（领取后填写）
