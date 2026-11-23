# ISSUE-18 Pi 运行时读取 ANTHROPIC_CUSTOM_HEADERS：自定义供应商请求头透传

| 字段          | 值                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 进行中                                                                                                                                                                                                             |
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

（交付时填写）
