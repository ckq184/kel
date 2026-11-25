# THESIS-18 裁减遗留死代码清扫（宿主、Runner、脚本）

| 字段          | 值                                                                                                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                           |
| 领取人 / 分支 | claude/thesis-18-dead-code-sweep                                                                                                                                                                                                                                                                                                 |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                               |
| 类型          | 死代码                                                                                                                                                                                                                                                                                                                           |
| 依赖          | 无                                                                                                                                                                                                                                                                                                                               |
| 可并行        | ✅ 16、ISSUE-26。⚠️ 17（D-Q1 选 ② 时同改 `src/runtime-config.ts`）（口径见 [README 第三节](README.md#三并行关系)）                                                                                                                                                                                                               |
| 预计改动路径  | `src/runtime-config.ts`、`src/auth.ts`、`src/db.ts`（只删空分节注释）、`container/agent-runner/src/runtime/pi/pi-provider.ts`、`container/agent-runner/src/runtime/pi/pi-runtime.ts`、`scripts/test-real-model-smoke.ts`、`tests/no-duplicate-helpers-contract.test.ts`、`tests/pi-subagent-custom-provider.test.ts`、`tests/**` |
| 需用户决策    | **是**：D-S1                                                                                                                                                                                                                                                                                                                     |
| 来源          | THESIS-02、04、05、10、14 交付记录的登记项                                                                                                                                                                                                                                                                                       |

## 目标

清掉各裁减包按"不扩范围"原则留下的死代码。每一项都已在 `68a57de` 上用 `git grep -w` 核实：除定义本身、历史文档和锁定它的测试外没有调用方。

## 清单（`68a57de`）

| #   | 符号或位置                                                                            | 位置                                             | 来源          | 说明                                                                                                                    |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| S1  | `OAuthUsageBucket`、`OAuthUsageResponse`、`CachedOAuthUsage`                          | `src/runtime-config.ts:233-247`                  | THESIS-02     | 官方 OAuth 用量接口删除后的死导出                                                                                       |
| S2  | `parseOAuthUsageBucket` 连同其上方的"OAuth Usage Types"分节标题与 ISSUE-11 注释       | `src/runtime-config.ts:2972-2986`                | THESIS-02     | 同上                                                                                                                    |
| S3  | `resolveProfileToConfig`                                                              | `src/runtime-config.ts:1882`                     | THESIS-05     | 在 `d6e04aa` 上就没有调用方                                                                                             |
| S4  | `generateInviteCode`                                                                  | `src/auth.ts:104`                                | THESIS-10、14 | 邀请码下线后的死导出                                                                                                    |
| S5  | 四个空分节注释 `User Subscriptions`、`User Balances`、`Monthly Usage`、`Redeem Codes` | `src/db.ts:9489-9495`                            | THESIS-14     | 只删注释，不碰任何代码与迁移链                                                                                          |
| S6  | `PiProviderResolution.custom` 字段及 `modelResolution.custom ? … : []` 分支           | `pi-provider.ts:18`、`:208`；`pi-runtime.ts:103` | THESIS-04     | 官方分支删除后恒为 `true`，另一侧不可达                                                                                 |
| S7  | 冒烟脚本的 `providerConfigured` 仍读 `claudeCodeOauthToken`、`claudeOAuthCredentials` | `scripts/test-real-model-smoke.ts:26-27`         | THESIS-05     | 删掉这两个字段，只留 `anthropicApiKey \|\| anthropicAuthToken`；Base URL 另由同一输出里的 `baseUrlPresent` 报告，不合并 |

锁定这些符号的测试：

- `tests/no-duplicate-helpers-contract.test.ts:29`（文件头注释）、`:381`（`OAuthUsageBucket` 全仓恰好声明一次）——S1 之后改为断言全仓零声明，或连同注释一起删除该用例。
- `tests/pi-subagent-custom-provider.test.ts:96`（`resolution.custom` 为 `true`）、`:177`（锁定 `modelResolution.custom ? [createSubagentInheritModelExtension()]` 的源码形状）——见 D-S1。
- `tests/thesis-03-provider-ui.test.ts:125` 断言 `web/` 里没有 S1 的三个类型，是否定断言，不受影响。

## 非目标

- 不动供应商存储层的 OAuth 闲置字段（D-4 ①），不动 `users` 表的保留列（D-F2 ①）。
- 不动 `src/db.ts` 的任何代码、迁移与 `CURRENT_SCHEMA_VERSION`。
- 不动 ISSUE-26 的调度器残留（另有 issue）。
- 不做本清单以外的"顺手清理"。执行中发现新的死代码，登记到交付记录。

## 需用户决策（领取前拍板）

| #    | 问题                                                                                                                  | 选项                                                                                                                   | 建议 |
| ---- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- |
| D-S1 | S6：`tests/pi-subagent-custom-provider.test.ts` 锁定了 ISSUE-22 的设计（自定义端点下子 Agent 继承父模型），属意图信号 | ① 删除 `custom` 字段，扩展改为无条件挂载；用例改为断言"扩展恒挂载"，ISSUE-22 的意图不变；② 保留字段与分支，本包跳过 S6 | ①    |

## 执行前核实

- 每个符号重新跑 `git grep -n -w <符号> -- . ':!docs'`，确认除定义和上述测试外没有引用。和本清单不一致就停下报告。
- S6 改的是 Runner 源码。确认 `make typecheck` 覆盖 `container/agent-runner/`；Container 模式要等镜像重建后才会带上这次改动，但这是无行为变化的重构，不需要为此单独重建镜像。在交付记录写明。

## 实现步骤（TDD）

1. **Red**：在已有契约测试里加否定断言——S1 至 S4 的符号在 `src/` 中零出现；S6 选 ① 时断言 `PiProviderResolution` 不再有 `custom` 字段、扩展无条件挂载；S7 断言脚本不再读取两个 OAuth 字段。
2. **Green**：按清单删除并修改锁定测试。
3. 跑 `npm run verify` 与 `node scripts/check-scope.mjs`。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 清单内每个符号 `git grep -w` 在 `src/`、`container/`、`scripts/`、`tests/` 中只剩否定断言。
3. 无运行界面变化，不需要人工冒烟。`npm run test:real-model` 会产生真实请求，不作为验收项。

## 风险与回滚

- 纯删除与等价改写；回滚为 `git revert <提交号>`。

## 交付记录

- **提交**：`a18c6c8`（立项）、`60ad4a2`（实现）、`b1440bc`（规格审查处置），审查记录与交付随本提交（分支 `claude/thesis-18-dead-code-sweep`，基于 main `248c7cb`）。
- **实现**：S1/S2 删除 `OAuthUsageBucket`、`OAuthUsageResponse`、`CachedOAuthUsage`、`parseOAuthUsageBucket` 及 “OAuth Usage Types” 分节注释；S3 删除无调用方 `resolveProfileToConfig`；S4 删除 `generateInviteCode`；S5 只删 `src/db.ts` 四个空分节注释，代码、迁移与 `CURRENT_SCHEMA_VERSION` 未动；S6 删除 `PiProviderResolution.custom` 与 `modelResolution.custom` 分支，`createSubagentInheritModelExtension()` 改为无条件挂载（D-S1 ①）；S7 冒烟脚本 `providerConfigured` 只留 `anthropicApiKey || anthropicAuthToken`，`baseUrlPresent` 保持独立。
- **验证**：`npm run verify` 六步全绿（369 文件，3031 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 14 个路径全在声明范围内；`npm run docs:check` 135 个 Markdown；定向 4 文件 46 例、shuffle 两轮、S6 相邻 36 例全绿；`make typecheck` 三侧通过。
- **偏差**：无。规格审查建议 2/3 已由 `b1440bc` 处置；质量审查 Minor 1–3 延后（见审查记录）。
- **范围外登记**：S3 删除后 `buildOfficialClaudeProviderConfig`（`src/runtime-config.ts:811`）失去唯一调用方，按非目标不删；Container 模式需等镜像下次重建才带上 S6 改动，无行为变化，不单独重建。
- **未实机验收**：无界面/行为变化，不需要人工冒烟；`npm run test:real-model` 不作为验收项。
