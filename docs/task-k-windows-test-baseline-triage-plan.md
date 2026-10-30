# 任务 K：Windows 测试基线 triage

> **文档定位**：任务 J 收官（`b3d2035` / `481ff02` / `a7872f6`）后的下一阶段
> 立项。本文档 = 第一步「只读普查」的交付物：全量实测 + 逐文件根因归类 +
> 批次修复处置表，自包含可交接。建议注入语：
> **「阅读 docs/task-k-windows-test-baseline-triage-plan.md，按批次 1 开工。」**
> **基线（回滚点）**：本立项提交。**模式**：同 H/I/J 链——批次间每批一提交、
> 修复批走六步门禁、失败集只许收缩不许扩大。
> **普查方法**：`npm test -- --run` 全量（2026-10-23 16:26 实测，Duration
> 180s），日志剥 ANSI 后逐 FAIL 块读错误详情 + 测试源码比对；两个只读子代理
> 并行承担 7 个文件的源码级定位（结论已交叉核验）。

## 0. 一句话结论

33 个失败文件（354 中）收敛为 **9 类系统级根因**，其中约 **23 个文件可在
批次 1 用机械化纯测试代码修复**（rmSync 重试 helper、路径分隔符、CRLF 归一、
过时 pin、超时预算、配置隔离）；其余为显式平台 skip（带理由）或需用户裁决
的产品语义问题。**基线与文档记录零漂移**（任务 B 曾引 33/354，本次实测同值）。
附带发现一个 P2 安全卫生问题：失败断言 diff 会把本机
`data/config/auto-memory.json` 的真实 apiKey 明文打进测试日志（已修测试前
先删除了涉密日志，详见 §5-1）。

## 1. 实测结果（2026-10-23）

- **Test Files：33 failed | 321 passed（354）**；**Tests：51 failed |
  3067 passed（3118）**；Duration 180s（transform 74.6s，import 771.7s 累计）。
- 结构 = **15 个加载失败 Suite** ∪ **19 个有用例失败的文件** − 1 交集
  （backup-restore-safety 既有 suite 级 afterAll 超时又有 11 个失败用例）= 33。
- 与历史基线比对：2026-10-20 实测 38 文件/70 用例（REMAINING-WORK §1）→
  今日 33/51；任务 B/C/J 期间门禁引用 33/354——**今日结果与现行基线零漂移**，
  38→33 的收窄发生在 10-20 之后至任务 B 门禁之前（部分文件已自然修复），
  非本次漂移。

## 2. 根因归类（9 类）

| 类  | 根因（机制级）                                                                                                                                                                                            | 文件数 | 失败用例数    | 代表证据                                                   |
| :-- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- | :------------ | :--------------------------------------------------------- |
| A   | `afterAll` 里 `fs.rmSync(tmpDir,{recursive,force})` 在 Windows 抛 **EPERM**（better-sqlite3/文件句柄未释放即清理；`force` 只管 ENOENT 不管 EPERM）→ 未捕获异常把整个 suite 记为加载失败                   | 14     | —（suite 级） | `Error: EPERM ... rmSync` ×14，全部指向 `afterAll` 行      |
| B   | POSIX-only 外部工具链：`spawn make ENOENT`（本机无 make）、`tar -czf <winpath> -C <winpath> data` 失败、单用例 20s 超时（文件级 52.5s）                                                                   | 1      | 11            | backup-restore-safety                                      |
| C   | 测试用 posix 路径字面量/`path.join` 构造**期望值**，win32 下产出 `\` 分隔符或盘符前缀，与生产实际输出不符（**错在测试侧**）                                                                               | 4      | 13            | `expected '\nvm\bin\node' to include '/nvm/bin/node'`      |
| D   | 断言 POSIX 文件权限位（`0o600`=384），win32 恒得 438（0o666）                                                                                                                                             | 2      | 4             | `expected 438 to be 384` ×4                                |
| E   | 生产挂载校验器 `validateMount` 无条件拒绝含 `:` 的 hostPath（Linux 挂载语义），win32 绝对路径必含盘符 `:` → legit fixture 全被拒；部分用例还要在 Windows FS 上 `mkdir 'colon:name'`（非法文件名，ENOENT） | 4      | 13            | `Host path must not contain control characters or colons`  |
| F   | 本机 `data/config/` 存在真实配置，污染「默认值」断言                                                                                                                                                      | 1      | 1             | auto-memory-config 期望 `{enabled:false}` 实得本机真实端点 |
| G   | 断言维护债：schema pin 未随 v70/v71 迁移更新（`toBe(69)` vs 实际 71）；Dockerfile ARG 有意改 `=latest`→`=locked`（`165ecd1`）测试未跟；terminology 断言的短语在 git 全历史中从未存在于 README             | 3      | 3             | `expected 71 to be 69`                                     |
| H   | CRLF：仓库无 `.gitattributes`、`core.autocrlf=true`，检出文件为 CRLF，而断言/`prettier.check()`（默认 `endOfLine:'lf'`）按 LF 比较                                                                        | 2      | 2             | received 含 `\r\n`；`prettier.check()` false               |
| I   | 超时预算：Docker 集成用例串行 2 次 `docker run`（Windows Desktop 每次 ~5s）压不过默认 `testTimeout=5000ms`，断言根本没执行到                                                                              | 1      | 2             | `Test timed out in 5000ms` ×2（全文件 106s）               |
| J   | 生产 `script-runner.ts:113` 硬编码 `shell:'/bin/sh'`，win32 下 spawn ENOENT → 进程即刻假结束（exit 1），信号/进程树终止逻辑根本没被走到                                                                   | 2      | 2             | abort/revocation 两用例                                    |

## 3. 逐文件处置表（33 文件）

> 处置代号：**FIX-T**=纯测试代码修复；**FIX-SHARED**=修共享 helper（仍纯测试）；
> **SKIP-W32**=显式 `test.skipIf(process.platform==='win32')` + 理由注释
> （POSIX 生产环境仍执行，不属宪法「跳过测试绕过」——语义在 Windows 上不适用，
> 见 §6 论证）；**裁决**=需用户拍板后落地（§4）。

### 3.1 批次 1 修复清单（机械化，预计 −23 文件）

| 文件                                                                                                                                                                                                                                                                                                                                                                                   | 类  | 失败形态                                       | 处置与修法                                                                                                                                                                                                              |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-- | :--------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent-profile-prompt-migration / agent-profile-runtime / agent-profiles-db / canonical-workspace-mirrors / channel-mounts-db / conversation-agent-archive / db-transactions / foreign-key-orphan-repair / routes-agent-profiles / routes-provider-runtime-apply / routes-system-settings-security / routes-tasks-contract / routes-workspaces / task-scheduler-contract（14 个 suite） | A   | afterAll rmSync EPERM                          | **FIX-SHARED**：新增共享清理 helper（`fs.rmSync(..., { recursive:true, force:true, maxRetries:10, retryDelay:100 })`，Node 官方 retry 选项覆盖 Windows EPERM；helper 同时先关闭已知句柄），逐文件替换 afterAll 清理调用 |
| claude-memory-policy（4）                                                                                                                                                                                                                                                                                                                                                              | C   | posix 期望值                                   | **FIX-T**：期望值改 `path.posix.join` / 字面量（生产契约本就输出 posix 形态，`toClaudePattern` 已做 `\`→`/`）                                                                                                           |
| node-resolver（5）                                                                                                                                                                                                                                                                                                                                                                     | C   | 同上                                           | **FIX-T**：同上（fixture 期望值 posix 化）                                                                                                                                                                              |
| plugin-expander-routing-bugs（3）                                                                                                                                                                                                                                                                                                                                                      | C   | 同上                                           | **FIX-T**：同上                                                                                                                                                                                                         |
| plugin-command-index（1）                                                                                                                                                                                                                                                                                                                                                              | C   | `endsWith('/commands/review.md')` 撞原生分隔符 | **FIX-T**：断言改分隔符无关（`/[\\/]commands[\\/]review\.md$/`）                                                                                                                                                        |
| provider-model-fallback-contract（1）                                                                                                                                                                                                                                                                                                                                                  | H   | 源码 contains 按 LF 比较                       | **FIX-T**：读入后归一 EOL 再 contains                                                                                                                                                                                   |
| reproducible-build-contract ①（1）                                                                                                                                                                                                                                                                                                                                                     | H   | `prettier.check()` LF vs 检出 CRLF             | **FIX-T**：该测试的 prettier 选项显式加 `endOfLine:'auto'`（仓库级 `.gitattributes` 方案见 §5-3，不混入本批）                                                                                                           |
| db-upgrade-safety（1）                                                                                                                                                                                                                                                                                                                                                                 | G   | pin 69 vs 实际 71                              | **FIX-T**：`tests/db-upgrade-safety.test.ts:176` 的 pin 更新为 71（v70 任务 B、v71 任务 A 两次迁移均未更新，锁已锈两版；修复即恢复「schema 头版本变更须评审」语义）                                                     |
| reproducible-build-contract ②（1）                                                                                                                                                                                                                                                                                                                                                     | G   | Dockerfile ARG 断言 `=latest`                  | **FIX-T**：断言改 `=locked`（`165ecd1` 有意变更，git 证据充分，无需裁决）                                                                                                                                               |
| container-session-permissions（2）                                                                                                                                                                                                                                                                                                                                                     | I   | docker run ×2 超 5s 默认 testTimeout           | **FIX-T**：两用例（或集成 describe 整体）显式 `{ timeout: 60_000 }`                                                                                                                                                     |
| auto-memory-config（1）                                                                                                                                                                                                                                                                                                                                                                | F   | 本机配置污染默认值断言                         | **FIX-T**：测试隔离 `DATA_DIR`/相关 env 到 temp（不读本机 data/config）；**同时改断言不回显配置体**（§5-1 秘密卫生）                                                                                                    |

### 3.2 批次 2 清单（显式平台 skip + 裁决项）

| 文件                                                     | 类    | 失败形态                    | 处置                                                                                                                                                                                                                                              |
| :------------------------------------------------------- | :---- | :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| backup-restore-safety（11 用例 + suite 级 hook 超时）    | B(+A) | make/tar 工具链 + 超时      | **SKIP-W32**：fixture 构造绑定 POSIX 工具链（make/tar），备份/恢复的生产执行环境是 Linux 容器；如批次 3 想彻底修，可把 fixture 改用 node 侧 tar 实现（列为可选后续，不承诺）。afterAll 清理可顺带换 A 类 helper（其 hook 超时 = rmSync 对抗 52s） |
| routes-channel-accounts（1）                             | D     | mode bits 384 vs 438        | **SKIP-W32**（仅该 mode 断言；Windows FS 无 POSIX mode 语义，生产跑 Linux）                                                                                                                                                                       |
| routes-mcp-server-secrets（3）                           | D     | 同上                        | **SKIP-W32**（同上）                                                                                                                                                                                                                              |
| mount-security-strict（6）                               | E     | colon 校验器 + mkdir 非法名 | **裁决**（§4-1）：否→SKIP-W32；是→修 `src/mount-security.ts`（盘符前缀白名单，触碰生产安全校验器）                                                                                                                                                |
| container-runner-host-mount（2）                         | E     | 同上                        | 同上跟随 §4-1 裁决                                                                                                                                                                                                                                |
| routes-groups-host-mount（3）                            | E     | 同上 + mkdir 非法名         | 同上跟随 §4-1 裁决                                                                                                                                                                                                                                |
| routes-browse-host-mount（2）                            | E     | selectable 恒 false         | 同上跟随 §4-1 裁决（子代理已证非分隔符问题，是 `validateMount.allowed` 连带）                                                                                                                                                                     |
| script-runner-abort（1） / script-runner-revocation（1） | J     | `/bin/sh` ENOENT            | **裁决**（§4-2）：否→SKIP-W32；是→修 `src/script-runner.ts` shell 选择（已有 win32/taskkill 分支，说明存在部分 Windows 意图）                                                                                                                     |
| frontend-product-terminology（1）                        | G     | 断言短语从未存在于 README   | **裁决**（§4-3）：改断言跟现状（推荐，该词全历史未出现过）或改 README 写入口号                                                                                                                                                                    |

## 4. 需用户裁决清单

1. **Windows 是否是受支持的 additional-mounts 宿主平台？** 涉及 4 文件 13 用例
   （E 类）。否 → 全部 SKIP-W32（挂载是 Linux/容器宿主功能）；是 → 修生产
   `src/mount-security.ts` 的 colon 检查（放行 `/^[A-Za-z]:[\\/]/` 盘符前缀、
   仍拒绝其余冒号，连带审计 `hardDeniedHostPath` 等 POSIX 假设）——这是生产
   安全校验器变更，须按敏感变更对待并补安全向测试。
2. **Windows 宿主是否需要支持运行 host 脚本？** 涉及 2 文件（J 类）。否 →
   SKIP-W32；是 → 修 `src/script-runner.ts`（win32 用 `process.env.comspec`
   或 `shell:true`）并同步改测试命令。
3. **frontend-product-terminology**：`智能体优先工作模型` 是否是要写进 README
   的产品口号？（推荐改断言跟现状措辞——该短语在 git 全历史从未出现在
   README，属断言先天不成立。）

## 5. 附带发现（修复批次外，需知晓）

1. **P2 安全卫生（本普查中实测发生）**：auto-memory-config 断言失败时，
   vitest 的 diff 把本机 `data/config/auto-memory.json` 的**真实 apiKey 明文**
   打进测试日志（本次两份 $TEMP 日志已删除）。批次 1 修该文件时必须同时让
   断言只比较 `enabled` 标志或先脱敏，杜绝秘密进日志；在本机跑全量测试前，
   该 key 建议轮换（由用户决定）。若未来引入 CI，此类泄漏会直接进 CI 日志，
   属必须堵的洞。
2. **全量测试耗时结构**：180s 中 backup-restore-safety 52.5s +
   container-session-permissions 106s（≈20 次 docker run）占 ~88%。批次 1 的
   timeout 修复会让后者更慢（不会更快的用例；如需提速属另一任务）。
3. **`core.autocrlf=true` + 无 `.gitattributes`** 是 H 类与 J2（SDK 行尾）的
   共同土壤。系统性修法 = 仓库加 `.gitattributes`（`* text=auto eol=lf` 或
   按类型声明），属仓库级配置变更、影响所有协作者检出形态，**列为建议项由
   用户决定**，批次 1 先用测试内 `endOfLine:'auto'` 回避，不混入。
   **裁决落档（2026-10-24 任务 N）**：用户选定**轻量方案**——仅
   `.githooks/*` 与 `*.sh` 检出锁定 `eol=lf`；彻底归一（`* text=auto` +
   renormalize + 冻结期）与维持现状被否。`endOfLine:'auto'` 特判保留
   （源码行尾仍随 autocrlf）。
4. **db-upgrade-safety pin 失效本身是流程发现**：v70/v71 两次 schema 迁移
   （均有正式任务与评审）都没人更新 pin，说明「改 pin」未进迁移 checklist——
   建议批次 1 修 pin 的同时在该测试头部注释写明维护义务，并在
   `docs/constitution.md` 或迁移规范处补一句（后者属规则变更，单独小提交）。

## 6. 关于 SKIP 的合规论证（防「绕过」违宪）

宪法第 3-7 条禁止「跳过测试绕过问题」。本计划的 SKIP-W32 均满足：
① 语义在 Windows 上**不适用**而非「失败被掩盖」（POSIX mode 位、`/bin/sh`、
tar 管道、Linux 挂载校验语义都是平台边界，不是被测逻辑缺陷）；② 采用显式
`test.skipIf(process.platform === 'win32', '<理由>')`，理由写入代码注释，
任何平台 flag 变化即刻可见；③ 生产实际运行环境（Linux 容器/宿主）不受影响
——这些断言在 Linux 上照常执行；④ 每一个 SKIP 都落在本表有案可查，不新增
静默 skip。批次 2 的 PR 描述须附本表对应行。

## 7. 验收

- 批次 1 后：全量失败集 **≤ 10 文件**（33 − 23，余量 = 批次 2 项）；
  批次 1 修复的文件必须全绿且不引入新失败（失败集合单调收缩）。
- 批次 2 后：全量失败集 = §4 裁决项落地后的残余（目标 ≤ 2 或 0）。
- 每批六步门禁全过；批次 1 改动的每个测试文件在本机单文件复跑绿。
- 收官时更新：AGENTS.md Quick Commands 基线数字、REMAINING-WORK §1
  （基线段改写为triage 后状态）、本文档 §8 执行记录。

## 8. 执行记录

### 批次 1（2026-10-24，机械化修复，`test:` 提交）

**结果：33 → 10 失败文件（51 → 31 失败用例），恰好收敛到批次 2 残余集合
（B/E/D/J 类 10 文件），无新失败；重负载轮（Duration 259s）复现同值。**
六步门禁全过（format:changed / docs:check / 三侧 typecheck+sync 脚本 /
全量 vitest / build:all / git diff --check；本机无 make，按 CLAUDE.md 等价链执行）。

改动构成（27 个测试文件 + 新增 `tests/helpers/remove-tmp-dir.ts`）：

1. **A 类（14 文件）**：新增共享 helper（先逐个关闭传入句柄，再
   `rmSync {maxRetries:10, retryDelay:100}` 兜底），14 个 suite 的 afterAll
   统一改为 `removeTmpDirRecursive(tmpDir, [db.closeDatabase, ...])`。
   勘察补强两处计划外发现：①这些 suite 从未调用 `closeDatabase()`（泄漏句柄
   才是 EPERM 主因，重试只是兜底）；②foreign-key-orphan-repair 用例内两次
   `initDatabase()` 模拟重启，但生产 `initDatabase()` 不关旧连接——第二次
   init 前补 `closeDatabase()`（这正是「重启」语义，测试侧修复成立）。
2. **C 类（4 文件）**：claude-memory-policy 期望值改 posix 字面量（生产
   `toClaudePattern` 契约本就恒输出 posix）；node-resolver 期望值改
   `path.join`/`path.delimiter` 构造（与生产同构）；plugin-expander-routing-bugs
   的 host cwd 期望改 `path.resolve(...)`（生产即 path.resolve）；plugin-command-index
   的 `endsWith('/commands/review.md')` 改分隔符无关正则
   `/[\\/]commands[\\/]review\.md$/`。
3. **H 类（2 文件）**：provider-model-fallback-contract 读源后统一归一
   CRLF→LF（内嵌换行+缩进的 needle 不再撞 autocrlf 检出）；
   reproducible-build-contract 的 `prettier.check` 显式 `endOfLine:'auto'`
   （仓库级 `.gitattributes` 仍按 §5-3 留给用户裁决）。
4. **G 类（2 处）**：db-upgrade-safety pin 69→71（v70=审批审计表、v71=续跑链，
   注释已按 src/db.ts 实况修正）并写入维护义务注释；Dockerfile ARG 断言
   `=latest`→`=locked`（165ecd1 有意变更，注释同补）。
5. **I 类（计划内 1 + 计划外扩展 6）**：container-session-permissions 集成
   describe 显式 `timeout: 120_000`，并删除 4 处旧式 test 第三参超时字面量
   （`}, 30_000)`——它们覆盖 describe 预算，是首轮修复仍超时 30s 的真因；
   grep "timeout" 搜不到这类字面量，教训入档）。**负载敏感扩展（均为基线外
   或基线内文件的边缘 5s/1s 预算用例，单跑绿、全量重负载轮翻红，非本批
   改动引入，与本机连续 7 轮全量压测的负载波动相关）**：
   channel-turn-runtime（1001 行 SQLite 对账 30s）、task-scheduler-contract
   （60ms 租约→250ms/工作 400ms/检查点 300ms，保持「工作>租约」的心跳
   fence 契约不变；60ms 心跳在负载下饿死会污染下一用例的通知 drain——
   两个失败同一根因）、builtin-skill-bootstrap-contract（7 次串行 node
   子进程 spawn，30s）、mcp-send-message-ack（`vi.waitFor` 默认 1s→10s
   ×2 处）、reproducible-build-contract（prettier 异步 check，30s）、
   schema-v60-channel-reliability（db.js 动态导入+迁移链，30s）。
6. **F 类（1 文件）**：auto-memory-config mock `DATA_DIR` 到 temp（文件
   回退不再读本机真实配置）+ 两处整对象 `toEqual` 改字段级断言
   （`enabled`/`llm`/`embedder`）——失败 diff 不再可能回显含 apiKey 的
   配置体，§5-1 秘密卫生闭环。**key 轮换提醒仍归用户**（普查期涉密日志
   已删，本批后断言层不再有回显路径）。

验证过程：7 轮全量实测（143s/268s/208s/173s/257s/253s/259s，负载波动
极大），失败集从 33 → 13 → 11 → 11 → 12 → 12 → **10**；批次 1 文件
单跑全绿；最终两轮（173s 轻载 / 259s 重载）均为恰好 10 文件 31 用例，
且集合 == §3.2 批次 2 清单（backup-restore-safety、mount-security-strict、
container-runner-host-mount、routes-groups-host-mount、routes-browse-host-mount、
routes-channel-accounts、routes-mcp-server-secrets、script-runner-abort、
script-runner-revocation、frontend-product-terminology）。

批次 2 前置：§4 三项裁决（挂载宿主平台 / Windows host 脚本 / terminology
口号）待用户拍板；SKIP-W32 按 §6 论证执行。

### 批次 2（2026-10-24，显式平台 skip + 裁决落地，任务收官）

**三项裁决（用户 2026-10-24 拍板）**：①挂载宿主平台 = 否 → SKIP-W32；
②Windows 宿主脚本 = 否 → SKIP-W32（`/bin/sh` 硬编码落档为后续任务候选）；
③terminology = 改断言跟现状。

**结果：全量 0 失败文件（349 passed + 5 skipped 文件 / 3065 passed +
54 skipped 用例，Duration 160s 冷却负载轮），任务收官。**

逐文件落地（10 文件 + 1 个顺带修复）：

1. **backup-restore-safety（B 类）**：整卷 `describe.skipIf(win32)`（fixture
   绑 make/tar POSIX 工具链与 symlink/mode 语义，13 用例 skip，文件耗时
   52s→0.9s）；afterAll 顺带换 A 类清理 helper。node 侧 tar 重写 fixture
   列为可选后续不承诺。
2. **routes-channel-accounts（D 类）**：原用例拆两——「key 跨保存稳定」
   （可移植，win32 照跑）+「mode 0600/0700」（`skipIf(win32)`，1 skip）。
3. **routes-mcp-server-secrets（D 类）**：三处 mode 断言内嵌于复杂迁移
   用例，拆分会复制 fixture——改为文件内 `expectSecretsFileMode0600`
   helper（win32 显式 no-op + 注释，迁移/脱敏断言全保留在两平台执行）。
4. **mount-security-strict（E 类，裁决①）**：整卷 skip（校验器即 Linux
   挂载路径语义本体，win32 盘符冒号必被 colon ban 拒）。
5. **container-runner-host-mount（E 类）**：整卷 skip + afterAll 换
   helper（原文已 closeDatabase，仅换 rmSync 兜底）。
6. **routes-groups-host-mount（E 类）**：逐用例 skip ×3——「persists the
   canonical source」（合法挂载过不了校验）与 `test.each` 的
   colon/control-char 两参数（NTFS 禁止该文件名，mkdir 即 ENOENT；用
   `test.skipIf(win32).each`）。其余 18 个 ACL/授权用例 win32 照跑。
7. **routes-browse-host-mount（E 类）**：逐用例 skip ×2（selectable 由
   validateMount 门控，win32 不可达）；admin gate/fail-closed 等照跑。
8. **script-runner-abort / script-runner-revocation（J 类，裁决②）**：
   整卷 skip ×2，注释写明裁决与「`/bin/sh` 硬编码 = 后续任务候选」；
   afterAll 换 helper。
9. **frontend-product-terminology（G 类，裁决③）**：断言
   「智能体优先工作模型」→「自托管、Pi Agent 驱动的多渠道智能体工作台」
   （README 实际口号行），术语契约语义保持。
10. **顺带（负载敏感家族新增 1 处）**：dingtalk-streaming-card
    state-transitions describe 显式 30s（await 刷新链在连续压测轮超 5s
    默认预算一次，单跑绿）。

**连续压测观察（§8 补充，供后续任务参考）**：两批次合计 12+ 轮全量
（143–262s）暴露出一族「边缘预算/时序」用例在连续满载下**轮换翻红**
（每文件通常只翻一次、单跑均绿）：批次 1 已修 7 处，批次 2 又见
dingtalk-streaming-card（已修）、task-runs-v2（租约/通知状态机时序断言，
非预算问题，未修——候选后续）、container-session-permissions 的
「10000-file session <10s」容器内实测性能预算断言（10069ms 惜败，属
真实性能契约，不应放宽——冷却后即过，未改）。**结论：判定基线状态须以
冷却后单轮全量为准**；连续压测轮的翻红不构成基线漂移证据。

收官同步：AGENTS.md §2 基线数字改 0 失败（54 平台 skip）；REMAINING-WORK
状态快照补 K 收官行；六步门禁全过（同批次 1 的 Windows 等价链）。
