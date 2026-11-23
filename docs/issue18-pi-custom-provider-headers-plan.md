# 任务立项：ISSUE-18 Pi 运行时读取 ANTHROPIC_CUSTOM_HEADERS

> 立项日期：2026-11-23｜base：`38da090`｜分支：`claude/practical-khorana-1df554`
> 来源：`docs/issues/ISSUE-18-pi-custom-provider-headers.md`

## 0. 需求采访结论（2026-11-23）

- **目标**：自定义 Anthropic Messages 兼容端点能携带用户配置的额外请求头（如端点要求的会话头）。
- **完成条件**：`ANTHROPIC_CUSTOM_HEADERS` 在 Pi runner 被解析并经 `registerProvider` 生效；单测覆盖解析、透传、不传不变、官方分支不受影响、字面量不被模板解释；`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
- **约束**：四项用户拍板（见 issue）；凭据、Endpoint、模型名不得写进日志、测试或文档；真实端点实测由用户决定。

## 1. 关键事实

- Pi `ModelRuntime.getAuth(model)` 把注册模型的 `headers`（`rawModelHeaders`）合并进请求头；provider 级 `headers` 只在 API key 认证解析成功时合并。故头挂在**模型定义级**，不依赖是否配置了 key。
- Pi 把头值当配置值解析：开头 `!` 执行 shell 命令，`$VAR`/`${VAR}` 展开环境变量；`$$`、`$!` 为转义。用户填写的头值必须转义为字面量，否则可能执行命令或被意外替换。

## 2. 方案

| 步骤 | 文件                                                           | 内容                                                                                                                         |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | `container/agent-runner/src/runtime/pi/pi-provider.ts`         | 新增 `parseCustomHeaders(raw)` 返回 `{ headers, warnings }`；`escapePiConfigLiteral`；自定义分支模型定义带转义后的 `headers` |
| 2    | `container/agent-runner/src/runtime/types.ts`、`pi-runtime.ts` | `provider.headers` 字段与透传                                                                                                |
| 3    | `container/agent-runner/src/pi-index.ts`                       | 读 `ANTHROPIC_CUSTOM_HEADERS`，解析、告警（只打行号与原因）、传入                                                            |
| 4    | `tests/pi-custom-provider-headers.test.ts`                     | TDD 单测 + 生产接线源码契约                                                                                                  |

非目标：Web 表单字段、官方端点透传、按 Session 生成会话头、宿主侧变更。

## 3. 回滚点

`38da090`。
