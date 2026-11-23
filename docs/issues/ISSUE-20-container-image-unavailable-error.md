# ISSUE-20 容器镜像不可用时快速失败并明确告知用户

| 字段          | 值                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                         |
| 领取人 / 分支 | —                                                                                                                                                                                                                              |
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

（领取后填写）
