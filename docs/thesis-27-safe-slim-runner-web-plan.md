# 任务立项：THESIS-27 安全瘦身（Runner 与前端）

> 立项日期：2026-11-26｜base：`5f0db61`（main tip，纪律文档合并后）｜分支：`claude/thesis-27-safe-slim-runner-web`
> 来源：[docs/issues4/THESIS-27-safe-slim-runner-web.md](issues4/THESIS-27-safe-slim-runner-web.md)、[personal-slim 方案 P7](issues4/task-personal-slim-plan.md)
> 执行方式：完整档；与 THESIS-22、THESIS-34 并行（27 对 22 ✅、对 34 ⚠️，合入冲突时后合入方 rebase）。

## 0. 需求采访结论

- **目标**：合并 Runner 与前端里结构相同的重复代码（issue 清单 R1、R2、W1、W2、W3），约 −650 行，行为不变。
- **完成条件**：五项重复代码各只剩一份实现；Runner 五个任务工具的名称、参数 schema、描述文案、IPC 请求体、成功/失败/超时返回逐字不变；表情分类名、顺序与每类数量不变；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：方案 §3 八条裁剪原则与四条硬约束；不改 MCP 工具对外契约；不拆大组件；不新增依赖；不改表结构、迁移链与 `CURRENT_SCHEMA_VERSION`；不读写 `data/`。
- **需用户决策**：无（issue 已标"否"）。

## 1. 执行前核实（base `5f0db61`）

| 项     | 复核结论                                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1     | `container/agent-runner/src/mcp-tools.ts:1356-1842` 五个工具：`pause_task`/`resume_task`/`cancel_task` 共享 `task_id + expected_revision` 请求；`stop_task_run` 为 `run_id`；`restore_task` 为 `task_id + expected_revision` 但字段无 describe。每个工具的成功、失败、超时文案各不相同。           |
| R1     | `tests/mcp-task-v2-contract.test.ts` 已覆盖 pause 成功与 resume 失败；cancel/stop/restore 的请求体、失败与超时无参数化覆盖。`tests/ipc-type-bidirectional-contract.test.ts` 用 `/type: '([a-z_]+)'/` 扫 `mcp-tools.ts` 源码，工厂配置中的 `type: '<字面量>'` 可满足。                              |
| R2     | `src/ipc/task-ops.ts` 的 pause（:300）、resume（:362）、cancel（:474）、update（:562）、restore（:845）各自重复"expected_revision 校验 → TASK_REVISION_CONFLICT → not_found/not authorized"三段；文案除 restore 的冲突提示少一句 "Call list_tasks and retry." 外一致。无专门单测。                 |
| W1     | `web/src/components/common/EmojiPicker.tsx:9-347` 六类表情逐行一个；实测数量：动物 119、表情 32、自然 43、食物 24、物品 48、符号 41。自然类含重复 🌈、符号类含重复 🎵，压缩时必须保留重复与顺序。无既有测试。                                                                                      |
| W1     | issue 建议 `Array.from` 拆分整串；`Array.from` 按码点切分会把 `🐻‍❄️`、`🐕‍🦺`、`🐈‍⬛` 等 ZWJ 序列拆坏。改用空白分隔 + `split(/\s+/)` 保留每个表情为一个元素，属"行为不变"约束下的必要偏差。                                                                                                               |
| W2     | `web/src/components/settings/ProviderEditor.tsx:60` 与 `web/src/pages/SetupProvidersPage.tsx:31` 的 `envRowsToText` 函数体逐字相同；共享校验在 `web/src/utils/custom-env.ts`，适合同文件收敛。                                                                                                     |
| W3     | `UnifiedSidebar.tsx:287-320` 与 `ChatPage.tsx:271-307` 的用户头像 Popover 块约 36 行逐字相同，差异只有 `side="right"`/`"bottom"` 与 `aria-label`。`tests/frontend-agent-identity.test.ts:89-95` 按源码文本断言两处都有 `imageUrl={user?.avatar_url}`，抽组件后需把断言改读共享组件并断言两处调用。 |
| 测试面 | 交集测试：`frontend-sidebar-refresh-contract`、`frontend-agent-capabilities-entry`、`frontend-chat-group-item-props`、`frontend-settings-information-architecture`、`issue11-compat-and-duplicate-convergence`、`ipc-type-bidirectional-contract`、`result-file-prefixes-consistency`。            |

与 issue "预计改动路径"的差异：新增 `web/src/utils/custom-env.ts`（W2 共享 helper）、`web/src/components/common/UserMenuPopover.tsx`（W3 共享组件）与对应测试文件；未动 `web/tests/**`。

## 2. 方案（TDD）

本任务是行为不变的重构，Red 阶段以"表征测试先通过"为准：新增用例在 base 上即通过，重构后必须继续通过；不制造人为失败断言。

### 2.1 Red（表征用例，base 上通过）

1. `tests/mcp-task-v2-contract.test.ts` 增加参数化用例，覆盖五个工具：
   - 工具名存在；zod schema 接受合法参数、拒绝缺失/非正整数 revision；
   - IPC 请求体的 `type`、`taskId`/`runId`、`expectedRevision`、`groupFolder`/`isMain`（仅 task 三兄弟）与 `timestamp`；
   - host 返回 `success:false` 时（分别模拟修订冲突文案与 "Task not found."）返回 `isError` 且文本含 host error；
   - 成功文案与超时文案按工具逐字断言。
2. 新增 `tests/emoji-picker-contract.test.tsx`（happy-dom）：渲染 `EmojiPicker`，断言六个分类标签、每类网格按钮数量（119/32/43/24/48/41）与每类首尾表情，锁定顺序与重复项。
3. 新增 `tests/ipc-task-ops-revision.test.ts`：mock `src/db.js` 等依赖，驱动 `processIpcTaskOps` 的 pause/resume/cancel/update/restore，断言 expected_revision 缺失、修订冲突、not_found 三类回执的 `writeTaskResult` 负载（含 restore 冲突文案的差异）。
4. `tests/issue11-compat-and-duplicate-convergence.test.ts` 增加 `envRowsToText` 用例：空占位行序列化为空行、KEY=value 保留、仅空 key 或仅空 value 仍序列化（行为与现实现一致）。
5. `tests/frontend-agent-identity.test.ts` 的用户头像断言改为：`UserMenuPopover.tsx` 含 `imageUrl={user?.avatar_url}`，且侧栏与聊天页都渲染 `UserMenuPopover`；该断言在 base 上失败（组件尚不存在），属结构 Red。

### 2.2 Green

1. **R1**：在 `createMcpTools` 内新增任务工具工厂，五个工具改为配置化调用。配置对象保留 `type: '<字面量>'` 供 IPC 契约扫描；`inputSchema`、`description`、成功/失败/超时文案原样搬运。
2. **R2**：在 `processIpcTaskOps` 内新增 `revisionFailurePayload(mutation, options)` 与 expected_revision 校验 helper；五个 case 复用之，回执字段与文案逐字保留，日志与 `failUpdate` 的 warn 行为不变。
3. **W1**：`EMOJI_CATEGORIES` 每类改为一个空白分隔字符串，模块加载时 `split(/\s+/)` 展开；分类名、顺序、重复项不变。
4. **W2**：`envRowsToText` 移入 `web/src/utils/custom-env.ts`（结构化入参），两处调用点改为 import。
5. **W3**：新增 `web/src/components/common/UserMenuPopover.tsx`（props：`side`、`ariaLabel`），侧栏与聊天页改为渲染它；删除两处内联块与不再使用的 `EmojiAvatar`/图标/Popover import。

### 2.3 Refactor / 门禁

- 行数对比：`git diff --numstat` 汇总生产代码净减行数（目标约 −650，issue 估算）。
- `npm run format:changed`、`npm run docs:check`、`make typecheck`、`make test`、`make build`、`git diff --check`（即 `npm run verify` 六步）。
- `node scripts/check-scope.mjs`。
- `make typecheck` 覆盖 Runner（TS 项目引用）；容器镜像无需重建（无行为变化），在交付记录写明。

## 3. 任务拆解

| #   | 任务       | 主要文件                                                                                        | 独立验收                                        |
| --- | ---------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| T1  | 立项与 Red | plan、`.gatescope.json`、issue/README 状态、新增/扩充测试                                       | 表征用例在 base 全绿；W3 结构用例按预期红       |
| T2  | R1/R2      | `container/agent-runner/src/mcp-tools.ts`、`src/ipc/task-ops.ts`                                | 参数化与修订冲突用例通过；IPC 类型契约通过      |
| T3  | W1         | `web/src/components/common/EmojiPicker.tsx`、`tests/emoji-picker-contract.test.tsx`             | 分类数/顺序/数量不变                            |
| T4  | W2/W3      | `web/src/utils/custom-env.ts`、Provider 两页、`UserMenuPopover.tsx`、侧栏与聊天页、相关契约测试 | envRowsToText 唯一实现；用户菜单两处行为一致    |
| T5  | 门禁与交付 | 全范围                                                                                          | verify 六步全绿；check-scope 通过；三处状态同步 |

回滚点：base `5f0db61`；每个提交可单独 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-27-safe-slim-runner-web-plan.md`、`docs/issues4/THESIS-27-safe-slim-runner-web.md`、`docs/issues4/README.md`、`docs/审查记录.md`、`container/agent-runner/src/mcp-tools.ts`、`src/ipc/task-ops.ts`、`web/src/components/common/EmojiPicker.tsx`、`web/src/components/common/UserMenuPopover.tsx`、`web/src/components/settings/ProviderEditor.tsx`、`web/src/pages/SetupProvidersPage.tsx`、`web/src/utils/custom-env.ts`、`web/src/components/layout/UnifiedSidebar.tsx`、`web/src/pages/ChatPage.tsx`、`tests/mcp-task-v2-contract.test.ts`、`tests/emoji-picker-contract.test.tsx`、`tests/ipc-task-ops-revision.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts`、`tests/frontend-agent-identity.test.ts`。

与 issue "预计改动路径"的差异：增列经核实需要同步的共享 helper/组件与测试；未列 `web/tests/**`（经核实无相关用例）。

## 5. 验收条件

1. 五项重复代码各只剩一份实现；R1 五个工具对外契约逐字不变；W1 表情分类名/顺序/每类数量不变。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 新增表征/契约用例在 base 上通过（W3 结构用例除外，按计划先红后绿），重构后全部通过。
4. 生产代码净减行数不低于约 550 行（issue 估算 ~650）。
5. **人工冒烟（用户）**：在对话里让 Agent 暂停、恢复、取消一个定时任务；聊天输入框表情选择器显示正常。

## 6. 非目标

- 不改 MCP 工具名称、参数 schema、描述文案与返回格式。
- 不拆大组件；不合并主/子会话流水线；不做 `src/index.ts`/`src/db.ts` 拆分（归 THESIS-28 至 33）。
- 不动 `data/`、数据库 schema、迁移链、`CURRENT_SCHEMA_VERSION`。
- 不清理与本任务无关的死代码或文档漂移。
- 不推送、不合并 main。

## 7. 风险与回滚

- R1 的参数 schema 与文案搬运易漂移：以现有参数化用例逐字锁定；工厂配置保留 IPC `type` 字面量，满足双向契约扫描。
- R2 的冲突/不存在回执含日志与 `failUpdate` 差异：用例覆盖五 case 的回执负载，保留各自日志路径。
- W1 若用 `Array.from` 会拆坏 ZWJ 表情：改用空白分隔，用例锁定每类数量与首尾项。
- W3 抽组件改变源码文本：同步更新 `frontend-agent-identity` 的读取路径并断言两处调用，保持"桌面与移动账号菜单都显示上传头像"的原意。
- 回滚：`git revert <提交号>`；无数据、schema 与外部依赖变更。
