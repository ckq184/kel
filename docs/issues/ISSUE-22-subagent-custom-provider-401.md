# ISSUE-22 子代理没有沿用自定义 Provider：Explore 与显式 model 落到 Anthropic 官方通道报 401

| 字段          | 值                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                               |
| 领取人 / 分支 | `claude/focused-volhard-b1d243`                                                                                                                                      |
| 优先级        | P1                                                                                                                                                                   |
| 类型          | 缺陷（Pi 子代理模型解析）                                                                                                                                            |
| 依赖          | 无                                                                                                                                                                   |
| 阻塞          | 无                                                                                                                                                                   |
| 预计改动路径  | `container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/pi/pi-subagents.ts`（或 runner 的子代理配置注入），以及相应的 `tests/**` |
| 需用户决策    | **是**：见下文“需用户决策”                                                                                                                                           |
| 来源          | 2026-11-23 ISSUE-17 实机验收（飞书话题，Host 工作区，自定义 Provider）                                                                                               |

## 现象

主对话使用自定义 Anthropic 兼容 Provider（runner 注册为 `ckqclaw-*` provider）正常工作；同一轮里主 Agent 调用 `Agent` 工具派生子代理，四次全部在 1～2 秒内失败：

```text
401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011…"}
```

`request_id` 是 Anthropic 官方格式，说明子代理请求发到了 Anthropic 官方通道，而不是自定义端点。主 Agent 随后放弃子代理、自己完成任务，用户看到“子代理鉴权失败”的说明。

## 证据（会话 jsonl 与依赖源码，行号以 `@tintinweb/pi-subagents@0.22.0` 为准）

| 调用参数                                                    | 结果 |
| ----------------------------------------------------------- | ---- |
| `subagent_type: "Explore"`（三次，未传 `model`）            | 401  |
| `subagent_type: "general-purpose", model: "sonnet"`（一次） | 401  |

- pi-subagents 子代理模型解析顺序为“显式 `model` 参数 > 代理类型配置的 `model` > 父模型”（`src/agent-runner.ts:416-445`、`:930-932`）。
- 内置 `Explore` 类型写死 `model: "anthropic/claude-haiku-4-5"`（`src/default-agents.ts:37-40`）；只要注册表认为 `anthropic` provider 可用，就不会回退到父模型。
- 显式传 `model: "sonnet"` 时，也会解析到内置 Anthropic 目录里的模型。
- runner 在自定义端点分支把端点注册成独立的 `ckqclaw-<provider>`，并刻意不动 Pi 内置的 Anthropic 目录与凭据（`container/agent-runner/src/runtime/pi/pi-provider.ts:95-110`、`:150-185`）。内置 `anthropic` provider 被判为“可用”的具体来源（环境变量回落或其他凭据发现路径）**待核实**，不要在日志或 issue 里打印凭据。
- 没有传 `model` 的 `general-purpose` 是否正常继承父模型，本次没有覆盖到，待核实。

## 需用户决策

1. **修复方向**：
   - (a) 自定义端点下，强制子代理一律继承父模型（忽略代理类型配置和显式 `model`）；
   - (b) 把代理类型配置和显式 `model` 映射到自定义 provider 下的同名模型，映射不到时回退父模型；
   - (c) 只改 Explore 等内置类型的默认 model（覆盖为继承父模型），保留显式 `model` 的行为。
2. **官方端点**下是否保持现状（Explore 用 haiku 省钱）。
3. **报错可读性**：子代理鉴权失败时是否需要更明确的提示（目前卡片任务行直接显示原始 401 JSON）。

## 验收标准（待拍板后细化）

- 自定义 Provider 下，`Explore`、`general-purpose`（含显式 `model`）子代理都能成功运行，请求发往自定义端点。
- 有测试锁定模型解析结果；`npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

- **分支**：`claude/focused-volhard-b1d243`，base `dc5c746`。立项方案见 `docs/issue22-subagent-custom-provider-plan.md`。
- **根因核实**（原“待核实”项）：runner 在自定义端点下仍保留环境变量 `ANTHROPIC_API_KEY`（值为自定义端点的 key），Pi 内置 anthropic 的凭据发现读到它，于是被判“可用”；pi-subagents 只在可用模型里解析代理类型配置和显式 `model`，因此 Explore 和 `model: "sonnet"` 都落到官方通道。未传 `model` 的 `general-purpose` 没有配置模型，按源码直接继承父模型。
- **用户决策**（2026-11-23，全部按推荐）：自定义端点下子代理一律继承父模型；官方端点保持现状；鉴权失败加中文提示，保留原文。

| 任务 | 落地                                                                                                                                                                                      | 提交      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 立项 | 领取、方案与 `.gatescope.json`                                                                                                                                                            | `aab6881` |
| T1   | `pi-provider.ts` 新增 `restrictAvailableModelsToProvider`，自定义分支把可用模型快照收窄到 `ckqclaw-*`，Explore 的配置模型解析不到，按 pi-subagents 既有逻辑回退父模型；新增 `custom` 标记 | `3bb9c25` |
| T2   | `pi-subagents.ts` 新增 `createSubagentInheritModelExtension`，在 `tool_call` 中删除 `Agent` 调用的 `model`；`pi-runtime.ts` 仅在自定义端点加载，扩展工厂改为每个 loader 各自构造          | `60cb1a9` |
| T3   | `pi-runner.ts` 新增 `describeSubagentFailure`，`failed` 任务行的 401/403 鉴权错误显示“子代理鉴权失败（401）：请检查 Provider 凭据与端点配置”，原始错误截断 300 字符写入 runner 日志       | `21adabc` |

- **测试**：新增 `tests/pi-subagent-custom-provider.test.ts` 9 条用例，均先红后绿。T1 用真实 `ModelRuntime` 和假 `ANTHROPIC_API_KEY` 复现“自定义端点下 anthropic 可用”，并用 pi-subagents 自身的 `resolveModel` 锁定解析结果；官方端点下 Explore 仍解析到 anthropic 的 haiku。
- **验证**：`npm run verify` 6/6 步全绿，总耗时 38.0s，第 4 步 356 个文件、2909 条通过、23 条跳过；`node scripts/check-scope.mjs` 通过，9 个路径都在声明范围内。
- **偏差**：
  - 验收标准中“请求发往自定义端点、子代理成功运行”在本分支只验证到模型解析层（无真实请求），需实机验收确认。
  - 子代理再派生子代理（pi-subagents 嵌套工具）时，子会话不加载 CKQClaw 的扩展，显式 `model` 不会被删除；由于可用模型已收窄，结果是“模型不存在”的提示文本返回给调用方，不会再发往官方通道。本次未处理，有需要时另开 issue。
  - 工作流第 6 阶段的独立审查代理未执行。
- **未做**：合入 main、推送、实机验收由用户决定。
