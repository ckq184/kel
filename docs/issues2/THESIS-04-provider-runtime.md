# THESIS-04 供应商（三）：Runner 与环境变量回退只剩第三方路径

| 字段          | 值                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                   |
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

（交付时填写）
