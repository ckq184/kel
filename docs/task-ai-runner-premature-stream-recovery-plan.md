# 任务 AI 立项：Runner 早夭流恢复——把「断流即进程退出」降级为「有界重试 + 终态错误」

> **状态**：2026-11-12 任务 AH 收官后，用户指示按流程立项（真实故障实证见 §2）。本文档即范围声明，**零代码改动**，待用户审批后执行。
> **基线**：`.gatescope.json` base = `e88f3c5`（任务 AH 单提交）。

---

## 0. 一句话结论

`pi-runner.ts:372-374` 的排队不变量（`Pi session ended with uncompleted input turns`）把「供给侧断流」这种**瞬态故障**升级成了 runner 进程退出（exit 1）——一次 glm 网关中断就杀掉健康的 12 分钟会话，恢复全靠宿主回卷重放+新进程。修复：把该 throw 降级为**优雅返回 `prematureEnd` + 走既有 requeue 通道自动重试一次**；同一 turn 连续第二次早夭则发布**带回执的终态 per-turn 错误**（停下重试、跑步者存活），全程序不退出。

## 1. 已拍板裁决（待审批确认）

1. **选方案 A（降级+有界重试），不做方案 B（runner 内原地 re-prompt）**。A 复用 main 既有 requeue→waitForNextInput→新 runTurn 通道（pi-index.ts:521-548 现成代码零改动），B 需在已 idle 的 session 上二次 prompt，语义未定义且与宿主重放职责重叠。
2. **有界：同一 delivery id 连续早夭 ≤1 次自动重试**。第 2 次连续早夭 → 发布终态错误（`inputTurnCompleted:false` + `ipcReceipts` 回执确认，形态对齐既有 publishResult 的错误路径）——不确认回执会引发宿主回卷重放风暴（跨进程无限重试），确认回执则错误直达用户、由用户决定重发。
3. **其余 throw 路径不动**：`promptError`（prompt promise reject，如凭据缺失）与 `fatalError`（runtime 显式 fatal）仍是真致命错误，维持 main 捕获→单错误输出→exit 1 现状。供给侧超时若 runtime 以 error result 事件呈现（2026-11-12 实测「Request timed out.」即此路径）本来就优雅，无需改。
4. **不变量的「真 bug 守卫」价值保留但转向可观测**：降级不静默——`log()` 打完整审计行（pending turn 清单+sessionId），连续早夭经计数器兜底后必然浮出为终态错误，逻辑 bug 不会被吞，只是不再杀进程。

## 2. 背景与根因（2026-11-12 实证链）

用户在 `web:12538129-…` 验收任务 AH 时第 8 条消息无输出。取证（`/tmp/ckqclaw-dev.log` + `data/groups/flow-mwa5m2le-01d8/logs/host-2026-11-12T01-53-38-442Z.log`，34965 行）：

| 时刻        | 事件                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 09:52:15    | turn 8 首请求 `Request timed out.`（runtime 以 error result 发布，**优雅**，runner 存活）                                                                                     |
| 09:52–09:53 | 宿主重投该消息 → 第二次尝试：完整工具循环+答案流式至结尾                                                                                                                      |
| 09:53:38    | 流中途终止且**无 result 事件** → pi-runner.ts:374 不变量 throw → main 捕获 → 单错误输出 + exit(1) → **runner 进程死亡**（存活 12.6 分钟，会话上下文 ~124.6K cache-read 全弃） |
| 09:53:42    | 宿主回卷重放（`Rewound unacknowledged IPC deliveries`）→ 新 runner → 又超时 → 用户侧「无输出」                                                                                |

根因判级：H1 瞬态网关不稳（重发即愈，已实证）为触发器；**H3 本不变量为放大器**——把一次可恢复的断流变成进程级死亡。修复 H3 后同类事件的用户可见代价从「进程重启+上下文全弃+等待重放」降为「自动重试一次，多数无感」。

## 3. 方案设计（文件级）

- **`container/agent-runner/src/runtime/pi/pi-runner.ts`**（改）：
  - `PiQueryRunResult` 增 `prematureEnd?: boolean`（与 `prematureTerminal?: boolean`，见下）。
  - 372-374 行不变量分支：`log()` 审计行（含 tracker pending 清单+sessionId）→ 查模块级早夭计数器（`Map<deliveryId, number>`，键=当前 turn 最新 delivery id，容量上限 32 防泄漏，任一 turn 成功完成即清零）：
    - 计数 < 1：返回 `{prematureEnd: true, …}`，pending 不确认（`pipedMessagesDuringQuery` 原样带回）→ main 既有 requeue 通道自动重试。
    - 计数 ≥ 1（同 id 连续第二次）：发布终态输出（`status:'error'`、`inputTurnCompleted:false`、`error:'Pi 流中断（连续两次），turn 未完成——请重发'`、`ipcReceipts=tracker.completeNextTurn()` 回执）→ 返回 `{prematureTerminal: true}`。
  - 计数器写入点：早夭分支 +1；`publishResult` 成功路径（`inputTurnCompleted===true`）清零。
- **`container/agent-runner/src/pi-index.ts`**（**预期零改动**；若实现中发现 requeue 对 `prematureEnd` 返回值有隐含依赖再最小适配——超出即回本计划修订）。
- **`tests/agent-runtime-migration.test.ts`**（改，追加 3 用例）：
  1. 「早夭重试」：fake session `prompt()` resolve、无 result 事件、tracker 带 pending followUp → 不 throw、返回 `prematureEnd:true`、pending 原样带回、session 正常 dispose。
  2. 「连续第二次早夭→终态」：同 delivery id 两轮早夭 → 第二轮发出 `status:'error'` 终态输出且带 `ipcReceipts`、`inputTurnCompleted:false`。
  3. 「成功清零」：早夭→成功完成→再早夭 → 第三轮仍走重试（计数已清）。
- **文档**：AGENTS.md / CLAUDE.md 若已有描述该不变量的段落则同步（实现时 grep 确认；无则不动，不为此扩 gatescope）。

## 4. 执行顺序（TDD）

| 批次 | 动什么                                                                                                                                                           | 交付                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1    | `tests/agent-runtime-migration.test.ts` 先红 → `pi-runner.ts` 实现                                                                                               | 三用例绿 + 既有 60+ 用例不回归 |
| 2    | `make build`（runner dist 重编）→ `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `fix: 观测 - runner 断流降级为有界重试，早夭流不再杀进程（任务AI）` | 收官                           |

## 5. 文件清单（= `.gatescope.json` allow）

新增：`docs/task-ai-runner-premature-stream-recovery-plan.md`
修改：`container/agent-runner/src/runtime/pi/pi-runner.ts`、`tests/agent-runtime-migration.test.ts`

## 6. 风险与边界

1. **掩盖真逻辑 bug**（followUp-after-idle 竞态等原本靠 crash 暴露）：缓解=审计 log 行 + 连续早夭必浮出终态错误 + 单测钉住两路径；且任务 AG 后续（`06baaf0`）已证明该 glm 端点断流是常态而非假设。
2. **重试的重复副作用**：断流前工具若已产生文件/外发，重试可能重复执行——现状（宿主回卷重放）同样存在此问题，本任务不引入新风险，不扩大范围去解。
3. **计数器跨 runTurn 持久性**：模块级 Map 随进程生命周期，进程重启自然清零（保守方向，安全）。
4. **不改宿主/不改 schema/零新依赖**；runner dist 由 verify 的 build 步骤重编。
5. **验收的现实约束**：断流无法确定性人工复现——真机验收降级为「单测双路径 + 回归（正常对话不受影响）+ 观测预案（若再遇断流，dev 日志出现早夭审计行且无 `Host Agent exited with error`）」。

## 7. 门禁与验收

- 门禁：`npm run verify` + `node scripts/check-scope.mjs`；单提交收官。
- 验收：① 三新用例+全量测试绿；② 真机正常对话回归一轮（含一次多 turn 会话）；③（best-effort 观测项）下一次自然断流时 runner 存活、日志含早夭审计行。
