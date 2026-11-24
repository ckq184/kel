# ISSUE-24 供应商表单无法配置多个自定义请求头

| 字段          | 值                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                            |
| 领取人 / 分支 | `claude/cool-mayer-764510`                                                                                                        |
| 优先级        | P3                                                                                                                                |
| 类型          | 功能缺口（Web 表单与 schema）                                                                                                     |
| 依赖          | 无                                                                                                                                |
| 阻塞          | 无                                                                                                                                |
| 预计改动路径  | `web/src/components/settings/ProviderEditor.tsx`、`web/src/components/settings/types.ts`、`src/schemas.ts`，以及相应的 `tests/**` |
| 需用户决策    | **是**：表单形态（多行值编辑、专用请求头字段等）与存储格式                                                                        |
| 来源          | ISSUE-21 A5（原登记于 ISSUE-18 交付记录），用户 2026-11-23 拍板“拆成独立 issue”                                                   |

## 现象

ISSUE-18 让 Pi runner 按 Claude Code 约定解析 `ANTHROPIC_CUSTOM_HEADERS`（每行一个 `Name: Value`）。但 Web 供应商表单的自定义环境变量是“一行一个 `KEY=value`”，值里不能换行，所以只能配置**一个**请求头。

## 需用户决策

- 方案 1：自定义环境变量支持多行值（例如值内允许转义换行），schema 与存储格式随之调整。
- 方案 2：供应商表单新增专用“自定义请求头”字段，保存时拼成 `ANTHROPIC_CUSTOM_HEADERS`。
- 方案 3：只在文档写明限制。

## 验收建议

- 能在 Web 配置至少两个请求头，runner 解析后两个头都生效；旧数据兼容读取。

## 交付记录

交付日期 2026-11-24，分支 `claude/cool-mayer-764510`，base `e6c62ec`。

### 提交

| 提交      | 内容                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `18208a4` | 立项：领取、立项计划 `docs/issue24-provider-multi-custom-headers-plan.md`、`.gatescope.json`                                       |
| `b44a702` | 新增 `web/src/utils/custom-headers.ts`（请求头行与 customEnv 互转、校验）与 `buildCustomEnv` 的 `manageCustomHeaders` 拦截，含测试 |
| `6b0af2a` | `ProviderEditor.tsx` 接线：第三方供应商的「自定义请求头」行编辑器                                                                  |
| 本提交    | 交付落档：状态改为已完成、交付记录、README 索引                                                                                    |

### 用户拍板（2026-11-24）

1. 方案 ②：供应商表单新增专用「自定义请求头」字段，保存时拼成 `ANTHROPIC_CUSTOM_HEADERS`。
2. 交互：行编辑器（头名 + 值，可增删），与环境变量编辑器同款。
3. 值不按密钥处理：沿用现状，明文存在 `customEnv`，前端值框默认打码、可切换显示。
4. 冲突：迁入专用字段并拦截。打开编辑时把已有值拆成请求头行、不再出现在环境变量列表；环境变量里新加该键被拦截，提示改用「自定义请求头」。
5. 引导页 `/setup/providers` 不改。
6. 前端校验与 runner 同规则（头名 RFC 9110 token、值非空、值不含除 Tab 外的控制字符），不合格拒绝保存并指出第几个请求头；两格都空的占位行忽略。
7. 头名大小写不敏感重名：拒绝保存并提示重复。
8. 旧值里解析不了的行：整行放进头名格、值留空，由保存校验拦住，用户修改或删除后才能保存。
9. 只在第三方供应商显示该字段；官方供应商的环境变量保持现状（不迁移、不拦截）。

### 实现要点

- 存储与后端未改：仍是 `customEnv.ANTHROPIC_CUSTOM_HEADERS`，每行一个 `Name: Value`。后端 `sanitizeCustomEnvValue` 早已对该键保留换行，Host 与 Container 两种模式都能把多行值完整送到 runner（`tests/runtime-config-env.test.ts` 已有用例）。
- `custom-headers.ts`：`parseCustomHeaderRows`（旧值 → 行，兼容 CRLF，值里的冒号保留）、`buildCustomHeadersValue`（行 → 值并校验，错误只写序号和原因、不回显值）、`extractCustomHeaders` / `applyCustomHeaders`（与 customEnv 的迁入和写回，没有请求头时不写该键，编辑保存即删除该键）。
- 编辑模式 PATCH 整体替换 `customEnv`，所以删光请求头行后保存会删除该键。

### 验证

- 新增 `tests/issue24-provider-multi-custom-headers.test.ts`，共 23 例：旧数据兼容读取 4 例（无头、单头、多头含 CRLF、坏行）、序列化与校验 8 例（含与 runner `parseCustomHeaders` 往返两个头都生效、错误不回显值）、迁入与写回 5 例（含旧单头加载后原样保存）、拦截 2 例、ProviderEditor 与引导页源码契约 4 例。先跑确认红（模块不存在），工具实现后接线契约 3 例仍红，接线后全绿。测试只用无意义占位值。
- `npm run verify` 六步全绿（359 文件，2950 过 23 跳 0 败）；`node scripts/check-scope.mjs` 8 个路径全在声明范围内，没有扩宽。
- 未做实机验收，由用户决定。建议：在第三方供应商的「高级设置」里添加两个请求头保存，重开编辑确认两行都在；发送消息确认 runner 无请求头告警且端点正常。

### 与 issue 描述的偏差和登记项

- 预计改动路径列了 `web/src/components/settings/types.ts` 与 `src/schemas.ts`，实际都不需要改（存储格式不变）；新增了 `web/src/utils/custom-headers.ts` 并改了 `web/src/utils/custom-env.ts`。
- 登记（未处理）：官方供应商的环境变量值框仍是单行输入；若旧数据里官方供应商存了多行 `ANTHROPIC_CUSTOM_HEADERS`，编辑保存会被浏览器合并成一行。按 ISSUE-18 拍板 2 官方分支本就不读请求头，影响为零，按拍板 9 不处理。
