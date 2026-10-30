# 任务 L：门禁机审化（verify 一键脚本 + git hooks）

> **文档定位**：任务 K 收官（`cf17ecc`/`09567bd`/`61a89fa`，Windows 全量
> 0 失败文件）后的下一阶段立项，自包含可交接。建议注入语：
> **「阅读 docs/task-l-gate-automation-plan.md，按批次 1 开工。」**
> **基线（回滚点）**：本立项提交。**模式**：同 H/I/J/K 链——批次间每批
> 一提交、修复批走六步门禁、测试失败集不许扩大（现行基线 = 0 失败文件
> / 54 平台 skip 用例）。
> **批准状态**：批次 1（纯脚本 + 文档，封装既有手动门禁，不引入
> hooks/CI/lint 配置）**无需新批准**；批次 2（git hooks）属宪法第 6 条
> 配置引入，**开工前必须在新窗口向用户显式申请批准**；批次 3 可选。

## 0. 一句话立项理由

宪法门禁落地表 6 项「待建设」；现行提交前门槛 = CLAUDE.md §10 六步手动
执行，本机无 make 每次都需手工翻译等价链（任务 K 两批实测，六步全跑
约 10+ 分钟且易漏步）。任务 K 已把 Windows 测试基线清零，机审化的
最大障碍（本机测试常年红、verify 无意义）已扫清。本任务把六步门槛
代码化为 `npm run verify`（批次 1），再按用户批准引入 git hooks
（批次 2）。

## 1. 范围与非目标

**范围（按批次）**：

- **批次 1（无需新批准）**：`scripts/verify.mjs` + `package.json`
  `"verify"`——把 CLAUDE.md §10 六步（format:changed → docs:check →
  typecheck（三侧 + sync/prompts 脚本）→ test（全量 vitest）→ build
  （build:all + sentinel）→ git diff --check）封装为一键命令：顺序执行、
  失败即停（fail-fast）、步骤边界与耗时打印、Windows 原生兼容（**不依赖
  make**，等价链已在任务 K 两批实测过三遍）。含契约测试：解析
  CLAUDE.md §10 的步骤清单与 verify 实际步骤清单强一致（§10 变更不同步
  即红——规范代码化）。同步更新：AGENTS.md Quick Commands（verify 行
  从「未建设」改实况）、CLAUDE.md §10（补 verify 入口）、宪法门禁表
  行 7 建成状态、REMAINING-WORK。
- **批次 2（须用户显式批准后开工，宪法第 6 条）**：git hooks——
  `.githooks/` 目录 + 安装脚本（`git config core.hooksPath .githooks`，
  不写 .git/hooks，检出即可用）+ pre-commit（**零依赖** node 脚本：
  secret 模式扫描 + 改动文件 format 检查，秒级）+ commit-msg
  （Conventional Commits 白名单正则 + house style「 - 」分隔检查）。
  同步更新宪法表行 8、AGENTS.md hooks 行；`--no-verify` 禁令从人工
  遵守升级为文档红线。**设计决策留给执行窗口**：pre-push 是否挂全量
  verify（慢，~15 分钟）或只做提示。
- **批次 3（可选，非承诺）**：范围检查脚本原型（`git diff` 文件清单 vs
  任务声明范围的机器可读声明格式）——若声明格式设计不出说服力即放弃。

**非目标**：GitHub Actions CI（仓库无 remote，remote/push 与 Docker Hub
用户已暂缓）；引入 gitleaks/husky/commitlint 等任何外部依赖（**运行时
依赖冻结零新增**，宪法第 4 条——全部用 node 内置能力手写）；改动宪法
条款文本本身（只更新门禁落地表的「建成状态」列）；Windows 宿主脚本
支持（任务 K 裁决②已定否）。

## 2. 环境事实表（新窗口必读）

| 事实           | 内容与出处                                                                                                                                                                                                                                                                                                |
| :------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发机         | Windows + Git Bash；**无 make**——typecheck 等价链 = `./scripts/sync-stream-event.sh` → 根 `npx tsc --noEmit` → `web/` tsc → `container/agent-runner/` tsc → `check-stream-event-sync.sh` → `check-agent-runner-prompts.sh`；build 等价 = `npm run build:all` + `touch .build-sentinel`（任务 K 两批实测） |
| 测试基线       | **0 失败文件**（349 passed + 5 整卷 skipped / 354；3065+54 skipped 用例；54 平台 skip 的合规论证见 `docs/task-k-windows-test-baseline-triage-plan.md` §6）                                                                                                                                                |
| 负载现象       | 连续满载全量会让边缘预算/时序用例**轮换翻红**（单跑均绿；冷却后单轮即过）——**verify 的 test 步结果以冷却机器单轮为准**，翻红清单见任务 K 计划 §8；verify 输出可提示「连续重跑出现新失败时先冷却复测再定性」                                                                                               |
| 耗时预期       | 全量 vitest 160–260s（Docker Desktop 在跑时更慢；container-session-permissions 约 20 次 docker run）；build:all 约 2 分钟；六步全链 10–15 分钟                                                                                                                                                            |
| CRLF           | `core.autocrlf=true` 且无 `.gitattributes`——`git diff --check` 的 autocrlf warning 是噪音（exit 0），**以退出码为准**不要按输出判败（任务 K 实测）                                                                                                                                                        |
| 旧式超时字面量 | 测试里 `}, 30_000)` 这类 test 第三参超时 grep "timeout" 搜不到（任务 K §8 教训，涉及时直接搜数字）                                                                                                                                                                                                        |
| 提交规范       | `type: 范围 - 摘要`，type 白名单 = 宪法第 8 条（feat\|fix\|docs\|chore\|refactor\|test\|perf\|build\|ci\|style\|revert）；每任务/每批次一提交                                                                                                                                                             |
| 门禁真相源     | 步骤与顺序以 `CLAUDE.md` §10 为唯一真相源；verify 脚本是它的代码化投影，两者由契约测试锁同步                                                                                                                                                                                                              |

## 3. 批次 1 实现要点（执行窗口细化，此处只定约束）

1. `scripts/verify.mjs` 用 node 内置 `node:child_process` 串步骤；
   每步 `[n/6] <命令>` 打印 + 耗时；任一步非零退出即停并汇总已过步骤。
2. 步骤清单单一来源：脚本内导出 `VERIFY_STEPS`（名称 + 命令数组），
   `package.json` 的 `"verify": "node scripts/verify.mjs"` 消费；
   契约测试读 `CLAUDE.md` §10 代码块解析六步命令逐一比对 `VERIFY_STEPS`
   （含顺序）。`--step <n>` 可单跑某步（排障用，不改变门禁语义）。
3. Windows 兼容：不 shell 内建 make；`.sh` 脚本经 Git Bash 可直接
   execFileSync（K 实测）；`git diff --check` 只看 exit code。
4. TDD：先写契约测试（红）→ 脚本落地（绿）；另用故意失败注入验证
   fail-fast（例如 `--step` 跑一个必败命令，确认后续步骤不执行）。
5. 文档同步四处 + REMAINING-WORK 立项行更新为批次进度。
6. 验收：本机 `npm run verify` 全绿跑通一轮（冷却态）；六步门禁即
   verify 一条命令；失败注入演示 fail-fast。

## 4. 批次 2 实现要点（须批准后细化）

1. 零依赖：pre-commit 的 secret 扫描用正则集（已知模式：`sk-`、
   `api[_-]?key`、`apiKey:`、`password`、飞书 `xoxb`/`t-` 前缀等，从
   `src/` 现有 redact 实现提取真相源），diff 范围 = staged 文件；
   白名单机制（测试 fixture 的假 key 需可豁免，如 `.gatesecretsignore`）。
2. commit-msg 正则 = 宪法第 8 条白名单 + `: ` 与 `-` 结构；错误信息
   直接给出正确示例。
3. 安装：`node scripts/install-githooks.mjs`（写 core.hooksPath），
   并在 AGENTS.md Golden Path 首次设置段提一行；hooks 缺失不阻塞
   （门槛仍靠 verify），hooks 只是第二道防线——**verify 仍是唯一
   强制门禁**，这样 hooks 被绕过不产生虚假安全感。
4. `--no-verify`：文档红线升级（宪法已预留条款），不做技术对抗。

## 5. 验收（全任务）

- 批次 1 后：`npm run verify` = 六步门禁的完整机审化，本机全绿；
  契约测试锁定 §10 同步；AGENTS/CLAUDE/宪法表/REMAINING-WORK 四处同步。
- 批次 2 后（若批准）：hooks 安装脚本一次生效；坏 commit message 与
  staged secret 被本机实测拦截；正常提交流程不受影响（秒级 pre-commit）。
- 每批六步门禁全过（批次 1 落地后即用 `npm run verify` 本身跑门禁——
  自举验证）；收官更新宪法门禁表建成状态 + REMAINING-WORK + 本文档 §6。

## 6. 执行记录

### 批次 1（2026-10-24，`build:` 提交）

**结果：`npm run verify` 全绿一轮（冷却态单轮，总耗时 5m28s），自举验证
成立——本提交的六步门禁即由 verify 本身跑出。** 分步耗时：format:changed
3.8s / docs:check 2.2s / typecheck 51.5s / test 3m23s（350 passed + 5
skipped / 355 文件，0 失败 = 任务 K 基线 349+5/354 + 本批新增契约测试
文件，零漂移）/ build 1m7s / git diff --check 0.3s。fail-fast 注入演示
通过（失败步 exit 7 透传、后续步骤未执行、汇总列出未执行清单）。

交付构成：

1. **`scripts/verify.mjs`**：`VERIFY_STEPS` 单一来源导出（name +
   docCommand + commands + note/failHint）；docCommand 与 CLAUDE.md §10
   六行逐字一致（含顺序）；命令三形态 `run`（shell 串）/`sh`（经
   resolveBash）/`touchFile`（fs open('a') 等价 touch）；`[n/6]` 步骤边界
   - 逐步/总耗时；失败即停并汇总已过/失败/未执行步骤，退出码透传失败子
     命令；`--step n` 单步排障（明示不构成完整门禁）+ `--list`；
     `VERIFY_STEPS_JSON` 测试接缝（醒目警告 + 形态校验，非法即 exit 2）。
2. **Windows 原生等价链落为代码**（§2 环境事实表的代码化）：
   - npm/npx 经 `shell:true`：node 拒绝无 shell 的 .cmd 直启（实测裸
     `npm` ENOENT、`npm.cmd` EINVAL）；
   - bash 解析序：`MINICLAW_BASH` > PATH `bash`（win32 以 `uname -s`
     MINGW/MSYS/CYGWIN 守卫，排除 System32 的 WSL bash）> 从 `where.exe
git.exe` 命中路径逐级向上找 `bin\bash.exe`（cmd\ 与 mingw64\bin\
      两态 git.exe 均收敛到安装根）；
   - MSYS 运行时自举 `/usr/bin`（探针实测：剥离 PATH 后 find/awk/sed
     仍正确解析），故来源 shell（Git Bash / cmd / PowerShell）不影响
     `.sh` 脚本内工具链。
3. **计划外坑（首轮 verify 实测踩中）**：Git Bash 派生的 node 继承
   Windows 形态 `PWD`（`D:/...`）→ 子 bash `pwd` 输出 Windows 路径 →
   `grep -H` 行前缀的 `D:` 冒号打散 `check-agent-runner-prompts.sh` 中
   sed 的 `file:line:content` 切分 → 0 命中 → 脚本防呆守卫误报「regex
   matched 0 references」。修复落在 verify（sh 子进程剥离
   `PWD/OLDPWD`，bash 按 getcwd 自建 MSYS 形态 PWD，与 Git Bash 终端直跑
   行为一致；POSIX 下 shell 自行重建 PWD 无害）+ 回归测试锁死（注入
   pwd-probe 假步骤断言子 bash PWD 不含盘符冒号）。既有 `.sh` 检查脚本
   未改动，Git Bash 终端用法不受影响。
4. **契约测试 `tests/verify-gate-contract.test.ts`（9 用例）**：§10 ↔
   VERIFY_STEPS 逐字含序锁定（§10 变更不同步即红）/ package.json verify
   接线 / 命令形态恰居其一 / 注入步骤集的 fail-fast、全绿汇总、`--step`
   选择与越界缺参用法错误（exit 2）/ VERIFY_STEPS_JSON 校验 / PWD 回归。
5. **文档同步**：AGENTS.md（引言注、门槛行、verify 行、Golden Path、
   目录结构 scripts 括注、敏感区域④）、CLAUDE.md §10（verify 入口补写，
   六步代码块原样保留为唯一真相源）、宪法门禁落地表行 7 建成状态 +
   建成状态注补 2026-10-24 段、REMAINING-WORK 状态快照、本节。

### 批次 2（2026-10-24，`build:` 提交；用户在批次 1 交接后显式批准「开始批次2」，满足宪法第 6 条）

**结果：实机四项验收全过——安装一次生效（幂等）、坏 commit message
被拦（exit 1 + 正确示例）、staged 假密钥被拦（双模式命中、行号准确、
零内容回显、无提交产生）、正常提交流程 4.5s 秒级。** 本提交经已装
hooks 自举（pre-commit + commit-msg 真实放行）。

交付构成：

1. **`.githooks/` 三 shim**（sh 三行壳，逻辑全在 `scripts/`）：
   pre-commit → `gate-pre-commit.mjs`；commit-msg → `gate-commit-msg.mjs`
   （传 `$1` 消息文件）；pre-push → 仅 echo 提醒不强制（设计决策按
   「verify 仍是唯一强制门禁」定位落地；本仓库无 remote，push 不发生，
   文件头留了未来改强制的单行替换说明）。
2. **`scripts/gate-pre-commit.mjs`**：`git diff --cached -U0` 解析，只扫
   新增行（@@ 头取新侧行号；/dev/null 与删除行跳过；context 行占行号
   以兼容 -U1+ diff）。15 个 secret 模式，真相源 = 仓库现有 redact 实现
   （`container/agent-runner/src/utils.ts` redactInlineSecrets 的厂商前缀
   集 sk-/ghp*/github_pat*/glpat-/xox/AKIA|ASIA/AIza/sk*live*/SG./npm\_/
   PEM 块 + `src/routes/bug-report.ts` 的 Bearer/Basic/JWT/敏感键名赋值
   泛化集 + DSN userinfo）。**命中输出只含 文件:行号 + 模式 id + 模式
   描述，绝不回显命中内容**（涉密日志红线，实测验证）。第二段为格式
   检查（复用 check-format-changed.mjs check 模式）；脚本与仓库不匹配
   时（temp 仓库测试场景）跳过格式段只做 secret 扫描。
3. **误报启发式（两轮全库扫描定型，契约测试锁回归）**：敏感键名赋值
   的值侧豁免——代码元字符 `[]{}()$^*+?|\``（zod schema、模板串、正则
字面量）、URL 形态（由 url-userinfo 单独覆盖）、点路径标识符
（`v3.officialSecrets.x`）、`process.\*` 引用、占位符（`\*\*\*`/`<…>`/
example…）、纯字母或纯数字（`\_\_Host-miniclaw_session`、
`password: string`类型注解）；保留门槛=字母数字混排 + 最小长度
（带引号 ≥8 / 裸值 ≥12）。auth-scheme 长度 8→12（拦真凭据，放过`placeholder="Bearer token..."`）。收敛轨迹：首轮 40+ 文件命中 →
src 生产代码零残留（仅 redact 实现文件自命中，属白名单类）。
`\b` 边界保留（`docs/task-k-…` 路径词不误伤——grep 无边界版会命中，
   实测对照）。
4. **`scripts/gate-commit-msg.mjs`**：首行正则 = 第 8 条白名单 +
   `: ` + 「 - 」分隔，范围/摘要非空；仅校验首行；豁免 git 自动生成
   （Merge/Revert "…"/fixup!/squash!）；错误信息输出首行 + 三条正确
   示例 + 白名单清单。
5. **`scripts/install-githooks.mjs`**：`git config core.hooksPath
.githooks`（不写 .git/hooks，检出即可用）+ `.githooks/*` CRLF→LF
   归一（**计划外坑预案**：本仓库 core.autocrlf=true 且无
   .gitattributes，其他机器检出会把无属性 hook 文件转成 CRLF，sh 执行
   时 `\r` 破坏 shebang 与命令行——安装是每仓库一次动作，顺手归一即
   保证可执行）+ POSIX chmod 755（Windows 忽略）。幂等。
6. **`.gatesecretsignore`**（15 条目）：仅两类——redact 实现文件（模式
   文本自命中：auto_memory_sidecar.py、utils.ts、load-env.ts、
   gate-pre-commit.mjs 自身）与假 key 测试 fixture（11 个）。红线写进
   文件头：真实密钥的正确处置是撤销轮换，不是加白。
7. **契约测试 `tests/githooks-contract.test.ts`（19 用例）**：commit-msg
   规则矩阵（白名单/大写/缺空格/缺分隔/缺范围/缺摘要/豁免/多行/空首行/
   CLI）+ secret 扫描（厂商前缀 13 形态、\b 防误报、Bearer/JWT/DSN/
   键值、两批代码形态误报防线回归、scanAddedLines 行号与零回显键集、
   白名单 glob 语义）+ 安装器（hooksPath 写入、CRLF 归一、幂等、本仓库
   三 shim LF）+ CLI 集成（temp 仓库暂存假密钥被拦）。
8. **文档同步**：AGENTS.md（引言注、hooks 行、目录结构括注+.githooks/
   .gatesecretsignore、敏感区域④、Golden Path 的 commit-msg 机审与
   --no-verify 措辞升级为现行事实）、宪法门禁表行 3、行 8 建成 + 状态
   注批次 2 段、REMAINING-WORK 状态快照、本节。

### 批次 3（2026-10-24，`build:` 提交；用户指示「下一阶段」开工——与批次 1 同类纯脚本+文档，无需新批准）

**放弃条件裁决：建。** 声明格式的说服力锚点 = 本仓库既有流程的立项
提交——scope 声明（`.gatescope.json`：task / base（pin 开工前 HEAD）/
allow 路径 glob）随立项提交落档，由用户批准立项时一并锚定；实现偏离
声明时唯一出路是显式修改声明文件，扩宽行为本身成为可见 diff，供立项
批准者复核。这是审计轨迹型防线而非硬边界（实现者仍可扩宽，但扩宽必
须显式、可审计），与「hooks 是第二道防线」同一哲学——说服力成立，
不触发放弃条件。

**Dogfood：任务 L 全量 diff（`f275e7b`→工作树）19 路径全在声明范围
内（声明为批次 3 补写，触发审计提示——未来任务须随立项提交落档方有
锚定力）；范围外探针文件被拦（exit 1，列出文件 + 处置指引 + 当前
allow 清单）。**

交付构成：

1. **`.gatescope.json`**：任务 L 自身声明（base=`f275e7b`，allow 17 条
   精确到文件——三批全部产物；不用宽 glob，示范格式的精确性）。
2. **`scripts/check-scope.mjs`**：声明解析（缺字段/非法 JSON/空 allow
   exit 2 + 创建指引）→ base 可解析性校验 → 变更路径采集
   （`git diff --name-only --no-renames <base>`（增删两侧都算变更）+
   `git ls-files --others --exclude-standard`（未跟踪）；gitignored
   天然排除）→ 逐路径归类（glob 匹配器 import 自 gate-pre-commit.mjs，
   单一实现；`.gatescope.json` 自身自动允许并置 declarationChanged 审计
   标记）→ 失败输出：范围外清单 + 处置指引（回滚，或改声明并在提交
   信息说明理由）+ 当前 allow 回显。退出码 0/1/2 三档。定位：与 verify
   并列的手动门禁，**不并入六步**（verify 步骤集锁定 CLAUDE.md §10，
   且 check-scope 是每任务有状态的一次性核对，与 verify 的无状态语义
   不同）。
3. **契约测试 `tests/scope-check-contract.test.ts`（11 用例）**：声明
   校验矩阵 / auditScope 归类与审计标记 / 采集（已改+已暂存+未跟踪，
   gitignored 排除）/ temp 仓库 CLI 端到端（拦截→整改→通过；坏 base
   与缺声明 exit 2）/ 本仓库声明存在性与 base 可解析。
4. **文档同步**：AGENTS.md（Quick Commands 范围核对行、Golden Path
   立项段与提交前 `check-scope` 行、目录结构括注）、宪法门禁表行 1.5
   建成（原型）+ 状态注批次 3 段、REMAINING-WORK 状态快照（任务 L
   全部收官）、本节。

**任务 L 全部收官**：宪法门禁表本仓库可行建设项全部落地（行 7
verify / 行 3、8 hooks / 行 1.5 check-scope）；行 1（测试覆盖入 CI）、
行 2（API 契约测试）依赖 CI 基建，仓库无 remote 暂缓。
