# ISSUE-04 Pi 运行时设置与凭据（6 项“设置不生效”）

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中（2026-11-20 领取，决策表已出，等用户逐项拍板）                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 领取人 / 分支 | 分支 `issue-04-pi-runtime-settings-and-credentials`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 优先级        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 类型          | 断链修复：上游还在产出，Pi 端没人读取                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 依赖          | ISSUE-01（仅 OAuth 一项需要它的结论）                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 阻塞          | ISSUE-10、ISSUE-13（CLAUDE.md 的上下文窗口那一行）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 预计改动路径  | `container/agent-runner/src/provider-runtime.ts`、`container/agent-runner/src/context-window.ts`、`container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`container/agent-runner/src/pi-index.ts`、`container/agent-runner/src/types.ts`、`src/runtime-config.ts`、`src/container-runner.ts`、`web/src/components/settings/**`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/components/agents/**`、相应的 `tests/**` |
| 需用户决策    | **是**：每项二选一                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 来源          | 审查报告 §3 P0-3 至 P0-8                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 背景

旧 Claude runner 会读取下面这些设置。换成 Pi 之后，它们在 Web 上仍然可以修改，宿主也照常注入，但 Pi 端没有任何代码读取。用户会以为改动已经生效。

## 流程要求

领取后**先输出一张决策表**：每一项给出两个方案——“在 Pi 端补上读取”或“在界面下线 / 标注为 Pi 下无效”，并说明各自的影响和你的推荐。用户逐项拍板后再立项实现。**不允许维持“界面能改、实际无效”的现状。**

## 6 项明细

| #   | 设置                                                                                                           | 断在哪里                                                                                                                                                                                                                                                                     | 如果选择补读取，可以从这里接                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 上下文窗口（provider 级：auto/128k/256k/512k/1M）                                                              | 宿主在 `src/runtime-config.ts:2067` 注入 `CKQCLAW_CONTEXT_WINDOW`，runner 在 `provider-runtime.ts:92` 解析出来；唯一的消费者 `resolveClaudeQueryModelRuntime`（`:46`）只有测试在调用；`pi-provider.ts:77` 对自定义端点写死了 `contextWindow: 200_000` 和 `maxTokens: 32_000` | 把 `declaredContextWindow` 传进 `pi-provider` 的 model 定义。同时核对 `context-window.ts:40/60` 那两个只被测试调用的函数是否还需要 |
| 2   | fallbackModel                                                                                                  | 界面 `SystemSettingsSection.tsx:276-359`；宿主在 `src/container-runner.ts:946-952、2504` 注入 `CKQCLAW_FALLBACK_MODEL`；runner 和 Pi 依赖都不读；原来的消费者 `provider-fallback.ts` 已在 64d6d7b 删除                                                                       | 先确认 Pi 是否支持备用模型；如果不支持，就下线这个设置                                                                             |
| 3   | 推理强度 effort                                                                                                | 界面 `MainAgentCapabilitiesSection.tsx:79-299`；宿主只在 `container-runner.ts:1293、2482` 用它来删除 provider 级的 `CLAUDE_CODE_EFFORT_LEVEL`，从不注入；`pi-runtime.ts:182` 也不传 `thinkingLevel`                                                                          | 把 effort 映射成 Pi 的 `thinkingLevel`                                                                                             |
| 4   | Prompt 模式“追加 / 替换预设”（`prompt_mode` / `include_claude_preset`）                                        | 宿主在 `src/index.ts:2152` 和 `src/task-scheduler.ts:259` 计算并下发；runner 只在 `types.ts:243` 声明了字段，构建系统提示时并不读它；界面 `AgentPromptEditor.tsx:96-99`                                                                                                      | 在构建系统提示时，按这个字段区分“追加”和“替换”两种行为                                                                             |
| 5   | 自动压缩阈值（`mainAgentAutoCompactWindow/Percentage`，以及 Agent 的 `runtime_policy.context.auto_compact_*`） | `pi-index.ts:360-364` 有注释说明在 Pi 下仅作参考，并写死了 `autoCompactEnabled: true`（`docs/runtime-migration.md` 的 Known risks 一节也有记录）；但界面 `SystemSettingsSection.tsx:501-516` 和 `AgentProfilesPage.tsx:102-144` 仍然提供编辑控件                             | 这一项带有意图信号。倾向于在界面下线或加注“Pi 下由运行时自动决定”，最终由用户确认                                                  |
| 6   | OAuth / setup-token 凭据                                                                                       | 宿主在 `src/runtime-config.ts:2019-2025、2553` 注入 `CLAUDE_CODE_OAUTH_TOKEN` 并写入 `.credentials.json`；Pi 只读 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（`pi-index.ts:352-354`）；界面 `ProviderList.tsx:82-95` 仍然显示 OAuth 标签                                  | 以 ISSUE-01 的结论为准：如果确实拿不到凭据，就把 OAuth 凭据映射到 Pi 认可的变量，或者在界面上说明 Pi 下不支持                      |

## 非目标

- 不清理 Claude SDK 时代其他无人读取的环境变量注入，例如 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`CKQCLAW_AGENT_MCP_POLICY`。这些由 ISSUE-10 负责。

## 验收标准

- 每一项都满足以下两种情况之一：
  - 在 Pi 下生效：有测试证明 runner 读取了这个设置并传给了 Pi；
  - 界面不再提供该设置，或者明确标注为无效。
- 修改了与 Prompt 或能力身份相关的字段后，暖 Runner 必须失效（CLAUDE.md §5）。
- `npm run verify` 和 check-scope 都通过。

## 注意

- 修改 `ContainerInput` 或共享类型后，执行 `make sync-types`。
- 真实 Provider 测试会产生费用，注意脱敏。

## 交付记录

（领取后填写）
