# THESIS-29 index.ts 拆分（二）：IM 斜杠命令

| 字段          | 值                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                       |
| 领取人 / 分支 | —                                                                                            |
| 优先级        | P2                                                                                           |
| 类型          | 结构重构（搬代码，不改行为）                                                                 |
| 依赖          | THESIS-28                                                                                    |
| 阻塞          | 30                                                                                           |
| 可并行        | ✅ 21、24、25、27、32、33。❌ 其余（口径见 [README 第三节](README.md#三并行关系与执行顺序)） |
| 预计改动路径  | `src/index.ts`、`src/im-commands/**`（新建）、`tests/**`                                     |
| 需用户决策    | 否                                                                                           |
| 来源          | 方案 P7、§7.2                                                                                |

## 目标

把 IM 斜杠命令整簇搬出 `src/index.ts`，约 1,100 行。

## 范围（`248c7cb`，THESIS-19 至 28 合入后行号会变，按符号定位）

- `handleCommand`（:2829）及它分发的 17 个 `handle*Command`；
- `/recall`：`handleRecallCommand`（:3556）、`summarizeWithClaude`；
- 对话标题：`generateAndApplyLLMTitle`（:3670）；
- `/spawn`（:3736–3939 一带）。

建议目录：`src/im-commands/index.ts`（分发）、`recall.ts`、`title.ts`、`spawn.ts`，其余命令按只读/变更/主人分组。具体切分由执行者在立项计划里给出。

## 约束（拆分包通用）

- 只搬代码：函数体、日志文案、错误码逐字不变。被搬函数需要的 `index.ts` 内部依赖，经 `src/host-state.ts` 读写器或显式参数传入，不得反向 import `index.ts`。
- 读源码文本的契约测试改读新文件，断言内容不变：本簇相关的有 `tests/im-owner-gate.test.ts`（切片 `handleCommand`）等；`tests/ipc-type-bidirectional-contract.test.ts`、`tests/result-file-prefixes-consistency.test.ts` 若扫描到被搬代码里的字面量，把新文件加入扫描列表。
- `tests/no-duplicate-helpers-contract.test.ts` 钉死的 helper 定义文件不变。
- `CLAUDE.md` §6.4 "命令由 `src/index.ts` 的 `handleCommand()` 分发"一句同步改为新路径。

## 实现步骤

1. 先确认全量测试在改前通过（基线）。
2. 搬代码、调整 import、改契约测试的读取路径。
3. 交付记录给出 `src/index.ts` 改前改后行数。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：在飞书（或任一 IM）里执行 `/status`、`/list`、`/recall`、`/new`；新对话自动生成标题。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
