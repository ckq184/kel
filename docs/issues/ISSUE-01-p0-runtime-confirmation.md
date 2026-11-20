# ISSUE-01 P0 实机确认（只读诊断）

| 字段          | 值                                         |
| ------------- | ------------------------------------------ |
| 状态          | 待领取                                     |
| 领取人 / 分支 | —                                          |
| 优先级        | P0                                         |
| 类型          | 诊断，不改代码                             |
| 依赖          | 无                                         |
| 阻塞          | ISSUE-02、ISSUE-03、ISSUE-04（OAuth 一项） |
| 预计改动路径  | 仅本文件（回填诊断结果）                   |
| 需用户决策    | 否                                         |
| 来源          | 审查报告 §3 P0-1、P0-2、P0-8、P0-9         |

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

| 项                    | 结论 | 证据 | 对后续 issue 的影响 |
| --------------------- | ---- | ---- | ------------------- |
| P0-1 流式栅栏         |      |      |                     |
| P0-2 飞书卡片回滚     |      |      |                     |
| P0-8 OAuth            |      |      |                     |
| P0-9① 子代理 toolName |      |      |                     |

## 交付记录

（领取后填写）
