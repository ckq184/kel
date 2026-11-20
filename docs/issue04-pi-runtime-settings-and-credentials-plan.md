# 任务立项：ISSUE-04 Pi 运行时设置与凭据（6 项“设置不生效”）

> 立项日期：2026-11-20｜base：`cfae147`（main tip）｜分支 `issue-04-pi-runtime-settings-and-credentials`｜领取自 `docs/issues/ISSUE-04-pi-runtime-settings-and-credentials.md`
> 依赖核实：ISSUE-01 已完成合入——P0-8 结论直接作为第⑥项输入：Pi 凭据仅认 (a) 编程显式 `apiKey`、(b) env `ANTHROPIC_AUTH_TOKEN`（Bearer 头，`pi-ai/dist/providers/anthropic.js:21-28`）/`ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`、(c) 自有 `auth.json`；不读 `CLAUDE_CODE_OAUTH_TOKEN` 与 Claude `.credentials.json`；两处 Pi auth.json 实况为空 `{}`。

## 1. 背景（main `cfae147` 复核，6 项断链全部成立）

| #   | 设置            | 断链取证（当前行号）                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 上下文窗口      | 宿主按「声明≠auto 或 `[1m]` 后缀」注入 `CKQCLAW_CONTEXT_WINDOW`（`src/runtime-config.ts:1957-1964`）；runner `resolveClaudeProviderRuntime` 解析出 `declaredContextWindow`（`provider-runtime.ts:92`）但 `pi-index.ts:332` 解析后丢弃；自定义端点注册写死 `contextWindow: 200_000`（`pi-provider.ts:77`）；`resolveClaudeQueryModelRuntime` 仅被根 `tests/agent-runner-provider-runtime.test.ts` 调用                                                    |
| 2   | fallbackModel   | UI「额度墙回退模型」（`SystemSettingsSection.tsx:444-466`）；容器/Host 两模式注入 `CKQCLAW_FALLBACK_MODEL`（`container-runner.ts:936-953、2501-2505`）；消费者 `provider-fallback.ts` 已随 64d6d7b 删除；Pi 无同轮备用模型机制（`scopedModels` 仅交互切换、`allow_fallbacks` 属 OpenRouter 路由配置）                                                                                                                                                    |
| 3   | 推理强度 effort | Agent 级仅用于**删** provider 级 `CLAUDE_CODE_EFFORT_LEVEL`（`agent-effort.ts:46-56`）从不注入；provider 级为第三方默认 `'max'`（`runtime-config.ts:136`）；Pi 端无人读 → 实际全部跑 Pi 默认 medium；`RuntimeSessionOptions.thinkingLevel` 管道已通至 `createAgentSession`（`pi-runtime.ts:182-183`）只缺 `pi-index.ts` 赋值                                                                                                                             |
| 4   | prompt_mode     | 宿主下发 `includeClaudePreset = (prompt_mode==='append')`（`index.ts:2142`、`task-scheduler.ts:256`）；runner 声明不读（`types.ts:243`）；**Pi 下不存在 Claude Code 预设**，`buildSystemPrompt` 两种模式产物本就一致，平台运行规则恒定包含是已记录设计意图（`agent-profile-prompts.ts:46` 注释）                                                                                                                                                         |
| 5   | 自动压缩阈值    | 两处 UI 保留百分比/固定阈值覆盖编辑路径（`SystemSettingsSection.tsx:668-710`、`AgentProfilesPage.tsx:2031-2105`）；宿主注入 `AUTO_COMPACT_PERCENTAGE/WINDOW`（`container-runner.ts:1306-1311`）；runner 注释明确「Pi 下仅作参考、写死 `autoCompactEnabled: true`」（`pi-index.ts:361-365`）+ `docs/runtime-migration.md` Known risks 记录；`resolveAutoCompactWindow/resolveLegacyAutoCompactWindow`（`context-window.ts:40-72`）仅被测试调用            |
| 6   | OAuth 凭据      | 单 token → `CLAUDE_CODE_OAUTH_TOKEN`（`runtime-config.ts:1913-1917`）、完整 OAuth → 仅写 `.credentials.json`（`:2415-2466`）；runner 把 `ANTHROPIC_API_KEY \|\| ANTHROPIC_AUTH_TOKEN` 折为 apiKey 传 `setRuntimeApiKey`（`pi-index.ts:354-355`→`pi-provider.ts:44-46/82-84`）→ **X-Api-Key 头**，而 Claude OAuth 令牌的官方用法是 `Authorization: Bearer`（Pi `ANTHROPIC_AUTH_TOKEN` 路径）；顺带发现 first-party `anthropicAuthToken` provider 同被降级 |

## 2. 用户决策（2026-11-20 拍板：全部按推荐 ①A ②B ③A ④B ⑤B ⑥A）

- **①A 补读取**：`declaredContextWindow` 传入 Pi model 定义。1M 声明模型的压缩预留估算随之修正（行为变化=回归设计本意）。
- **②B 下线**：Pi 无备用模型机制，宿主 provider 失败隔离+重试已覆盖可靠性兜底；补实现属新功能设计而非断链修复。**动机登记**：原设置为「额度墙同轮换模型重跑」（UI 文案详述设计动机），消费者已随 Claude runner 删除；本任务下线 UI+注入，存储/API 留兼容，残留归 ISSUE-09/10。
- **③A 映射 thinkingLevel**：`low/medium/high/xhigh/max` 与 Pi `ThinkingLevel` 恒等映射。**已向用户明示**：接线后第三方 provider 默认 `effort='max'` 真实生效，推理费用较现状（实际 medium）上升；用户显式调 low 可省。
- **④B 如实标注/下线**：Pi 下 Claude Code 预设已不存在，两模式产物一致；平台脚手架不可被 replace 移除是已拍板设计——补新语义=推翻既有设计+改存量 Agent 提示词，故下线控件、如实说明。
- **⑤B 下线**：意图信号明确（runner 注释 + Known risks 记录「Pi 自主决定阈值」为有意设计），按用户审查口径经本次拍板确认下线；做彻底版：UI 覆盖路径下线 + 停止 `AUTO_COMPACT_*` 注入 + 删 runner 死函数。
- **⑥A 映射生效**：OAuth 令牌 → `ANTHROPIC_AUTH_TOKEN`（Bearer 路径，Claude OAuth 官方用法）；完整 OAuth 用 accessToken，**不代刷新**（过期→401→宿主 provider 隔离，UI 注明需重新授权）；顺带修复 first-party authToken 降级问题。

## 3. 技术方案

### 3.1 ① 上下文窗口接线

- `container/agent-runner/src/context-window.ts`：新增纯函数 `resolveContextWindowOverride(model, declared): number | undefined` —— `declared !== undefined ? declared : (isExtendedContextModel(model) ? 1_000_000 : undefined)`；仅在**有宿主声明或旧 `[1m]` 后缀**时产出覆盖值，无声明时返回 undefined 以保留 Pi 官方目录真实窗口。
- `runtime/types.ts`：`RuntimeSessionOptions.provider` 增 `contextWindow?: number`、`authToken?: string`（⑥共用）。
- `pi-index.ts`：`sessionOptions.provider.contextWindow = resolveContextWindowOverride(provider.model, provider.declaredContextWindow)`。
- `pi-provider.ts`：统一在返回前对解析出的 model 应用覆盖——`override ? { ...model, contextWindow: override } : model`（**浅拷贝**，不污染共享目录对象；官方缺省路径、官方显式路径、custom 注册三处全覆盖；custom 注册行 `contextWindow: 200_000` 改为 `override ?? 200_000`）。
- 死代码清理：`provider-runtime.ts` 删 `resolveClaudeQueryModelRuntime` + `ClaudeQueryModelRuntime`（唯一调用方是测试）；`context-window.ts` 删 `resolveAutoCompactWindow`/`resolveLegacyAutoCompactWindow`（⑤配套）。保留 `resolveDeclaredContextWindow`/`isExtendedContextModel`/`stripOneMillionSuffix`（`resolveClaudeProviderRuntime` 链在用）。
- `CLAUDE.md:331` 上下文窗口行更新（ISSUE-13 挂靠子项）：补记 Pi 端消费事实。

### 3.2 ② fallbackModel 下线

- Web `SystemSettingsSection.tsx`：删「额度墙回退模型」section（`:444-466`）及 `fallbackModel` state/dirty/payload 逻辑（`:276-360` 散布）。
- 宿主 `container-runner.ts`：删 `applyFallbackModelToEnvLines`（`:936-953`）及容器模式调用点、host 模式注入块（`:2501-2505`）。`RESERVED_CLAUDE_ENV_KEYS` 保留 `CKQCLAW_FALLBACK_MODEL` 条目（继续阻止 custom env 冒充该键，防御性保留）。
- `system_settings` 存储字段与 `/api/config/system` GET/PUT 保留兼容（UI 不再提供）；`web/src/components/settings/types.ts` 的 `SystemSettings.fallbackModel` 类型保留。
- `tests/provider-model-fallback-contract.test.ts` 重写为「不注入契约」。

### 3.3 ③ effort → thinkingLevel

- 契约扩展：`ContainerInput.agentProfile` 增 `effort?: 'low'|'medium'|'high'|'xhigh'|'max'`——runner `container/agent-runner/src/types.ts` 与宿主镜像 `src/container-runner.ts:373-386` 同步声明（ContainerInput 为双侧手维护契约，改双侧即可，不涉 `make sync-types`——该命令仅管 `shared/stream-event.ts`）。
- 宿主：`toContainerAgentProfile`（`index.ts:2131`）与 `toRunnerAgentProfile`（`task-scheduler.ts:250`）以 `resolveAgentSdkEffort(profile.runtime_policy)` 填充（`inherit`/非法 → undefined 不下发）；`removeProviderEffortEnv` 既有删除逻辑保留（Agent 显式时删 provider env，与 runner 端 `effort ?? env` 优先级双保险）。
- runner：`pi-index.ts` 新增纯函数 `resolveAgentThinkingLevel(agentEffort, env)` —— `agentEffort ?? env['CLAUDE_CODE_EFFORT_LEVEL']`（env 值校验白名单 low/medium/high/xhigh/max，垃圾值忽略）→ 填入 `sessionOptions.thinkingLevel`（`pi-runtime.ts:182` 管道已通，`undefined` 落 Pi 默认 medium）。
- 暖 Runner 失效契约：`runtime_policy` 参与 `identity_hash`（`agent-profile-runtime.ts:88`），effort 改动自动触发失效（CLAUDE.md §5 满足）；Agent 级 effort 经 ContainerInput 每轮新鲜生效。
- UI 不改动（能力页 effort 控件本就是有效设置，③为补齐消费端）。

### 3.4 ④ prompt_mode 下线/如实标注

- `AgentPromptEditor.tsx`：删「Claude Code 默认提示词」fieldset 两张选择卡（`:82-105`）与 `onModeChange` prop；原位置改固定说明段——Pi 运行时系统提示词由 CKQClaw 运行规则 + 四段提示词构成，Claude Code 预设已不存在，追加/替换两种模式产物一致。
- 存量兼容：`prompt_mode` 存储与 API 不动（表单继续按存量值提交，不改 DB/迁移）；宿主 `includeClaudePreset` 下发保留（ContainerInput 契约字段）；runner `types.ts:243` 注释标注 Pi 下无消费者（兼容层彻底下线归 ISSUE-11）。
- 父组件 `AgentProfilesPage.tsx:1803` 的 `onModeChange={setPromptMode}` 接线随组件 prop 删除同步清理。

### 3.5 ⑤ 自动压缩阈值下线

- 现状澄清：两处 UI 已有「运行时自动压缩（推荐）」主开关+注记，但**保留百分比/固定阈值覆盖编辑路径**——该覆盖路径即 Pi 下无效部分，为本次下线对象。
- Web `SystemSettingsSection.tsx`（host-integration scope）：删 `mainAgentAutoCompactPercentage` 编辑与开关切换逻辑，保留注记文案并补「覆盖配置已下线（Pi 由运行时自动决定）」；`AgentProfilesPage.tsx`：删 `useSdkCompactDefault` 关闭后的百分比/legacy 阈值编辑块（`:2044-2105`），保留推荐开关说明。存量非零值不静默改写（存储原样、仅不再提供编辑）。
- 宿主 `container-runner.ts`：删 `AUTO_COMPACT_PERCENTAGE/WINDOW` 注入 push（`:1306-1311`），**保留对继承值的 strip 循环**（防 custom env 冒充该键）；`src/agent-profile-runtime.ts` 的 `getAgentAutoCompactPercentage/Window` 失去调用方→删除（实现时以 grep 复核无其他调用方）。`mainAgentAutoCompact*` 与 `runtime_policy.context.auto_compact_*` 存储字段/API 保留兼容。
- runner：`context-window.ts` 删两函数（随3.1）+ 对应测试用例删除；`pi-index.ts:361-365` 与 `runtime/types.ts` `autoCompactEnabled` 注释按「界面已下线」决策更新。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 第三方预填（`runtime-config.ts` buildClaudeEnvLines）**不动**——属 Claude SDK 遗留 env，归 ISSUE-10。
- `docs/runtime-migration.md` Known risks 该行更新为「旋钮已下线、注入链停用」。

### 3.6 ⑥ OAuth 凭据映射

- 宿主 `buildClaudeEnvLines`（`runtime-config.ts`）：官方端点（无 `anthropicBaseUrl`）且 OAuth-only（无 `anthropicApiKey`、无 `anthropicAuthToken`）时注入 `ANTHROPIC_AUTH_TOKEN=<claudeCodeOauthToken ?? claudeOAuthCredentials.accessToken>`；`CLAUDE_CODE_OAUTH_TOKEN` 与 `.credentials.json` 写入保留（遗留面归 ISSUE-10）。凭据仅入 0600 env 文件/hostEnv，不入日志（宪法第 3 条）。
- runner `pi-index.ts:354-355` 拆分：`apiKey: process.env.ANTHROPIC_API_KEY`、`authToken: process.env.ANTHROPIC_AUTH_TOKEN`；`pi-provider.ts`：官方分支仅 `apiKey` 走 `setRuntimeApiKey`，`authToken` 存在而 `apiKey` 为空时**不 set**，留 env 由 Pi `anthropicApiKeyAuth.resolve` 走 Bearer 发现路径（`anthropic.js:21-28` 已核实）。custom 分支注册 `apiKey: ANTHROPIC_API_KEY` 不变；第三方 Bearer 代理模式（`ANTHROPIC_AUTH_TOKEN`+baseUrl）折入注册 apiKey 的旧行为是否随拆分转为 env 发现，实现时以测试钉住（见 §5 风险）。
- 顺带修复（同段代码）：first-party `anthropicAuthToken` provider 不再被降级为 X-Api-Key，按 Pi 语义走 Bearer。
- Web `ProviderEditor.tsx` 官方认证区（oauth/setup_token tab）加注：「Pi 运行时以 Bearer Token 生效；不自动刷新，过期需重新授权/导入」；`ProviderList.tsx` OAuth/Setup Token 标签保留。

## 4. 测试方案（TDD，先红后绿）

新增 `tests/pi-runtime-settings-and-credentials.test.ts`（整合 + 源码契约混合，沿用 ISSUE-02 测试风格）：

1. **①** `resolvePiProvider`：custom 端点注册 `contextWindow` = 声明值；官方模型带声明 → 浅拷贝覆盖且**目录原对象未被修改**；无声明官方 → 目录值保留；`[1m]` 旧宿主 → 1M 覆盖；`pi-index.ts` 源码契约：`sessionOptions` 传递 `provider.contextWindow`。
2. **②** env 契约：system settings 配置了 fallbackModel 时 env 行**不含** `CKQCLAW_FALLBACK_MODEL`；RESERVED 防冒充保留（custom env 注入该键仍被剥离）。
3. **③** 宿主：`toContainerAgentProfile`/`toRunnerAgentProfile` 对显式 effort 下发、`inherit` 不下发；runner：`resolveAgentThinkingLevel` 优先级 Agent > env > undefined，env 垃圾值忽略；`pi-index.ts` 源码契约：`sessionOptions.thinkingLevel` 接线。
4. **④** Web DOM：选择卡不存在、说明段存在；表单提交仍携带存量 `prompt_mode`（API 兼容）。
5. **⑤** env 契约：`AUTO_COMPACT_*` 不再注入、继承 strip 仍生效；DOM：覆盖编辑控件不存在、注记存在。
6. **⑥** `buildClaudeEnvLines`：OAuth-only 官方 → `ANTHROPIC_AUTH_TOKEN` 注入；同时配 API key → 不注入（避免优先级歧义）；custom 端点 → 不注入。`resolvePiProvider`：仅 apiKey → `setRuntimeApiKey` 调用；仅 authToken → **不调用**（env 发现路径）；custom 注册 apiKey 语义钉住。凭据一律假 token fixture（secret 扫描白名单机制已有先例）。

既有测试更新：`tests/agent-runner-provider-runtime.test.ts`（删 `resolveClaudeQueryModelRuntime` 用例）、`tests/agent-runner-context-window.test.ts`（删两函数用例）、`tests/provider-model-fallback-contract.test.ts`（重写为不注入契约）、`tests/runtime-config-env.test.ts`、`tests/provider-model-settings.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`tests/agent-profiles-page-dom.test.tsx`。

## 5. 范围与约束（`.gatescope.json`）

allow：`container/agent-runner/src/provider-runtime.ts`、`container/agent-runner/src/context-window.ts`、`container/agent-runner/src/runtime/types.ts`、`container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/pi-index.ts`、`container/agent-runner/src/types.ts`、`src/runtime-config.ts`、`src/container-runner.ts`、`src/index.ts`、`src/task-scheduler.ts`、`src/agent-profile-runtime.ts`、`web/src/components/settings/SystemSettingsSection.tsx`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/components/agents/AgentPromptEditor.tsx`、`web/src/components/settings/ProviderEditor.tsx`、`tests/pi-runtime-settings-and-credentials.test.ts`（新增）、`tests/agent-runner-provider-runtime.test.ts`、`tests/agent-runner-context-window.test.ts`、`tests/provider-model-fallback-contract.test.ts`、`tests/runtime-config-env.test.ts`、`tests/provider-model-settings.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`tests/agent-profiles-page-dom.test.tsx`、`docs/issue04-pi-runtime-settings-and-credentials-plan.md`（本文）、`docs/issues/ISSUE-04-pi-runtime-settings-and-credentials.md`、`docs/issues/README.md`、`docs/runtime-migration.md`、`CLAUDE.md`。

**非目标**：`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`CKQCLAW_AGENT_MCP_POLICY`/`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 等其他 Claude 遗留 env（ISSUE-10）；`prompt_mode`/`includeClaudePreset` 契约层彻底下线（ISSUE-11）；`system_settings`/`runtime_policy` 存储字段与 API 删除（ISSUE-09/10）；custom 注册 `maxTokens: 32_000` 写死（另案）；Pi auth.json 写入式 OAuth 刷新客户端（超范围）；DB 零改动；`shared/` 零改动（不涉 `make sync-types`）。

## 6. 风险与应对

- **③ 成本行为变化**（第三方默认 max 真实生效）：已向用户明示并拍板，交付记录再登记；用户可用 Agent 级 effort 或 provider 高级设置显式调低。
- **⑥ 第三方 Bearer 代理行为**：runner 拆分 authToken 后，custom 注册端点的 AUTH_TOKEN 消费方式可能从「折入 apiKey（X-Api-Key）」转为「Pi env 发现（Bearer）」——实现时先核 Pi 注册 provider 的凭据解析路径并以集成测试钉住；若 Pi 对注册 provider 不做 env 发现，则 custom 分支保留折入并在交付记录注明差异。
- **① 官方目录对象污染**：覆盖必须浅拷贝，测试显式断言原对象未变。
- **④⑤ 表单残留状态**：删除编辑控件后 dirty/payload 逻辑需同步清理（payload 继续携带存量值，防 API 兼容破坏）；DOM 测试同步更新。
- **敏感纪律**：env 测试一律假 token；不把凭据/端点/模型名写入测试或日志（宪法第 3 条，pre-commit secret 扫描为第二道防线）。
- **实机验收**：①③⑥ 的端到端生效（含 OAuth-only provider 真跑）属用户侧操作（真实 Provider 会产生费用），交付记录登记待用户复测项。
