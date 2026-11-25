# 任务立项：THESIS-18 裁减遗留死代码清扫（宿主、Runner、脚本）

> 立项日期：2026-11-25｜base：`248c7cb`（main tip，THESIS-17 合入后）｜分支：`claude/thesis-18-dead-code-sweep`
> 来源：[docs/issues3/THESIS-18-dead-code-sweep.md](issues3/THESIS-18-dead-code-sweep.md)

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-S1 选 ①**：删除 `PiProviderResolution.custom` 字段与 `modelResolution.custom` 分支；`createSubagentInheritModelExtension()` 改为无条件挂载。ISSUE-22 的意图（自定义端点下子 Agent 继承父模型）保留，测试改为断言“扩展恒挂载”。
- **完成条件**：S1–S7 清单内符号在 `src/`、`container/`、`scripts/` 只剩否定断言；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不动供应商存储层 OAuth 闲置字段（D-4 ①）、`users` 保留列（D-F2 ①）、`src/db.ts` 的任何代码/迁移/`CURRENT_SCHEMA_VERSION`、ISSUE-26 的调度器残留；不做清单外“顺手清理”。

## 1. 执行前核实（base `248c7cb`）

| 项       | 复核结论                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1       | `OAuthUsageBucket`、`OAuthUsageResponse`、`CachedOAuthUsage` 仅定义于 `src/runtime-config.ts:233-247`；`CachedOAuthUsage` 无引用；前两者只被 S2 使用。                                                                         |
| S2       | `parseOAuthUsageBucket` 仅定义于 `src/runtime-config.ts:2977-2986`，无调用方；其上方 “OAuth Usage Types” 分节标题与 ISSUE-11 注释一并删除。                                                                                    |
| S3       | `resolveProfileToConfig` 仅定义于 `src/runtime-config.ts:1882`，无调用方。删除后 `buildOfficialClaudeProviderConfig`（`:829`）失去唯一调用方，成为新死代码；按非目标不扩范围，只在交付记录登记。                               |
| S4       | `generateInviteCode` 仅定义于 `src/auth.ts:104`，无调用方。                                                                                                                                                                    |
| S5       | 四个空分节注释位于 `src/db.ts:9489-9495`（`User Subscriptions`、`User Balances`、`Monthly Usage`、`Redeem Codes`），只删注释。                                                                                                 |
| S6       | `PiProviderResolution.custom` 定义于 `container/agent-runner/src/runtime/pi/pi-provider.ts:18`，唯一读取方 `pi-runtime.ts:103`；返回对象 `:208` 恒为 `true`。锁定测试 `tests/pi-subagent-custom-provider.test.ts:96`、`:177`。 |
| S7       | `scripts/test-real-model-smoke.ts:26-27` 仍读 `claudeCodeOauthToken`、`claudeOAuthCredentials`；`baseUrlPresent` 已独立报告 Base URL，不合并。                                                                                 |
| 锁定测试 | `tests/no-duplicate-helpers-contract.test.ts:29`（头注释）、`:381`（`OAuthUsageBucket` 全仓恰一次）；`tests/pi-subagent-custom-provider.test.ts:96`、`:177`；`tests/thesis-03-provider-ui.test.ts:125` 是否定断言，不受影响。  |

与 issue 清单的差异：仅 S3 删除后新增一个孤儿 helper，按“不做清单外清理”登记不删。

## 2. 方案（TDD）

### 2.1 Red

新增 `tests/thesis-18-dead-code-sweep.test.ts`，以源码契约覆盖：

1. `src/runtime-config.ts` 不含 `OAuthUsageBucket`、`OAuthUsageResponse`、`CachedOAuthUsage`、`parseOAuthUsageBucket`、`resolveProfileToConfig`。
2. `src/auth.ts` 不含 `generateInviteCode`。
3. `src/db.ts` 不含四个分节注释 `User Subscriptions` / `User Balances` / `Monthly Usage` / `Redeem Codes`。
4. `pi-provider.ts` 的 `PiProviderResolution` 不含 `custom`，返回对象不含 `custom: true`。
5. `pi-runtime.ts` 不含 `modelResolution.custom`，且工厂数组无条件包含 `createSubagentInheritModelExtension()`。
6. `scripts/test-real-model-smoke.ts` 不含 `claudeCodeOauthToken` / `claudeOAuthCredentials`，仍含 `anthropicApiKey ||` 与 `anthropicAuthToken`。

同步修改现有锁定测试：

- `tests/no-duplicate-helpers-contract.test.ts`：`OAuthUsageBucket` 用例改为“全仓零声明”；文件头注释同步。
- `tests/pi-subagent-custom-provider.test.ts`：删除 `expect(resolution.custom).toBe(true)`；源码形状断言改为“无 `modelResolution.custom` 且扩展恒挂载”，保留两个 loader 共用同一工厂列表的断言。

在 base 上运行新契约与改后的锁定测试应失败（Red）。

### 2.2 Green

1. **S1/S2**：删除三个 OAuth 用量类型、`parseOAuthUsageBucket` 及其分节注释。
2. **S3**：删除 `resolveProfileToConfig` 整个函数；`buildOfficialClaudeProviderConfig` 保留，登记为孤儿。
3. **S4**：删除 `generateInviteCode`。
4. **S5**：删除 `src/db.ts` 四个空分节注释，不碰任何代码、迁移与 schema 版本。
5. **S6**：删除 `PiProviderResolution.custom` 与返回对象字段；`pi-runtime.ts` 工厂数组无条件挂载扩展；更新 ISSUE-22 注释为“所有端点均为自定义”。
6. **S7**：冒烟脚本 `providerConfigured` 只留 `anthropicApiKey || anthropicAuthToken`。
7. 更新两个锁定测试与新增契约测试。

### 2.3 Refactor / 门禁

- `git grep -n -w -E "<S1-S7 符号>" -- src container scripts tests` 只剩否定断言。
- `npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。
- Runner 侧 `make typecheck` 覆盖 `container/agent-runner/`；Container 镜像下次重建才带上 S6 改动，无行为变化，不单独重建。

## 3. 任务拆解

| #   | 任务       | 主要文件                                                                       | 独立验收                                       |
| --- | ---------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| T1  | Red 契约   | `tests/thesis-18-dead-code-sweep.test.ts`、两个锁定测试                        | 新契约在 base 上失败；锁定测试能定位到待改断言 |
| T2  | S1 + S2    | `src/runtime-config.ts`                                                        | 四个符号零出现；类型检查通过                   |
| T3  | S3         | `src/runtime-config.ts`                                                        | 函数删除；无新增编译错误；孤儿 helper 登记     |
| T4  | S4 + S5    | `src/auth.ts`、`src/db.ts`                                                     | 符号与四个注释零出现                           |
| T5  | S6         | `pi-provider.ts`、`pi-runtime.ts`、`tests/pi-subagent-custom-provider.test.ts` | 扩展恒挂载；ISSUE-22 行为用例通过              |
| T6  | S7         | `scripts/test-real-model-smoke.ts`                                             | 两个 OAuth 字段不再读取                        |
| T7  | 门禁与交付 | 全范围                                                                         | verify 六步全绿；check-scope 通过；新契约通过  |

回滚点：base `248c7cb`；每个提交可单独 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-18-dead-code-sweep-plan.md`、`docs/issues3/THESIS-18-dead-code-sweep.md`、`docs/issues3/README.md`、`docs/审查记录.md`、`src/runtime-config.ts`、`src/auth.ts`、`src/db.ts`、`container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`scripts/test-real-model-smoke.ts`、`tests/no-duplicate-helpers-contract.test.ts`、`tests/pi-subagent-custom-provider.test.ts`、`tests/thesis-18-dead-code-sweep.test.ts`。

与 issue “预计改动路径”的差异：未列 `tests/thesis-03-provider-ui.test.ts`（否定断言已通过，不需要改）；其余一一对应。

## 5. 验收条件

1. S1–S7 清单内符号在 `src/`、`container/`、`scripts/` 零出现（否定断言除外）。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 新契约用例在 `248c7cb` 上失败、实现后通过（非空转）。
4. 无 UI/行为变化；不需要人工冒烟；`npm run test:real-model` 不作为验收项。

## 6. 非目标

- 不动供应商存储层的 OAuth 闲置字段（D-4 ①）与 `users` 表的保留列（D-F2 ①）。
- 不动 `src/db.ts` 的任何代码、迁移与 `CURRENT_SCHEMA_VERSION`。
- 不动 ISSUE-26 的调度器残留。
- 不做清单外“顺手清理”；S3 产生的孤儿 `buildOfficialClaudeProviderConfig` 只登记，不删。
- 不改 `ClaudeProviderConfig` 的存储字段；S7 只改冒烟脚本读取。
- 不跑 `npm run test:real-model`（会产生真实请求）。

## 7. 风险与回滚

- 纯删除与等价改写；S6 是唯一 Runner 行为面改动，但 `custom` 恒为 `true`，行为不变。
- 回滚：`git revert <提交号>`；无数据、schema 与接口变更。
