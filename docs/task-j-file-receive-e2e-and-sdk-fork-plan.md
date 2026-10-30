# 任务 J：文件接收端到端闭环 + 飞书 SDK fork 治理

> **文档定位**：任务 B IM 四项补验收官（2026-10-23，落档 `1e33dab`）后的
> 下一阶段自包含交接。建议注入语：
> **「阅读 docs/task-j-file-receive-e2e-and-sdk-fork-plan.md，按任务 J1 开工。」**
> **基线（回滚点）**：`1e33dab`。**模式**：同任务 H/I 链——TDD、每任务一
> 提交、真机验证、交付报告附六门禁证据。

## 0. 一句话结论

任务 J1 = 文件接收端到端闭环（整条改造的原始诉求「Agent 发文件 → owner
批准 → 文件真实到达」从未成功走完；审批机制已于任务 B 补验中全通，现在只
差把最后一环跑通并顺带复验 backfill 修复）；任务 J2 = 飞书 SDK fork 治理
（`node_modules` 里的手工 fork 不被 git 跟踪，一次 `npm ci` 即静默丢失，
必须给出确定性结论与防丢失机制）。

## 1. 任务 J1：文件接收端到端闭环

### 背景与现状

- 任务 B IM 四项补验已全过（①卡片收到 ②按钮决定 ③`/approve` 命令
  ④重启重放幂等，见 `docs/REMAINING-WORK.md` 状态快照「任务 B 的 IM 渠道
  四项补验完成」）。审批链路：卡片推送 → 回调解析 → owner 门禁 → 决策
  落库 → pending 文件清除 → 卡片响应换卡，全部真机验证。
- **未闭环的一环**：审批批准后宿主执行 `mcp__miniclaw__send_file` 的文件
  送达从未成功过（早期审批全被 200621/接线缺陷卡死，等审批的 turn 全部
  超时流失）。
- **顺带复验**：用户 2026-10-23 已在飞书控制台补开 `im:message.group_msg`
  scope 并发布，启动期 backfill 的 230027 报错应已消除——**尚未复验**
  （补 scope 后服务重启过多次但未专门看 backfill 行）。

### 步骤

1. 重启后端（当前进程已停）：`node dist/index.js`（后台、输出重定向到
   `$TEMP/c3-server.log`；调试排障时前缀 `LOG_LEVEL=debug`）。
   - 验证：`GET /api/health` 200；启动日志**无 230027**；出现
     「Feishu backfill finished」且无「chat backfill failed」。
2. 群「测试」里 @电商机器人 提出让它发文件（如「把 CLAUDE.md 发给我」）。
   Agent 调 `send_file` → 产生新审批 → 卡片推送（新代码：决策时响应内
   回传结果卡，卡片当场换卡）。
3. owner 在卡片点 **✅ 批准**。
4. 验证：文件真实到达群（飞书 file/image 消息）；日志有 send_file 执行
   证据；`pending_approvals` 行 approved + `decisions/{id}.json` 落盘 +
   `pending/` 无残留（任务 I1 行为）。
5. （可选对照）再来一次让 owner 点 ⛔ 拒绝：文件不发送，Agent 收到拒绝
   结果。

### 验收

- backfill 启动成功（无 230027）。
- 批准路径：文件到达群 + 决策落库三件套（DB/decisions 文件/pending 清除）。
- 若文件未到达：按日志定位是宿主发送层还是容器/runner 层问题——注意
  send_file 宿主端路径写死 GROUPS_DIR 的缺陷已由任务 G1 修复
  （`send-file-path.ts`），勿重复排查。

## 2. 任务 J2：飞书 SDK fork 治理

### 证据

- `node_modules/@larksuiteoapi/node-sdk/lib/index.js`（1.71.1）是**手工
  fork**：含自定义 `LarkChannel` 类（`createLarkChannel`，含 cardAction
  二级去重/安全队列，~行 99588 起）等非官方内容，且在本次排障中曾被插入
  过探针（已还原）。该文件**不被 git 跟踪**——任何一次 `npm ci` 都会把
  fork 静默抹回官方版。
- `src/feishu.ts` 走的是裸 `lark.WSClient` + 自建 `EventDispatcher`
  （`createFeishuConnection`），**疑似不依赖 fork 行为**；`normalizeCardAction`
  等 fork 辅助是否被间接引用未系统排查过。
- 风险场景：换机/重装依赖后 IM 渠道行为漂移且无任何报错提示。

### 设计（先取证再定方案）

1. 取证：从 npm registry 拉同版本（1.71.1）官方 tarball，与本机
   `lib/index.js` 做 diff，列出 fork 改动全集与是否被 `src/` 引用
   （`grep -rn "LarkChannel\|createLarkChannel" src/ container/`）。
2. 若零依赖 → 结论落档：文档立牌（AGENTS.md 维护规则一条 + 任务 J2 执行
   记录）「本项目仅依赖官方 SDK 行为，禁止引用 fork 私有导出」，npm ci
   丢失即无害。
3. 若有依赖 → `patch-package` 正规化（新增 devDependency 属运行时依赖
   冻结的例外，需在提交信息说明理由）或将 fork 关键改动收编进
   `scripts/vendor/` 自持文件。
4. 不做全量 `npm ci` 实验（会重编译 better-sqlite3、耗时长且污染当前
   可用环境）；用「官方 tarball diff + 引用扫描」替代。

### 验收

- diff 结论 + 引用扫描结论落档（本文件 §5 执行记录）。
- 按结论落地立牌或 patch-package；`docs:check` 过。

## 3. 非目标

- git remote/push、Docker Hub 镜像发布：用户 2026-10-23 明确暂缓
  （`CONTAINER_IMAGE=ckq184/miniclaw-agent:latest`，本机仅有 docker CLI、
  守护进程未启动；remote 未配置、gh 未安装）。
- Windows 测试基线 triage（32-34 个永久失败文件）与门禁机审化（宪法
  第 6 条：CI/lint/hooks 引入需用户单独批准）：列为后续方向，未立项。
- 群里 5 张远古「权限请求」卡片：非本项目产物，用户未决定是否清理。
- 账号 `ckq184` 的 Docker Hub / GitHub 任何远端操作。

## 4. 环境事实表（冷启动必读）

- **HEAD**：`1e33dab`（master，工作区干净）；`dist/` 为 2026-10-23
  12:24 build:all 产物，与源码 HEAD 内容一致（其后仅 docs 提交）。
- **六步门禁（本机无 make，用等价 npm）**：
  `npm run format:changed` → `npm run docs:check` → 后端 `npm run typecheck`
  - `cd web && npx tsc --noEmit` + `cd container/agent-runner &&
npx tsc --noEmit`（typecheck 目标另含
    `bash scripts/check-stream-event-sync.sh` 与
    `bash scripts/check-agent-runner-prompts.sh`）→ `npm test -- --run`
    （**失败文件集与基线比对**：32-34 个永久失败文件为既有 Windows 基线，
    判据=集合不扩大；改动相关文件必须全绿）→ `npm run build:all` →
    `git diff --check`。
- **飞书渠道**：测试群 JID
  `feishu:oc_ead0f477fbbb737d3a080c91ed347df9#account:4cf3c8fc-44d5-4e4d-8c76-5d193983f474`
  （folder=`main`，`registered_groups.owner_im_id` 已认领 =
  `ou_1239b889ceee51c32f55b109670a972c`，来源=DB 直写，等效
  `/owner_mention`，向用户透明报备过）。渠道账号 `4cf3c8fc-44d5-4e4d-8c76-5d193983f474`。
- **飞书凭据**：`data/config/channel-accounts/<accountId>.json`
  （AES-256-GCM，密钥 `data/config/claude-provider.key`，解密范式
  `src/channel-account-secrets.ts`）。只读 API 排查范式：tenant_access_token
  - fetch（列消息/删消息/patch 实测可用；**严禁打印/落盘任何密钥**）。
- **scope 现状**：`im:message.group_msg` 已开通（裸群消息可投递、backfill
  应通、列/删消息可用）；群命令带 `@电商机器人` 为现行 scope 模型下的
  预期用法。
- **审批卡换卡通道**：必须走 `card.action.trigger` 回调响应内
  `card:{type:'raw',data:<v1 卡>}`（`buildApprovalResultCardV1`）；
  **im/v1/message.patch 对 v1 审批卡渲染无效**且会把实体转 2.0、此后 v1
  payload 被 230099/200830 拒绝（真机实测，勿再走 patch 路线）。
- **敏感区域**：`data/` 禁改既有数据（用户批准清单除外）；密钥不进
  代码/日志/文档；CI/lint/hooks 引入需用户单独批准；无 remote，不得推送。
- **后台服务注意**：会话回收可能杀掉后台服务进程——验证前先
  `netstat -ano | grep :3000` 确认，挂了就重启（J1 步骤 1）。

## 5. 执行记录（2026-10-23）

- **J1（本提交落档）**：真机全过，原始诉求「Agent 发文件 → owner 批准 →
  文件真实到达」**首次端到端闭环**。
  - 步骤 1 复验：重启后端 → `/api/health` 200；全日志 **0×230027**
    （`im:message.group_msg` 补 scope 复验通过）；出现
    「Feishu backfill finished」、无「chat backfill failed」。
  - 运行前提（非代码改动）：群「测试」为 container 模式但 Docker Desktop
    守护进程处于停止状态（启动日志 WARN container-mode 将在消息时失败）；
    本次拉起 Docker Desktop（daemon ~10s 就绪，镜像
    `ckq184/miniclaw-agent:latest` 在本地）后触发。
  - 批准路径（approval `e71ea6f5`）：群「测试」@电商机器人「把 CLAUDE.md
    发给我」→ 卡片推送 → owner 点 ✅ → 四层证据：① 宿主日志
    `Tool approval requested`（15:50:04）→ `File sent to Feishu`
    （15:50:14，CLAUDE.md 17256B，chatId=测试群）→ `File sent via IPC`；
    ② `pending_approvals` 行 status=approved、decided_by=`im:ou_1239b…`
    （owner open_id）；③ `decisions/e71ea6f5….json` 落盘 +
    `approvals/pending/` 0 残留；④ 飞书只读 API 列群消息实证
    `file_name=CLAUDE.md` 消息真实落群（紧跟审批卡与触发消息）。
  - 观察项（不在 J1 范围，未定论）：批准后 Agent 的文字回包路由到
    `web:main`（日志 `Message sent jid: web:main`、`sendToIM: false`，
    源头 `directImReply=false`），飞书群只收到文件未收到文字回包。
    folder main 同挂 web home（acceptance Home）与飞书群（测试）两个
    表面（single_context + reply_policy=source_only），该路由是否符合
    预期待单独排查立项，不在此定论。
  - 步骤 5（可选拒绝对照）未跑：同代码状态 10-23 15:16 已有真机拒绝轮
    （`28e84518` ⛔ → denied 落库 + pending 清除，任务 B 补验期），
    如需可随补。
- **J2（本提交落档）**：取证完成，「手工 fork」前提**证伪**，走零依赖
  立牌路线（§2 设计第 2 步），patch-package 不需要。
  - diff 结论：`npm pack @larksuiteoapi/node-sdk@1.71.1` 官方 tarball 与
    本机 `node_modules` 逐文件对比，取证时仅 `lib/index.js` 有字节差，
    且**去行尾后哈希一致**（`a01f30d1…`）——内容级等同官方。历史真相：
    排障探针插入后已于 10-23 10:34 还原为官方内容，还原动作把该文件行尾
    转成了 CRLF；本文档 §2 所记「自定义 LarkChannel / createLarkChannel
    （cardAction 二级去重/安全队列）」实为**官方 1.71.1 正式导出**
    （官方文件行 99006 `normalizeCardAction`、99656 `createLarkChannel`，
    两侧逐行同位置），非 fork 内容，立项前提据此修正。
  - 引用扫描结论：`grep -rn "LarkChannel|createLarkChannel|
normalizeCardAction" src/ container/ tests/` **零引用**；项目仅用
    公开导出 `Client / WSClient / EventDispatcher / AppType /
LoggerLevel`（import 面：`src/feishu.ts`、`feishu-capability.ts`、
    `feishu-streaming-card.ts`、`dingtalk.ts`、`im-safety/processing-lock.ts`、
    `im-safety/stale-detector.ts` + 3 个测试文件）。`npm ci` 丢失即无害
    （当前已无 fork 可丢）。
  - 落地：① 已把 `lib/index.js` 行尾归一为官方字节（从官方 tarball 复制，
    现整包 raw md5 与官方一致，未来一次哈希比对即可自证非 fork）；②
    立牌一条入 `AGENTS.md` §4 边界与禁令（node_modules 禁手改/插探针、
    官方 tarball 哈希对照范式、仅引用公开导出）。
  - 未做全量 `npm ci` 实验（§2 设计第 4 步遵守）；docs-only 提交，门禁
    format:changed / docs:check / git diff --check 过。
- **J1 观察项澄清（本提交）**：定性为**取证误判，非缺陷**，观察项销案，
  无需修复。
  - 结论：bot 的文字回包**一直以流式答案卡落群**，从未缺席。真机时间线：
    15:49:32 触发文本 → 15:50:03 审批卡 → 15:50:12 file CLAUDE.md →
    **15:50:23 sender=app、标题「已完成」的答案卡**（即 CLAUDE.md 轮的
    文字回包）；16:07:39「你是什么模型」→ 16:08:08 同形答案卡。
  - 代码链路：飞书群消息被路由进工作区主会话（日志
    `Feishu message routed to workspace main conversation`，
    `effectiveJid=web:main`——群是 folder main 的 IM 窗口，single_context
    绑定）；turn 文字回包持久化到 `web:main`（web 表面可见），IM 侧由
    `StreamingCardController`（`src/feishu-streaming-card.ts`，typewriter
    流式，终态「已完成」=`src/feishu-cards/sections.ts:155`）向群投递
    答案卡；`sendToIM: false` 是防重复设计（`src/index.ts:9032` 注释
    「飞书卡片已在原卡片上完成收束，不重复发送」）。`reply_policy=
source_only` 在此架构下的实现 = 回包落工作区会话 + IM 侧答案卡投递。
  - 误判成因（留档防再犯）：飞书消息 list/get API 对 schema 2.0 卡仅返回
    降级 v1 投影（title + 「请升级至最新版本客户端」占位文本，正文拿不到），
    首轮取证又只筛了 `msg_type=text`，卡片文本域为空 → 误记「群未收到
    文字回包」。教训：飞书侧取证必须带 sender/时间线全量看，interactive
    卡片默认就是 bot 回包的主要形态。
