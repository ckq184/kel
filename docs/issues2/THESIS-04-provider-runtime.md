# THESIS-04 供应商（三）：Runner 与环境变量回退只剩第三方路径

| 字段          | 值                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                   |
| 领取人 / 分支 | THESIS-04 会话 / `claude/thesis-04-provider-runtime`                                                                                                                                                                                                     |
| 优先级        | P1                                                                                                                                                                                                                                                       |
| 类型          | 裁剪（运行时）                                                                                                                                                                                                                                           |
| 依赖          | 无                                                                                                                                                                                                                                                       |
| 阻塞          | THESIS-05（同改 `src/runtime-config.ts`，需串行）                                                                                                                                                                                                        |
| 可并行        | ✅ 01、02、03、06、07、08、09、11、12、13、15。⚠️ 10（`src/runtime-config.ts`，改动相距约 10 行）。❌ 05（依赖本包，且同改 `src/runtime-config.ts`）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                  |
| 预计改动路径  | `container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/provider-runtime.ts`、`src/runtime-config.ts`（仅 `defaultsFromEnv` 与 `buildClaudeEnvLines` 的 endpoint 标记）、`tests/**`；若动共享类型再加 `shared/**` 与同步副本 |
| 需用户决策    | **是**：D-2（没有 Base URL 时的回退）                                                                                                                                                                                                                    |
| 来源          | 方案 §5（T3）                                                                                                                                                                                                                                            |

## 目标

运行时只有一条路径：把第三方端点注册为独立的 `ckqclaw-*` provider。runner 不再走 Pi 内置的 anthropic 官方模型目录。

## 范围（锚点为 `d6e04aa`）

1. **`resolvePiProvider`**（`pi-provider.ts:131`）：删除官方分支（:152-168 "无模型、非 custom、无 Base URL 时用内置默认模型"；:213-215 `setRuntimeApiKey('anthropic', …)`；:217-223 对 `getModel` 的兼容回退）与 `getModel` 的兼容导入（:2）。按 D-2，遇到 `endpointKind === 'official'` 或缺少 Base URL 时给出明确错误。
2. **`provider-runtime.ts:50-55`**：缺标记且没有 `ANTHROPIC_BASE_URL` 时默认 `official` 的回退，按 D-2 处理。
3. **宿主侧**：`defaultsFromEnv`（`src/runtime-config.ts:1681`）读取 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 的回退按 D-2 处理；`buildClaudeEnvLines` 里由"有无 Base URL"推导 `endpointKind`（:2264）的逻辑与 D-2 对齐。

保留：第三方注册（`pi-provider.ts:173-212`）、子代理继承父模型（`pi-subagents.ts:18-30`，ISSUE-22）、自定义请求头（`parseCustomHeaders`，ISSUE-18、ISSUE-24）、上下文窗口声明（ISSUE-04）。

## 非目标

- 不删凭据写入与会话凭据刷新（THESIS-05）。
- 不改 `claude-provider.json` 存储格式。
- 不改 Docker 模式与 `host_claude` 上下文解析。

## 需用户决策（领取前拍板）

| #   | 问题                   | 选项                                                                                                                             | 审核建议 |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D-2 | 没有 Base URL 时的回退 | ① 保持现状；② 宿主要求必须有 `ANTHROPIC_BASE_URL`，runner 遇到 official 直接报错；③ 在 ② 的基础上去掉环境变量回退，只认 Web 配置 | ②        |

现状下"只有 API Key、没有 Base URL"等于直连 Anthropic 官方端点，与"只保留第三方"的目标不一致，所以不建议 ①。

## 执行前核实

- `endpointKind` 的类型 `'official' | 'custom'` 是否定义在共享类型里。若收窄共享类型，改完执行 `make sync-types`，`make typecheck` 会检查副本一致性。
- 对 `getModel`、`setRuntimeApiKey`、`endpointKind` 做一次 `git grep -w`，范围包含 `container/agent-runner/` 与 `tests/`。
- `tests/agent-runner-provider-runtime.test.ts` 覆盖的正是 `provider-runtime.ts:50-55`（审核 S6，原方案清单漏列），同步改写。

## 实现步骤（TDD）

1. **Red**：
   - runner 用例：`endpointKind` 为 `official`、或缺少 Base URL 时，按 D-2 报出可读的错误；
   - 宿主用例：`defaultsFromEnv` 按 D-2 处理只有 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN` 的环境；
   - 第三方注册、子代理继承父模型、自定义请求头、上下文窗口的既有用例保持通过。
2. **Green**：按范围 1 至 3 修改。
3. **测试同步**：`tests/agent-runner-provider-runtime.test.ts`、`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/runtime-config-env.test.ts` 中的官方用例。

## 验收条件

1. runner 单测全绿；动了共享类型时 `make sync-types` 后没有差异。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. **人工冒烟（用户）**：用第三方供应商跑通一次流式对话，主机模式和容器模式各一次；子代理（Explore）正常。

## 风险与回滚

- **演示依赖第三方端点**：裁剪后无法直连 Anthropic 官方，演示前须确认有可用的第三方端点（方案 §14 第 5 项）。
- 真实 Provider 冒烟会产生费用，不要把凭据、Endpoint、模型名写进日志或交付记录。
- **回滚**：`git revert <提交号>`。

## 交付记录

交付日期 2026-11-24，分支 `claude/thesis-04-provider-runtime`，base `17113e9`。

### 提交

| 提交      | 内容                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `e0e65f0` | 立项：领取、立项计划 `docs/thesis-04-provider-runtime-plan.md`、`.gatescope.json`                         |
| `8886aa3` | 实现：runner 官方分支删除、`providerError` 预检、宿主 env 回退与 endpoint marker 收口，含 Red/回归测试    |
| `541f858` | 文档同步：`CLAUDE.md` 过时事实订正、allow 扩宽说明、pi-index 预检用例加固                                 |
| `d6fbcce` | 代码质量审查 Major 修复：共享错误策略与文案（`resolveProviderConfigError`），删除冗余 `withContextWindow` |
| `fd2ecf9` | 非阻塞残留：窗口注释订正、两层文案一致性断言改为精确比较                                                  |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引、`docs/审查记录.md`                                       |

### 用户拍板（2026-11-24）

**D-2 ②**：宿主要求必须有 `ANTHROPIC_BASE_URL`，runner 遇到 `official` 或缺 Base URL 时直接报可读错误；环境变量回退只在有 Base URL 时生效，官方专用的 `CLAUDE_CODE_OAUTH_TOKEN` 回退去掉；纯环境变量配第三方的部署方式保留。

### 实现要点

- `container/agent-runner/src/provider-runtime.ts`：新增 `providerError`；导出三条共享错误文案与 `resolveProviderConfigError`。`official` 标记（即使带 stale Base URL）与缺 Base URL 均报配置错误；缺标记但有 Base URL 仍按 `custom` 兼容旧宿主；`missingRequiredModel` 语义不变。
- `container/agent-runner/src/pi-index.ts`：`providerError` 在 `missingRequiredModel` 之前预检，走既有 `status: 'error'` 结构化输出；缺模型提示改用共享文案。运行时不启动会话、不注册 provider、不写凭据。
- `container/agent-runner/src/runtime/pi/pi-provider.ts`：删除官方分支（内置 anthropic 目录回退、`setRuntimeApiKey('anthropic', …)`、`pi-ai/compat` 的 `getModel` 导入与兜底）；只保留第三方注册路径，`custom: true`；注册参数（providerId、base URL、apiKey/authToken 折叠、模型定义、headers、可用性收窄）与改动前逐项等价。删除注册后无实际作用的 `withContextWindow`。
- `src/runtime-config.ts`：`defaultsFromEnv` 的 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 回退以 Base URL 为前提，`CLAUDE_CODE_OAUTH_TOKEN` 回退去掉（含 catch 分支）；`buildContainerEnvLines` 只在有 Base URL 时写 `CKQCLAW_CLAUDE_ENDPOINT_KIND=custom`；`clearInheritedClaudeProviderEnv` 注释去掉官方口径。
- `CLAUDE.md`：常见修改入口的上下文窗口行改为"第三方端点替换写死 200k、无声明保留注册值"。
- 未动 `shared/`，无需 `make sync-types`。

### 验证

- 新增 `tests/thesis-04-provider-runtime.test.ts`（8 例）：宿主"仅 API Key / 仅 OAuth token / Base URL + OAuth token"不形成官方凭据，Base URL + API Key/Auth Token 仍可用，endpoint marker 只在有 Base URL 时写入，runner 源码契约。
- 改写 `tests/agent-runner-provider-runtime.test.ts`、`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/pi-custom-provider-headers.test.ts`、`tests/pi-subagent-custom-provider.test.ts`、`tests/runtime-config-env.test.ts`：official 用例改为拒绝语义；补垃圾 marker、空白 Base URL、apiKey 优先级、两层文案一致性用例；第三方注册、子代理继承、自定义请求头、上下文窗口声明的既有用例保持。
- `npm run verify` 六步全绿（361 文件，2985 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 16 个路径全在声明范围内。
- 独立规格符合性审查：初轮不通过（`CLAUDE.md` 修正未提交导致证据错位），提交 `541f858` 后复核通过；独立代码质量审查：通过（Critical 0 / Major 1 已修复并复核 / Minor 6），详见 `docs/审查记录.md`。
- **人工冒烟未执行**：由用户用第三方供应商跑通主机/容器各一次流式对话，并验证 Explore 子代理。

### 与 issue 描述的偏差和登记项

- **范围扩宽 3 个文件**（理由见 plan §3）：`container/agent-runner/src/pi-index.ts`（结构化错误预检出口）、`container/agent-runner/src/runtime/types.ts`（`authToken`/`contextWindow` 注释随契约订正）、`CLAUDE.md`（上下文窗口行失实订正）。
- **`sdkQuery` 残留官方路径（后续项，本包未改）**：`src/sdk-query.ts` 在无 Base URL 时仍会 `setRuntimeApiKey('anthropic')` 并使用内置 catalog；调用方包括 `src/routes/bug-report.ts`、`src/routes/tasks.ts`、`src/agent-profile-generator.ts`、`src/index.ts`。其中 `bug-report` 与 `agent-profile-generator` 另有 Base URL 判定，`tasks`（任务解析）与 `index`（对话摘要/标题）在存量官方供应商未删除时仍可能走到；D-1 ① 要求用户先删除官方供应商。建议后续独立 issue 或并入 THESIS-05 收口。
- **宿主残留官方凭据投递（THESIS-05）**：`buildClaudeEnvLines` 的 stored OAuth → `ANTHROPIC_AUTH_TOKEN` 映射（`src/runtime-config.ts`）与 `container-runner.ts` 的 `.credentials.json` 写入仍存在，但 runner 现在会直接拒绝无 Base URL 配置，这些路径对运行已不可达；删除归 THESIS-05。
- **`docs/runtime-migration.md:162-167` 过时陈述**：仍称 OAuth/setup-token 经 `ANTHROPIC_AUTH_TOKEN` 抵达 Pi。建议 THESIS-05 执行时把该文件补入其预计改动路径并一并订正（THESIS-05 现有范围未列该文件）。
- **`PiProviderResolution.custom` 恒真**：`pi-runtime.ts` 的 `modelResolution.custom ? ... : []` 官方分支已不可达；不影响正确性，列后续清理（连同字段与契约正则一起删）。
- **源码字符串契约**：`tests/thesis-04-provider-runtime.test.ts` 的 compat 导入守卫与预检顺序断言依赖源码文本/引号风格，属仓库既有先例；预检策略已抽成纯函数，行为面有直接单测。
- 未改 `docs/API.md`、`docs/ACL-MATRIX.md`：本包无接口/权限变更；`grep` 确认无对应行需要同步。
