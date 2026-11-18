# 任务立项：把工具摘要、脱敏与技能标签接回 pi 链路

> 立项日期：2026-11-18｜base：`335bdfc`｜状态：已获用户批准（核查报告后确认"立项接回"，四项产品取舍均按推荐项）
> 前序：死代码第二档连带孤儿核查报告（第 1 项）；`docs/dead-code-tier1-prune-plan.md` / `dead-code-tier2-prune-plan.md` 中删除的 `summarizeToolInput` 等函数恰是本任务要接回的实现。

## 1. 背景与取证

pi 迁移后，runner 对工具事件的处理与旧 Claude runner 不一致，界面却仍按旧契约读取字段：

| 字段 / 行为             | 宿主与前端读取处 | pi runner 现状                                                | 旧 runner                                      |
| ----------------------- | ---------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `toolInputSummary`      | 42 处            | **无生产者**                                                  | `summarizeToolInput`：取关键字段、脱敏、截 180 |
| `skillName`             | 36 处            | **无生产者**                                                  | `extractSkillName`（仅 `Skill` 工具）          |
| 原始 `toolInput`        | 提问面板         | **对所有工具全量下发**                                        | 仅 `AskUserQuestion` 下发                      |
| `toolResult` / `detail` | 界面基本不展示   | 完整原文（`stringify`），无截断无脱敏                         | `summarizeToolResult`：脱敏并截 400            |
| 工具名                  | `Bash/Read/Glob` | 小写 `bash/read/find`（界面 `parseToolParam`、`isBash` 失效） | 大写（与界面一致）                             |

- `shared/stream-event.ts` 对 `toolResult` 的类型注释声称"truncated + sanitized"，pi 实现不符合。
- 宿主 `broadcastStreamEvent` 把整个事件原样广播给有权访问该工作区的 WebSocket 客户端（ACL 默认拒绝）；未发现原始事件被持久化。因此这是数据最小化策略的回退与界面功能缺失，不是对外泄露。
- 这 6 个被映射的工具名（`Bash/Read/Write/Edit/Glob/Grep`）在宿主与前端**只用于展示**（`parseToolParam` 标签、`isBash` 样式），无业务逻辑依赖。
- pi 没有 `Skill` 工具：技能是模型读取 `SKILL.md` 触发；pi 链路也没有 `AskUserQuestion` 工具。

## 2. 已确认裁决（用户逐项选定）

1. **工具名**：runner 把 pi 小写名映射回界面名——`bash→Bash`、`read→Read`、`write→Write`、`edit→Edit`、`find→Glob`、`grep→Grep`；`ls`、MCP 工具与子代理工具（`Agent` / `get_subagent_result` / `steer_subagent`）保持原名。
2. **原始参数**：只有名为 `AskUserQuestion` 的工具保留原始 `toolInput`，其余工具只发脱敏摘要（恢复旧策略；pi 目前没有该工具，将来加提问工具无需再改）。
3. **工具结果**：截断到 400 字符并脱敏后再发；**不**恢复飞书卡片的"↳ 结果"行（不新增 `tool_result` 事件，不在群聊里展示工具输出）。
4. **技能标签**：启发式恢复——`read` 的路径以 `/<技能名>/SKILL.md` 结尾时，该次调用以 `Skill` 名称、`skillName=<技能名>` 下发。这是新逻辑而非原样接回，由新测试锁定。

## 3. 方案

在 `pi-runner.ts` 的 `toStreamEvent` 事件映射处接入，界面与宿主**不改**：

- `tool_start`：`toolName` 经映射；`toolInputSummary = summarizeToolInput(input)`；命中技能启发式时 `toolName='Skill'`、`skillName` 赋值；仅 `AskUserQuestion` 带原始 `toolInput`。
- `tool_update`（`tool_progress`）：同样带 `toolInputSummary`；`detail = summarizeToolResult(result)`。
- `tool_end`（`tool_use_end`）：`toolName` 经映射；`toolResult = summarizeToolResult(result)`。
- **函数**（从 `4379013:container/agent-runner/src/utils.ts` 取回并按 pi 调整）：
  - `shorten`、`summarizeToolInput` 原样取回。
  - `summarizeToolResult` 取回，并识别 pi 的 `AgentToolResult` 形状 `{ content: [{type:'text', text}|{type:'image'}], details }`；超过 8KB 的文本先取头部再脱敏，避免旧实现对大结果只输出 `[REDACTED LARGE INPUT]` 占位。
  - `extractSkillName` 改写为 pi 启发式（见裁决 4）。
- **名字对照**：新增 `runtime/pi/pi-tool-names.ts`，把 `pi-runtime.ts` 内的 `toolAliases`（Claude→pi）提为共享常量，并提供 `toUiToolName`（仅反向映射裁决 1 列出的 6 个）。
- `redactSensitive` / `redactInlineSecrets` 无需改动，本任务使其重新有调用方。

## 4. 不做（范围外）

- 不新增 `tool_result` 事件，不恢复飞书"↳ 结果"行。
- 不映射子代理工具名（界面里按 `Task` 判断的子代理面板语义另案）。
- 不实现 `AskUserQuestion` 工具本身。
- 不改宿主、前端与 `shared/stream-event.ts`（类型注释在本任务后才与实现一致，无需改动）。
- 不改 `toolcall_start` / `toolcall_end` 触发的重复事件行为。

## 5. 实施步骤（立项 1 提交 + 实现 1 提交）

| 步骤 | 内容                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`335bdfc`）                                                                                                                                                                                   |
| 1    | **Red**：取回 `tests/agent-runner-utils-redact.test.ts` 中被删的 `summarizeToolInput` 5 例；新增 `tests/pi-tool-event-format.test.ts`（名字映射、摘要、技能启发式、结果截断脱敏、原始参数策略，经 `runPiQueryAttempt` 驱动）；先确认失败 |
| 2    | **Green**：取回并调整 `utils.ts` 函数、新增 `pi-tool-names.ts`、改 `pi-runtime.ts` 引用共享常量、改 `pi-runner.ts` 事件映射                                                                                                              |
| 3    | `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过 + `feat:` 提交（不 push）                                                                                                                                                |

## 6. 风险清单

| #   | 风险                                                         | 缓解                                                                                            |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | 工具名变化影响按名字判断的逻辑                               | 已 grep 核实 6 个名字仅用于展示；子代理工具名不动                                               |
| 2   | `toolcall_start` 先半截参数后完整参数，名字/技能名前后不一致 | Web 按 `toolUseId` 合并且后者覆盖前者；技能检测只在完整路径命中时触发；测试覆盖空参数与半截参数 |
| 3   | 工具结果被截断到 400 字符，调试信息变少                      | 与旧 runner 一致；完整结果仍写入 pi 会话 JSONL，不受影响                                        |
| 4   | 脱敏正则在高频 `tool_update` 上的开销                        | 沿用 32KB 长度兜底；结果先取 8KB 头部再脱敏                                                     |
| 5   | 技能启发式误判（读到名为 `SKILL.md` 的普通文件）             | 只对 `read` + 路径以 `/SKILL.md` 结尾生效；误判后果仅是标签显示为"技能 xxx"，无功能影响         |
| 6   | 脱敏不是完备的密钥检测                                       | 沿用既有模式集（Bearer、DSN、`api_key=`、`sk-`、`ghp_`、PEM 等）；不承诺覆盖所有密钥格式        |

## 7. 验证方式

1. 新测试先红后绿；取回的 5 例脱敏测试通过。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 数据流复核：`toolInputSummary`、`skillName` 在 runner 里重新有生产者。
