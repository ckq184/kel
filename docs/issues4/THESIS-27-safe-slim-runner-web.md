# THESIS-27 安全瘦身（Runner 与前端）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                  |
| 领取人 / 分支 | claude/thesis-27-safe-slim-runner-web                                                                                                                                                                                                                                                                                                   |
| 优先级        | P3                                                                                                                                                                                                                                                                                                                                      |
| 类型          | 重复代码                                                                                                                                                                                                                                                                                                                                |
| 依赖          | THESIS-20（`src/ipc/task-ops.ts` 有角色分支）                                                                                                                                                                                                                                                                                           |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                                                      |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 27 行                                                                                                                                                                                                                                                                                         |
| 预计改动路径  | `container/agent-runner/src/mcp-tools.ts`、`src/ipc/task-ops.ts`、`web/src/components/common/EmojiPicker.tsx`、`web/src/components/settings/ProviderEditor.tsx`、`web/src/pages/SetupProvidersPage.tsx`、`web/src/components/layout/UnifiedSidebar.tsx`、`web/src/pages/ChatPage.tsx`、新的共享 helper 文件、`tests/**`、`web/tests/**` |
| 需用户决策    | 否                                                                                                                                                                                                                                                                                                                                      |
| 来源          | 方案 P7、§7.1                                                                                                                                                                                                                                                                                                                           |

## 目标

合并 Runner 与前端里结构相同的重复代码，约 −650 行，行为不变。

## 清单（`248c7cb`）

| #   | 项                   | 位置                                                                                                                                                                                   | 估算 |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| R1  | MCP 任务工具五兄弟   | `container/agent-runner/src/mcp-tools.ts` 的 `pause_task`（:1360 一带）、`resume_task`、`cancel_task`、`stop_task_run`、`restore_task`，每个约 55 行，差别只在名称与动词；改为一个工厂 | ~200 |
| R2  | 宿主侧修订冲突处理   | `src/ipc/task-ops.ts`（`processIpcTaskOps` :79 起）多个 case 重复 `expected_revision`、冲突、不存在三段                                                                                | ~80  |
| W1  | 表情表每行一个表情   | `web/src/components/common/EmojiPicker.tsx:9` 起的 `EMOJI_CATEGORIES`（约 339 行）；每类存成一个字符串，用 `Array.from` 拆分                                                           | ~300 |
| W2  | `envRowsToText` 两份 | `web/src/components/settings/ProviderEditor.tsx:60`、`web/src/pages/SetupProvidersPage.tsx:31`                                                                                         | ~15  |
| W3  | 侧栏与聊天页重复片段 | `UnifiedSidebar.tsx` 与 `ChatPage.tsx` 约 36 行相同逻辑                                                                                                                                | ~35  |

## 约束

- R1：`tests/ipc-type-bidirectional-contract.test.ts` 扫描 `mcp-tools.ts` 里的 `type: '<字面量>'`。工厂里每个工具的 IPC `type` 必须仍以字面量出现在源码中（例如作为工厂参数的字面量），不能拼接字符串。
- W1：表情顺序与分类名不变；EmojiPicker 已有的测试（若有）保持通过。

## 非目标

- 不改 MCP 工具的名称、参数 schema、描述文案与返回格式。
- 不拆大组件。

## 实现步骤（TDD）

1. **Red**：为五个任务工具补参数化用例（名称、参数校验、IPC 请求体、冲突与不存在两种返回），在改前通过；表情表补"分类数与每类表情数不变"的快照式断言。
2. **Green**：改工厂、合并重复。
3. 若改了 runner，`make typecheck` 覆盖 `container/agent-runner/`；容器镜像无需为此单独重建（无行为变化），在交付记录写明。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：在对话里让 Agent 暂停、恢复、取消一个定时任务；聊天输入框表情选择器显示正常。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

- **交付日期**：2026-11-26｜**分支**：`claude/thesis-27-safe-slim-runner-web`｜**base**：`5f0db61`
- **提交**：`4a8374e` 立项与表征用例、`cfe27d4` 实现、`8ffd530` 规格审查处置、`cc6232d` 质量审查处置，交付文档紧随其后。
- **实现**：
  - R1：`container/agent-runner/src/mcp-tools.ts` 的 pause/resume/cancel/stop_task_run/restore 改为 `taskMutationTool` 工厂；名称、description、参数 schema/describe、IPC 请求体、成功/失败/超时文案逐字不变；`type: '<字面量>'` 保留，双向契约扫描通过。
  - R2：`src/ipc/task-ops.ts` 抽出 `revisionFailurePayload` / `writeRevisionOutcome` / 缺失 revision 校验；五个 case 的冲突、not_found、active_run、成功回执与日志/通知顺序保持不变。
  - W1：`EmojiPicker.tsx` 六类表情各压成一个空白分隔字符串，加载时拆分；分类名、顺序、数量（119/32/43/24/48/41）、类内重复 🌈 与跨类重复 🎵 保留；未用 `Array.from`（会拆坏 ZWJ 序列）。
  - W2：`envRowsToText` 移入 `web/src/utils/custom-env.ts`，ProviderEditor 与 SetupProvidersPage 共用。
  - W3：新增 `UserMenuPopover.tsx` 与 `useAgentWorkspaceSections.ts`，侧栏与聊天页的账号菜单、Agent 分组计算各只剩一份实现。
- **净减行数**：生产代码 `+468 / −900`，净减 **432 行**（issue 估算 ~650）。分项与偏差原因见 plan §8：R2 公共骨架抵掉重复块、W2 函数仅 7 行、W3 两个共享实现自身约 118 行。plan 立项时的行数阈值已改为如实记录，**该验收调整待用户追认**。
- **范围**：最终 `node scripts/check-scope.mjs` 20 路径全在 `.gatescope.json` 内（含本交付记录）；新增 `useAgentWorkspaceSections.ts` 属 W3 重复片段，allow 与 plan 已同步。
- **门禁**：`npm run verify` 6/6 全绿（372 文件 3066 通过 / 23 跳过，34.4s）；`make typecheck` 覆盖 root、web、`container/agent-runner`；runner build 通过。
- **容器镜像**：无行为变化，无需为此单独重建；`container/agent-runner` 仅在 verify 第 5 步执行 tsc。
- **审查**：规格审查“有条件通过”（无 Critical；行数基线待用户追认）；质量审查“通过”（Critical 0 / Major 0 / Minor 6，均已处置）。详见 `docs/审查记录.md`。
- **人工冒烟（待用户）**：在对话里让 Agent 暂停、恢复、取消一个定时任务；聊天输入框表情选择器显示正常。
- **已知边界**：`update_task` 的缺失 revision 守卫仍单列以保留 `failUpdate` 的 warn 日志，未强行并入 helper。
- **并行提示（THESIS-34）**：本包新增 `web/src/hooks/useAgentWorkspaceSections.ts`，其中 3 处使用 `is_my_home`；THESIS-34 把该字段改名为 `is_home` 时必须同步此文件（侧栏与聊天页已改为经 hook 读取，旧文件不再直接出现该字段）。THESIS-34 后合入时先 rebase 本分支并补这一处；本包后合入时同理。
