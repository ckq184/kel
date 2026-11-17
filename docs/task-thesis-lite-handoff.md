# 任务 thesis-lite 交接文档

> **交接自**：主仓 `Personnal-agent-main` 评估会话（2026-11-17）。
> **交接到**：本仓库（`/Users/xy/Desktop/workspace/Personnal-agent-thesis`）的裁剪执行会话。
> **你要做的事**：按 `docs/task-thesis-lite-plan.md` 从批次 0 开始执行裁剪，全部七批完成后交付。

---

## 1. 你是谁、在哪、做什么

- 本仓库是主仓 `Personnal-agent-main`（GitHub: ckq184/Personnal-agent）在 `bf0eba1` 的完整副本（含 .git 历史），用途：**本科毕设精简版**。主仓继续作为活项目存在，**两边后续互不同步，本仓独立演化**。
- 你的任务：执行 `docs/task-thesis-lite-plan.md` 定义的七批裁剪。方案由用户逐项裁决产生，**所有裁决已定，不需要也不应该重新发起讨论**（裁决清单见方案 §2）。

## 2. 环境状态（开工前必读）

| 项           | 状态                                                                 | 动作                                                                                  |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| git          | 干净，HEAD = `bf0eba1`，分支 main                                    | `git log --oneline -1` 核对后再动工                                                   |
| node_modules | **不存在**（三侧都没装）                                             | 开工先 `make install`（三侧 npm ci，较慢；verify 的 typecheck/test/build 步都依赖它） |
| git hooks    | 已生效（`.git/config` 的 `core.hooksPath=.githooks` 随复制带过来了） | 无需重装；提交信息须过 commit-msg hook（`type: 范围 - 摘要` house style）             |
| origin 远程  | **存在但禁用**——`.git/config` 里有 GitHub origin 和代理              | **全程不 push、不 pull、不 fetch**                                                    |
| data/        | 不存在（运行时目录未复制，含密钥）                                   | 代码工作不需要它；冒烟测试时运行时自建，LLM key 需用户自行配置                        |
| 行号基准     | 方案中行号 = `bf0eba1` 原始树                                        | 前序批次提交后行号漂移，**以 import/符号名为锚点 grep 定位**                          |

## 3. 执行纪律（宪法摘录 + 本任务附加）

1. **先读 `AGENTS.md`**（会话开始时的仓库入口手册），遵守 `docs/constitution.md` 全部强制条款。
2. 每批流程：删文件 → 清 import/挂载 → 删/修测试 → `make typecheck` → 相关测试子集 → `npm run verify` 全绿 → commit（每批一提交，Conventional Commits）。
3. **`src/db.ts` 一字不动**（保 75 版 schema 迁移链；表留着不用）。
4. stream-event 改动后跑 `make sync-types`。
5. **禁止** `git commit --no-verify`；禁止跳过 verify 变通；禁止 push。
6. 范围核对：批次 0 重置 `.gatescope.json`（task=thesis-lite、base=bf0eba1、allow 全树），每批提交前跑 `node scripts/check-scope.mjs`。
7. 方案中标注"执行时核实"的项（usage.ts 的 billing 依赖面、channel-account-migration 的 dingtalk 分支等）：**先核实再动刀，发现与方案预期不符即停下来向用户报告**，不猜测、不擅自扩范围。

## 4. 首个动作（批次 0）

1. `git log --oneline -1` 确认 HEAD = `bf0eba1`、工作区干净
2. `make install`（装三侧依赖）
3. 读 `scripts/check-scope.mjs` 理解 `.gatescope.json` 语义 → 重置该文件（task=thesis-lite、base=bf0eba1、allow 覆盖全树）
4. commit：`docs: 立项 - 毕设精简裁剪（thesis-lite）`
5. 进入批次 1（评测/RSI），此后按方案顺序推进

## 5. 完成标准（全部七批后）

- `npm run verify` 六步全绿；`make build` 通过；web e2e 通过
- `make dev` 冒烟通过（登录 → 聊天流式 → 浏览器操控 → 用量页 → 监控页 → 渠道页无钉钉 → 桌面端）
- 输出裁剪前后行数对比与批次 commit 清单，向用户交付总结
- 用户验收（实现者不得自做验收结论）

## 6. 关键背景一句话

删的是「研究级/商业化」模块（评测+RSI、mem0 侧车、billing、钉钉），留的是「可演示、可讲清」的核心（容器隔离 Agent、浏览器操控、三渠道、任务调度、能力扩展、记忆库、用量统计、监控、多用户、桌面端）。每批独立可回滚。
