# 任务 O：miniclaw → ckqclaw 全仓品牌重命名计划

> 立项：2026-10-30，用户批准执行（四项决策见 §2）。
> 基线：`7f41d5b`（本仓库 git init 后的 zip 快照基线提交）。
> 性质：纯重命名改造，不改任何行为逻辑；验收 = 全量测试 + 三侧类型检查 + 构建全绿。

## 1. 目标

把产品品牌从 Miniclaw 统一改为 CKQClaw：前端显示、后端标识、Runner、
环境变量、MCP 工具命名空间、包名、镜像名、仓库 URL 全部跟随。

## 2. 已确认决策（用户 2026-10-30）

1. 显示品牌 = `CKQClaw`（独立词）；代码标识符词内驼峰 = `Ckqclaw`
   （如 `isCkqclawBootstrapTurn`）；小写 `ckqclaw`（包名/键/镜像/URL）；
   大写 `CKQCLAW`（env 前缀/常量/输出 marker）。
2. Docker 镜像 → `ckq184/ckqclaw-agent`（默认值 + Makefile + workflow + 文档；
   新镜像发布前容器执行模式暂不可用）。
3. GitHub 仓库 URL → `github.com/ckq184/ckqclaw`。
4. 不做 DB 迁移：纯重命名，按全新部署对待。

## 3. 替换规则（大小写敏感，按序）

全仓仅三种变体（`Miniclaw` / `miniclaw` / `MINICLAW`）：

1. `MINICLAW` → `CKQCLAW`
2. `miniclaw` → `ckqclaw`
3. 词内 `Miniclaw`（前后紧邻 `[A-Za-z0-9_$]`）→ `Ckqclaw`（标识符）
4. 独立词 `Miniclaw` → `CKQClaw`（显示文案）

## 4. 范围

- 改：src/、web/、container/、shared/、scripts/、tests/、electron/、.github/、
  .githooks/、deploy/、Makefile、start-desktop.bat、根 package\*.json、
  现行文档（README、CLAUDE、AGENTS、SECURITY、docs/{API,ACL-MATRIX,BUILTIN-MCP,constitution,workflow}.md、
  web/public/icons/README.md、LICENSE）、.gitignore、.gatesecretsignore。
- 文件重命名（11 个）：`src/miniclaw-bootstrap.ts`、
  `container/agent-runner/prompts/{identity,bootstrap}.miniclaw.md`、
  5 个 `tests/miniclaw-*.test.ts`、`electron/assets/miniclaw.{icns,-icon.png}`。
- 不改（历史审计记录，保留原样）：docs/ 下 TASK-_-ACCEPTANCE.md、
  task-_-plan.md、REMAINING-WORK.md、runtime-migration.md、
  workspace-memory-v2.md、miniclaw-migration-cleanup.md、
  claude-code-plugin-automation-design.md、agent-first-architecture-plan.md、
  auto-memory-\*.md、PROMPT-SKILL-RUNTIME-TEST-PLAN.md、审查记录.md；
  二进制文件内容；`personal agent 综述.pdf`。

## 5. 验收

1. `npm run verify` 六步全绿（改名后全量 vitest 通过 = 行为面未破坏）。
2. `node scripts/check-scope.mjs` 通过。
3. 残留审计：`grep -ri miniclaw` 仅 §4「不改」清单允许残留。
4. 关键联动点人工核对：MCP 命名空间 5 处注册/通配/展开、输出 marker 双端、
   容器名前缀 ↔ docker ps filter、cookie、`__ckqclawApprovalHolder__` 单一定义、
   lockfile name 字段与 package.json 同步。

## 6. 非目标

- 不加 DB 迁移、不做旧数据兼容（cookie/localStorage 键改名导致的会话与
  偏好重置属预期破坏）。
- 不推送远程（push 由用户显式发起）。
- 不引入 CI、不改门禁结构。
- 不改历史文档内容。

## 7. 已知影响（如实告知用户）

- 已登录会话失效、前端本地偏好重置；部署侧 env 需 MINICLAW*\* → CKQCLAW*\*。
- 镜像名变更后需 Actions 发布新镜像，期间容器模式不可用。
- 旧数据库字面量（owner-profile 键、sender、默认 Agent 名）与新代码不匹配。
- Electron appId 变更 = 新应用身份；微信 bot_agent / WhatsApp 设备名变更；
  GitHub 链接需实际建立 ckq184/ckqclaw 仓库。
