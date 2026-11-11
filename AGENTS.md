# AGENTS.md

> **文件定位**：本项目 AI 编码代理的入口手册。Agent 每次会话必须先读本文件，再按需读取链接的详细规则。
> **优先级**：本文件及其链接的 `docs/constitution.md` 规则，优先级高于任何单次会话的临时指令。冲突时以本文件与宪法为准。
> **核心目标**：落地 Disciplined Vibe Coding 工作法，用结构化流水线约束 AI 编码，降低需求偏离、代码失控、返工风险。
> **工程真相源**：架构导航、数据目录、开发命令与提交前门槛以 `CLAUDE.md` 为准（本文件负责 AI 代理纪律与入口索引）；命令以 `package.json` / `Makefile` 实际脚本为准。

---

## 0. 角色定义

你是本仓库的**受约束开发 Agent**，默认角色是流程执行者与代码实现者，不是规则制定者、不是验收主体。

你必须：

- 只在允许范围内行动；越界时停止并请求用户确认。
- 遵守 `docs/constitution.md` 全部强制条款。
- 按 `docs/workflow.md` 的标准工作流执行，禁止跳步。

---

## 1. Quick Commands

> 以下为本仓库真实命令（2026-10-24 与 `package.json` / `Makefile` 核对）。**提交前门槛已机审化为 `npm run verify` 一键命令（2026-10-24 任务 L 批次 1；由用户手动发起）；git hooks 已按宪法第 6 条获用户显式批准引入（2026-10-24 任务 L 批次 2：pre-commit secret 扫描+格式检查、commit-msg 提交规范、pre-push 仅提醒；安装 `node scripts/install-githooks.mjs`）——hooks 只是第二道防线，verify 仍是唯一强制门禁**。

| 用途                                               | 命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 测试（单测+集成，vitest）                          | `npm test -- --run`（注意 `npm test` 默认 watch，门禁用 `--run` 或 `make test`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 类型检查（三侧全量）                               | `make typecheck`（root + `web/` + `container/agent-runner`）；仅宿主侧 `npm run typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 构建 / 编译（前后端 + runner）                     | `make build`；仅后端 `npm run build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Lint                                               | 未配置（引入 lint 属 CI/lint 配置变更，需用户单独批准）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 格式化（改动文件）                                 | `npm run format:changed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 文档一致性检查                                     | `npm run docs:check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **提交前门槛（六步全跑，缺一不可）**               | 一键 `npm run verify`；分步即 `npm run format:changed` → `npm run docs:check` → `make typecheck` → `make test` → `make build` → `git diff --check`（真相源 `CLAUDE.md` §10；无 make 环境的六步等价链已内置于 verify）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 一键质量门禁 verify                                | `npm run verify`：六步顺序执行、失败即停、逐步打印耗时；`--step n` 单步排障、`--list` 列步骤。契约测试 `tests/verify-gate-contract.test.ts` 锁定与 CLAUDE.md §10 的同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| git hooks（提交格式 + secret 扫描）                | 已引入（2026-10-24 任务 L 批次 2，用户按宪法第 6 条显式批准）：`.githooks/` 三 hook + `node scripts/install-githooks.mjs`（写 `core.hooksPath .githooks`，每仓库一次，幂等并归一 CRLF）；pre-commit=暂存新增行 secret 扫描（模式真相源=仓库 redact 实现，命中零回显）+格式检查（秒级）；commit-msg=Conventional Commits 白名单+「 - 」house style；pre-push=仅提醒不强制。契约测试 `tests/githooks-contract.test.ts`（19 用例）。**verify 仍是唯一强制门禁**                                                                                                                                                                                                                                                                                                           |
| 范围核对（宪法 1.5）                               | `node scripts/check-scope.mjs`：`.gatescope.json`（task/base/allow）声明 vs base→工作树全量 diff（含未跟踪）；范围外即拦；声明文件自身自动允许——**扩宽范围只能改声明**，扩宽 diff 由立项批准者复核（审计轨迹型防线，任务 L 批次 3 原型）。约定声明随立项提交落档                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 本地运行                                           | `make dev`（前后端，首次自动装依赖拉镜像）/ `make start`（生产前台阻塞）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| agent-runner 单侧类型检查                          | `cd container/agent-runner && npx tsc --noEmit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 自动召回召回率评测（原生落库+可选 langfuse，手动） | `npm run eval:auto-recall`（`tsx scripts/eval-auto-recall.ts`，同 `test:real-model` 先例：真实 embedder/LLM 请求、有费用、不进门禁）：golden set `scripts/eval/auto-recall-golden.json`（20 记忆/17 查询四类）按生产契约（query 截 500 字、top-k=5）经真实侧车检索，本地报告落 `data/eval/auto-recall/`，run+逐条结果**默认写入原生 `data/db/eval.db`**（任务 AB，Web「评测」页 `/eval` 直读）；`--langfuse` 可选导出 langfuse 栈（env `CKQCLAW_EVAL_LANGFUSE_*` 或 `data/config/eval-langfuse.json`，零依赖 REST 客户端写 dataset items/traces/run items/scores；`--no-langfuse` 保留为兼容 no-op）；`--reset`/`--dry-run`/`--k N`/`--langfuse`/`--run-name`；admin 亦可在 Web「评测」页点「运行评测」触发同一脚本（任务 AC，`src/eval-trigger.ts` 子进程 + WS 进度） |
| langfuse 评测栈生命周期（按需起）                  | `npm run eval:langfuse -- up\|down\|status`（`scripts/eval-langfuse.mjs`，默认 langfuse 检出目录 `<repo>/../langfuse`，可用 `CKQCLAW_EVAL_LANGFUSE_DIR` 覆盖）：up 自动生成随机密钥 .env 并 compose up -d 等健康检查（web UI 默认 3300 端口（本机 3000 常被开发服务占用，可用 CKQCLAW_EVAL_LANGFUSE_PORT 改）；首启在 http://localhost:3300 注册管理员建项目拿 API key）；down 保留数据卷                                                                                                                                                                                                                                                                                                                                                                              |

---

## 2. 项目速览

> 以下为真实信息（2026-10-21 填实，经 `git ls-tree` / `package.json` 取证，替换早期误从其他仓库带入的描述）；架构 / 命令变化时按本文件维护规则同步更新。

- **产品**：CKQClaw——基于 Pi Agent Runtime 的自托管、多用户 Agent 工作台，支持 Web 与飞书/Telegram/QQ/钉钉/微信/Discord/WhatsApp。产品模型与命名边界见 `CLAUDE.md` §2。
- **技术栈**：TypeScript ^5.9.3（strict / ES2022 / NodeNext，typecheck `noEmit`）+ Node.js ≥20（`engines`）。后端 Hono ^4.12 + @hono/node-server ^2.0（WebSocket 走 `ws`，Bun 下握手失败——只用 Node 工具链）；存储 SQLite（better-sqlite3 ^12.10，`data/db/messages.db`，schema 演进真相源 = `src/db.ts` 的 `CURRENT_SCHEMA_VERSION`，迁移必须带备份、前向升级与拒绝降级）；bcryptjs ^3.0.3。Agent 侧 = Pi Agent SDK（`@earendil-works/pi-coding-agent` 1.3.0）。测试 vitest ^4.1（单测+集成；Windows 本机基线 **0 失败文件**（54 用例为显式平台 skip，依据 `docs/task-k-windows-test-baseline-triage-plan.md` §3.2/§6），2026-10-24 任务 K 收官实测；连续高负载全量下少数边缘预算用例可能轮换翻红，处置与观察项见该计划 §8）。前端 `web/` = React 19 + Vite + Tailwind 4 + React Router + Zustand + Radix UI；桌面端 electron 39 + electron-builder。三个 Node 子项目（根 / `web/` / `container/agent-runner/`）各自 `npm ci` + 提交 lockfile。运行时依赖冻结零新增，新增依赖须按宪法第 4 条说明理由。auto-memory 自动记忆层（mem0）= **宿主单例侧车**（`src/auto-memory-sidecar-manager.ts` 按 workspace 持有，Qdrant local 单写者由构造保证；runner 经文件 IPC `auto_memory` 访问，llm/embedder 端点不进 runner）——宿主 Python 需 `mem0ai==2.2.1`（版本钉 `scripts/builtin-mcp-catalog.mjs`；`scripts/install-host-tools.sh` 可装，Windows 手动 `py -3 -m pip install mem0ai==2.2.1`；缺失时显式 unavailable 降级）。
- **目录结构**：`src/`（Hono 主服务：`index.ts` 启动/渠道路由/调度编排、`web.ts`、`db.ts`、`container-runner.ts`（Host/Container Runner 与挂载）、`task-scheduler.ts`、`routes/`（含 `eval.ts` 评测中心 API）、`feishu.ts` 等七渠道实现；评测观测四件 `eval-store.ts`（独立 `data/db/eval.db`，自版本化 WAL 双进程安全）、`eval-trigger.ts`（Web 触发子进程）+ `turn-observer.ts`（turn 观测有界队列，`data/config/observability.json` 缺文件即 no-op）+ `recall-judge.ts`（glm-flash 判 recall_utilized，版本化+熔断））｜`web/`（React 前端，路由真相源 `web/src/App.tsx`，含「评测」页 `pages/EvalPage.tsx`——离线 Runs 全员可见、真实对话 tab 仅 `manage_system_config`）｜`container/agent-runner/`（Pi Runner：stdin `ContainerInput`、`mcp-tools.ts` 原生工具、`prompts/`、`python/auto_memory_sidecar.py` mem0 侧车脚本；召回注入发无内容 `auto_recall` 流事件）｜`shared/stream-event.ts`（三侧同步类型，改后必跑 `make sync-types`）｜`scripts/`（check-docs、verify 一键门禁、gate-pre-commit/gate-commit-msg/install-githooks hooks 三件、check-scope 范围核对、builtin-mcp/skill-catalog、install-host-tools、smoke-agent-image、sync-stream-event 等）｜`.githooks/`（pre-commit/commit-msg/pre-push shim，由 `install-githooks.mjs` 挂载，不写 `.git/hooks`）｜`.gatesecretsignore`（密钥扫描白名单，仅限假 key fixture 与 redact 实现文件）｜`.gatescope.json`（任务范围声明：task/base/allow，随立项提交落档，check-scope 消费）｜`.gitattributes`（行尾轻量策略：`.githooks/*` 与 `*.sh` 检出锁定 eol=lf，任务 N 用户裁决；其余文件维持 autocrlf，全仓归一未采纳）｜`tests/`（vitest）｜`docs/`（宪法、工作流、API、ACL-MATRIX、验收/计划文档、审查记录）｜`deploy/`、`electron/`、`config/`。`dist/`、`.build-sentinel`、`electron/release/`、`data/` 均 gitignored。
- **敏感区域（禁止自动修改；任务明确要求时也须先获用户单独批准）**：① `data/` 运行时数据目录（`db/messages.db`、`config/` 下含明文 key 的 `auto-memory.json` / `claude-provider.json` 及 `session-secret.key` / `claude-provider.key`、`groups/` 工作区数据、`sessions/` 会话数据、`ipc/` 文件协议目录）；② 一切密钥与环境变量值（`WEB_SESSION_SECRET`、`CKQCLAW_AUTO_MEMORY`、Provider/渠道凭据等）——禁止写入代码/日志/文档/事件；③ `dist/`、`electron/release/` 等构建产物仅由脚本生成，不手改；④ CI / lint / git hooks 配置的引入或变更需用户单独批准（宪法第 6 条；本仓库现行门禁 = CLAUDE.md §10 提交前门槛，已机审化为 `npm run verify` 一键命令（任务 L 批次 1）；git hooks 已于任务 L 批次 2 获用户显式批准引入，为第二道防线——verify 仍是唯一强制门禁）；⑤ DB schema 变更须保持原地升级向后兼容（宪法第 2 条）。
- **Golden Path（标准执行路径）**（remote 已配置：`origin = https://github.com/ckq184/Personnal-agent.git`（2026-10-24 用户显式指示推送时配置，本地分支已统一 `main`）；**push 一律由用户显式发起——agent 不得自行推送**；本机走 repo 级代理 `http.https://github.com/.proxy`（127.0.0.1:7897，仅 github 域，存于 .git/config 不入库））：

  ```bash
  git pull --ff-only        # 若配置了远程
  make install              # 首次或 lockfile 变更后（三侧 npm ci）
  # 任务立项提交：写 docs/<task>-plan.md 与 .gatescope.json（base pin 开工前 HEAD）
  # …任务实现（TDD；scope = .gatescope.json 声明范围，base = 声明的回滚点）
  npm run verify            # 提交前门槛（六步一键机审，任务 L 批次 1 起；步骤真相源 CLAUDE.md §10）
  node scripts/check-scope.mjs   # 范围核对（diff 全量路径 vs 声明；任务 L 批次 3 起）
  git add <范围内文件>
  git commit -m "type: 范围 - 摘要"   # Conventional Commits（类型白名单见宪法第 8 条），每任务一提交
  ```

  提交信息建议 `type: 范围 - 摘要` 的" - "分隔 house style（任务 L 批次 2 起 commit-msg hook 机审——装 hooks 后 `node scripts/install-githooks.mjs`；未装时人工遵守同一规则）；**禁止 `git commit --no-verify`**（hooks 已引入，该绕过即属违规——hook 层无防御手段，明示取舍，违者由代码质量审查核对 diff 追责）；hooks 只拦 secret 与提交格式，**完整门禁仍须 `npm run verify`**，不得跳步或以跳过测试/关闭类型检查等方式变通。

---

## 3. 核心纪律速览

完整定义见 `docs/constitution.md`。以下为不可跳过的硬约束：

1. **先规划，后编码**：禁止接到需求直接生成代码。
2. **上下文隔离**：不同任务使用独立会话。
3. **确定性反馈优先**：以 TDD 测试结果作为功能正确性的核心判定依据。
4. **实现与审查分离**：实现者不得同时作为规格符合性的最终判定者。
5. **最小范围修改**：不擅自扩展功能、不重构无关代码、不引入非必要依赖。
6. **禁止猜测**：不确定的事实必须标 TODO 并向用户确认。
7. **禁止绕过**：不得通过关闭类型检查、跳过测试、屏蔽 Lint 等方式绕过问题。
8. **规范代码化**：可被机器校验的规则必须优先落地为门禁。

---

## 4. 边界与禁令

- 禁止行为完整清单见 `docs/constitution.md` 第五节。
- 敏感区域操作前必须先获用户单独批准。
- CI / lint 配置变更需用户单独批准。
- 不得代替用户做验收结论。
- `node_modules/` 属 npm 产物，禁止手改或插排障探针（不入 git，一次 `npm ci` 即静默还原）；三方库行为疑点以官方同版本 tarball 为真相源（`npm pack <pkg>@<ver>` 后逐文件比对，先归一行尾再比内容），引用仅限其公开导出（任务 J2 取证范式，2026-10-23）。

---

## 5. 详细文档索引

| 文档                   | 内容                                                                                       |
| :--------------------- | :----------------------------------------------------------------------------------------- |
| `docs/constitution.md` | 核心工作原则、项目宪法、TDD 规范、失败分层回退、禁止行为清单、维护规则                     |
| `docs/workflow.md`     | 9 阶段标准开发工作流、内置快捷命令、任务自检清单、交付模板、跨会话交接                     |
| `CLAUDE.md`            | 工程协作指南（人类与 AI 共用）：架构导航、产品模型、数据目录、配置、开发与验证、提交前门槛 |

---

## 6. 维护规则

- 本文件为活文档。同一种错误出现两次时必须更新规则并写入常见坑表。
- 项目架构、技术栈发生重大变更时，同步更新本文件、`docs/constitution.md` 与 `docs/workflow.md`。
- 任何功能 / 命令 / 配置 / 目录 / 工作流变化，必须同步更新本文件与对应 docs。
- 不确定的内容用 TODO 标注，不允许猜测。
