# 任务 H：收尾清理三项（H1 format:changed 修复 / H2 中断转轮复验 / H3 运行时残留清理）

> **文档定位**：任务 A/B/G 全部闭环后的收尾任务自包含交接。用户已批准按此
> 清单开工。新会话只读本文即可动工；建议注入语：**「阅读
> docs/task-h-cleanup-plan.md，按任务 H1 开工。」**
> **写作时点**：2026-10-22。基线提交（回滚点）：`86d6b6e`。
> **模式**：同任务 C/F/G 链——TDD（适用处）、每任务一提交、用户在环验收、
> 交付报告附四门禁证据。

## 0. 一句话结论

清掉登记在案的最后三个小项：H1 = `npm run format:changed`（提交前门槛第
一步）在 Windows 必 ENOENT 的脚本缺陷；H2 = 中断后「正在准备回复」转轮
滞留——**先复验**（任务 G2 修复后可能已自愈，可能零代码）；H3 = 运行时
目录残留清理（G1 验收夹具 + 5 个已决定的审批 pending 文件，消除 server
每次启动的重放噪音）。

## 1. 各任务证据与设计

### H1：format:changed 脚本 Windows 修复（`fix:` 提交）

- **证据**：`scripts/check-format-changed.mjs:72-73` 以
  `spawnSync(node_modules/.bin/prettier, ...)` 调用——`.bin/prettier` 是无
  扩展名 sh shim，Windows spawnSync 必 `ENOENT`（2026-10-21 实测，近期全部
  提交该步均为手动 `npx prettier` 补位）。本机六步门槛的第一步实际从未
  机审过。
- **设计**：改为平台无关的 `spawnSync(process.execPath, [prettierCjs,
...args])`，其中 `prettierCjs = path.join(root, 'node_modules', 'prettier',
'bin', 'prettier.cjs')`（已核实存在；不经 shell、不依赖 .bin shim，
  Windows/macOS/Linux 一致）。保留 `--write`/`--check` 参数透传与退出码。
- **验收**：① 构造一个故意格式不规范的临时 md → `npm run format:changed`
  能改写它；② 再跑一次 `npm run format:changed` exit 0（幂等绿）；③
  `npm run format:changed` 对干净树 exit 0。
- **附带**：修复后本脚本恢复为提交前门槛第一步的机审，交付报告里注明。

### H2：中断后转轮滞留——先复验再决定（可能零代码）

- **背景证据**：2026-10-21 14:07 用户两次点停止 → interrupt sentinel →
  会话卡片 `query_interrupted`，但「正在准备回复…」转轮长期滞留、排队消息
  卡「发送中」直至 server 重启。当时归因 = runner 自恢复监视器 Windows
  失明（任务 G2 已修复：win32 存活启发式替代 Unix `ps`，卡死 runner 3 分钟
  idle 即恢复）。**G2 落地后本现象可能已自愈，禁止未复验先改码。**
- **复验步骤**：AB测试 工作区发一条会触发工具调用的消息 → 在模型执行中点
  停止（■）→ 观察转轮是否在 ~3 分钟内（G2 的 idle 恢复阈值）清除、排队
  消息是否继续投递。另测「停止后立即发新消息」路径。
- **分支**：自愈 → 本文 §7 追加复验记录、H2 关闭（零代码）；未自愈 →
  保守修法 = interrupt sentinel 处理路径上向 Web 广播 turn 终态事件清除
  转轮（找到 `query_interrupted` 的广播点，在其后补 turn-finished；
  具体挂点动工时定位，改码单独 `fix:` 提交）。

### H3：运行时残留清理（操作类，无代码；已获用户批准进入）

- **证据**：① G1 验收夹具 `data/groups/flow-mvhhmhqa-31mt/CLAUDE.md` 仍在
  （2026-10-22 核实）；② `data/ipc/flow-mvhhmhqa-31mt/approvals/pending/`
  残留 5 个**已决定**审批的挂起文件（f0d1b426/e9c1750b/2d241778/761e57ce
  均 approved、aa8a29cc denied；另有 e67e6b5d 需先对 DB 核实状态再动）——
  它们是 server 每次启动重放 `Tool approval requested by runner` 日志噪音
  的来源（对应 DB 行均已 decided，重放无害但不洁）。DB `pending_approvals`
  表当前已无 pending 行，**不涉及 DB 写**。
- **操作**：删除夹具文件；pending 目录中逐个核对 DB 状态为 decided 后删除
  对应 json（e67e6b5d 若 DB 无对应行或状态不明，保留并在报告中注明）。
  `data/` 属敏感区域，本项为用户批准清单内的明确动作，仅删上述列名文件。
- **验收**：重启 server → 启动日志不再出现旧审批重放行；`/approvals` 页
  无陈旧条目；AB测试 工作区 send_file 真机一发仍正常（G1 修复不依赖夹具）。

## 2. 环境关键事实（动工前必读）

| 事实        | 值                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 平台        | Windows + Git Bash；`make` 不在 PATH                                                                                                                                                                                                                                                                            |
| 提交前门槛  | ① `npm run format:changed`（H1 修复后已恢复机审，见 §7-H1）→ ② `npm run docs:check` → ③ 三侧 `npx tsc --noEmit`（root / `web/` / `container/agent-runner`）→ ④ `npm test -- --run` → ⑤ `npm run build:all` → ⑥ `git diff --check`                                                                               |
| vitest 基线 | 失败**文件集合**对比法；基线约 33-38 个随日期漂移（2026-10-22 实测 34），已知抖动对 `channel-turn-runtime`/`container-session-permissions` 互换出现，定向重跑即绿；差异先定向重跑再定性                                                                                                                         |
| server      | 起：`node dist/index.js > 日志 2>&1 &`（src 变更后先 `npm run build:all`）→ `curl http://127.0.0.1:3000/api/health` 200；停：`netstat -ano` 找 3000 LISTENING pid → `taskkill //PID <pid> //F`（G3 的注册表+reap 已接管孤儿清理，下次启动自动收；即时清理仍可手动：PowerShell 查 `pi-index` 进程 Stop-Process） |
| provider    | 默认 `glm-5.3-flash`（bigmodel）；`step-3.7-flash` 备选（曾大面积超时勿切回）；偶发 `Request timed out.` 为端点抖动，重试即可                                                                                                                                                                                   |
| Web 账号    | `acceptance`（admin；密码经多次轮换未存档，`npm run reset:admin -- acceptance <新密码>` 重置）；`ab_member`（member）                                                                                                                                                                                           |
| 测试工作区  | AB测试（`flow-mvhhmhqa-31mt`，host 模式，customCwd `C:\Users\hscom\Desktop\测试`，chatJid `web:97133474-aabd-4285-b131-7a0db466ddd5`）                                                                                                                                                                          |
| 敏感区      | `data/` 禁改既有数据——H3 仅删本文列名文件；一切 key 不回显/不入档                                                                                                                                                                                                                                               |

## 3. 非目标（后续方向，本任务不做）

- IM 渠道绑定与任务 B 四项补验（等用户绑飞书）。
- git remote 配置与首次 push（用户账号侧，TASK-D §10）。
- Windows 全量 vitest 基线修绿（38 文件级技术债，独立立项）。
- verify 一键脚本 / git hooks 机审门禁（宪法第 6 条，等用户批准）。
- `linked_memory_ids` 落地（mem0ai v3 升级或侧车后处理，另议）。
- 产品新功能规划（等用户使用体感后出题）。

## 4. 交付物

- H1 `fix:` 提交（脚本 + 验收证据）。
- H2 复验记录追加本文 §7（零代码）或 `fix:` 提交（若需改码）。
- H3 操作清单执行结果记入本文 §7。
- 交付报告（验收匹配度 + 四门禁证据 + 剩余风险），用户签收后本链闭环。

## 7. 执行记录（2026-10-22）

### H1：format:changed Windows 修复 — 已完成（`f53b775`）

- 复现（红）：改前对含探针 md 的树跑 `npm run format:changed` 必现
  `spawnSync ...\node_modules\.bin\prettier ENOENT` exit 1，与 §1 证据一致。
- 验收（绿）：① 故意不规范临时 md 被改写、exit 0；② 重跑幂等 exit 0 全
  `(unchanged)`；③ 提交后干净树 exit 0；补充 `--check` 透传模式 exit 0
  （"All matched files use Prettier code style!"）。
- 六步门槛全过；vitest 失败文件集 34 与当日基线一致（grep 证实该脚本与
  tests/src/web/container 零耦合）。附带成效：提交前门槛第一步自 `f53b775`
  起恢复机审（H2 全程即以 `npm run format:changed` 通过第一步）。

### H2：中断转轮滞留 — 复验未自愈，已修复（`bc0b675`）

- **复验方法**：AB测试 工作区真机 API 驱动（登录 acceptance 经密码轮换），
  发 A（exec 工具 8 秒任务）→ B 排队 → 执行中 `POST /interrupt` → 轮询
  follow-up 队列与消息历史；server 带 `LOG_LEVEL=debug` 日志佐证。
- **未修复行为**（事故同型复现）：`query_interrupted` 分隔线即时落库，但 B
  卡 `queued`；pi runner 36ms 内消费哨兵并 abort（"Pi turn interrupted"）但
  **不向宿主发任何终态输出**，宿主 `queryInFlight` 永不清零。G2 监视对此
  失效：冷启动查询没有 IPC 债务锚点（`runForGroup` 启动即清
  `ipcOwedSinceAt`，消息走 bootstrap prompt 不经 IPC 注入）→
  `snapshotStuckRecoveryCandidate` 两条件恒假 → 恒无候选，扫描/探活全程
  静默（任务 I 勘察修正：本节原记「轮询循环阻塞致扫描不跑」不成立——
  扫描不依赖候选存在，无候选才无探活日志；暖路径注入的 A2 则有候选、
  天花板重启如期触发，两者差异即佐证）；重启后 B 经
  `recoverDurableFollowUps` 释放投递（03:30:44Z 才被回答）。判定：
  **未自愈**，远超 §1 的 ~3 分钟线。
- **根因**：`runPiQueryAttempt`（`container/agent-runner/src/runtime/pi/
pi-runner.ts`）中断路径 `break` 后 `publishResult` 被 `!interruptedDuringQuery`
  条件跳过——pi runner 中断后静默回空闲。对照旧 runner
  （`container/agent-runner/src/index.ts`）中断后显式补发
  `statusText:'interrupted'`，宿主 `wrappedOnOutput` 借此
  `markRunnerQueryIdle` 放行队列并让 Web 收束「已停止」。
- **修法**：pi-runner 中断后按旧 runner 字段契约补发终态（`status:'stream'` +
  `streamEvent{eventType:'status', statusText:'interrupted', queryRunId, turnId,
sessionId}` + `newSessionId` + `queryIdle` + cancelled `ipcReceipts`）。宿主
  与 Web 的既有处理链零改动。TDD 新增 1 用例先红（expected undefined to be
  defined）后绿；六步门槛全过（失败文件集 33 与 H1 基线一致零新增，
  `channel-turn-runtime` 为已知互换抖动转绿）。
- **修复后真机复验**：同场景 interrupt → 队列 ≤22s 清空、B 于 +24s 被回答
  （"收到B3"）；「停止后立即发新消息」→ 新消息 `disposition:'started'`
  立起新 Run（修复前会被僵尸 Run 吞入永久排队）、+24s 被回答（"收到E"）。
  两路径均秒级～半分钟级，远优于 ~3 分钟验收线。

### H3：运行时残留清理 — 批准范围内已完成（操作类，无代码提交）

- **删除前 DB 核实（只读）**：列名 6 个 pending json 对应 DB 行全部已决定
  （f0d1b426/e9c1750b/2d241778/761e57ce approved、aa8a29cc denied，与 §1 一致；
  e67e6b5d 亦 approved @2026-10-21T08:10:14Z）→ 6 个 json 全部删除；
  `pending_approvals` 表 pending 行数 0，全程零 DB 写。
- **夹具删除**：`data/groups/flow-mvhhmhqa-31mt/CLAUDE.md`（内容实为
  AGENTS.md 副本，7479 字节）已删。
- **重放噪音验收**：重启前基线 = 启动日志 11 行 `Tool approval requested by
runner`；重启后（默认 info 级）**计划范围内 6 文件重放 0 行**。但发现
  **计划外同类残留 5 个**（全部 DB 已决定、pending=0，均为重放噪音源，按
  「仅删列名文件」纪律未动，待用户定夺）：
  - `data/ipc/flow-mvaklhpb-o36t/approvals/pending/` 4 个（container 模式
    工作区，创建于 10-16：3a5f94b3 read approved、45c65427 send_file
    approved、8b4e1b41 get_channel_context approved、b8e1a7cd read denied）；
  - `data/ipc/flow-mvhhmhqa-31mt/.../0d971d3f-*.json`（send_file approved，
    10-21，计划清单漏列）。
    现状：每次启动仍有 5 行重放（此前 11 行）。
- **`/approvals` 验收**：`listPendingApprovals()` 实为全量历史列表（无状态
  过滤，行内含 status/decided_at 字段）；pending 类陈旧条目 0。已删 6 文件
  的 DB 历史行按计划保留（不涉 DB 写）。
- **send_file 真机一发**：审批请求（0310ab95）→ admin 批准 → `File sent via
IPC` → 回执 `No IM route is available for file delivery`——与任务 G1 验收
  记录（task-g-runtime-defects-fix-plan.md:186）的预期语义逐字一致（Web-only
  会话按设计跳过 IM 投递并如实回执 ✓）；模型引用的是 customCwd 下真实
  CLAUDE.md（7.5KB），证明夹具删除零影响、G1 修复不依赖夹具。
- **环境顺带**：server 现以默认 info 级运行（H2 期间的 debug 级已撤）。
- **追删（用户批准「同意删除」后执行）**：上述 5 个计划外残留删前重核 DB
  全部已决定（3a5f94b3/45c65427/8b4e1b41 approved、b8e1a7cd denied、
  0d971d3f approved；pending=0）→ 删除。另发现并追删 `0310ab95`（send_file
  approved @05:53:03Z）——即本次 H3 send_file 验收自产的新残留，同类同程序。
  最终重启验证：启动日志 `Tool approval requested by runner` **0 行**（全日志
  仅 5 行纯启动信息），两个工作区 approvals/pending 目录全空，重放噪音清零。
