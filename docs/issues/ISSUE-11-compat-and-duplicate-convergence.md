# ISSUE-11 兼容层下线与重复实现收敛

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 优先级        | P3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 清理：下线兼容层、合并重复实现                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 依赖          | ISSUE-06（两个 store 重复加载 `/api/groups` 的问题）                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 预计改动路径  | `src/routes/config.ts`、`src/routes/agents.ts`、`src/routes/tasks.ts`、`src/routes/auth.ts`、`src/routes/pricing.ts`、`src/web.ts`、`src/index.ts`、`src/db.ts`、`src/runtime-config.ts`、`src/memory-store.ts`、`src/owner-profile-store.ts`、`src/channel-reliability-store.ts`、`src/workspace-memory-capability.ts`、`container/agent-runner/src/workspace-memory-auth.ts`、`container/agent-runner/src/context-window.ts`、`shared/**`、`scripts/sync-stream-event.sh`、`web/src/**`、`docs/API.md`，以及相应的 `tests/**` |
| 需用户决策    | **是**：A 部分要确认兼容期是否已经结束                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 来源          | 审查报告 §7、§8、§14.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

本 issue 分为 A、B 两部分，可以分两次提交。

## A. 兼容层下线（先请用户确认兼容期已经结束）

1. **`/api/config/user-im/*` 旧门面**（`src/routes/config.ts:2479-3213`）
   - 以下 13 条 Web 已经不再调用，可以下线：QQ 7 条、微信 5 条，以及 `GET user-im/feishu`。
   - 以下 4 条**仍在被调用，不能直接删**：`user-im/status`、`PUT bindings/:imJid`、`reset-allowlist`、`PUT user-im/feishu`。要先把这几处调用迁移到 `/api/channel-accounts`，再下线：
     - `ChatView.tsx:263`
     - `useConnectedChannels.ts:14`
     - `useImBindings.ts:201/225`
     - `SetupProvidersPage.tsx:208`：它还在用旧的单例 API 写入飞书凭据
2. **已经没有调用方的旧入口**：
   - `POST /api/tasks/parse`
   - `GET /tasks/:id/logs`
   - `POST /tasks/:id/run`（有测试，要同步修改）
   - `GET /api/config/claude`
   - `PUT /claude/custom-env`
   - `GET/PUT /api/config/feishu`
3. **`/agents` 别名下的写路由**（`src/routes/agents.ts:414-1673`，约 470 行）：这是一份独立的重复实现，要改为委托给 `/sessions` 的实现。**`GET /agents` 保留**，它目前是会话列表唯一的数据来源（`web/src/stores/chat.ts:3489`）。
4. **WS 入站消息 `send_message`**（`src/web.ts:1318-1507`，约 190 行）：仓库里已经没有发送方，而且它和 `POST /api/messages` 各维护了一套鉴权和校验逻辑。
5. **前端残留**：
   - WhatsApp 相关：`web/src/stores/channel-accounts.ts:44-56`、`:84`；`QrOnboardingPanel.tsx:214`、`:436`
   - `include_claude_preset` 字段：`web/src/types.ts:64`。这一项要等 ISSUE-04 第 4 项的结论
   - `components/settings/types.ts:56` 的空段落标题
6. **Settings 旧标签页重定向**（`web/src/pages/SettingsPage.tsx:61-69`、`:93`）：数量超出了 CLAUDE.md 声明的 3 条，请用户确认是否保留；对应测试是 `tests/frontend-settings-information-architecture.test.ts`。

## B. 重复实现收敛

| 条目                                          | 位置                                                                                                                                                                    | 注意                                                                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 个路由辅助函数                              | `src/routes/agents.ts:77-172` 与 `src/routes/config.ts:1621-1741`                                                                                                       | `markNativeContextWorkspace` 的两个版本语义已经分叉：config 版会把旧格式 `web:{folder}` 折叠成新格式，agents 版不会。统一之前先确认取哪一版 |
| `resolveWorkspaceJid`                         | `src/index.ts:17468` 有一份私有重写                                                                                                                                     | 改为调用 `src/channel-mount-service.ts:342` 的导出版                                                                                        |
| 两个 store 都加载 `/api/groups`               | `web/src/stores/groups.ts:26`、`chat.ts:1653`                                                                                                                           | 统一数据源，让重命名、置顶、删除操作在两边保持同步                                                                                          |
| 错误消息提取函数，共 11 份                    | 共享函数已经存在：`web/src/utils/error.ts:4` 的 `extractErrorMessage`                                                                                                   | 各副本的行为已有细微差异：是否回退到 `Error.message`、是否 trim                                                                             |
| `formatCost`、`safeStorage`、`buildCustomEnv` | `UsageTrendChart.tsx:36` 与 `UsagePage.tsx:107`；`routeRestore.ts:18` 与 `workspaceLastAgent.ts:8`；`ProviderEditor.tsx:63` 与 `SetupProvidersPage.tsx:36`              | `buildCustomEnv` 两份的校验规则已经分叉                                                                                                     |
| `nowIso`、`requireDatabase`                   | `src/memory-store.ts`、`src/owner-profile-store.ts`、`src/channel-reliability-store.ts`                                                                                 | 体量很小                                                                                                                                    |
| `OAuthUsageBucket` 声明了两次                 | `src/runtime-config.ts:252` 与 `:3477`                                                                                                                                  | TS 的接口合并特性会掩盖这个重复                                                                                                             |
| 计费 pattern 归一化                           | `src/db.ts:12700` 与 `src/routes/pricing.ts:77`                                                                                                                         | 两处一旦改得不一致，409 唯一性判定就会静默失真                                                                                              |
| 头像上传有两套实现                            | `src/routes/config.ts:1874` 与 `src/routes/auth.ts:763`                                                                                                                 | —                                                                                                                                           |
| 跨进程逐字相同的函数                          | `normalizeForCanonicalJson`：`container/agent-runner/src/workspace-memory-auth.ts:9` 与 `src/workspace-memory-capability.ts:34`；`stripOneMillionSuffix` 同样两边各一份 | 把它们纳入 `shared/` 的同步机制。前者涉及签名一致性，必须保持逐字相同                                                                       |

`/pair` 正则和 `safeRoot` 已经归 ISSUE-05 处理，本 issue 不重复。

## 验收标准

- `npm run verify` 和 check-scope 都通过。
- 合并后的行为有测试锁定。对于原本已经分叉的实现，在交付记录里写明最终选择了哪一种行为。
- 下线的接口同步更新 `docs/API.md` 和 `docs/ACL-MATRIX.md`。

## 交付记录

（领取后填写）
