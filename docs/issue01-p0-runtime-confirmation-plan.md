# 任务立项：ISSUE-01 P0 实机确认（只读诊断）

> 立项日期：2026-11-20｜base：`b08a3b8`｜状态：领取自 `docs/issues/ISSUE-01-p0-runtime-confirmation.md`
> 性质：**只读诊断，不改任何产品代码**。产出为 issue 文件内回填的结论与脱敏证据。

## 1. 背景

审查报告 `docs/dead-code-review-r2.md` 中 4 条 P0 为代码级推断（P0-1 流式栅栏、P0-2 飞书卡片回滚、P0-8 OAuth-only 官方 provider、P0-9① 子代理 toolName），未经实机验证；其结论决定 ISSUE-02/03/04 的修复范围。本任务核实现象、收集证据、回填结论，不修复。

## 2. 诊断方法

1. **静态链核对**：对 issue 中引用的每一处代码（`pi-runner.ts`、`src/index.ts:6904`、`src/web.ts:2774/2948`、`src/run-stream-fence.ts:45-48`、`turn-output-coordinator.ts:109-189`、`runtime-config.ts:2019-2025/2550+`、`pi-index.ts:352-354`、`pi-runtime.ts:139-149`、宿主与 Web 的 `'Task'` 匹配）逐一复核，并补齐推断链缺失环节（fence 两侧 JID 归一一致性、`shouldBroadcastSdkStreamEvent` 放行策略、`publishesFrameworkAnswer` 覆盖面）。
2. **Pi 包源码核验（P0-8 方法 2）**：官方包 1.3.0 dist + docs，穷举 anthropic provider 的凭据来源（编程显式 apiKey、`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` env、自有 `auth.json`），确认不读 `CLAUDE_CODE_OAUTH_TOKEN` 与 Claude Code 的 `.credentials.json`；实测主仓两处 `auth.json` 均为空。
3. **实机事件捕获（P0-1/P0-2/P0-9① 源头证据）**：以生产同款 dist + 生产同款 env 构造链（`resolveProviderById` → `buildContainerEnvLines`，凭据仅内存注入沙箱子进程）直跑 agent-runner，一轮含「文本→顶层工具→Task 子代理→收尾文本」的真实交互，捕获 220 个输出块做结构化统计（不含正文/凭据/Endpoint/模型名）。
4. **历史取证**：主仓 `messages.db`（副本查询）与全部 Pi 会话 jsonl 的工具调用名统计，交叉验证历史流量中从未暴露该断链。

## 3. 结论（详见 issue 文件「诊断结果」表）

四项全部**成立**：

| 项    | 结论           | 关键证据                                                                                           |
| ----- | -------------- | -------------------------------------------------------------------------------------------------- |
| P0-1  | 成立           | 实机 219/219 流事件无 turnId/queryRunId + fence 静态链闭合                                         |
| P0-2  | 成立（机制级） | 实机事件流无 `raw_sdk_event` + coordinator 静态链闭合；卡片实况待 02 修复后顺带复现                |
| P0-8  | 成立（源码级） | Pi 凭据三来源均不含宿主 OAuth 注入形态；两处 auth.json 为空；环境无 OAuth-only provider 可实机复现 |
| P0-9① | 成立           | 实机 `tool_use_start.toolName='Agent'`；扩展注册名单与别名表双重印证                               |

ISSUE-02/03/04 对应条目**无需取消或缩范围**；04 的修复方向提示（OAuth token 映射为 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_OAUTH_TOKEN` 或写 Pi auth.json）已登记在 issue 内。

## 4. 范围与约束

- **改动路径**：仅 `docs/issues/ISSUE-01-p0-runtime-confirmation.md`（回填）与 `docs/issues/README.md`（状态行）——README 流程要求的领取登记。
- **不改**任何 `src/`、`container/`、`web/`、`shared/` 代码；诊断脚本置于 `/tmp` 沙箱，不入库。
- **敏感约束**：凭据仅内存注入；所有落盘材料（issue 回填、计划本文）不含凭据、Endpoint、模型名与未脱敏回复；`data/` 只读（DB 以副本查询）。
- 实机部分复用主仓生产 dist 与 provider 配置属只读消费；沙箱工作区隔离于 `/tmp`。

## 5. 验证与交付

- 本任务无代码改动：`npm run verify` 六步门禁照跑（防文档/格式回归），`node scripts/check-scope.mjs` 核对改动仅在声明范围内。
- 交付：issue 状态改「已完成」，交付记录写明提交号、验证结果与偏差（P0-2 卡片级、P0-8 实机级两项因属用户侧外发操作/缺素材未复现，机制/源码级证据已闭合——已作为附注登记）。
