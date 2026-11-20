# ISSUE-01 P0 实机确认（只读诊断）

| 字段          | 值                                            |
| ------------- | --------------------------------------------- |
| 状态          | 已完成                                        |
| 领取人 / 分支 | ZCode 会话 / issue-01-p0-runtime-confirmation |
| 优先级        | P0                                            |
| 类型          | 诊断，不改代码                                |
| 依赖          | 无                                            |
| 阻塞          | ISSUE-02、ISSUE-03、ISSUE-04（OAuth 一项）    |
| 预计改动路径  | 仅本文件（回填诊断结果）                      |
| 需用户决策    | 否                                            |
| 来源          | 审查报告 §3 P0-1、P0-2、P0-8、P0-9            |

## 背景

审查报告里有 4 条 P0 是读代码推断出来的，还没在实际运行中验证过。它们的结论决定了 ISSUE-02、03、04 的修复范围。本 issue 只负责确认现象和收集证据，不改任何代码。

## 要确认的 4 项

### 1. P0-1：Web 流式事件是否被 run 栅栏丢弃

- **推断依据**：
  - Pi runner 发出的流事件只有 interrupted 状态那一条带 `turnId`/`queryRunId`（`container/agent-runner/src/runtime/pi/pi-runner.ts:478-484`）；
  - 宿主在 `src/index.ts:6904` 原样调用 `broadcastStreamEvent`，没有补这两个字段；
  - 每次 query 开始时，`src/web.ts:2774` 都会调用 `streamRunFence.start`；
  - `src/run-stream-fence.ts:45-48` 规定：run 进行中、事件又没有 `turnId` 时，返回 `accepted:false`。
- **确认方法**：
  1. 用 `make dev` 启动服务，在 Web 上发一条需要较长输出、并且会调用工具的消息；
  2. 打开浏览器开发者工具，在 Network 面板的 WS 一栏里观察：run 进行期间，是否陆续收到流事件帧（消息类型以 `src/web.ts` 中 `broadcastStreamEvent` 发出的类型为准）；
  3. 同时把日志级别临时调到 debug，看是否出现 `Discarding stream event from superseded query attempt`。
- **回填内容**：成立、不成立或部分成立；附帧截图或日志片段（需脱敏）。

### 2. P0-2：飞书卡片正文在工具调用后是否回滚

- **推断依据**：
  - `src/turn-output-coordinator.ts:108-149` 依靠 `raw_sdk_event` 的 `message_start`/`message_stop` 来切分消息，但 Pi 不产出这类事件；
  - 因此首个顶层 `tool_use_start` 之后，`visibleAnswerText`（`:184-189`）会一直返回空字符串。
- **确认方法**：
  1. 在已绑定的飞书群里，用 assistant 模式问一个必然会调用工具的问题（例如让它读一个文件，然后总结）；
  2. 观察工具调用之后，卡片正文是被清空、停止续写，还是继续正常续写；
  3. 再在执行中途中断一次，看中断后的部分回答是否为空。

### 3. P0-8：只配了 OAuth 的官方 provider 能否使用

- **推断依据**：
  - 宿主注入的是 `CLAUDE_CODE_OAUTH_TOKEN`，并写入 `.credentials.json`（`src/runtime-config.ts:2019-2025、2553`）；
  - Pi 只读取 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（`container/agent-runner/src/pi-index.ts:352-354`）。
- **确认方法**：
  1. 建一个只配置 OAuth 或 setup-token 的官方 provider，用它跑一次对话，记录能否成功，以及失败时的报错；
  2. 查阅 `@earendil-works/pi-coding-agent` 的源码，确认 Pi 有没有其他凭据来源（例如它自己的 `auth.json`）。

### 4. P0-9①：Pi 子代理事件里的实际 toolName

- **推断依据**：
  - `container/agent-runner/src/runtime/pi/pi-runtime.ts:146` 的别名表把 `Task` 映射成了 `Agent`；
  - 宿主（`src/index.ts:7093-7098`）和 Web（`web/src/stores/chat.ts:2752-2754`）都只认 `toolName === 'Task'`。
- **确认方法**：在 Pi 下触发一次子代理调用，从 runner 的输出日志或 WS 帧里，记录 `tool_use_start` 事件的 `toolName`。

## 非目标

- 不修改任何代码，也不在本 issue 里修复问题。

## 验收标准

- 4 项都有明确结论（成立、不成立或部分成立），并附上脱敏后的证据。
- 如果某项不成立，同步修改受影响的 issue：把 02、03、04 中对应的条目标为“已取消”，或者调整它们的范围。

## 注意

- 真实 Provider 调用会产生费用，日志里不要出现凭据、Endpoint、模型名或未脱敏的回复。

## 诊断结果（领取后回填）

> 诊断日期：2026-11-20。诊断环境：worktree `issue-01-p0-runtime-confirmation`（基线 `b08a3b8`，与 `3f34cf7` 代码一致）；实机部分复用主仓生产 dist（`container/agent-runner/dist/pi-index.js`，与源码同刻构建）+ 主仓默认 provider 的生产同款 env 构造链（`resolveProviderById` → `buildContainerEnvLines`），沙箱工作区隔离，凭据仅内存注入。以下证据均已脱敏：不含凭据、Endpoint、模型名与未脱敏回复。

| 项                    | 结论                                                                                                                                                            | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 对后续 issue 的影响                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 流式栅栏         | **成立**（静态链全量核实 + 实机事件级佐证）                                                                                                                     | ① 实机：真实 provider 跑一轮完整交互（含工具与子代理），捕获 220 个输出块、219 个流事件（thinking_delta×188、text_delta×11、tool_use_start×8、tool_use_end×8、task_progress×3、usage×1）——**全部 219 个事件的 `streamEvent` 内均无 `turnId`/`queryRunId`**（顶层 `inputTurnId` 是 runner `writeOutput` 层补的关联字段，不在 `streamEvent` 里，宿主 `broadcastStreamEvent` 不消费它盖章）。② 静态：`toStreamEvent`（`pi-runner.ts:114-246`）所有事件分支均不写这两个字段；唯一带 `turnId`/`queryRunId` 的流事件是 interrupted 状态事件（`pi-runner.ts:476-491`）。③ 宿主 `src/index.ts:6904` 原样转发；`broadcastRunStarted`（队列 `onQueryStart` 挂载，`web.ts:2948`）每次 query 启动 `streamRunFence.start`，键与 observe 侧一致（两侧 JID 都经 `normalizeHomeJid` 归一）；`run-stream-fence.ts:45-48`：run 进行中 + 无 turnId → `accepted:false` 丢弃并打 debug 日志 `Discarding stream event from superseded query attempt`。④ Web 路径无过滤豁免：`shouldBroadcastSdkStreamEvent` 对 assistant 模式全放行（`workspace-interaction-runtime.ts:146-157`）。 | ISSUE-02 的「流式盖章」范围成立且必要；无需删改 02 条目                                                                                                                    |
| P0-2 飞书卡片回滚     | **成立**（机制级：源头实机 + 全链静态；真实飞书群内卡片实况未复现，属用户侧外发操作）                                                                           | ① 实机（同上轮）：真实事件流中**不存在任何 `raw_sdk_event`**（也即永远没有 `message_start` 与 `message_stop` 两个 rawType 事件），只有映射后类型。② 静态：`toStreamEvent` 无 `raw_sdk_event` 分支（Pi 侧根本不产）；`turn-output-coordinator.ts:109-116` 的消息切分只认 `raw_sdk_event` 且 rawType 为 `stream_event/message_start` 或 `stream_event/message_stop` → 永不触发 → 首个顶层 `tool_use_start`（`:133-135`）置 `hasTopLevelTool=true` 后 `activeMessage` 永不提交、不清除，`visibleAnswerText`（`:184-189`）从此恒返回 `answerCandidate`（无已提交消息时为空串）；assistant 模式全部经过该 coordinator（`publishesFrameworkAnswer`，`workspace-interaction-runtime.ts:20-22`；`src/index.ts:6886-6896` 将 `visibleAnswerText` 写入 `streamingAccumulatedText` 供卡片渲染）。③ 历史佐证：主仓 DB 内全部真实 Pi 会话（sessions/\*.jsonl）工具调用仅有 `mcp__ckqclaw__send_message` 等 `mcp__ckqclaw__` 前缀工具，无任何 Task/Agent 调用可对照。                                                                                                       | ISSUE-02 的「消息边界」范围成立；卡片级复现可并入 02 修复后的验证                                                                                                          |
| P0-8 OAuth            | **成立**（源码级证据链闭合；实机复现未做——当前环境不存在 OAuth-only 官方 provider，仅有 1 个 third_party authToken provider，构造 OAuth-only 需用户提供 token） | ① 宿主注入侧（`runtime-config.ts:2019-2025`）：单 token OAuth → `CLAUDE_CODE_OAUTH_TOKEN`；完整 OAuth → 仅写 `.credentials.json`（`writeCredentialsFile`，`:2550+`）。② Pi 消费侧（方法 2，官方包 1.3.0 源码核验）：anthropic provider 的凭据来源仅三类——(a) 编程显式 `apiKey`（runner 仅在非空时 `setRuntimeApiKey`，`pi-provider.ts:44-46、82-84`）；(b) env `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`（bundle `getApiKeyEnvVars("anthropic")`；内嵌 Anthropic SDK 在 `apiKey===undefined` 时也只回退读这三个 env）；(c) 自有 `auth.json`（agentDir，`/login` 产物）。**不读 `CLAUDE_CODE_OAUTH_TOKEN`，不读 Claude Code 的 `.credentials.json`**（包内 `credentials.json` 引用仅为 gcloud ADC）。③ 实况核验：主仓两处 Pi auth.json（`data/config/pi-agent/auth.json`、各 group `data/sessions/*/.claude/agent/auth.json`）均为空 `{}`。④ OAuth-only provider 时 runner 的 `apiKey = ANTHROPIC_API_KEY \|\| ANTHROPIC_AUTH_TOKEN = undefined`（`pi-index.ts:352-354`）→ 上述 (a)(b)(c) 全空 → 请求无凭据。                     | ISSUE-04 的 OAuth 项成立；修复方向提示：宿主可将 OAuth token 映射为 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`（Pi 认可），或写入 Pi auth.json——具体方案由 04 立项时定 |
| P0-9① 子代理 toolName | **成立**（实机确认）                                                                                                                                            | ① 实机：同一轮真实运行中子代理调用的 `tool_use_start` 事件 `toolName` 实测为 **`Agent`**（另有 `get_subagent_result`；子代理生命周期另有 `task_progress`×3，`agentScope='subagent'`，不带 toolName）。② 静态印证：`pi-runtime.ts:146` 别名表 `Task → 'Agent'`；`@tintinweb/pi-subagents` 扩展注册的工具名单即 `SUBAGENT_TOOL_NAMES.AGENT = "Agent"`（`agent-runner.js`，"Single source of truth"）；宿主（`src/index.ts:7093-7098`）与 Web（`web/src/stores/chat.ts:2752-2754`）的匹配串均为 `toolName === 'Task'` → 永不命中。③ 历史佐证：主仓全部历史 Pi 会话无任何 Task/Agent 调用记录（此断链从未在真实流量中暴露过）。                                                                                                                                                                                                                                                                                                                                                                                                                                   | ISSUE-03 的「子代理 toolName 对齐」范围成立且必要；无需删改 03 条目                                                                                                        |

### 实机证据摘录（脱敏：仅事件结构，无正文/凭据/Endpoint/模型名）

```
# 真实一轮（text → 顶层工具 → 子代理 → 收尾 text）流事件统计与盖章情况
blocks=220  stream_events=219
thinking_delta=188  text_delta=11  tool_use_start=8  tool_use_end=8  task_progress=3  usage=1
tool_use_start.toolName 实测序列（节选）: mcp__ckqclaw__send_message / read / Agent / get_subagent_result
streamEvent 内带 turnId 或 queryRunId 的事件数: 0/219
terminal: status=success
task_progress(agentScope=subagent): taskStatus = created → started → completed（无 toolName）
```

### 附注（不改变结论的观察）

1. **诊断当日端点曾闪断**：直连 TCP 超时约 40 分钟后自愈（无凭据 GET 探测：超时 → 恢复应答）；期间服务侧同样零模型调用（主仓 usage_events 当日无记录）。与四项结论无关，但解释了首次实验的 "Request timed out."。
2. 实机复现 P0-8 需要一个 OAuth-only 官方 provider：当前统一 provider 池中不存在（仅 1 个启用中的 third_party authToken provider）。若需实机级复现，请用户提供 OAuth token 建临时 provider；源码级证据链已足以支撑 ISSUE-04 立项。
3. 实机复现 P0-2 的卡片级症状需要在已绑定飞书群外发消息（外部可见动作），本诊断未执行；机制级证据（Pi 不产 `raw_sdk_event`）+ 代码链已闭合，建议在 ISSUE-02 修复后的验证中顺带复现。

## 交付记录

- **提交**：分支 `issue-01-p0-runtime-confirmation`（基线 `b08a3b8`），提交信息 `docs: ISSUE-01 - P0实机确认四项全成立`；提交号以本分支 git log / 合入 main 的记录为准。
- **验证**：`npm run verify` 6/6 步全绿（40.2s）；`node scripts/check-scope.mjs` 通过（4 路径全在声明范围内，`.gatescope.json` 声明随本提交落档）。
- **与 issue 描述的偏差**：
  1. P0-2 未在真实飞书群复现卡片级症状（外发消息属用户侧外部可见动作，本诊断未执行）——以机制级证据（实机事件流无 `raw_sdk_event` + coordinator 全链静态核对）替代定论，卡片复现建议并入 ISSUE-02 修复后的验证；
  2. P0-8 实机复现未做（当前 provider 池无 OAuth-only 官方 provider，构造需用户提供 token）——以 issue 方法 2（Pi 包源码穷举凭据来源 + 两处 auth.json 实况为空）定论；
  3. P0-1/P0-9① 按 issue 方法完成；P0-9① 顺带捕获 `get_subagent_result` 与 `task_progress`（`agentScope='subagent'`）生命周期事件，可作 ISSUE-03 的额外输入；
  4. 范围外观察（不处理，仅登记）：诊断当日晨间 provider 端点直连超时约 40 分钟后自愈，期间主仓服务侧亦零模型调用；与四项结论无关。
