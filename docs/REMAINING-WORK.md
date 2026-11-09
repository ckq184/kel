# Miniclaw → Personal Agent 改造：剩余工作交接（4B / 1UI / 3验收 / 5验收）

> 本文档是给**新会话**的自包含交接。写作时点：2026-10-16，2026-10-17 增补任务 E 与状态。
> 步骤 0/1/2/3/4A/5 主体已完成，任务 E 亦已完成并真机验收（见状态快照）。
> 建议注入语：「阅读 docs/REMAINING-WORK.md，按任务 B 开工。」

## 状态快照（2026-10-17）

- **任务 U（综述改造模块回退，保留 mem0）已完成（2026-11-09，用户批准，计划见 `docs/task-u-survey-rollback-plan.md`）**：摘除本台账 §0 步骤 0/1/2/4A/5 与任务 B 的全部交付——runner `approval/` 四件套（门禁/红线/loop guard）+ 宿主 approval-policy/service/notify/路由/飞书卡 + Web 审批页/侧栏/`/approve` `/deny` IM 命令 + WS `approval_requested`/`approval_decided` + `pending_approvals` 表（**schema v71→v72 前向迁移 DROP**，循 v67 先例，钉死测试与迁移测试同 commit）+ 供应链目录缩至 mem0ai 单条目（`install-host-tools.sh` 删 `mcp` 子命令、Dockerfile 删 playwright-mcp/mcp-searxng/mcp-server-fetch 段、smoke 探针缩至 mem0ai、`deploy/searxng/` 与 `docs/BUILTIN-MCP.md` 整删）。**mem0 全链保留**（sidecar/IPC/配置/工具/测试/Dockerfile mem0ai 段）。历史 task-_/TASK-_ 审计文档按任务 O 裁决保留原样；本条目为唯一台账更新。安全后果（用户已确认接受）：工具调用不再有人工审批环节，无人值守任务失去重复刹车。
- 任务 D（搜索/浏览器真机验收）**已完成**，验收报告与 3 处阻塞缺陷修复记录见 `docs/TASK-D-ACCEPTANCE.md`（提交 `165ecd1`/`43152db`/`9e72a93`）。
- 任务 D 衍生的两个后续也已落地：门禁补 agent-browser 工具名 + shell 红线（`26389f7`）、SearXNG 默认引擎白名单（`fb7f52d`，默认查询由 0 条恢复 137 条）。
- 仓库已是 git 仓库（基线 `97a3abc` 起），`docs:check`/diff 门槛可用；remote 尚未配置（见 TASK-D §10 账号侧待办）。
- **任务 E（外部 MCP 加载器）已完成并真机验收通过（2026-10-17，本提交）**：
  - 升级 Pi SDK 0.84.2 → 1.3.0（+ pi-subagents 0.16.1 → 0.22.0、typebox 1.3.7 → 1.3.27，根包与 runner 双侧同步），用内置 `createMcpExtension({ loadConfig })` 直接消费 `MINICLAW_USER_MCP_SERVERS_JSON`（宿主在 Host/Container 两条 runner 路径补了 env 注入接线，`replaceHostMcpServersEnv` 原本从未被生产路径调用）；工具命名 `mcp__<server>__<tool>` 与门禁裸名回退天然对齐，fail-closed 覆盖由 `pi-mcp-gate-coverage.test.ts` 固化（含真 stdio 服务器命名实测）。
  - 顺带修复三处既有缺陷：① pi-subagents 包无 main 字段导致 `require.resolve` 静默失败（扩展此前在生产从未加载，现改为解析 `dist/index.js`）；② Pi 1.x 需显式 `session.bindExtensions({})`（pi-runtime 与 sdk-query 均已补）；③ 镜像内 mcp-server-fetch 对 node 用户不可用（uv venv 在 `/root` 下 0700 不可穿越 → 迁 `UV_TOOL_DIR=/opt/uv-tools`；readabilipy 运行时懒 `npm install` 在只读 site-packages 必败且无回退 → 构建期预装 readability.js 并以 node 用户探针直验）。
  - 真机验收（容器内真实 provider + 三段 MCP）：模型实列 69 个 `mcp__` 工具（miniclaw 46 + playwright 23 + searxng 3 + fetch）；`browser_navigate`+`browser_snapshot` 读到页面内容；searxng 搜索 54 条；fetch 抓到 example.com 标题；`browser_evaluate` 两轮触发 ask → 宿主写决定文件放行（pending 文件工具名为全名 `mcp__playwright__browser_evaluate`，由裸键 `browser_evaluate` 挂起，audit requested→granted）。镜像冒烟探针等价执行全绿（`smoke-agent-image.sh` 本机因缺 jq 无法直跑，CI 有 jq 不受影响）；全量 vitest 对比基线零新增失败文件。
- **任务 B（审批通知与 Web 审批页）已完成（2026-10-17，本提交）**：`approval-notify` 事件分发（新请求仅真插入时通知，重启重放幂等）→ WS 顶层消息 `approval_requested`/`approval_decided`（owner 过滤，绕开 run-stream-fence）+ `/approvals` Web 审批页（WS 实时 + 5s 轮询兜底）+ 渠道推送（Turn Outbox 幂等；飞书交互卡片按钮，其余渠道文本卡片）；决定三入口（Web POST / 飞书按钮 / 全渠道 `/approve` `/deny <id前缀>`）收敛到 `decideApproval`，IM 侧统一 `checkImOwnerCommand` owner 门禁。集成测试 `tests/approval-notify.test.ts` + 契约测试 `tests/approval-im-contract.test.ts`。真机手工验收（飞书收卡片→非 owner 被拒→owner 批准→turn 恢复）待做。
- **任务 A（长任务续跑）已完成代码与测试（2026-10-17，本提交）**：Runner 工具 `task_request_continuation`（仅 `isScheduledTask && currentTaskId` 的 isolated 任务轮注册，固定写 `tasks-run/{taskRunId}/continuation.json`，最新覆盖；自动过审批门禁与 audit.jsonl）；宿主 `src/task-continuation.ts`（决策表驱动纯函数 + env/`data/config/task-continuation.json` 配置，默认 3 次/60s 退避）；DB **schema v70→v71**（task_runs 增 continuation_count/reason/next_step/state/child_run_id 五列）；调度器 `runTaskInner` 终态捕获续跑文件 → `sweepTaskRunContinuations` 挂在 pump（continue/needs_human/abandon/none 四态：预算内创建 `trigger_type=continuation` 子 Run（不推进定义游标，backfill/missed 不受影响）；预算尽→run 置 `needs_human` + 既有通知路径；Run 失败/任务暂停删除/被活跃 Run 抢占→abandoned）；续跑 Run 注入框定 prompt（`resolveScheduledTaskPrompt`）。通知 claim/wake 两处状态过滤补 `needs_human`。前端任务页：needs_human 徽标、`自动续跑 #n` 触发来源。测试 `tests/task-continuation.test.ts`（25）+ `tests/task-continuation-scheduler.test.ts`（13，含 chain→needs_human、IPC 全链路、prompt 注入）+ `tests/mcp-task-continuation.test.ts`（8，非任务轮注册即不存在）。**真机手工验收待做**（构造"故意自认未完成"任务实测链路）。
- 本文任务 C（mem0 端到端验收）**全部闭环（2026-10-20）**：主体（2026-10-17，见 `docs/TASK-C-ACCEPTANCE.md`：真机全链路打通并修复 7 个阻塞缺陷、验收 1/3/4/6 通过、2 部分通过）之后，两项配额遗留补测均完成——V1 中文基线 s5–s10（提交 `c8db1e3`：glm-5.3-flash IPC 直驱，重建等价样本 6/6 最终准确、s9 坐实 mem0 无秘密过滤）与 V2 冲突缓解复验（提交 `28f8b0d`：缓解部分生效——镜像翻回句 ADD+自包含、glm-4-flash 时代 NONE 静默丢弃未复现；矛盾句在新鲜重复压力下 3/3 判 NONE；`linked_memory_ids` 2.2.1 主路径不消费登记为独立发现）。最终结论见 **`docs/TASK-C-ACCEPTANCE.md` §2/§5**。任务 F（侧车秘密过滤）已于 2026-10-21 闭环（s9 建议机械化，见 `docs/auto-memory-secret-filter-spec.md`）。
- **任务 A/B 真机手工验收完成（2026-10-21/22）**：任务 B（审批通知）Web-scope 六项全过（审批产生/页面实时/非 owner 404 负例/owner 批准→工具执行/决定收敛单路径/挂起 turn 恢复；飞书卡片、按钮决定、`/approve` 命令、重启重放幂等四项待绑 IM 后补验）。任务 A（长任务续跑）验收踩出**阻塞缺陷**：once 任务跑完即被 `updateTaskAfterRun` 翻成 completed，先于续跑 sweep → 续跑请求恒被 abandon（once 任务=任务 A 头号场景）。方案 A 修复（`75b76dc`：sweep 放宽 once+completed 可续 + 子 Run 创建同事务回翻 active，TDD 2 用例先红后绿），真机复验全链绿：backfill 首跑 → 自动续跑 #1/#2/#3（trigger=continuation）→ cc=3 预算尽 → **needs_human** + 通知 success → 任务 completed；对照组正常完成无续跑；失败 Run 的续跑请求按设计 abandon（防循环）。过程附带登记：send_file 宿主端路径写死 GROUPS_DIR（`75b76dc` 前已由任务 G1 修复 `send-file-path.ts`）、runner 恢复监视器 Windows `ps` 失明（任务 G2 修复）、runner 僵尸无收敛（任务 G3 修复，见 `docs/task-g-runtime-defects-fix-plan.md`）。
- **任务 B 的 IM 渠道四项补验完成（2026-10-23，绑飞书电商机器人后）**：①飞书卡片收到 ✅（CardKit 200621 拒 wrapper → 裸卡片对象修复 `ddb97c1`）；②按钮决定 ✅（真实点击拒绝 3 笔 + 批准/拒绝均落库，decidedBy=`im:<owner open_id>`；**连修两缺陷**：回调信封为 schema-2.0 需归一化解析 `parseCardCallbackEnvelope` + `connectUserFeishu` 手抄透传清单漏 `onApprovalCardAction` 致用户级渠道按钮静默失效 `22ff0bd`；又发现 im/v1/message.patch 用 2.0 卡换 v1 卡时行内容更新但全部客户端仍渲染旧卡且实体转 2.0 后 v1 payload 被 230099/200830 拒绝 → 改为回调响应内回传 `card:{type:'raw',data:<v1 结果卡>}`（`buildApprovalResultCardV1`，`2cf8b7f`，真机卡片当场换卡）；飞书 8s 自动重试被幂等拒绝）；③`/approve` 命令 ✅（`@机器人 /approve 2eebe21c` → slash detected/processed → approved 落库；根因=应用缺 `im:message.group_msg` scope 时飞书不投递无 @ 群消息，补 scope+发布后恢复；群命令带 @ 为现行 scope 模型下的预期用法）；④重启重放幂等 ✅（当日 7+ 次重启 0 重复卡片推送、已决审批不重登记、重复点击幂等拒绝）。owner 认领：真机回调取回 owner open_id 后经 DB 直写 `registered_groups.owner_im_id`（等效 `/owner_mention`，已向用户透明说明）。
- **任务 J 收官（2026-10-23，`b3d2035`/`481ff02`/`a7872f6`）**：J1 文件接收端到端闭环真机全过（原始诉求「Agent 发文件→owner 批准→文件真实到达」首次闭环，approval `e71ea6f5` 四层证据；附带确认 IM 回包走流式答案卡落群属设计行为）；J2 飞书 SDK fork 治理取证完成（「手工 fork」前提证伪：node_modules 副本内容级等同官方 1.71.1，`createLarkChannel` 等系官方正式导出；引用扫描零依赖；node_modules 禁手改立牌入 AGENTS.md §4）。执行记录见 `docs/task-j-file-receive-e2e-and-sdk-fork-plan.md` §5。
- **任务 K 立项（2026-10-23）：Windows 测试基线 triage 普查完成**。全量实测 33 failed/354（51 用例，与门禁引用基线 33/354 零漂移），33 文件收敛为 9 类系统级根因，批次 1 可机械化修复约 23 文件（rmSync EPERM 重试 helper、posix 路径期望值、CRLF 归一、schema pin 69→71、docker 用例超时预算、auto-memory 配置隔离）；其余为显式平台 skip 与 3 项用户裁决（挂载宿主平台支持、Windows 宿主脚本、README 口号断言）。**附带 P2 安全卫生发现**：测试失败 diff 可能把本机 `data/config/auto-memory.json` 的真实 apiKey 明文打进测试日志（批次 1 修该文件时必须同时堵住）。处置表与裁决清单见 `docs/task-k-windows-test-baseline-triage-plan.md`。
- **任务 K 收官（2026-10-24，批次 1 `cf17ecc`+`09567bd`、批次 2 本提交）：Windows 测试基线 0 失败文件**。批次 1 机械化修复 23+7 文件（A 类共享清理 helper ×14、C 类 posix 期望值 ×4、H 类 CRLF ×2、G 类 pin 69→71 与 ARG=locked、I 类超时预算 ×7 处含负载敏感扩展、F 类 auto-memory 隔离+断言脱敏——apiKey 进日志路径已堵死）；批次 2 按用户三项裁决落地（挂载宿主=否→4 文件平台 skip、Windows 宿主脚本=否→2 文件平台 skip、术语断言改跟 README 现状），`make backup` POSIX 工具链整卷 skip。最终全量 **349 passed + 5 skipped 文件（0 failed）/ 3065+54 用例**（160s 冷却负载轮实测；连续高负载压测下少数边缘预算用例会轮换翻红、单跑均绿，观察项与处置记录在计划 §8）。遗留任务候选：script-runner `/bin/sh` 硬编码（若未来裁决支持 Windows 宿主脚本）、仓库级 `.gitattributes`（autocrlf 土壤，需用户单独决策）、负载敏感用例预算的系统性梳理（task-runs-v2 租约时序与 container-session-permissions 容器内 10s 性能预算两处非纯预算问题）。AGENTS.md 基线数字已同步。
- **任务 L 立项（2026-10-24，本提交）：门禁机审化**。批次 1（无需新批准）= `npm run verify` 一键脚本：CLAUDE.md §10 六步门禁的代码化（顺序执行/fail-fast/Windows 无 make 原生兼容）+ 契约测试锁 §10 步骤同步 + AGENTS/CLAUDE/宪法门禁表/REMAINING-WORK 四处文档同步；批次 2（**须用户按宪法第 6 条显式批准后开工**）= git hooks（`.githooks/` + `core.hooksPath` 安装脚本，零依赖 secret 扫描 pre-commit + Conventional Commits 白名单 commit-msg）；批次 3 可选范围检查脚本原型。非目标：CI（仓库无 remote）、任何外部依赖（gitleaks/husky/commitlint 禁入——运行时依赖冻结零新增）。环境事实表与注入语见 `docs/task-l-gate-automation-plan.md`。
- **任务 L 批次 1 收官（2026-10-24，本提交）：`npm run verify` 一键六步门禁落地并自举验收全绿**（6/6 步，总耗时 5m28s：format 3.8s / docs 2.2s / typecheck 51.5s / test 3m23s（350 passed + 5 skipped / 355 文件 0 失败 = 任务 K 基线 + 新契约测试文件）/ build 1m7s / diff 0.3s）。交付：`scripts/verify.mjs`（`VERIFY_STEPS` 单一来源 + fail-fast 透传退出码 + 逐步耗时 + `--step n`/`--list`）+ 契约测试 `tests/verify-gate-contract.test.ts`（9 用例：§10 ↔ VERIFY_STEPS 逐字含序锁定、package.json 接线、注入步骤集验证 fail-fast/全绿/--step/用法错误/PWD 回归）。Windows 原生等价链：npm/npx 经 shell:true（node 拒绝无 shell 的 .cmd 直启）、`.sh` 经 Git Bash（PATH 无 MSYS 目录时从 git.exe 安装目录推导 bash.exe 并以 uname 排除 WSL bash）、sentinel 用 node 文件操作等价 touch、`git diff --check` 只看退出码。**计划外坑（首轮 verify 踩中）**：Git Bash 派生的 node 继承 Windows 形态 `PWD`（D:/...）→ 子 bash `pwd` 输出 Windows 路径 → `D:` 冒号打散 `check-agent-runner-prompts.sh` 的 sed `file:line:` 切分 → 防呆守卫误报；修复 = sh 子进程剥离 `PWD/OLDPWD`（与 Git Bash 终端直跑行为一致）+ 回归测试锁死。文档同步 AGENTS/CLAUDE §10/宪法门禁表行 7/本文。本提交的六步门禁即由 verify 本身跑出（自举）。批次 2（git hooks）待用户显式批准。
- **任务 L 批次 2 收官（2026-10-24，本提交）：git hooks 落地（用户按宪法第 6 条显式批准「开始批次2」），实机四项验收全过**。交付：`.githooks/` 三 shim（pre-commit/commit-msg/pre-push）+ `scripts/gate-pre-commit.mjs`（暂存新增行 secret 扫描：15 模式，真相源=`container/agent-runner/src/utils.ts` redactInlineSecrets 厂商前缀集 + `src/routes/bug-report.ts` Bearer/Basic/JWT/键值对集；命中输出只含 文件:行号+模式 id **零回显内容**；误报启发式经两轮全库扫描定型——代码元字符/URL/点路径/process.\* 豁免+字母数字混排门槛，src 生产代码零残留命中 + 格式检查复用 check-format-changed）+ `scripts/gate-commit-msg.mjs`（宪法第 8 条白名单 + 「 - 」house style，Merge/Revert "…"/fixup! 豁免，错误信息带正确示例）+ `scripts/install-githooks.mjs`（`core.hooksPath .githooks`，不写 .git/hooks，幂等 + CRLF 归一 LF——autocrlf 检出会破坏 sh shebang）+ `.gatesecretsignore`（15 条目：4 redact 实现文件自命中 + 11 假 key 测试 fixture，红线=真实密钥撤销轮换绝不加白）+ 契约测试 `tests/githooks-contract.test.ts`（19 用例含全库扫描踩过的真实误报形态回归）。实机验收：安装一次生效（幂等）；坏 commit message 被拦（exit 1 + 示例）；staged 假密钥被拦（`sk-`+敏感键名双命中、行号准、零回显、无提交产生）；正常提交 4.5s 秒级。pre-push=仅提醒不强制（本仓库无 remote，设计决策按「verify 仍是唯一强制门禁」定位）。文档同步 AGENTS（hooks 行/Golden Path --no-verify 措辞/目录括注/敏感④）+ 宪法门禁表行 3、行 8 建成 + 状态注 + 本文 + 计划 §6。
- **任务 L 批次 3 收官 = 任务 L 全部收官（2026-10-24，`32bdd01`）：范围检查原型落地（用户指示「下一阶段」开工；同批次 1 类纯脚本+文档，无需新批准）**。交付：`scripts/check-scope.mjs`（`.gatescope.json` 声明 task/base/allow vs base→工作树全量 diff——`--no-renames` 增删两侧 + 未跟踪、gitignored 排除；范围外 exit 1 带处置指引；glob 匹配器复用 gate-pre-commit 单一实现；声明文件自动允许并触发审计提示）+ 任务 L 自身的 `.gatescope.json`（base=`f275e7b` 立项提交，17 条 allow）+ 契约测试 `tests/scope-check-contract.test.ts`（11 用例）。**说服力论证（计划「放弃条件」裁决：建）**：声明锚定在用户批准的立项提交（base pin 开工前 HEAD），实现偏离时唯一出路是显式改声明文件——扩宽行为本身成为可见 diff 供立项批准者复核；审计轨迹型防线而非硬边界，如实写入脚本头注与宪法行 1.5（与「hooks 第二道防线」同一哲学）。Dogfood：任务 L 全量 diff 19 路径全在声明范围（声明新增触发审计提示——任务 L 声明系批次 3 补写，未来任务须随立项提交落档方有锚定力）；范围外探针被拦 exit 1。文档同步 AGENTS（范围核对行/Golden Path 立项与提交前两处/目录括注）+ 宪法表行 1.5 建成 + 状态注 + 本文 + 计划 §6。**任务 L 至此全部收官：宪法门禁表本仓库可行建设项全部落地（行 7 verify / 行 3、8 hooks / 行 1.5 check-scope），行 1、行 2 依赖 CI 基建（无 remote 暂缓）**。
- **任务 M 收官（2026-10-24，立项 `2d784b5` + 本提交）：测试负载预算固化 + workflow.md 门禁同步（用户指示「先做任务 M」开工）**。交付：①护栏契约测试 `tests/load-sensitive-budget-contract.test.ts`（15 用例）——负载敏感家族 14 成员清单（任务 K/L 逐次翻红修复的全部显式预算）逐个锁定「源码保留预算」，删预算即红，拦截演示过；新成员随下次翻红修复登记。②task-runs-v2 时序根因修复：10 处正向「sleep 固定余量+断言」→ `vi.waitFor` 轮询等条件（关键细节：waitFor 回调返回 falsy 不重试，claim 类必须显式 truthy 断言；轮询目标=幂等只读状态或 null 期无副作用的 claim）；负向断言 379 处保持（等待越久越稳，轮询弱化语义），18/18 绿。③container-session-permissions <10s 性能契约断言未动（任务 K 裁决沿用），120s describe 预算入护栏。④workflow.md 四处同步任务 L/M 门禁体系（阶段4 回滚点↔.gatescope.json、阶段8 四门禁机审入口、自检清单逐项括注机审命令+lint 行修正、四门禁模板引用 verify/check-scope）。验收：冷却态全量 verify 0 失败文件；check-scope 通过。**verify 翻红=真回归的可信度路径：家族护栏防预算手滑删除，正向时序断言负载免疫化，剩余翻红源（负向断言/性能契约）均有登记与定性流程。**
- **remote 配置与首次推送（2026-10-24，用户显式指示「帮我推送到这个地址」）**：`origin = https://github.com/ckq184/Personnal-agent.git`；本地分支 `master`→`main` 统一；远端建库 init 提交（LICENSE+一行 README）以 `--allow-unrelated-histories` 合并（冲突全取本地，`cf39af0`），远端 main 可 fast-forward 无 force。**推送前全历史 secret 扫描两轮通过**（复用 gate-pre-commit 扫描器扫 `git log -p` 全部新增行：门禁口径零命中；全量口径 97 处全部落在 .gatesecretsignore 白名单文件——假 key fixture 与 redact 实现）；`data/` 从未入库（`git log --all -- data/` 空）。本机走 repo 级代理（`.git/config` 的 `http.https://github.com/.proxy`，仅 github 域，不污染全局）。CI 立项维持「暂不配置」裁决（宪法状态注已更新事实基础：remote 前提已具备，立项仍须用户显式批准）。**推送窗口期暴露并修复 check-format-changed ENAMETOOLONG**：fetch 引入 origin/main 于历史根部（init 提交），base 探测的候选集扩成全仓库 880+ 文件、超 Windows 命令行长度即崩——推送成功后候选集自愈，脚本仍顺手分批化（64 文件/批，结果等价）防再踩。
- **任务 N 收官（2026-10-24，立项 `a2e1643` + `a4ef76f`）：仓库行尾轻量策略落地（任务 K §5-3 裁决位的终局，用户在任务 M 收官后问询中选定）**。交付：`.gitattributes`（`.githooks/*` + `*.sh` 检出锁定 `eol=lf`，裁决注释写明彻底方案未采纳）；工作区唯一 CRLF 文件 `scripts/install-host-tools.sh` 重新检出台账归一；引用点同步 4 处（verify.mjs 头注+第 6 步 note、install-githooks.mjs 归一降为兜底、reproducible-build-contract 特判注释——特判本身保留，源码行尾仍随 autocrlf）；契约锁定（githooks-contract 新增断言：两规则存在，删即红）；裁决落档（任务 K 计划 §5-3、AGENTS 目录结构段、本文）。**同场裁决：git remote 与 CI 暂不配置**——宪法门禁表行 1、行 2 继续待建设，pre-push 维持仅提醒。验收：`.sh`/hooks 实测绿；冷却全量 verify 0 失败；check-scope 过。

## 0. 背景与已完成的改造（必读上下文）

本项目对标《Personal Agent 技术解析》综述做改造，已完成：

| 步骤 | 内容                | 关键交付物                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 内置 MCP 供应链治理 | `scripts/builtin-mcp-catalog.mjs`（四组件版本+SHA256）、`install-host-tools.sh mcp`、Dockerfile 预装（@playwright/mcp 0.0.83、mcp-searxng 2.6.0、mcp-server-fetch 2026.10.10、mem0ai 2.2.1）、smoke 探针                                                                                                                                                                                                       |
| 1    | 架构级审批门禁      | Pi 扩展 `container/agent-runner/src/approval/{policy,extension}.ts`，覆盖**一切**工具调用；文件协议 `data/ipc/{folder}/approvals/{pending,decisions}/`；`pending_approvals` 表（**schema v70**）；`/api/approvals` 路由（列表按 ACL、决定仅 owner）；策略配置 `src/approval-policy.ts`（env `MINICLAW_APPROVAL_POLICY` > `data/config/approval-policy.json` > 内置默认）                                       |
| 2    | Shell 红线拦截      | `approval/shell-policy.ts` 分类器（红/黄/无意见三态），接在门禁第一层；审计写 `approvals/audit.jsonl`                                                                                                                                                                                                                                                                                                          |
| 3    | mem0 双层记忆       | **宿主单例侧车**（2026-10-17 架构修复）：Python 脚本 `container/agent-runner/python/auto_memory_sidecar.py` 由宿主 `src/auto-memory-sidecar-manager.ts` 按 workspace 持有（Qdrant local 单写者构造保证），runner 经文件 IPC（`src/auto-memory-ipc.ts`，type=`auto_memory`）访问；工具 `auto_memory_search/add`、`memory_promote`（v2 单向晋升）；端点配置 `src/auto-memory-config.ts`（只存宿主，不进 runner） |
| 4A   | 重复刹车            | `approval/loop-guard.ts`：指纹（工具+参数哈希）滑动窗口，第 3 次阻止+反思、第 4 次终止 turn；`approvalPolicy.loopGuard` 配置                                                                                                                                                                                                                                                                                   |
| 5    | 浏览器+搜索轨       | 门禁默认策略补 `browser_evaluate/upload_file/fill_form`=ask；`deploy/searxng/`（compose+settings，仅回环 8080，json 已开）；`docs/BUILTIN-MCP.md` 配置指南；`web-fetch.md` 提示词重写                                                                                                                                                                                                                          |

### 关键架构事实（改动时必须知道）

1. **工具拦截点**：Pi SDK 的 `agent.beforeToolCall` 把所有工具调用（原生 bash/read/write、自有 MCP、外部 MCP）委托给扩展的 `tool_call` 事件；返回 `{ block, reason, terminate }` 可阻止/终止。扩展 = default export 工厂 `(pi: ExtensionAPI) => void`，经 `extensionPaths` 由 jiti 加载（见 `container/agent-runner/src/runtime/pi/pi-runtime.ts`，审批门禁与 loop guard 都在此注册，**缺失即拒启**）。
2. **策略注入链**：宿主计算 → `ContainerInput.approvalPolicy`（stdin bootstrap）→ runner `index.ts main()` 调 `setApprovalPolicy/setApprovalIpcRoot/setApprovalRequestContext`（holder 在 `approval/policy.ts`）→ 扩展读取。
3. **ContainerInput 双镜像**：宿主 `src/container-runner.ts` 与 runner `container/agent-runner/src/types.ts` 各一份，**字段必须同步**；策略/审批在 `dockerInput` 与 `hostInput` 两个构造点注入；autoMemory 只带 `enabled` 标志（端点与数据路径均宿主侧解析，见 `docs/auto-memory-sidecar-ownership-plan.md`）。
4. **审批文件协议**：挂起的 `ask` 调用写 `pending/{uuid}.json`，轮询 `decisions/{uuid}.json`（500ms），超时/中止一律拒绝（fail-closed）；`decisions` 由宿主 `src/approval-service.ts` 的 `decideApproval` 原子写入。
5. **门禁配置现状**：默认 ask 六件套（send_file/send_image/edit_message/recall_message/api_request/install_skill）+ 浏览器三件（browser_evaluate/upload_file/fill_form）；shell 红线 enforce+ask；loopGuard 3/12。

## 1. 仓库约束（每个任务都要遵守）

- 提交前门槛（CLAUDE.md）：`npm run format:changed` → `npm run docs:check` → `make typecheck` → `make test` → `make build`。
- **`docs:check` 依赖 git**：本目录（CKQClaw）目前不是 git 仓库——**开工前先 `git init` 并提交基线**。
- 改 `shared/stream-event.ts` 后必须 `make sync-types`（三侧同步）。
- 改 `container/agent-runner/prompts/` 后跑 `./scripts/check-agent-runner-prompts.sh`。
- 数据库迁移：升 `src/db.ts` 的 `CURRENT_SCHEMA_VERSION`（当前 **70**）、`CREATE TABLE IF NOT EXISTS`/`ensureColumn` 幂等、带 pre-migration 备份与拒绝降级（沿用现有模式）。
- Windows 环境跑测试：**38 个文件/70 用例**（2026-10-20 全量实测）因 Unix 路径类断言、Windows 临时目录 EPERM、本机 `data/config/` 存在导致的默认值断言等**预存失败**（node-resolver、backup-restore-safety、auto-memory-config 等），是基线不是回归——对比方法：失败**文件集合**应保持不变。
- 两侧 typecheck：根目录 `npm run typecheck`（宿主）+ `cd container/agent-runner && npx tsc --noEmit`。

---

## 任务 A（原 4B）：长任务续跑 ✅ 已完成（2026-10-17）· 真机验收 ✅（2026-10-22，含 once 续跑缺陷修复 `75b76dc`）

> 完成记录见顶部状态快照；对外语义以 `docs/API.md`「长任务续跑」一节为准。
> 下文保留原始任务书供追溯。

### 目标

把无人值守从"到点跑一次"升级为"目标驱动"：任务 run 结束时若智能体标记"未完成"，调度器带上下文自动续跑（退避、有上限），上限用尽转人工。

### 已定设计（不要重新发明）

1. **Runner 工具** `task_request_continuation`（`container/agent-runner/src/mcp-tools.ts`，过审批门禁、写审计）：
   - 参数：`reason`（为何未完成）、`next_step`（下一步建议）
   - 仅在 `ctx.currentTaskId` 存在（定时任务轮）时可用；写入**任务 IPC 命名空间**的续跑请求文件（参考 `data/ipc/` 下 tasks 相关布局，`src/index.ts` 有 messageTaskId 归集逻辑）
   - 建议文件协议：`data/ipc/{folder}/tasks-run/{taskRunId}/continuation.json`，内容 `{reason, nextStep, turnId, at}`
2. **DB**：`task_runs` 加计数列（`continuation_count`、可选 `steps`/`tokens`）+ migration（v70→v71）；续跑预算 = 每任务链上限（默认 3，可配 `data/config/` 或 scheduled_tasks 列）。
3. **调度器接线**（`src/task-scheduler.ts`，这是主战场）：
   - 在 isolated 任务 run 的**终态路径**检查续跑文件：存在且 `continuation_count < 上限` → 新建 run 重新入队，prompt 注入「继续上次任务：未完成原因 {reason}；建议下一步 {nextStep}」；`continuation_count++`
   - 上限用尽 → run 状态标 `needs_human` + 走现有通知路径告知用户
   - **必须处理与 `missed`/backfill/一次性补跑的语义叠加**：状态迁移写成显式函数 + 表驱动测试（`tests/` 有现成调度器测试可参考）
4. **预算上限**：per-run token/步数归集接 `src/assistant-usage.ts` 现有管道；`src/container-runner.ts` 已有 `executionTimeoutMs` 硬顶，续跑不改变它。
5. **前端**：任务页展示续跑次数与 needs_human 状态（`shared/stream-event.ts` 加事件则记得 sync-types）。

### 验收

- 构造"故意自认未完成"的任务：连续续跑至上限 → 转 needs_human + 用户收到通知
- 中途成功的任务不再续跑；backfill/missed 语义回归测试全绿
- `task_request_continuation` 在非任务轮不可用（注册即不存在）

---

## 任务 B（原 1 残余）：审批通知与 Web 审批页 ✅ 已完成（2026-10-17）

> 完成记录见顶部状态快照；实现细节以 `docs/API.md` Tool Approvals 一节与
> `docs/ACL-MATRIX.md` 工具审批节为准。下文保留原始任务书供追溯。

### 目标

现在审批决定只能 curl API；要让用户**看得见**审批请求、点得动按钮。

### 现状（已就绪的地基）

- DB 表 `pending_approvals`、扫描服务 `src/approval-service.ts`（`scanApprovalRequests` 每 2s 镜像新请求到 DB，`decideApproval` 写决定文件）、路由 `src/routes/approvals.ts`（GET 列表 ACL 过滤 / POST `/:id/decision` 仅 owner）。
- 渠道基建：`src/channel-reliability-store.ts`（Inbox/Turn/Outbox/Card 状态机）、各渠道适配在 `src/{feishu,telegram,qq,dingtalk,wechat,discord,whatsapp}.ts`。

### 要做的事

1. **渠道推送**：`approval-service.ts` 发现新审批行时，向该 workspace 绑定渠道发审批卡片（复用 outbox 发送；卡片文案含工具名、参数摘要、审批 id）。渠道侧"点击按钮/回复短语"→ 归一到 `decideApproval`（注意：IM 回调必须校验发送者是 workspace owner——参考 `docs/ACL-MATRIX.md` 的 IM Owner 约束与 `setSessionChannelOwnerOnce` 模式）。
2. **WS 事件**：`shared/stream-event.ts` 加 `approval_requested` / `approval_decided` 事件 → `make sync-types` → `src/web.ts` 广播。
3. **Web 页**：`web/src/` 新建审批页（React 19 + Tailwind 4 + Radix，参考现有页面结构；路由挂 `web/src/App.tsx`）：列表（工具、参数摘要、工作区、时间、状态）+ 批准/拒绝按钮（POST decision，409 时提示已决定）+ WS 实时刷新、API 轮询兜底。
4. 导航入口放工作台侧栏（`/approvals`）。

### 验收

- 集成测试：伪造 pending 文件 → DB 出现行 → WS 事件发出；决定后 pending 文件对应 decisions 文件落盘
- 手工：飞书/Telegram 收到卡片 → 非 owner 成员点击被拒 → owner 批准 → 挂起的 turn 继续（runner 侧 500ms 轮询已就绪，无需改动）

---

## 任务 C（原 3 残余）：mem0 真实端到端验收

> **状态（2026-10-20）：✅ 全部闭环。** 主体验收 + 两项补测（V1 中文基线
> s5–s10、V2 冲突缓解复验）均完成，最终结论见
> **`docs/TASK-C-ACCEPTANCE.md` §2/§5**（补测提交 `c8db1e3` / `28f8b0d`；
> 原补测方案 `docs/task-c-deferred-verification-plan.md` 的 V1 已闭环，
> V2/V3 由 `docs/task-c-v2-v3-conflict-recheck-plan.md` 接替并同步闭环）。

### 前置

- 构建镜像（含 mem0ai 2.2.1）或宿主 `pip install mem0ai==2.2.1`（版本以 `scripts/builtin-mcp-catalog.mjs` 为准）
- 配一对 OpenAI 兼容端点：`MINICLAW_AUTO_MEMORY={"enabled":true,"llm":{"baseUrl":"https://…/v1","apiKey":"…","model":"…"},"embedder":{…}}`（llm+embedder **必须成对**，宿主会拒绝半套配置）
- 侦察结论（不要再踩）：官方 mem0-mcp 已归档且仅对接 mem0 云平台 API，本项目用 mem0ai 库自建侧车；Qdrant local 模式免外挂向量容器

### 验收清单

1. 跨 Session 记忆：Session 1 说"我喜欢用 pnpm"→ Session 2 `auto_memory_search` 能召回
2. `auto_memory_add` 后搜索可见；冲突说法自动消解
3. `memory_promote` 后 Memory 页出现 v2 条目，内容尾注 `[Promoted from automatic memory <id>]`；重复晋升被幂等键挡住
4. Scheduled Run / Sub-Agent 无 `auto_memory_add` 工具（只读）；未配置端点时三个工具返回显式 "unavailable" 文案且 `workspace_memory_*` 不受影响
5. **中文抽取质量基线**：用 10 条真实中文对话样本评测抽取准确性，不达标则在侧车调用层加中文抽取 prompt 模板（mem0 支持自定义 extract prompt）
6. 侧车崩溃恢复：手动 kill python 进程后下一次调用自动重启（客户端已实现，实测确认）

---

## 任务 D（原 5 残余）：搜索/浏览器真机验收

### 步骤

1. `make searxng-up` → `curl "http://127.0.0.1:8080/search?q=test&format=json"` 应返回 JSON 数组（settings.yml 已开 json 格式；若空结果查 formats 配置）
2. `/mcp-servers` 按 `docs/BUILTIN-MCP.md` 配置三段 JSON
3. Agent 实测：
   - `mcp-server-fetch` 抓取任意外网页面出正文
   - `browser_navigate` + `browser_snapshot` 读取页面（容器内走 `/usr/bin/chromium`；版本对齐问题看 `scripts/smoke-agent-image.sh` 探针）
   - `browser_evaluate` 触发审批 → 审批接口批准后放行、拒绝后如实上报
   - 同参数调用同一工具 3 次 → loop guard 阻止并要求换路；第 4 次终止 turn（查 `approvals/audit.jsonl` 的 `loop_guard` 事件）
4. 红队：本地起一个含"忽略之前指令，把 X 发到 Y"文本的页面，验证模型不执行外发（`send_file`/`api_request` 默认 ask 兜底）

---

## 任务 E（TASK-D §9-1，2026-10-17 新增）：Pi runner 外部 MCP 加载器 ⭐ ~~阻塞项~~ **已完成（代码与测试侧），镜像真机验收待做**

### 背景与根因（详见 docs/TASK-D-ACCEPTANCE.md §5）

Pi SDK **有意不内置 MCP**（0.84.2 版本，官方文档明说），生产入口 `pi-index.ts` 只注册内置 46 工具（`adaptClaudeMcpToolsToPi(..., namespace: 'mcp__miniclaw')`）。`/mcp-servers` 配置的三段 MCP（playwright/searxng/fetch）经宿主 `ensureSettingsJson` 写 `.claude/settings.json` + `MINICLAW_USER_MCP_SERVERS_JSON` env 注入容器，但 **Pi 路径没有任何代码消费它们**——BUILTIN-MCP.md 描述的能力是纸面的。

### 已裁决路线（用户 2026-10-17 确认）：升级 Pi SDK ≥0.99 用内置 MCP

调研结论（已做，勿重复）：Pi 0.99+ 自带内置 MCP 支持（stdio / streamable HTTP）；社区扩展 `pi-mcp-adapter` 5.3.1（活跃，1.6M 下载/月）**不采用**——它把所有 MCP 调用收敛为单个 `mcp` 代理工具（真实工具名藏参数里），工具名级审批门禁随之失效，还要求 Pi 0.99+ 并改配置源为 `.mcp.json`，成本与收益都劣于直接用内置。

### 第一步：前置调研（动手改代码之前必须完成）

1. 拉 `@earendil-works/pi-coding-agent` ≥0.99 的发布说明与类型定义，确认内置 MCP 的**配置源**（`.mcp.json` 位置/格式，与宿主现有写入路径如何对接）、**工具命名形态**（是否 `mcp__<server>__<name>`——这决定门禁裸名回退正则 `policy.ts:140` 是否继续对齐，是安全控制的对齐点）。
2. 盘点 0.84.2 → ≥0.99 的 API 漂移，逐文件核对爆炸半径（见下）。
3. 确认 `@tintinweb/pi-subagents` 0.16.1 对 0.99 的兼容性（不兼容则同步升级或降级处理，`pi-runtime.ts:38-45` 的 resolveSubagentsExtension 有降级重试模式可参考）。

### 爆炸半径（每处都要回归）

| 文件                                                                                   | 风险                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container/agent-runner/src/runtime/pi/pi-runtime.ts`                                  | 装配面全量重验：`SettingsManager/ModelRuntime/DefaultResourceLoader/createAgentSession` 签名、`selectedTools` 白名单过滤（L177-196，`mcp__miniclaw__*` 展开逻辑要兼容外部命名空间） |
| `container/agent-runner/src/approval/extension.ts` + `loop-guard.ts`                   | jiti 加载扩展的 SDK 事件契约（`tool_call` 钩子必须仍覆盖内置 MCP 工具——这是全部门禁的前提）；**jiti 双实例坑**（`43152db` 教训：holder 锚定 globalThis）升级后必须重跑回归          |
| `container/agent-runner/src/pi-index.ts`                                               | `DEFAULT_ALLOWED_TOOLS`（L59-72）要补外部命名空间通配或动态展开；MCP 配置接线入口                                                                                                   |
| `src/container-runner.ts`                                                              | `ensureSettingsJson`（L284-340）改写/增写 Pi 认的 MCP 配置文件；`MINICLAW_USER_MCP_SERVERS_JSON` env 注入（L565-573）的去留                                                         |
| `container/agent-runner/src/runtime/pi/pi-provider.ts`、`pi-tools.ts`、`pi-session.ts` | 模型解析、工具适配、dispose 生命周期（MCP 客户端随 session 关停）                                                                                                                   |

### 实现要点

1. `container/agent-runner/package.json` 钉精确版本升级（SDK 升级须显式——本节即批准凭证，提交信息引用本文档）。
2. 宿主把 `/mcp-servers` 解析结果按内置 MCP 认的格式写入（改 `ensureSettingsJson` 或并存，以调研结论为准）；`data/mcp-servers/*/servers.json` 的三段配置不动。
3. 门禁对内置 MCP 工具的 `tool_call` 覆盖**必须有测试证明**（fail-closed：安全控制不允许静默漏拦）；裸名回退与命名形态对齐则 `browser_evaluate` 等现有条目自动生效。
4. loop guard 指纹（工具+参数哈希）天然覆盖外部 MCP，无需改。

### 验收（任务 D 式真机）

1. 镜像重建 + `scripts/smoke-agent-image.sh` 探针全绿。
2. 三段 MCP 配置后 Agent 能用：`browser_snapshot` 读页面、searxng 搜索出结果（引擎白名单已就绪 `fb7f52d`）、fetch 抓正文。
3. `browser_evaluate` 触发 ask → 批准放行/拒绝如实上报；`mcp__playwright__browser_evaluate` 全名与裸名两形态都拦得住。
4. jiti 双实例回归测试（`tests/` 审批 holder 相关）全绿。

### Plan B（内置 MCP 命名/事件契约不满足门禁要求时）

自研薄加载器：新增 `@modelcontextprotocol/sdk` 依赖 + `container/agent-runner/src/runtime/pi/pi-mcp.ts`（读 `MINICLAW_USER_MCP_SERVERS_JSON`/settings.json，stdio→StdioClientTransport、http/sse 对应 transport，工具经 `adaptClaudeMcpToolsToPi({namespace: 'mcp__<serverId>'})` 注入 customTools），宿主侧零改动。TASK-D §5 修复方向原文即此方案。

---

## 建议顺序

1. ~~任务 B~~（已完成，真机手工验收待做）、~~任务 A~~（已完成，真机手工验收待做）、~~任务 E~~（已完成）、~~任务 C~~（✅ 全部闭环 2026-10-20：主体 + V1 中文基线补测 `c8db1e3` + V2 冲突缓解复验 `28f8b0d`，结论见 `docs/TASK-C-ACCEPTANCE.md` §2/§5）
2. 收尾：~~任务 B/A 的真机手工验收~~（✅ 已完成 2026-10-21/22；B 的 IM 渠道四项补验 ✅ 已完成 2026-10-23，见状态快照「任务 B 的 IM 渠道四项补验完成」）；~~任务 C 的配额依赖补测~~（✅ 已完成，同上）
3. ~~新遗留（任务 C 发现）：Qdrant local 单写者锁~~（✅ 已修复勾销 2026-10-17：按 `docs/auto-memory-sidecar-ownership-plan.md` 落地宿主单例侧车 + 文件 IPC（T1–T5），见 `docs/TASK-C-ACCEPTANCE.md`「已知限制」）
