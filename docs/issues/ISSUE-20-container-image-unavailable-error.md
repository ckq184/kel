# ISSUE-20 容器镜像不可用时快速失败并明确告知用户

| 字段          | 值                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                         |
| 领取人 / 分支 | `claude/distracted-noyce-b82677`                                                                                                                                                                                               |
| 优先级        | P2                                                                                                                                                                                                                             |
| 类型          | 缺陷（可观测性与错误处理）                                                                                                                                                                                                     |
| 依赖          | 无                                                                                                                                                                                                                             |
| 阻塞          | 无（镜像本身的发布问题需要用户在 GitHub 配置 Docker Hub 凭据，不在本 issue 范围）                                                                                                                                              |
| 预计改动路径  | `src/agent-output-parser.ts`、`src/container-runner.ts`、`src/index.ts`（Agent 失败处理与 `onMaxRetriesExceeded`）、`src/group-queue.ts`（重试判定），可能涉及 `web/src/lib/system-message-registry.ts`，以及相应的 `tests/**` |
| 需用户决策    | **是**：见下文“需用户决策”                                                                                                                                                                                                     |
| 来源          | 2026-11-23 容器镜像排查（ISSUE-14/16/19 实机验收中反复出现退出码 125）；用户拍板“立 issue 改进报错”                                                                                                                            |

## 背景：镜像为什么拉不到（已查明，不在本 issue 修）

- `.github/workflows/docker-publish.yml` 在每次推送 main 时登录 Docker Hub、构建双架构镜像并发布 `ckq184/ckqclaw-agent:latest`。
- 它只运行过一次（2026-11-22，提交 `ccd3b3d`），两个架构都在 “Log in to Docker Hub” 失败，报错 `Username and password required`：仓库没有配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`。Docker Hub 上 `ckq184/ckqclaw-agent` 返回 404，从未发布过。
- 修复方式是用户在 GitHub 仓库配置这两个 secret 后重新发布，需要用户本人的凭据。
- 顺带发现：同一次推送的 CI（`ci.yml`）在 “Agent runner self-test” 一步失败，与镜像无关，未排查。

## 现象：镜像不可用时，系统静默重试后丢弃消息

实机日志（ISSUE-14 验收，2026-11-23 10:03–10:10）：

1. 每条消息触发 `docker run`，Docker 先找本地镜像、再去拉取，失败后退出码 **125**，stderr 为 `Unable to find image ... locally` 和 `pull access denied for ckq184/ckqclaw-agent, repository does not exist or may require 'docker login'`。
2. `src/agent-output-parser.ts` 把错误拼成 `Container exited with code 125: <stderr 最后 200 字符>`；截断后丢掉了镜像名开头，日志里只剩 `:latest' locally ...`。
3. `src/index.ts` 的 Agent 失败处理把它当普通失败：`queue.willRetryAfterFailure()` 为真时只打 warn 日志 `Agent error (no reply sent), will retry silently with backoff`，向 Web 补发 `status: idle`，不告诉用户原因。
4. `src/group-queue.ts` 按 `MAX_RETRIES = 5`、`BASE_RETRY_MS = 5000` 指数退避：5s、10s、20s、40s、80s，约 2.5 分钟里一共启动 6 次容器，每次都必然失败。
5. 最后 `onMaxRetriesExceeded` 发一条系统消息 `agent_max_retries`：`<工作区名> 处理失败，已达最大重试次数`，只发到工作区（`sendSystemMessage(groupJid, ...)`），不含失败原因；从微信等 IM 渠道发来的消息，发送方在 IM 里收不到任何提示。

问题：

- **重试没有意义**：“镜像不存在 / 拉取被拒”是确定性失败，重试只会延迟告知、浪费资源。
- **原因不可见**：用户只看到“已达最大重试次数”，看不出是镜像问题，更不知道怎么处理（配置凭据、改 Host 模式、在 Monitor 页拉取镜像等）。
- **IM 发送方无感知**：消息被丢弃，IM 侧没有任何反馈。

可参考的先例：同一处失败处理已经对 OOM（退出码 137）做了专门识别和告知（`consecutiveOomExits`，`src/index.ts` 约 7880–7910 行）；`src/routes/monitor.ts` 已有管理员拉取镜像的入口（`Docker pull exited with code ...`）。

## 需用户决策

1. **识别范围**：只识别“镜像不存在 / 拉取被拒”（退出码 125 且 stderr 含 `Unable to find image` / `pull access denied` / `manifest unknown` 等），还是把所有退出码 125（Docker 自身启动失败，含挂载、参数错误）都当成不可重试。
2. **识别后的处理**：立即停止重试并把消息标记失败，还是保留一次重试（应对网络抖动导致的拉取失败）。
3. **告知内容与渠道**：系统消息是否带具体原因和处理建议（例如“Agent 镜像 xxx 不可用：请管理员在 Monitor 页拉取镜像，或把工作区切换为 Host 模式”）；是否同时回复到 IM 发送方；镜像名、错误原文是否向普通用户展示（可能暴露部署信息）。
4. **启动期预检**：服务启动时是否检查默认镜像是否存在（`docker image inspect`），不存在时在日志或 Monitor 页给出明确告警，而不是等到第一条消息才失败。
5. **错误截断**：`stderr.slice(-200)` 截掉了镜像名，是否改为保留首尾或按行截取。

## 验收标准（待拍板后细化）

- 有测试锁定：镜像不可用的退出被识别为不可重试（或按拍板只重试一次），不再走 6 次指数退避。
- 用户可见的失败提示包含原因和处理建议，送达范围按拍板执行（Web 工作区 / IM 发送方）。
- 其他失败（普通退出码、OOM、超时）的现有重试和告知行为不变，有回归测试。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

- **领取**：分支 `claude/distracted-noyce-b82677`，base `638d0c7`，立项文档 `docs/issue20-container-image-unavailable-plan.md`。
- **用户拍板（2026-11-23，五项全部按推荐）**：
  1. 识别范围：只认退出码 125 且 stderr 命中 `Unable to find image` / `pull access denied` / `manifest unknown` / `repository does not exist` / `repository … not found`；挂载、参数错误等其他 125 仍走现有重试。
  2. 识别后：立即停止，不保留重试。
  3. 告知：Web 工作区发 `agent_error`，文案只含原因和处理建议（监控页拉取镜像、或切换宿主机模式），不含镜像名和 Docker 原文；同时沿当前 Turn 的 IM 路由回复发送方。
  4. 启动期预检：存在 Container 工作区且 Docker 可用时，不阻塞地检查一次镜像，缺失只打 warn 日志（含镜像名和处理建议），不自动拉取。
  5. 错误截断：stderr 超过 400 字符时保留开头和结尾各 200 字符，中间用「…」连接；Container 与 Host 共用同一函数。
- **提交**：
  - `4f95eb1` 立项（领取、立项文档、`.gatescope.json`）。
  - `5a3ebed` T1：新增 `src/container-image-failure.ts`（识别、首尾截断、带 `container_image_unavailable:` 前缀的错误构造、用户文案、启动预检函数）；`agent-output-parser` 默认错误串与 Host `enrichError` 改用首尾截断，Container closeCtx 注入 `buildContainerExitError`。
  - `d2d115d` T2：`src/index.ts` 主路径在认证失败分支之后、OOM 与静默重试之前新增镜像不可用分支（Web 系统消息、IM 通知、定时任务终态、提交游标、清指示、不重试）；抽出 `resolveSystemNoticeRoute` 供主动尾部中断通知复用；`ensureDockerRunning` 接入启动预检。
- **测试**：新增 `tests/container-image-failure.test.ts`（识别正反例、截断、错误构造、文案不含镜像名、启动预检三种情况、Container/Host 接线断言）与 `tests/container-image-unavailable-wiring.test.ts`（新分支位置与收尾、IM 通知参数、回归：OOM 计数与自动重置、普通失败静默退避与末轮 `agent_error` 原文、`agent_max_retries`、`MAX_RETRIES = 5` / `BASE_RETRY_MS = 5000`、超时错误串）；`tests/agent-output-parser.test.ts` 补两条（默认错误串保留首尾、注入后带前缀）。均先红后绿。
- **验证**：`npm run verify` 六步全绿（总耗时约 36s；第 4 步 351 个文件，2878 通过、23 跳过）；`node scripts/check-scope.mjs` 通过（11 个路径全在声明内，未扩宽）。
- **偏差**：
  - 新增 `resolveSystemNoticeRoute`，把 `deliverProactiveTailInterruptionNotice` 中原有的路由解析抽出复用，行为不变（有断言锁定），属立项范围内的 `src/index.ts`。
  - 启动预检直接在 `index.ts` 调用 `docker images`，没有复用 `src/routes/monitor.ts` 的 `getDockerImageId`（该函数未导出且带 30 秒缓存，监控页不在本 issue 改动范围）。
  - 「index 分支接线」沿用仓库惯例，用源码结构断言锁定，没有对 `processGroupMessages` 做端到端测试。
- **未做 / 登记**：
  - Runtime Session（`processAgentConversation`）路径的失败处理没有接入镜像不可用识别（立项非目标）；该路径另有一套重试与收尾逻辑，若同样需要快速失败，可另立 issue。
  - 镜像发布（GitHub 配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`）与 CI「Agent runner self-test」失败仍需用户处理。
- **实机验收（2026-11-23，用户执行，通过）**：本分支 `npm run dev:all`，数据复制自 `intelligent-shamir-6c676c`，Docker 正常运行，本地没有 `ckq184/ckqclaw-agent:latest`；微信账号「测试」的默认工作区改为 Container 模式的「测试」工作区。
  1. 启动预检：日志打出 warn「Agent container image not found locally …」，带 `image: "ckq184/ckqclaw-agent:latest"`，没有阻塞启动。
  2. 微信发「你好」：容器以 125 退出，错误串带 `container_image_unavailable:` 前缀，镜像名完整；随即打出「Agent container image unavailable; skipping retry」。之后没有再启动容器，也没有静默重试或 `agent_max_retries` 的记录，从收消息到告知约 5 秒（原来约 2.5 分钟）。
  3. 告知：Web 工作区新增一条 `agent_error` 系统消息（不含镜像名），没有多存副本；`channel_outbox` 对应行 `delivered`；用户确认微信和 Web 都看到了提示。
  4. 该工作区已提交的消息进度停在这条消息，不会重放。
  - 顺带观察：在 Web 上打开 Container 工作区的终端面板时，终端预热也因镜像缺失以 125 失败，只打一条 warn「Terminal warmup run ended with error」，不经过消息的失败处理，不在本 issue 范围内。
  - 顺带观察：Web 新建微信账号时如果和已有账号重名，接口直接把 SQLite 唯一约束原文以 409 返回（`src/routes/channel-accounts.ts` 只对 QQ App ID 做了重复预检）。用户决定不登记。
