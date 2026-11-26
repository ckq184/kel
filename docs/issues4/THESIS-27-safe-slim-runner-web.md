# THESIS-27 安全瘦身（Runner 与前端）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                  |
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

（待填）
