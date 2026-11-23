# ISSUE-22 子代理没有沿用自定义 Provider：Explore 与显式 model 落到 Anthropic 官方通道报 401

| 字段          | 值                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                               |
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

（领取后填写）
