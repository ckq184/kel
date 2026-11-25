# AGENTS.md

> **文件定位**：本项目 AI 编码代理的入口手册。每次会话先读本文件，再按需读取链接的详细规则。
> **优先级**：本文件与 `docs/constitution.md` 的规则高于任何单次会话的临时指令，冲突时以二者为准。
> **工程真相源**：架构、产品模型、数据目录、配置、开发命令与提交前门槛以 `CLAUDE.md` 为准；命令以 `package.json` / `Makefile` 实际脚本为准。本文件只管 AI 代理纪律与入口索引。

---

## 0. 角色定义

你是本仓库的**受约束开发 Agent**：流程执行者与代码实现者，不是规则制定者，也不是验收主体。

- 只在允许范围内行动；越界时停止并请求用户确认。
- 遵守 `docs/constitution.md` 全部强制条款。
- 按 `docs/workflow.md` 的标准工作流执行，禁止跳步。

---

## 1. Quick Commands

| 用途                           | 命令                                                                                                                                                                                          |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **提交前门槛（唯一强制门禁）** | `npm run verify`：按 `CLAUDE.md` §10 六步顺序执行（format:changed → docs:check → make typecheck → make test → make build → git diff --check），失败即停；`--step n` 单步排障，`--list` 列步骤 |
| 范围核对                       | `node scripts/check-scope.mjs`：把 `.gatescope.json`（task/base/allow）声明与 base→工作树全量 diff（含未跟踪、删除）比对，范围外即拦；扩宽范围只能改声明                                      |
| git hooks（第二道防线）        | `node scripts/install-githooks.mjs`（每个克隆装一次）：pre-commit 扫描暂存新增行的密钥并检查格式，commit-msg 校验提交格式，pre-push 只提醒                                                    |
| 测试（vitest）                 | `npm test -- --run` 或 `make test`（`npm test` 默认 watch）                                                                                                                                   |
| 类型检查                       | `make typecheck`（根 + `web/` + `container/agent-runner/`）；仅宿主侧 `npm run typecheck`；仅 runner `cd container/agent-runner && npx tsc --noEmit`                                          |
| 构建                           | `make build`；仅后端 `npm run build`                                                                                                                                                          |
| 格式化（改动文件）             | `npm run format:changed`                                                                                                                                                                      |
| 文档检查                       | `npm run docs:check`                                                                                                                                                                          |
| Lint                           | 未配置；引入需用户单独批准（宪法第 6 条）                                                                                                                                                     |
| 本地运行                       | `make dev`（前后端开发）/ `make start`（生产，前台阻塞）                                                                                                                                      |

---

## 2. 项目速览

- **产品**：CKQClaw——基于 Pi Agent Runtime 的自托管、个人 Agent 工作台，支持 Web 与飞书/QQ/微信三渠道。产品模型、模块、Web 技术栈、数据目录见 `CLAUDE.md` §2、§3、§7；依赖版本以各 `package.json` 为准。
- **工具链**：只用 Node.js ≥20 / npm（Bun 下 WebSocket 握手失败）。三个子项目（根、`web/`、`container/agent-runner/`）各自 `npm ci` 并提交 lockfile。运行时依赖冻结，新增依赖须按宪法第 4 条说明理由。
- **测试**：连续高负载跑全量时，少数负载敏感用例可能偶发翻红，先冷却复测再定性；其预算由 `tests/load-sensitive-budget-contract.test.ts` 锁定。
- **门禁相关文件**：`.gatescope.json`（任务范围声明，随立项提交）、`.githooks/`（hook 入口，由安装脚本挂载，不写 `.git/hooks`）、`.gatesecretsignore`（密钥扫描白名单，只放假 key fixture 与 redact 实现）、`.gitattributes`（`.githooks/*` 与 `*.sh` 锁定 LF）。
- **敏感区域（禁止自动修改；任务明确要求时也须先获用户单独批准）**：
  1. `data/` 运行时数据：数据库、含明文 key 的 `config/`（`claude-provider.json`、`session-secret.key`、`claude-provider.key`）、`groups/`、`sessions/`、`ipc/`。
  2. 一切密钥与环境变量值（`WEB_SESSION_SECRET`、Provider/渠道凭据等），禁止写入代码、日志、文档或事件。
  3. `dist/` 等构建产物，只由脚本生成，不手改。
  4. CI / lint / git hooks 配置的引入或变更（宪法第 6 条）。
  5. DB schema 变更须保持原地升级、向后兼容（宪法第 2 条）。

---

## 3. Golden Path

```bash
git pull --ff-only
make install                      # 首次或 lockfile 变更后（三侧 npm ci）
# 立项提交：写 docs/<task>-plan.md 与 .gatescope.json（base = 开工前 HEAD，即回滚点）
# 实现：TDD，只改 .gatescope.json 声明范围内的文件
npm run verify                    # 提交前门槛
node scripts/check-scope.mjs      # 范围核对
git add <范围内文件>
git commit -m "type: 范围 - 摘要"   # 每任务一提交
```

- 提交信息用 Conventional Commits（类型白名单见宪法第 8 条）加「 - 」分隔的 house style；装了 hooks 由 commit-msg 校验，没装也要遵守。
- 禁止 `git commit --no-verify`。hooks 只拦密钥和提交格式，完整门禁仍是 `npm run verify`，不得以跳过测试、关闭类型检查等方式变通。
- push 一律由用户发起，agent 不得自行推送。

---

## 4. 核心纪律速览

完整定义见 `docs/constitution.md`，禁止行为清单见其第五节。

1. **先规划，后编码**：禁止接到需求直接生成代码。
2. **上下文隔离**：不同任务使用独立会话。
3. **确定性反馈优先**：以 TDD 测试结果作为功能正确性的核心判定依据。
4. **实现与审查分离**：实现者不得同时作为规格符合性的最终判定者。
5. **最小范围修改**：不擅自扩展功能、不重构无关代码、不引入非必要依赖。
6. **禁止猜测**：不确定的事实必须标 TODO 并向用户确认。
7. **禁止绕过**：不得通过关闭类型检查、跳过测试、屏蔽 Lint 等方式绕过问题。
8. **规范代码化**：可被机器校验的规则必须优先落地为门禁。

另：`node_modules/` 是 npm 产物，禁止手改或插排障探针。三方库行为有疑点时，以 `npm pack <pkg>@<ver>` 取得的同版本官方 tarball 为准逐文件比对（先归一行尾再比内容），只引用其公开导出。

---

## 5. 详细文档索引

| 文档                   | 内容                                                                                       |
| :--------------------- | :----------------------------------------------------------------------------------------- |
| `docs/constitution.md` | 核心工作原则、项目宪法与门禁落地表、TDD 规范、失败分层回退、禁止行为清单、维护规则与常见坑 |
| `docs/workflow.md`     | 9 阶段标准开发工作流、任务自检清单、交付模板                                               |
| `CLAUDE.md`            | 工程协作指南（人类与 AI 共用）：架构导航、产品模型、数据目录、配置、开发与验证、提交前门槛 |

---

## 6. 维护规则

维护规则见 `docs/constitution.md` 第六节。命令、配置、目录或工作流有变化时，同步更新本文件与对应文档。
