# 任务 G：运行时缺陷修复三项（G1 send_file 路径 / G2 恢复监视器 Windows 失明 / G3 runner 僵尸）

> **文档定位**：任务 B 验收会话（2026-10-21）踩出的三个运行时缺陷的自包含
> 修复交接。用户已批准立项（「先把这个修复了，写交接文档，注入新窗口开工」）。
> 新会话只读本文即可动工；建议注入语：**「阅读
> docs/task-g-runtime-defects-fix-plan.md，按任务 G1 开工。」**
> **写作时点**：2026-10-21。基线提交（回滚点）：`3091e78`。
> **模式**：同任务 C/F 链——TDD、每任务一提交（`fix:` 前缀）、用户在环验收、
> 交付报告附四门禁证据；规格符合性独立审查按宪法阶段 6 属可选项（历史链路
> 惯例未启用），如需启用由用户在交付时提出。

## 0. 一句话结论

修三个在 A/B 验收会话中实证的运行时缺陷：G1 = send_file 宿主端路径写死
`data/groups/{folder}/` 导致 customCwd 的 host 工作区文件投递必挂；G2 =
stuck-runner 恢复监视器 shell 出 Unix `ps` 在 Windows 必败、卡死 runner 永远
不被恢复；G3 = runner 子进程在 server 被强杀后存活成僵尸、无收敛机制。

## 1. 背景与证据（全部为 2026-10-21 验收会话实证）

任务 B（审批通知与 Web 审批页）真机验收在 AB测试 工作区进行时：

1. **G1**：模型三轮 `send_file` 全部 `file not found`（server 日志 13:53:07、
   14:02:31 两条 WARN + 一次绕过后成功）。根因
   `src/index.ts:13841`：`const fullPath = path.join(GROUPS_DIR, sourceGroup,
data.filePath)` ——宿主端把路径**写死解析到 `data/groups/{folder}/`**；
   而该工作区是 host 模式 + 自定义目录（`C:\Users\hscom\Desktop\测试`），
   文件实际在 customCwd 下。绝对路径 `C:/Users/...` 被 join 成
   `data/groups/<folder>/C:/Users/...` 的非法路径（碰巧仍落在 safeRoot 内，
   绕过 traversal 检查后 not found）。**默认工作区（文件目录即
   GROUPS_DIR）不受影响；customCwd 的 host 工作区必挂。**
   验收临时绕过：已拷贝 `CLAUDE.md` 副本到
   `data/groups/flow-mvhhmhqa-31mt/`（运行时目录中的测试夹具，G1 修复
   验收后可删）。
2. **G2**：server 日志 14:06-14:07 四条 `Failed to inspect host runner
descendant CPU; deferring stuck restart` + 大量 `Try 'ps --help'` 报错。
   根因 `src/stuck-runner-recovery.ts:49`：`execFileAsync('ps', ['-eo',
'pid=,ppid=,pcpu='])` —— Unix 命令在 Windows（Git Bash 的 ps 为有限
   兼容层）必然 exit 1 → CPU 检查永远失败 → `cpuActivity: 'unknown'` →
   卡死 runner 的恢复**永远 defer**（`deferReason: 'cpu_unknown'`），只能
   靠 30min 执行看门狗兜底。
3. **G3**：server（PID 29616）被 `taskkill //F` 后，其 10:28 spawn 的
   runner（PID 23840）**存活成僵尸**（`detached: true` 无父进程收敛、
   强杀不走 shutdown 钩子），持有一个 wedged turn 直到手工清理。spawn 点
   `src/container-runner.ts:2864`：`spawn(hostNodeBinary, [agentRunnerDist],
{ stdio: ['pipe','pipe','pipe'], env, cwd, detached: true })`。
   注意 `detached: true` 是为了 Windows 进程树整杀（killProcessTree），
   **不要简单改掉**——修复方向见 §3-G3。

## 2. 现状关键事实（动工前必读）

| 事实                   | 位置/值                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 平台                   | Windows + Git Bash；`make` **不在 PATH**——门禁用 npm 等效命令（见下）                                                                                                                                                                                                                                                                                                                                                                     |
| 提交前门槛（六步等效） | ① `npx prettier --write <改动文件>`（**`npm run format:changed` 在本机坏**：`scripts/check-format-changed.mjs:73` spawnSync 无扩展名 prettier shim ENOENT，预存缺陷已登记未修）→ ② `npm run docs:check` → ③ typecheck 三侧：`npx tsc --noEmit`（root）+ `cd web && npx tsc --noEmit` + `cd container/agent-runner && npx tsc --noEmit` → ④ `npm test -- --run`（**`npm test` 默认 watch**）→ ⑤ `npm run build:all` → ⑥ `git diff --check` |
| vitest 基线            | **38 个预存失败文件**（351 文件基线，2026-10-20/21 两日实测一致）；失败**文件集合**对比法；已知抖动对 `channel-turn-runtime` / `container-session-permissions` 会互换出现，定向重跑即绿，非回归                                                                                                                                                                                                                                           |
| server 起停            | 起：`node dist/index.js > 日志 2>&1 &`（dist 与 src 不一致时先 `npm run build:all`）→ `curl http://127.0.0.1:3000/api/health` 返回 200；停：`netstat -ano                                                                                                                                                                                                                                                                                 | grep :3000`找 LISTENING pid →`taskkill //PID <pid> //F`，**G3 修复前必须再清残留 runner**：PowerShell `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$\_.CommandLine -like '_pi-index_'}`→`Stop-Process -Id <pid> -Force` |
| provider               | 默认 = `glm-5.3-flash`（bigmodel，Anthropic 兼容端点，2026-10-21 配置并真机验证可用）；`step-3.7-flash`（StepFun）保留为备选——其推理端点当日曾大面积超时，勿切回                                                                                                                                                                                                                                                                          |
| Web 账号               | `acceptance`（admin，AB测试 工作区 owner；密码在验收会话中重置过、**未存档**——需 admin API 时 `npm run reset:admin -- acceptance <新密码>` 重置，密码不得写入代码/日志/文档）；`ab_member`（member，负例测试用）；`e2e_mem0`（任务 C 遗留）                                                                                                                                                                                               |
| 测试工作区             | **AB测试**（folder `flow-mvhhmhqa-31mt`，host 模式，customCwd `C:\Users\hscom\Desktop\测试`，chatJid `web:97133474-aabd-4285-b131-7a0db466ddd5`）——G1 复现与真机验收场                                                                                                                                                                                                                                                                    |
| 敏感区域               | `data/` 运行时目录（含明文 key 的 `data/config/auto-memory.json`、`claude-provider.json` 及 `.key` 文件）——禁止回显/复制 key、禁改既有数据；本任务允许的新增：G3 的 runner 注册文件（建议 `data/runtime/` 下，gitignored）                                                                                                                                                                                                                |
| 相关既有测试           | `tests/stuck-runner-recovery-policy.test.ts`、`tests/group-queue-stuck-recovery.test.ts`（G2 扩展）；G1 需新建路径解析测试；G3 需新建 reap 决策测试                                                                                                                                                                                                                                                                                       |

## 3. 任务拆解（回滚点 = `3091e78`，每任务一提交，TDD 先红后绿）

### G1：send_file 按工作区实际目录解析（`fix:` 提交）

- **范围**：`src/index.ts` send_file IPC 分支（~13820-14120）+ 新测试文件。
- **设计**：抽纯函数（如 `resolveSendFileRoot(sourceGroup, group): string`）
  ——host 模式且工作区有自定义目录时返回该目录（复用 container-runner
  spawn 时的 groupDir 解析逻辑，`src/container-runner.ts:~2825` 的
  `workingDir` 日志即来自它，找到同一 helper 接入）；否则回退
  `GROUPS_DIR/<folder>`（container 模式与默认 host 工作区语义不变）。
  `path.join(root, data.filePath)` 后保留既有两道防线：safeRoot 前缀检查
  与 symlink 检查。**语义明确化**：绝对路径仅当 resolve 后仍在允许 root
  内才接受（当前绝对路径"意外通过 traversal 但必然 not found"的糊涂态
  收敛为显式行为），在测试中固化。
- **TDD**：新 `tests/send-file-path-resolution.test.ts`：默认工作区回退
  GROUPS_DIR、customCwd host 工作区解析到自定义目录、相对路径、绝对路径
  在 root 内/外两态、traversal 拒绝。先红后绿。
- **真机验收**：AB测试 工作区发「把工作区里的任意一个文件发给我」→ 审批
  批准后工具**不再 not found**（customCwd 下的 CLAUDE.md 能被解析；
  Web-only 会话的投递语义 = 跳过 IM 投递、文件存工作区，这是设计行为
  不是 bug，模型会如实转告）。验收后删除
  `data/groups/flow-mvhhmhqa-31mt/CLAUDE.md` 夹具副本。

### G2：恢复监视器 Windows 兼容（`fix:` 提交）

- **范围**：`src/stuck-runner-recovery.ts`（172 行，CPU 检查在 ~L49）+
  扩展既有两测试文件。
- **设计**：`process.platform === 'win32'` 时不用 `ps`——Windows 下降级为
  **存活 + idle 时长**启发式（进程存在即视为活动候选，CPU 视为 unknown
  但**不得因此永久 defer**：改用「idle 超上限且进程存活 → 判 stuck」的
  平台分支），或用 `tasklist /fo csv` / PowerShell `Get-Process` 取 CPU。
  推荐前者（少一个外部进程依赖、语义可测）。非 Windows 路径行为不变。
  defer 决策收敛为纯函数便于测试（`cpu_unknown` 不再是永久豁免理由）。
- **TDD**：扩展 `tests/stuck-runner-recovery-policy.test.ts`：win32 分支
  （mock platform）cpu_unknown + idle 超限 → 判 stuck；idle 未超 → 继续
  defer；darwin/linux 路径回归不变。
- **真机验收**：Windows 下起 server + 拉起 runner，观察恢复监视器日志
  **不再出现** `ps --help` 报错与 `Failed to inspect ... CPU`（替代为平台
  分支日志）；卡死场景（可造一个挂起的 host runner）能被判 stuck 并恢复。

### G3：runner 孤儿收敛（`fix:` 提交）

- **范围**：`src/container-runner.ts`（spawn 点 ~2864 与 host run 收尾）+
  新增注册文件管理 + 新测试。
- **设计**：spawn 成功后把 `{pid, folder, bootId}` 追加到
  `data/runtime/host-runners.json`（bootId = server 本次启动的唯一 id，
  启动时生成），进程正常退出/被杀时移除条目；**server 启动时 reap**：
  条目的 bootId ≠ 当前 bootId 且 pid 仍存活（`process.kill(pid, 0)` 探活，
  Windows 下有效）→ `taskkill /PID <pid> /T /F` 整树杀 + 移除条目 + WARN
  日志。reap 决策写成纯函数（输入：注册条目 + 当前 bootId + 探活结果）。
  **不改 `detached: true`**（Windows 整杀依赖它）。
- **TDD**：新 `tests/host-runner-registry.test.ts`：异 bootId 且存活 →
  reap；同 bootId → 保留；进程已死 → 仅清条目；文件缺失/损坏 → 空表
  启动不炸。先红后绿。
- **真机验收**：起 server → 发消息拉起 runner → `taskkill //F` 杀 server →
  确认 runner pid 已在注册文件 → 重启 server → 日志出现 reap 记录、
  残留 runner 进程消失。
- **附带**：`data/runtime/` 若不在 `.gitignore` 需补（先查，gitignored
  的 `data/` 整目录已覆盖则无需）。

## 4. 风险与缓解

1. **G1 动的是文件投递安全路径**——两道既有防线（safeRoot、symlink）必须
   原样保留并补测试；绝对路径语义收紧为显式规则，防止回归成任意读。
2. **G2 改恢复决策**——保守侧默认：平台分支只影响 win32；非 Windows
   路径必须有回归测试锁定。
3. **G3 的 reap 误杀风险**——pid 复用可能让新进程被误判（低概率）：
   注册条目里加 spawn 时间戳，reap 前校验进程创建时间与条目时间接近
   （PowerShell 可取），偏差大则只清条目不杀进程；测试覆盖该分支。
4. **三个修复互相独立**，可按 G1→G2→G3 顺序单独交付单独回滚。

## 5. 非目标

- 不动容器（docker）模式的 runner 生命周期与挂载逻辑。
- 不做 IM 渠道补验（飞书卡片/按钮/`/approve` 命令——等用户绑 IM 另约）。
- 不修 `npm run format:changed` 脚本缺陷（已登记，独立小任务）。
- 不处理两条 UX 候选（中断后转轮滞留；send_file 无 IM 路由时模型重试
  循环）——G1 落地后第二个自然缓解，第一个需要交互设计决策，均另议。
- 不动任务 A 验收（长任务续跑真机验收仍挂账，与本链路无关）。

## 6. 交付物

- 三个 `fix:` 提交（G1/G2/G3 各一），每个附四门禁证据（§2 等效命令）。
- 真机验收记录追加到本文档 §7（每任务完成后写）。
- 交付报告给用户（验收匹配度 + 四门禁证据 + 剩余风险），由用户签收。

## 7. 真机验收记录

### G1（2026-10-21，提交 `a63bc7d`）——代码与单测全过；真机验收 = IPC 直驱四探针全过 + 完整模型链路复验全过（provider 曾阻塞，见 §7.1 与下方复验记录）

**实现范围落地**：新 `src/send-file-path.ts`（`resolveSendFileRoots` 双根 = host+customCwd
工作区 primary（realpath+isDirectory best-effort，失败回退）+ `GROUPS_DIR/<folder>`
workspace——后者是 IM 下载固定落点（`im-downloader.ts:76`），必须保持可投）+
`resolveSendFilePath`（相对路径按 primary=runner spawn cwd 语义；绝对路径仅 resolve
后仍在允许根内才显式接受；越界拒绝 `outside_roots`）。`src/index.ts` send_file IPC
分支接线替换写死 join（原 :13841），safeRoot 与 symlink 两道防线原样保留，symlink
检查升级 `isRealpathInside` 双根（覆盖 downloads 回退路径）。

**四门禁证据**：

- ① 测试：新 `tests/send-file-path-resolution.test.ts` 9 用例先红（module not
  found）后绿 9/9；全量 vitest 320 过 / 33 失败文件——全部为 §2 基线同族预存失败
  （node-resolver、backup-restore-safety、routes/db/mount 等），零新增失败文件，
  且失败数较 38 基线少 5（预存失败的环境性漂移，方向向好）；隔离性由依赖图证明：
  `index.ts` 为叶子入口，无任何测试/模块反向 import（grep 取证）。
- ② 类型检查：root / `web/` / `container/agent-runner` 三侧 `npx tsc --noEmit`
  全过。
- ③ 构建：`npm run build:all`（root + web + agent-runner）exit 0。
- ④ diff 范围：`src/index.ts`（import + send_file 分支两处）+ 新增
  `src/send-file-path.ts` + `tests/send-file-path-resolution.test.ts`，无范围外
  文件；`git diff --check` 干净。①前的 `npx prettier --write`（3 文件）与
  `npm run docs:check`（45 文件过）已执行（§2 六步等效全跑）。

**真机验收（IPC 直驱四探针，真实 server + 真实 AB测试 工作区）**：起新 dist
server（15:05:34，health 2s 200）后，因 provider 账户阻塞（§7.1）模型轮次不可用，
改用任务 F3 同款 IPC 直驱方法论：向 `data/ipc/flow-mvhhmhqa-31mt/tasks/` 投
send_file 任务 JSON，由 IPC watcher 驱动**真实 send_file 分支**（含新解析代码与
两道防线）。夹具判别前提：先删除 `data/groups/flow-mvhhmhqa-31mt/CLAUDE.md`
副本（计划批准的验收后动作；旧代码对该文件存在与否不敏感的糊态被消除）。

| 探针               | filePath                                | 回执                                                         | 判定                                                                                                          |
| ------------------ | --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1 相对路径         | `CLAUDE.md`                             | `No IM route is available for file delivery.`                | 文件在 customCwd 下**被找到**，走到投递路由分支；Web-only 会话按设计跳过 IM 投递并如实回执（§3-G1 预期语义）✓ |
| 2 绝对路径 root 内 | `C:/Users/hscom/Desktop/测试/CLAUDE.md` | 同上                                                         | 事发时的原始失败形态，现已**被找到** ✓                                                                        |
| 3 相对 traversal   | `../../../package.json`                 | `Invalid file path.` + WARN `Path traversal attempt blocked` | 防线保留 ✓                                                                                                    |
| 4 绝对路径 root 外 | `C:/Windows/win.ini`                    | `Invalid file path.` + WARN                                  | 糊态收敛为显式拒绝 ✓                                                                                          |

日志佐证：探针 1 完整走通至 `15:45:53 INFO File sent via IPC`；四探针全程**零
`file not found`**（旧代码在探针 1/2 处必产出该 WARN——即验收会话 13:53/14:02
的原始缺陷形态）。探针回执文件验后即清，IPC 目录无残留。

**模型链路复验（同日 16:05-16:10，用户提供新 GLM Coding Plan key 后补做，
全过）**：

- key 经 `PUT /api/config/claude/providers/7d30283ada603dc5/secrets` 正规通道
  写入 `anthropicApiKey` + `anthropicAuthToken`（带 Bearer 前缀）双字段——env
  构建顺序为 authToken 行后写覆盖 apiKey 行（`runtime-config.ts:2555-2579`），
  双写消除旧键残留歧义；密钥仅存 `data/config/claude-provider.json` 加密
  blob（iv/tag/data），不落代码/日志/文档。applied：persisted、6 会话失效重建。
- 链路：16:05:29 发「请把工作区里的 CLAUDE.md 文件用 send_file 发给我」→
  16:07:41 模型发起 `mcp__miniclaw__send_file` 审批（`filePath: "CLAUDE.md"`
  相对路径）→ Web 审批页 API 批准 → **16:10:15 `File sent via IPC`** →
  16:10:33 模型如实转告回执「报错 No IM route is available…」（Web-only
  会话跳过 IM 投递，§3-G1 预期设计语义）。
- 判别力：此时 `GROUPS_DIR/<folder>/CLAUDE.md` 夹具已删（探针阶段删除），
  文件唯一存在于 customCwd——旧代码该场景必报 not found；本轮日志
  `file not found` 计数 **0**，新路径解析真机生效的直接证据。
- §7.1 补充结论：`[1m]` 后缀在本代码库仅用于预填
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`（`isOneMillionContextModel`），
  模型串**原样上送 API**——1211 拒绝确系 provider 侧行为，与本项目无关。
- 环境收尾（第二轮）：server 已停、残留 runner 清零、会话 cookie 文件已删、
  acceptance 密码为未存档随机值（需要时 `npm run reset:admin` 重置）。

### 7.1 验收环境事件记录（provider 账户阻塞，需用户决策）

- 上午（~10:28 起）真机可用的 `glm-5.3-flash`（bigmodel Anthropic 兼容端点）在
  15:05 起的全部分析中返回 **400 `[1211] 模型不存在`**；15:03-15:04 有一次
  provider 配置变更（`claude-provider.json` updatedAt 为证）：模型代码被改为
  `glm-5.3-flash[1m]`，该代码被 provider 一致拒绝（20 分钟内 6+ 次全 1211，
  非瞬态）——**`[1m]` 后缀不被该端点支持**。
- 经 `PATCH /api/config/claude/providers/7d30283ada603dc5` 走正规 API 改回
  `glm-5.3-flash`（上午真机验证可用的值；此改动可逆，若 `[1m]` 系有意配置请
  在 provider 实际支持后再改回），随后返回 **429 `[1113] 余额不足或无可用资源
包,请充值`**——**账户额度已于上午验收中耗尽**。这是完整模型链路验收的硬阻塞，
  需用户充值 / 换 key / 或明确改用其他 provider（step-3.7-flash 按计划 §2 勿切回）。
- 期间观察（对 G2/G3 有参考价值）：provider 快速 4xx 后 runner 的 SDK 停在
  error 态不向宿主回传 final（runner 日志 `finalizationReason:"error"` 仅在进程
  被杀时落盘），宿主视角 runner 永远 busy、`interruptQuery` 返回 false（队列已
  失联）、steer 无法穿透，表现为零 TCP/零 CPU 的楔死进程，与 G3 僵尸场景同款；
  杀掉 runner 后队列自动退避重试自愈。恢复监视器在整个观察期未产生任何日志
  （G2 的 Windows 失明缺陷使然，30min 看门狗未到期）。
- 收尾状态：server 已停（taskkill），残留 runner 已按 §2 命令清零
  （`NO_RUNNER_LEFT`），夹具副本已删，IPC 探针文件已清。

### G2（2026-10-22，提交 `aa2dd63`）——代码与单测全过；真机验收 = 扫描循环取证 + 真实 dist/真实 pid 三路探针全过；「候选成熟→判 stuck→重启」全链路在 web-only 流结构性不可达（见下，决策语义由单测钉死）

**实现范围落地**：`src/stuck-runner-recovery.ts`——`resolveRunnerCpuActivity` 增
平台分支（win32 不再调 Unix `ps`，改 `probeHostRunnerLivenessWin32` 存活启发式：
`process.kill(pid,0)` 探活、`isProcessKillErrorAlive` 纯函数把 EPERM 视为存活）；
死 runner+欠账工作→`inactive`（与 Unix 死 pid 无后代同款=3min idle 阈值即恢复，
原 Windows 必等 10min ceiling）；活 runner→`unknown` 保守宽限，仍受
absolute_ipc_ceiling/idle_ceiling 双上限约束。非 Windows 路径不动；
`platform`/`isProcessAlive` 为注入测试缝；决策纯函数 `decideStuckRunnerRecovery`
未动。**范围微调**：`tests/group-queue-stuck-recovery.test.ts` 未扩展——候选选择
/复核逻辑与平台无关（经全量测试验证），扩展无实义。

**四门禁证据**：① policy 测试追加 6 用例先红（4 红）后绿，26/26；全量 vitest
失败文件集同 G1 基线（唯一差异 builtin-skill-bootstrap = 5s 超时抖动，定向重跑
3/3 绿）；② 三侧 typecheck 过；③ build:all 过；④ diff 仅
`src/stuck-runner-recovery.ts` + `tests/stuck-runner-recovery-policy.test.ts`，
`git diff --check` 干净。prettier/docs:check 已跑（六步等效）。

**真机取证（2026-10-22，真实 server + 真实 AB测试 工作区）**：

- **扫描循环证明**：临时诊断（已还原，工作树对 `aa2dd63` 零 diff）证实
  `recoverStuckPendingGroups` 每 ~30s 在真实 Windows server 上正常执行
  （`G2DEBUG stuck recovery scan executed` 逐 30s 落盘）。
- **真实探针三路**（直接驱动 `dist/stuck-runner-recovery.js` 编译产物，默认
  platform=win32，对真实 runner pid 10864）：
  1. 活 runner → `unknown` + INFO `Windows: host runner CPU is unobservable;
liveness heuristic keeps the live runner under the recovery grace
ceilings`（`runnerAlive: true`）✓
  2. 死 pid（999999）→ `inactive` + INFO `Windows: host runner process is
gone; treating owed work as inactive so recovery can restart it`
     （`runnerAlive: false`）✓
  3. 显式 `platform:'linux'` → 委托 ps 探针 → 复现**与原始缺陷一字不差的**
     `ps: unknown option -- o / Try 'ps --help'` + 原 WARN——证明该失败模式
     在 win32 已被新代码结构性根除（仅显式强制非 win32 平台才可达）✓
- **「候选成熟→判 stuck→重启」全链路不可达的系统性发现**：web-only 工作区的
  在飞消息被 durable follow-up 存储吸收（不进 group-queue 的
  pendingMessages/ipcOwed 状态），且 runner 退出即清 `state.active`、退出回退
  清债务时钟——六种场景实验（组级 env 黑洞、IP 黑洞、静默挂起服务器、500 服
  务器快败循环、在飞注入、steer）均无法使候选在 web-only 流中成熟。14:06 原始
  ps 报错场景源自任务 B 时代的审批 IPC/IM 渠道注入流（IM 渠道绑定属 §5 非目标
  ——同一批另约）。因此该决策链（死 runner 3min 恢复对等、活 runner 宽限到
  ceiling）由单测 26 用例钉死；候选成熟路径的端到端真机复验与 IM 渠道补验同批。
- **实验期附带发现（登记备查）**：① 组级 env 覆盖（`PUT /:jid/env` 的
  anthropicBaseUrl）在 host+provider 池模式下被池解析结果后写覆盖——组级改
  端点无效，文档/UI 存在误导（候选独立小任务）；② `/api/config/claude/
providers/:id` PATCH 偶发首调 404（重试即成功，候选独立小任务）；③ 17:30
  观测到 exit 后短暂「Group runner active, message queued」卡死态。
- **环境还原**：provider 已还原真实端点（`open.bigmodel.cn/api/anthropic` +
  `glm-5.3-flash`），健康消息 15s 内真实回复 "ok" 验证端到端恢复；server 已
  停、runner 清零、静默/500 测试服务器已杀（3128/3129/3000 端口全 FREE）、
  会话 cookie 已删。

### G3（2026-10-22，提交 `e5e7b75`）——代码与单测全过；真机验收四项全绿

**实现范围落地**：新 `src/host-runner-registry.ts`——持久注册表
`data/runtime/host-runners.json`（`/data/` 已 gitignore，附带项无需改）；spawn
后注册 `{pid, folder, bootId, spawnedAt}`（container-runner host spawn 点），
`proc.on('close')` 注销；写原子（tmp+rename），缺文件/损坏 JSON 容错空表；
bootId = server 启动单例 UUID。reap 纯函数 `decideHostRunnerReap`：异 bootId 且
存活 → 整树杀（win32 `taskkill /T /F`，POSIX SIGKILL best-effort）；同 bootId →
保留（正常退出路径自己注销）；进程已死 → 仅清条目；**pid 复用护栏** = 进程创建
时间与 spawnedAt 偏差 > 120s → 仅清条目不杀无辜进程（win32 PowerShell
ToFileTime / linux /proc mtime / 其余 null）。杀失败保留条目下次 boot 重试。
`reapOrphanedHostRunners` 挂 index.ts 启动序列（fire-and-forget + catch）。
探活复用 stuck-runner-recovery 的 `isHostProcessAlive`。**未改
`detached: true`**。全依赖（platform/探活/创建时间/杀执行/registryPath）注入
测试缝。

**四门禁证据**：① 新 `tests/host-runner-registry.test.ts` 13 用例先红（模块缺
失）后绿（决策五态+文件容错+reap 编排含杀失败保留、pid 复用不杀）；全量 vitest
失败文件集与基线**完全一致**（33/354）；② 三侧 typecheck 过；③ build:all 过；
④ diff = 新模块 + 新测试 + container-runner.ts（import+spawn 注册+close 注销）+
index.ts（import+启动 reap），`git diff --check` 干净。

**真机验收（2026-10-22，真实 server + AB测试 工作区，四项全绿）**：

1. **注册留痕**：发消息 → runner 在 spawn 后 **2 秒内**出现在注册表
   （pid 11428 / folder / bootId(boot A) / spawnedAt）✓
2. **强杀 server**（taskkill //F）：detached runner **存活成僵尸**
   （`RUNNER_11428_STILL_ALIVE`），注册表条目原样保留 ✓——G3 缺陷场景精确复现
3. **重启 server（boot B）→ reap**：启动日志 WARN `Reaped orphaned host runner
from a previous server boot`（folder + 旧 bootId 在案）→ taskkill 整树杀 →
   `RUNNER_11428_GONE (REAPED)` → 注册表清空为 `[]` ✓
4. **正常路径注销**：健康轮次完成（"ok"）→ 暖 runner 注册条目呈
   keep(current_boot) 语义（不误杀）→ stop 组触发退出 → close 钩子注销 → 注册
   表回 `[]` ✓

收尾：server 已停、runner 清零（`NO_RUNNER_LEFT`）、端口 3000 FREE、cookie 已
删。任务 G 全部三项（G1/G2/G3）交付完毕。
