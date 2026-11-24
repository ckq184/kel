# 任务立项：ISSUE-24 供应商表单配置多个自定义请求头

> 立项日期：2026-11-24｜base：`e6c62ec`｜分支：`claude/cool-mayer-764510`
> 来源：`docs/issues/ISSUE-24-provider-multi-custom-headers.md`

## 0. 需求采访结论（2026-11-24）

- **目标**：在 Web 供应商表单里能配置两个及以上自定义请求头，runner 按 ISSUE-18 的规则解析后全部生效。
- **完成条件**：第三方供应商表单可增删多行请求头，保存为每行一个 `Name: Value` 的 `customEnv.ANTHROPIC_CUSTOM_HEADERS`；旧数据（单个头、无头、含解析不了的行）都能正确读入；单测覆盖解析、序列化、校验、拦截与 runner 端往返；`npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过。
- **约束**：请求头的值不得写进日志、测试或文档（测试只用无意义的占位值）；后端与存储不改。

### 用户拍板

| #   | 问题                         | 拍板                                                                                                                   |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | 方案                         | ② 供应商表单新增专用「自定义请求头」字段，保存时拼成 `ANTHROPIC_CUSTOM_HEADERS`                                        |
| 2   | 交互形式                     | 行编辑器：每行头名 + 值，可增删，与环境变量编辑器同款                                                                  |
| 3   | 值是否按密钥处理             | 沿用现状：明文存在 `customEnv`，前端值框默认打码、可切换显示                                                           |
| 4   | 与环境变量里已有的同名键冲突 | 迁入专用字段并拦截：打开时拆成请求头行、不再出现在环境变量列表；环境变量里新加该键被拦截并提示改用「自定义请求头」     |
| 5   | 引导页 `/setup/providers`    | 不改，只改供应商表单                                                                                                   |
| 6   | 前端校验                     | 与 runner 同规则（头名 RFC 9110 token、值非空、值不含除 Tab 外的控制字符），不合格拒绝保存并指出第几个请求头；空行忽略 |
| 7   | 重名（大小写不敏感）         | 拒绝保存并提示重复                                                                                                     |
| 8   | 旧数据里解析不了的行         | 整行放进头名格、值留空，由保存校验拦住，用户修改或删除后才能保存                                                       |
| 9   | 官方供应商                   | 只在第三方供应商显示该字段；官方供应商的环境变量保持现状（不迁移、不拦截）                                             |

## 1. 关键事实

- 后端已支持多行：`sanitizeCustomEnvValue` 对 `ANTHROPIC_CUSTOM_HEADERS` 保留换行；Container 模式经 shell 单引号写环境文件、Host 模式按首个 `=` 切分，多行值完整到达 runner（`tests/runtime-config-env.test.ts` 已锁定）。
- 卡点在 Web：值输入框单行，且保存时 `envRowsToText` 拼文本后 `buildCustomEnv` 按 `\n` 拆分。

## 2. 方案

| 步骤 | 文件                                                        | 内容                                                                                                                                      |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `web/src/utils/custom-headers.ts`（新）                     | `parseCustomHeaderRows(raw)`：旧值 → 行；`buildCustomHeadersValue(rows)`：行 → `{ value, error }`，校验规则同拍板 6、7                    |
| 2    | `web/src/utils/custom-env.ts`                               | `buildCustomEnv` 新增选项 `manageCustomHeaders`，为真时拦截 `ANTHROPIC_CUSTOM_HEADERS`                                                    |
| 3    | `web/src/components/settings/ProviderEditor.tsx`            | 第三方供应商：加载时迁入请求头行并从环境变量行剔除；新增请求头行编辑器；保存时校验并写入 `customEnv`（无头则不写，编辑时即删除该键）      |
| 4    | `tests/issue24-provider-multi-custom-headers.test.ts`（新） | TDD：旧数据兼容读取（单头、无头、多头、坏行、CRLF）、序列化与校验、拦截、与 runner `parseCustomHeaders` 往返、ProviderEditor 接线源码契约 |

非目标：后端 schema 与存储变更、加密存储、引导页、官方供应商的请求头、按 Session 生成会话头。

## 3. 回滚点

`e6c62ec`。
