# 任务立项：THESIS-04 供应商（三）：Runner 与环境变量回退只剩第三方路径

> 立项日期：2026-11-24｜base：`17113e9`｜分支：`claude/thesis-04-provider-runtime`
> 来源：[docs/issues2/THESIS-04-provider-runtime.md](issues2/THESIS-04-provider-runtime.md)（方案 §5 T3，审核更正 S6）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：运行时只剩第三方端点一条路径。runner 不再走 Pi 内置的 anthropic 官方模型目录，也不再用环境变量兜底成官方直连。
- **完成条件**：`endpointKind` 为 `official`、或第三方配置缺少 `ANTHROPIC_BASE_URL` 时，runner 给出可读错误；第三方注册、子代理继承父模型、自定义请求头、上下文窗口声明的既有行为不变；宿主环境变量回退只在有 Base URL 时生效；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改 `claude-provider.json` 存储格式（version 5）与迁移链；不动 OAuth 凭据写入与会话凭据刷新（THESIS-05）；不动前端（THESIS-03）；不读不写 `data/`。

| #   | 问题                           | 拍板                                                                                                                                                                                                                                             |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-2 | 没有 Base URL 时的回退怎么处理 | **②**（用户 2026-11-24 拍板）：宿主要求必须有 `ANTHROPIC_BASE_URL`，runner 遇到 `official` 或缺 Base URL 时直接报可读错误；环境变量回退只在有 Base URL 时生效，官方专用的 `CLAUDE_CODE_OAUTH_TOKEN` 回退去掉。纯环境变量配第三方的部署方式保留。 |

## 1. 关键事实（开工前核实）

- **运行时契约**：`endpointKind: 'official' | 'custom'` 定义在 `container/agent-runner/src/provider-runtime.ts` 与 `runtime/types.ts`，**不在 `shared/`**，不需要 `make sync-types`。
- **`provider-runtime.ts` 的调用方**只有 `container/agent-runner/src/pi-index.ts`（`resolveClaudeProviderRuntime(process.env)`）与测试；无其他生产调用方。
- **`resolvePiProvider` 的官方分支**（`container/agent-runner/src/runtime/pi/pi-provider.ts`）：
  - `:152-168` 无模型、非 custom、无 Base URL 时回退 Pi 内置 anthropic 模型目录，并可把 API Key 写成 stored credential；
  - `:213-215` 非 custom 且 `providerId === 'anthropic'` 时 `setRuntimeApiKey('anthropic', …)`；
  - `:217-223` 对 `modelRuntime.getModel` 失败时用 `pi-ai/compat` 的 `getModel` 兜底；
  - `:2` 兼容导入 `getModel`。
- **官方分支之外**：第三方注册（`registerProvider`）、`restrictAvailableModelsToProvider`（子代理继承父模型）、`parseCustomHeaders`、`contextWindow` 覆盖都在 custom 路径里，与本任务目标一致，保留。
- **宿主侧**：
  - `defaultsFromEnv`（`src/runtime-config.ts`）在无存储配置时读 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_MODEL`；现状下"只有 API Key / OAuth token、没有 Base URL"会形成官方直连配置。
  - `buildContainerEnvLines` 由"有无 Base URL"推导 `CKQCLAW_CLAUDE_ENDPOINT_KIND`，无 Base URL 时写 `official`。
- **THESIS-02 已合入**：接口层只接受 `third_party`，"是否已配置"判定要求 Base URL；本包不再重复处理接口与判断。
- **测试面（初始红）**：`tests/agent-runner-provider-runtime.test.ts`、`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/pi-custom-provider-headers.test.ts`、`tests/pi-subagent-custom-provider.test.ts` 含 official 用例；`tests/runtime-config-env.test.ts` 含 official 标记与 OAuth 映射用例。第三方路径的既有用例必须保持通过。
- **红线**：不读不写 `data/`；不改存储格式与迁移；不动 OAuth 凭据写入/刷新函数本体、`.credentials.json` 相关逻辑（THESIS-05）；不动前端。

## 2. 实现步骤（TDD）

1. **Red**：
   - 新增 `tests/thesis-04-provider-runtime.test.ts`：
     - `resolveClaudeProviderRuntime`：`official` 标记（即使带 Base URL）报"不再支持官方端点"；缺标记且无 Base URL 报"需要 `ANTHROPIC_BASE_URL`"；缺标记但有 Base URL 仍按 `custom` 兼容旧宿主；`custom` + Base URL + 模型无错误。
     - `resolvePiProvider`：`endpointKind: 'official'` 与缺 Base URL 分别 reject，错误文案可读；官方路径不得产生 `registerProvider` / `setRuntimeApiKey` 副作用。
     - 宿主：临时 `DATA_DIR` + 环境变量，`getClaudeProviderConfig()` 对"只有 `ANTHROPIC_API_KEY`"和"只有 `CLAUDE_CODE_OAUTH_TOKEN`"不产生凭据；有 Base URL 时 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 正常生效。
     - 源码契约：`pi-provider.ts` 不再导入 `@earendil-works/pi-ai/compat`、不再调用 `setRuntimeApiKey('anthropic'`；`pi-index.ts` 使用预检错误。
   - 按新语义改写四个 runner 测试文件里的 official 用例。
2. **Green**：
   - `provider-runtime.ts`：官方标记与缺 Base URL 不再回退成可运行配置，返回可读的 `providerError`；`missingRequiredModel` 语义保持。
   - `pi-index.ts`：在 `missingRequiredModel` 预检之前输出 `providerError`（沿用 `status: 'error'` 结构化输出）。
   - `pi-provider.ts`：删除官方分支、`setRuntimeApiKey('anthropic', …)`、`getModel` 兼容导入与兜底；官方/缺 Base URL 显式报错；第三方注册路径不变。
   - `src/runtime-config.ts`：`defaultsFromEnv` 的凭据回退以 Base URL 为前提，去掉 `CLAUDE_CODE_OAUTH_TOKEN` 回退；`buildContainerEnvLines` 只在有 Base URL 时写 `CKQCLAW_CLAUDE_ENDPOINT_KIND=custom`。
3. **测试同步**：`tests/agent-runner-provider-runtime.test.ts`、`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/pi-custom-provider-headers.test.ts`、`tests/pi-subagent-custom-provider.test.ts`、`tests/runtime-config-env.test.ts`；全量 vitest 确认无连带打红。
4. **文档**：`docs/API.md`、`docs/ACL-MATRIX.md` 无对应接口/权限变更，执行时 `grep` 确认；`npm run docs:check`。
5. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`CLAUDE.md`、`docs/issues2/THESIS-04-provider-runtime.md`、`docs/issues2/README.md`、`docs/thesis-04-provider-runtime-plan.md`、`docs/审查记录.md`、`container/agent-runner/src/provider-runtime.ts`、`container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/types.ts`、`container/agent-runner/src/pi-index.ts`、`src/runtime-config.ts`、`tests/**`。

超出 issue 预计改动路径的三个文件：

- `pi-index.ts`：runner 的结构化错误出口与既有 `missingRequiredModel` 预检都在该文件，预检错误必须在这里输出，否则只能靠未捕获异常退出（宿主只能看到通用失败）。
- `runtime/types.ts`：只改 `provider.authToken` 的注释。原注释以"官方端点不落 stored key"为理由，官方路径删除后该理由失效，属随契约同步的事实订正，无类型/行为改动。
- `CLAUDE.md`：§常见修改入口的"上下文窗口声明"一行仍写"官方端点浅拷贝覆盖目录值"，官方路径删除后失实，改为"第三方端点替换写死 200k、无声明保留注册值"。

`docs/API.md`、`docs/ACL-MATRIX.md` 经 grep 确认无对应接口/权限行需要同步；`docs/runtime-migration.md` 的 OAuth 映射陈述属历史迁移记录，留给 THESIS-05 删除该映射时一并订正（登记在交付记录）。

## 4. 验收条件

1. `endpointKind` 为 `official`、或缺 Base URL 时，runner 输出可读错误（含 `ANTHROPIC_BASE_URL` 指引），不产生任何 provider 注册或凭据写入副作用。
2. 第三方注册、子代理继承父模型、自定义请求头、上下文窗口声明的既有用例全绿。
3. 宿主"只有 `ANTHROPIC_API_KEY`"或"只有 `CLAUDE_CODE_OAUTH_TOKEN`"的环境不再形成可用凭据；"Base URL + API Key/Auth Token"的纯环境变量配置仍可用。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 人工冒烟（用户）：用第三方供应商跑通一次流式对话，主机模式与容器模式各一次；子代理（Explore）正常。

## 5. 非目标

- 不删 OAuth 凭据写入、`writeCredentialsFile`、`updateAllSessionCredentials`、`.credentials.json` 清理（THESIS-05）。
- 不收窄存储层的 `official` 类型与 `claude-provider.json` 格式；不动迁移链。
- 不改前端（THESIS-03）、接口 Schema 与"已配置"判断（THESIS-02）。
- 不动 Docker 模式、`host_claude` 上下文解析、供应商池与健康检查。
- 不改 `sdkQuery`（`src/sdk-query.ts`）这条非 Pi 的辅助路径；如发现残留官方能力，登记给后续 issue。

## 6. 风险与回滚

- **演示依赖第三方端点**：裁剪后无法直连 Anthropic 官方，演示前须确认有可用的第三方端点（方案 §14 第 5 项）。
- **存量官方供应商**：按 THESIS-02 的 D-1 ① 由用户先删除；未删除时本包让 runner 报可读错误，不损坏数据、不静默改配置。
- **错误面变化**：未配置供应商时错误从 Pi 的"模型找不到"变为"需要 `ANTHROPIC_BASE_URL`"，属预期改进。
- **回滚**：`git revert <提交号>`；无数据迁移，回滚零额外操作。
