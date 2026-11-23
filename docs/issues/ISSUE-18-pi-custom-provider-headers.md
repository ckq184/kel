# ISSUE-18 Pi 运行时读取 ANTHROPIC_CUSTOM_HEADERS：自定义供应商请求头透传

| 字段          | 值                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                             |
| 领取人 / 分支 | `claude/practical-khorana-1df554`                                                                                                                                                                                  |
| 优先级        | P1                                                                                                                                                                                                                 |
| 类型          | 掉线逻辑补生产链路（宿主继承的环境变量在 Pi runner 无消费者）                                                                                                                                                      |
| 依赖          | 无                                                                                                                                                                                                                 |
| 阻塞          | 无                                                                                                                                                                                                                 |
| 预计改动路径  | `container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`container/agent-runner/src/runtime/types.ts`、`container/agent-runner/src/pi-index.ts`、`tests/**` |
| 需用户决策    | **是**（2026-11-23 已四项拍板，见下）                                                                                                                                                                              |
| 来源          | 用户需求：把需要额外请求头的第三方 Anthropic Messages 兼容端点配成默认供应商                                                                                                                                       |

## 背景

某第三方 Anthropic Messages 兼容端点要求每个请求携带 `x-opencode-session` 请求头，缺失时返回 400。宿主
`src/runtime-config.ts` 已把 `ANTHROPIC_CUSTOM_HEADERS` 列入继承的 Provider 环境变量，且
`sanitizeCustomEnvValue` 为它保留换行；但 `container/agent-runner/src` 没有任何代码读取它（Claude SDK 时代
由 CLI 自行解析，迁到 Pi 后掉线）。`resolvePiProvider` 注册自定义供应商时也没有传 `headers`，而 Pi 的
`ProviderConfig` / 模型定义支持 `headers?: Record<string, string>`。

## 用户拍板（2026-11-23）

1. **头格式**：沿用 Claude Code 约定，每行一个 `Name: value`，按换行分隔；**非法行跳过并告警**（告警不打印值）。
2. **官方端点**：**只透传给自定义端点**，官方分支保持现状。
3. **Web 表单**：**不加**专用字段，只走环境变量（供应商「自定义环境变量」行或工作区自定义环境变量）。
4. **`x-opencode-session`**：**固定值**，由用户在头配置里填写，不做按 Pi Session 自动生成的特例。

## 验收标准

- 解析函数单测覆盖：合法多行、空行、CRLF、非法行（无冒号、非法头名、控制字符、空值）跳过并告警、重名后者生效。
- `resolvePiProvider` 传入 headers 时注册的模型请求头生效；不传时行为不变；官方分支不受影响。
- 头值按字面量发送（不被 Pi 的 `$VAR` 模板或 `!command` 语义解释）。
- `npm run verify` 与 `node scripts/check-scope.mjs` 通过。

## 交付记录

交付日期 2026-11-23，分支 `claude/practical-khorana-1df554`，base `38da090`。

### 提交

| 提交      | 内容                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `03710f9` | 立项：新建并领取 issue、立项计划 `docs/issue18-pi-custom-provider-headers-plan.md`、`.gatescope.json` |
| `080e139` | 实现与测试：`parseCustomHeaders`、`escapePiConfigLiteral`、模型级 headers 透传、`pi-index` 读取与告警 |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引                                                       |

### 实现要点

- `container/agent-runner/src/runtime/pi/pi-provider.ts`：`parseCustomHeaders(raw)` 按行解析 `Name: value`，兼容 CRLF；值里的冒号保留；头名大小写不敏感去重，后出现的生效。非法行（无冒号、空名、头名不符合 RFC 9110 token、空值、含控制字符）跳过，并返回 `{ line, message }` 告警，告警不含值。
- 头挂在**模型定义级** `models[].headers`，不挂 provider 级：Pi `ModelRuntime.getAuth` 总会合并模型级头，provider 级头只在 API key 认证解析成功时合并，没有 key 时会丢。
- `escapePiConfigLiteral`：Pi 会把头值当配置值解析（开头 `!` 执行 shell 命令，`$VAR` 展开环境变量），所以 `$` 转成 `$$`，开头的 `!` 转成 `$!`，保证按字面量发送，也防止通过头值执行命令。
- 官方分支不读取 `headers`（用户拍板 2）。
- `runtime/types.ts` 的 `provider.headers` 字段、`pi-runtime.ts` 适配器透传、`pi-index.ts` 读取 `process.env.ANTHROPIC_CUSTOM_HEADERS`，告警用 `logWarn` 只写行号和原因。
- 没有改共享类型（`runtime/types.ts` 是 runner 私有类型），不需要 `make sync-types`。

### 验证

- 新增 `tests/pi-custom-provider-headers.test.ts`，共 12 例：解析 5 例、转义 1 例、`resolvePiProvider` 4 例（用真实 `ModelRuntime.getAuth` 验证头生效且 `$HOME`、`!echo` 按字面量发送；没有 key 也能注册上头；不传或传空对象时注册结构不变；官方分支不注册、不带头）、生产接线源码契约 2 例。先跑确认红（10 败），实现后转绿。
- `npm run verify` 六步全绿（342 文件，2795 过 23 跳 0 败）；`node scripts/check-scope.mjs` 9 个路径全在声明范围内，没有扩宽。
- **未用真实端点实测**：会产生费用并涉及凭据，由用户决定是否做。配置方式：在供应商「自定义环境变量」里加一行 `ANTHROPIC_CUSTOM_HEADERS=<头名>: <固定值>`，然后在 Host 模式下发一条消息。

### 与 issue 描述的偏差和登记项

- 偏差：issue 说「传给 `registerProvider({ headers })`」，实际挂在 `registerProvider` 的模型定义级 `headers`，原因见上（provider 级在没有 key 时不生效）。
- 登记（未处理）：Web 供应商表单的自定义环境变量是「一行一个 `KEY=value`」，`ANTHROPIC_CUSTOM_HEADERS` 只能填**一个**头；多头需求需要另开 issue（用户拍板 3 不在本 issue 加表单字段）。
- 登记（未处理）：Pi 自带 `pi-ai` 的 `withOpenCodeSessionHeader`，内置的 opencode provider 会按 `sessionId` 自动加会话头；本项目走自定义 `ckqclaw-*` provider，用不到它。用户拍板 4 选了固定值，所以没有接入。
