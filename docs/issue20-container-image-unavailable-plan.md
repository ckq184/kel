# 任务立项：ISSUE-20 容器镜像不可用时快速失败并明确告知用户

> 立项日期：2026-11-23｜base：`638d0c7`（本地 main tip，ISSUE-17 合并提交）｜分支：`claude/distracted-noyce-b82677`
> 来源：`docs/issues/ISSUE-20-container-image-unavailable-error.md`（ISSUE-14/16/19 实机验收中反复出现退出码 125）

## 0. 需求采访结论（2026-11-23）

- **目标**：Container 模式下镜像不存在或拉取被拒时，不再静默指数退避 6 次，而是立即停止，并把原因和处理建议告诉 Web 工作区和 IM 发送方。
- **完成条件**：镜像不可用的识别、跳过重试、告知内容与送达范围都有测试锁定；普通退出码、OOM、超时的现有重试和告知行为有回归测试；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：不修镜像发布本身（需要用户在 GitHub 配置 Docker Hub 凭据）；不改数据库 schema；用户可见文案不含镜像名和 Docker 原文；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 为准）

| 事实                                                                                                                                                                                                        | 位置                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 非零退出的默认错误拼接为 `${label} exited with ${exitLabel}: ${stderr.slice(-200)}`；ctx 可注入 `enrichError(stderr, exitLabel)`                                                                            | `src/agent-output-parser.ts:600-608`                |
| Host 模式已注入 `enrichError`（缺依赖时给出 `result` 用户提示），错误串同样 `slice(-200)`                                                                                                                   | `src/container-runner.ts:2702-2713`                 |
| Container 模式的 closeCtx 没有注入 `enrichError`                                                                                                                                                            | `src/container-runner.ts:1838-1870`                 |
| 主路径失败处理已有确定性失败先例：`context_budget_exceeded:` / `context_overflow:` / `agent_profile_unavailable:` 前缀和 `isPermanentProviderAuthError` 都是「发系统消息 → 收尾定时任务 → 提交游标 → 返回」 | `src/index.ts:7688-7770`                            |
| OOM 特判（`OOM_EXIT_RE = /code 137/`、`consecutiveOomExits`）位于确定性分支之后、静默重试之前                                                                                                               | `src/index.ts:623`、`:7772-7842`                    |
| 静默重试：`queue.willRetryAfterFailure(chatJid)` 为真时只打 warn 并补 `status: idle`；否则发 `agent_error`                                                                                                  | `src/index.ts:7847-7870`                            |
| 重试上限 `MAX_RETRIES = 5`、`BASE_RETRY_MS = 5000`；最终 `onMaxRetriesExceeded` 只向工作区发 `agent_max_retries`                                                                                            | `src/group-queue.ts:111-112`、`src/index.ts:14288`  |
| 按当前 Turn 的持久化 scope 向 IM 发系统通知的通用函数：`deliverIndependentChannelSystemNotice`（先例：`deliverProactiveTailInterruptionNotice` 用 `channelOutboxScopesByInput.get(inputTurnId)` 取 scope）  | `src/index.ts:2297`、`:2440`、`:5353-5377`          |
| 启动期 `ensureDockerRunning()` 只在存在 Container 工作区时检查 Docker 是否可用，不检查镜像                                                                                                                  | `src/index.ts:11748-11760`                          |
| 监控页 `/api/status` 已有 `dockerImageExists`（`docker images <镜像> --format {{.ID}}`）与管理员拉取入口                                                                                                    | `src/routes/monitor.ts:101-120`、`:244-272`、`:500` |

## 2. 用户决策（2026-11-23，全部按推荐）

| 项            | 决策                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 识别范围   | **仅镜像不可用**：退出码 125 且 stderr 含 `Unable to find image` / `pull access denied` / `manifest unknown` / `repository does not exist` 等；其他 125（挂载、参数错误）仍走现有重试 |
| 2. 识别后处理 | **立即停止**：跳过重试、提交游标、即时告知并收尾，与 401/403 认证失败分支一致                                                                                                         |
| 3a. 告知内容  | **原因 + 处理建议，不含镜像名**；镜像名和 Docker 原文只写服务端日志                                                                                                                   |
| 3b. 送达渠道  | **同时回复 IM 发送方**：沿当前 Turn 已绑定的 IM 路由发同文案；只对本分支生效，其他失败的送达方式不变                                                                                  |
| 4. 启动期预检 | **启动时打告警日志**：存在 Container 工作区且 Docker 可用时检查一次，镜像缺失打 warn（含镜像名和处理建议），不阻塞启动、不自动拉取                                                    |
| 5. 错误截断   | **保留首尾**：超长时取开头约 200 + 结尾约 200 字符，中间用「…」连接；Container 与 Host 两处统一用同一函数                                                                             |

## 3. 实现方案

1. **新模块 `src/container-image-failure.ts`**（纯函数，便于单测）：
   - `summarizeStderr(stderr, edge = 200)`：不超过 `2 * edge` 原样返回，否则首尾拼接。
   - `isContainerImageUnavailableExit(exitLabel, stderr)`：`exitLabel === 'code 125'` 且命中收窄的镜像不可用模式。
   - `CONTAINER_IMAGE_UNAVAILABLE_ERROR_PREFIX = 'container_image_unavailable:'` 与 `CONTAINER_IMAGE_UNAVAILABLE_USER_NOTICE`（不含镜像名）。
   - `buildContainerExitError(stderr, exitLabel)`：命中时返回带前缀的错误串，否则返回普通错误串（均用 `summarizeStderr`）。
   - `warnIfContainerImageMissing({ image, getImageId, warn })`：启动期预检，依赖注入便于测试。
2. **退出错误拼接**：`src/agent-output-parser.ts` 默认分支改用 `summarizeStderr`；`src/container-runner.ts` Host 的 `enrichError` 改用 `summarizeStderr`，Container 的 closeCtx 注入 `enrichError: buildContainerExitError`。
3. **主路径失败处理**（`src/index.ts`）：在 `isPermanentProviderAuthError` 分支之后、OOM 之前新增 `container_image_unavailable:` 分支：服务端 warn 日志记原始错误；`sendSystemMessage(chatJid, 'agent_error', 用户文案)`；当前 Turn 有 IM 路由时调用 `deliverIndependentChannelSystemNotice`（`noticeKey: 'container-image-unavailable'`、`storeMessage: false`，避免 Web 重复）；`projectCurrentScheduledGroupTerminal('failed', 文案)`；`commitCursor()`；清理处理中指示；`return true`。
4. **启动期预检**：`ensureDockerRunning()` 在 Docker 可用后调用 `warnIfContainerImageMissing`（`docker images <CONTAINER_IMAGE> --format {{.ID}}`，失败视为缺失）。

## 4. 任务拆分与回滚点

| 任务 | 内容                                                       | 验收                                                                                       | 回滚点   |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| T1   | 新模块纯函数 + 退出错误拼接接线（parser、Container、Host） | 125+镜像 stderr 产出带前缀错误；其他退出码/125 非镜像不带前缀；长 stderr 保留首尾          | 立项提交 |
| T2   | index.ts 失败分支 + IM 通知 + 启动期预检                   | 源码结构断言：新分支先于 OOM 与静默重试，完整收尾；OOM、静默重试、`agent_max_retries` 不变 | T1 提交  |
| T3   | 门禁与交付落档                                             | verify 全绿、check-scope 通过、issue 已完成                                                | T2 提交  |

## 5. 测试方案

- 单测 `tests/container-image-failure.test.ts`：识别正反例（125+四类文案命中；125+挂载错误、code 1、code 137、signal、超时文案不命中）、首尾截断、错误构造、启动预检（缺失告警 / 存在不告警 / 查询异常视为缺失）、用户文案不含镜像名。
- `tests/agent-output-parser.test.ts` 补：默认错误串长 stderr 保留首尾；注入 `buildContainerExitError` 后 125 镜像错误带前缀。
- 源码结构断言（风格同 `tests/provider-auth-error.test.ts`）：Container closeCtx 注入 `buildContainerExitError`；index 新分支位置与收尾；OOM 分支、`willRetryAfterFailure` 静默重试、`onMaxRetriesExceeded` 的 `agent_max_retries` 保持原样（回归）。

## 6. 非目标

- 不修复镜像发布（Docker Hub 凭据）和 CI self-test 失败。
- 不改 Runtime Session（`processAgentConversation`）路径的失败处理，只登记。
- 不把其他退出码 125（挂载、参数错误）改成不可重试。
- 不改 `MAX_RETRIES` / `BASE_RETRY_MS`，不给 group-queue 增加按失败类型的重试上限。
- 不在启动时自动拉取镜像，不改监控页。
- 其他失败（普通退出码、OOM、超时、认证失败）的告知内容和送达范围不变。
