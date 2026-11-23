# 任务立项：ISSUE-22 子代理没有沿用自定义 Provider

> 立项日期：2026-11-23｜base：`dc5c746`（本地 main tip，ISSUE-21 合并提交）｜分支：`claude/focused-volhard-b1d243`
> 来源：`docs/issues/ISSUE-22-subagent-custom-provider-401.md`（ISSUE-17 实机验收发现）

## 0. 需求采访结论（2026-11-23）

- **目标**：自定义 Anthropic 兼容端点下，`Agent` 工具派生的子代理不再落到 Anthropic 官方通道报 401，而是使用主对话的模型和端点；子代理鉴权失败时卡片任务行给出可读的中文提示。
- **完成条件**：模型解析结果、显式 `model` 处理和报错文案都有测试锁定；官方端点行为有回归测试；`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
- **约束**：不修改第三方包 `@tintinweb/pi-subagents`，只通过 Pi 公开的扩展与运行时接口介入；不写数据库、不改共享类型；凭据、端点、模型名不进日志；合入 main、推送、实机验收由用户决定。

## 1. 证据复核（行号以 base 和 `@tintinweb/pi-subagents@0.22.0` 为准）

| 事实                                                                                                                                                                                                           | 位置                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 内置 `Explore` 写死 `model: "anthropic/claude-haiku-4-5"`                                                                                                                                                      | pi-subagents `src/default-agents.ts:37-40`                                   |
| Agent 工具的模型输入是“代理类型配置 `model` ?? 调用参数 `model`”，配置优先                                                                                                                                     | pi-subagents `src/invocation-config.ts:130-137`                              |
| Agent 工具用 `resolveModel(modelInput, ctx.modelRegistry)` 解析：配置来源解析失败时静默回退父模型；调用参数来源解析失败时把“模型不存在”文本返回给主 Agent                                                      | pi-subagents `src/index.ts:1930-1940`                                        |
| `resolveModel` 只在 `registry.getAvailable()`（已配置凭据的 provider）范围内精确/模糊匹配，最后按去掉 provider 前缀的名字重试                                                                                  | pi-subagents `src/model-resolver.ts`                                         |
| 子代理会话复用父会话的 `ModelRuntime`（取自 `ctx.modelRegistry.runtime`）；嵌套派生同样用 `ctx.modelRegistry` 解析                                                                                             | pi-subagents `src/agent-runner.ts:1076-1093`、`src/nested-tools.ts:231-238`  |
| `ModelRegistry.getAvailable()` 读取 `ModelRuntime.getAvailableSnapshot()`；快照按各 provider 的 `checkAuth` 结果生成                                                                                           | pi-coding-agent `dist/core/model-registry.js:21`、`model-runtime.js:189-212` |
| Pi 内置 anthropic 的凭据发现读取环境变量 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`                                                                                                  | pi-ai `dist/env-api-keys.js:68-76`                                           |
| runner 在自定义端点下也把 `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`（自定义端点的 key）交给 `resolvePiProvider`，环境变量本身保留，于是内置 anthropic 被判“可用”——这就是 issue 中“待核实”的来源 | `container/agent-runner/src/pi-index.ts:367-371`                             |
| 自定义端点注册为独立的 `ckqclaw-<provider>`，只注册一个模型                                                                                                                                                    | `container/agent-runner/src/runtime/pi/pi-provider.ts:150-185`               |
| 扩展的 `tool_call` 事件允许“原地修改 `event.input`”改写参数                                                                                                                                                    | pi-coding-agent `dist/core/extensions/types.d.ts:1089-1091`                  |
| 子代理失败时卡片任务行取 `taskSummary = event.result \|\| event.error`，原始 401 JSON 直接显示                                                                                                                 | `container/agent-runner/src/runtime/pi/pi-runner.ts:238-266`                 |

**链路结论**：Explore 的配置模型和显式 `model: "sonnet"` 都在“可用”的内置 anthropic 下解析成功，请求带着自定义端点的 key 发往官方通道，得到 401。未传 `model` 的 `general-purpose` 没有配置模型，按源码会继承父模型（本次用测试锁定）。

## 2. 用户决策（2026-11-23，全部按推荐）

| 项          | 决策                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| 1. 修复方向 | **(a) 自定义端点下子代理一律继承父模型**：忽略代理类型配置的 `model` 和调用时的显式 `model`                         |
| 2. 官方端点 | **保持现状**：Explore 仍用 haiku，显式 `model` 仍按 Anthropic 目录解析                                              |
| 3. 报错提示 | **加中文提示，保留原文**：任务行显示简短中文提示；原始错误写入 runner 日志（不含凭据），主 Agent 收到的工具结果不变 |

## 3. 实现方案

1. **可用模型收窄（`pi-provider.ts`）**：新增 `restrictAvailableModelsToProvider(modelRuntime, providerId)`，自定义端点分支注册 provider 后调用，让该 `ModelRuntime` 的可用模型快照只保留 `ckqclaw-*` provider。效果：Explore 的 `anthropic/claude-haiku-4-5` 在可用范围内解析不到，按 pi-subagents 既有逻辑静默回退父模型；嵌套派生共享同一个 runtime，同样生效。`PiProviderResolution` 增加 `custom: boolean` 供运行时判断。官方分支不调用。
2. **剥离显式 `model`（`pi-subagents.ts` + `pi-runtime.ts`）**：新增扩展工厂 `createSubagentInheritModelExtension()`，在 `tool_call` 事件中遇到 `Agent` 工具时原地删除 `event.input.model`；`pi-runtime.ts` 仅在 `modelResolution.custom` 为真时把它加入 `extensionFactories`（含去掉子代理扩展后的重试分支）。
3. **鉴权失败提示（`pi-runner.ts`）**：新增纯函数 `describeSubagentFailure(error)`：错误文本以 401/403 开头，或含 `authentication_error` / `permission_error` / `invalid x-api-key` 时，返回“子代理鉴权失败（401）：请检查 Provider 凭据与端点配置”这类文案；否则原样返回。`subagent` 事件 `lifecycle === 'failed'` 时用它生成 `taskSummary`；改写发生时用 `options.log` 记录原始错误（截断到 300 字符）。

## 4. 任务拆分与回滚点

| 任务 | 内容                               | 验收                                                                                                                                             | 回滚点   |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| T1   | 可用模型收窄 + `custom` 标记       | 环境里有 `ANTHROPIC_API_KEY` 时：自定义端点下可用列表只有 `ckqclaw-*`，Explore 配置模型解析回退父模型；官方端点下 anthropic 仍可用、haiku 可解析 | 立项提交 |
| T2   | 显式 `model` 剥离扩展 + 运行时接线 | `Agent` 调用的 `model` 被删除，其他工具和其他参数不受影响；运行时只在自定义端点下加载该扩展（源码结构断言）                                      | T1 提交  |
| T3   | 子代理鉴权失败中文提示             | 401/403 文案命中，其他错误与成功结果原样；原始错误进日志；`failed` 以外的生命周期不改写                                                          | T2 提交  |
| T4   | 门禁与交付落档                     | verify 全绿、check-scope 通过、issue 已完成                                                                                                      | T3 提交  |

## 5. 测试方案

- 新增 `tests/pi-subagent-custom-provider.test.ts`：
  - 用真实 `ModelRuntime`（临时 auth/models 文件）+ 测试内临时设置的假 `ANTHROPIC_API_KEY`，走 `resolvePiProvider` 自定义/官方两个分支，再用 `new ModelRegistry(runtime)` 与 pi-subagents 自身的 `resolveModel` 断言解析结果（测试直接导入第三方源码，仅用于锁定行为）。
  - 扩展工厂用最小假 `ExtensionAPI` 收集 `on('tool_call')` 处理器并驱动。
  - `describeSubagentFailure` 正反例；经 `runPiQueryAttempt` 的真实链路断言任务行文案与日志。
- 回归：既有 `pi-custom-provider-headers`、`pi-runtime-settings-and-credentials`、`pi-subagent-tool-contract` 测试保持通过。

## 6. 非目标

- 不改官方端点下的子代理模型选择。
- 不为自定义端点注册多个模型，也不做模型名映射。
- 不修改 `@tintinweb/pi-subagents`，不改 RPC 派生（`PiSubAgentAdapter.spawn`，生产无调用方）。
- 不从进程环境删除 `ANTHROPIC_*` 变量（会影响 bash 等子进程，超出本 issue 范围）。
- 不改 Web 或飞书卡片的展示组件。
