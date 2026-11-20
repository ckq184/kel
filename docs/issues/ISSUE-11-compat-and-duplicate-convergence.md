# ISSUE-11 兼容层下线与重复实现收敛

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成（2026-11-20；八项决策拍板后实现交付，规格符合性审查通过，质量轮按用户指示跳过）                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | ZCode 会话 / `issue-11`（计划 `docs/issue11-compat-and-duplicate-convergence-plan.md`）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
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

（2026-11-20 交付，分支 `issue-11`，提交链 7f7b786 立项 / e99eadd A 实现 / b28ed51 B 实现 / 交付落档见本提交）

**提交号**：立项 `7f7b786`（八项决策拍板 + 计划落档）；A 实现 `e99eadd`（27 文件 +318/−1865：死门面 13 条、旧入口 7 条、/agents 写路由 5 条、WS send_message 及其类型面、includeClaudePreset 契约层、phoneNumber 死字段、status/飞书凭据前端迁 /api/channel-accounts）；B 实现 `b28ed51`（54 文件 +2115/−1062：B1-B10 收敛 + 2 个契约测试文件 44 用例）。

**验证**：`npm run verify` 六步全绿（A 34.4s / B 35.3s）；`node scripts/check-scope.mjs` 通过（A 30 路径 / B 77 路径全在声明内；扩宽路径均已随提交信息说明）。规格符合性审查（独立代理）**通过**（零阻塞；3 条非阻塞建议已处置或登记于 `docs/审查记录.md`）；代码质量审查按用户 2026-11-20 指示跳过，审查记录如实注明。

**与 issue 描述的偏差**：

1. A.1：原文要求 4 条活路由全部迁 `/api/channel-accounts`——核实发现 `PUT bindings/:imJid` 与 `reset-allowlist` 在 channel-accounts 无等价物，用户拍板**原地保留**（现行活 API 非死门面）；status 与 PUT feishu 迁移后下线（前端经 `deriveConnectedChannels` 派生与 POST/PATCH channel-accounts 写凭据）。
2. A.3：原文「改为委托 /sessions」→ 用户拍板**直接删除**（前端零调用；ACL 测试写用例迁 sessions 版）。
3. A.5：WhatsApp 残留在领取时已被先前任务清光，实际仅剩 phoneNumber 死字段；`include_claude_preset` 按用户拍板**契约层彻底下线**（含 ContainerInput 线缆、宿主两处计算、runner 声明；DB `prompt_mode` 列与 profile API 字段留 ISSUE-09/10；`agent-profile-prompts.ts` 两 helper 因 DB/API 存活调用方未删，归 09/10）；`settings/types.ts:56` 空段落标题（A.5 第 3 小项，规格审查非阻塞发现）随交付提交删除。
4. A.4：WS `send_message` 删除连带其专属 `ws_error` 错误通道，按用户审查口径单独拍板**连消费端一起下线**（类型变体 + ChatView 订阅 + ACL-MATRIX §7 行）。
5. A.6：重定向 8 处**全保留**，CLAUDE.md 声明补齐 + 测试补锁 4 条（用户拍板，未收敛条数）。
6. B.9：头像实为三套（`agent-profiles.ts` 第三套为核实新发现），用户拍板一并收敛，gatescope 随立项扩入。

**分叉实现的最终行为选择**（对应验收标准第 2 条）：

- `markNativeContextWorkspace`：**config 折叠版**（旧格式 `web:{folder}` 折叠到注册 jid 再写 native_thread 标记；agents 侧 3 调用点随之获得折叠语义——用户拍板）。共享实现落 `src/channel-mount-service.ts`。
- `updateWorkspaceGroup`/`applyRegisteredGroupUpdate`：**守卫版**（`if (groups[jid])`，不凭空建缓存条目）；detach 统一签名取 group 对象版、binding_mode 守卫内化。
- `resolveWorkspaceJid`：channel-mount-service 导出版 + index 薄适配保「缓存优先」语义；边缘行为变化=同 folder 多候选第一个未注册时跳过继续找（原私有版返回 null，拍板内更健壮方向）。
- groups 双 store：唯一 loader 落 groups store（in-flight 去重），chat store 委托 + 镜像 + create/rename/pin/delete/interaction 五流广播；两份 state 容器保留（组件 API 不动）。
- 错误提取：`web/src/utils/error.ts` 基准（Error.message → 对象 .message → String(err)，**不 trim**，fallback 可选参数）；11 副本全替换；顺带修复 McpServerDetail 吞 API 文案真 bug；`download.ts` 特化版与 `settings/types.ts getErrorMessage` 保留。
- `buildCustomEnv`：**严格合成版**（大写 key / 非空 value / trim 存储 / 整包作废）；文案取舍：保留键与第三方默认键取 ProviderEditor 版、格式/非空/重复取 Setup 版——SetupProvidersPage 保留键报错文案随之统一（文案级变化，拦截语义不变，规格审查已核实登记）。
- `nowIso`/`requireDatabase`：`src/store-helpers.ts` 参数化，三条抛错文案逐字保住；`isoNow`（可注入时钟增强版）保留。
- `OAuthUsageBucket`：删无注释版保 :250 注释版，类型不变。
- 计费 pattern 归一化：db 导出版为唯一实现，pricing 两处内联改调，409 行为不变（pricing-routes 19 用例照跑全绿）。
- 头像：共享 `src/avatar-upload.ts`（落 src/ 根仿 `http-upload-policy.ts` 先例，`src/routes/` 会触 docs:check 路由索引）；MIME 大小写不归一维持现状。

**遗留登记（未收敛）**：HMAC payload 构造两份同构（签名一致性仍靠注释纪律，建议后续纳入 shared/）；一行式错误提取约 75 处未全局清扫；`GET /agents` 与 `GET /sessions` 的读侧重复对（GET /agents 按拍板保留为 chat store 数据源）；`scripts/check-stream-event-sync.sh` 未扩展新两组 sync（完整性由 `tests/no-duplicate-helpers-contract.test.ts` fs 逐字节断言承担）；`agent-profile-prompts.ts` 两 helper（归 ISSUE-09/10）。
