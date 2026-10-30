# 任务 M：测试负载预算固化 + workflow.md 门禁同步

> **文档定位**：任务 L 收官（`ee8a179`/`c30892d`/`32bdd01`，宪法门禁表
> 可行建设项全部落地）后的巩固任务，自包含可交接。建议注入语：
> **「阅读 docs/task-m-test-budget-consolidation-plan.md，开工。」**
> **基线（回滚点）**：`32bdd01`（任务 L 批次 3 收官提交）。
> **批准状态**：用户 2026-10-24 指示「先做任务 M（负载预算 + workflow.md
> 同步）」——纯测试稳定性 + 文档同步，无需新批准。
> **范围声明**：`.gatescope.json` 已随本立项切换（base=`32bdd01`）。

## 0. 一句话立项理由

verify 已是每次提交必经的强制门禁，但翻红必须意味着真回归——任务 K/L
累计 15+ 轮全量暴露的「边缘预算/时序用例负载下轮换翻红」家族（已逐个
打补丁 12 处显式预算）没有系统性收口：家族清单只散落在各任务执行记录里，
新成员还会出现（任务 L 两批收官各新踩 1 次）；两处根因（task-runs-v2
墙钟余量断言、container-session-permissions <10s 性能契约）未处置；
workflow.md 未同步任务 L 门禁产物（宪法维护规则欠账）。

## 1. 范围与非目标

**范围（单批）**：

1. **负载敏感家族清单固化 + 防回归护栏**：契约测试
   `tests/load-sensitive-budget-contract.test.ts`——登记已知家族成员
   （文件 + 用例特征），逐个断言其保留显式预算（`timeout:` 对象形态或
   `_000)` 旧式字面量），手滑删除预算即红；新成员入清单即受保护。
2. **task-runs-v2 时序断言根因修复**：6 处 `setTimeout(resolve, 1_050)`
   固定余量墙钟等待（等 execution 超时窗过去）+ 贴值断言（5/15/60ms
   sleep vs 10/60ms 租约）改为「轮询等条件成立」模式（`vi.waitFor` /
   手写 pollUntil，语义不弱化——最终必须发生，只是不再赌 50ms 余量）。
   **探查降级条款**：若实施中发现需改生产代码时序才可修（测试侧不可
   修），降级为「登记 + 重负载观察」，在 §6 如实记录。
3. **container-session-permissions <10s 断言**：任务 K 已裁决「真实性能
   契约，不应放宽」——本任务只登记进家族清单文档（受护栏保护其
   120_000 describe 预算不被手滑删除），断言本身不动。
4. **workflow.md 同步**（宪法维护规则欠账）：阶段 4「回滚点」补
   `.gatescope.json` 落档衔接；阶段 8 四门禁证据 + 第四节交付模板补
   机审入口（verify / check-scope 实际命令）；第三节自检清单与仓库
   实况对齐（lint 未配置 → format:changed；diff 范围 → check-scope）。
   speckit 命令表属另一工作法体系，不动。
5. **收官同步**：REMAINING-WORK 状态快照、本计划 §6、（若涉及）
   AGENTS.md 门禁注。

**非目标**：

- 不放宽任何真实性能/行为契约断言（container-session-permissions <10s
  尤其不动）；
- 不引入 vitest 全局 testTimeout 配置变更（全局放宽 = 掩盖新成员症状，
  与护栏思路相反）；
- 不做 CI、不动 `.gitattributes`（前者被 remote 阻塞、后者待用户单独
  裁决——均在上轮咨询中列明）；
- 不动 speckit 快捷命令表与 spec-kit 工作法描述。

## 2. 环境事实表（新窗口必读）

| 事实        | 内容与出处                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 翻红模式    | 家族特征 = spawn 密集（docker run / node 子进程串行）、大 DB 对账、墙钟余量断言；全量满载轮翻、单跑绿、冷却后单轮即过——定性流程见任务 K 计划 §8 结论段                                                                                                                                                                                                                                                                                                                     |
| 已修清单    | 显式预算 12 处：channel-turn-runtime 30s、task-scheduler-contract 租约参数、builtin-skill-bootstrap 30s、mcp-send-message-ack waitFor 10s×2、reproducible-build 30s、schema-v60 30s、container-session-permissions describe 120s、dingtalk-streaming-card 30s、auto-memory-secret-filter 60s、githooks-contract 30s、scope-check-contract 30s；旧式字面量家族：auto-memory-sidecar-manager ×14（15–40s）、auto-memory-ipc 20s、backup-restore-safety ×2（win32 整卷 skip） |
| 未修根因    | task-runs-v2（本任务处置）；container-session-permissions「10000-file <10s」（登记不放宽）                                                                                                                                                                                                                                                                                                                                                                                 |
| verify 语义 | test 步 failHint 已提示「连续重跑先冷却复测再定性」；门禁基线 = 冷却态单轮 0 失败文件                                                                                                                                                                                                                                                                                                                                                                                      |
| 门禁工具链  | `npm run verify`（六步）→ `node scripts/check-scope.mjs`（范围核对）→ commit（hooks：secret 扫描 + 格式 + 消息规范）；`--no-verify` 禁止                                                                                                                                                                                                                                                                                                                                   |
| 提交规范    | `type: 范围 - 摘要`；本任务 type 预定 `test:`（主体是测试稳定性 + 文档）                                                                                                                                                                                                                                                                                                                                                                                                   |

## 3. 实现要点（约束，细节执行窗口定）

1. 护栏测试的登记清单直接写在测试文件内（数组：文件 → 预算特征断言），
   与 githooks-contract 的「本仓库三 shim LF」断言同风格；家族成员 =
   已修清单全集。
2. task-runs-v2 修复用 vitest 内建 `vi.waitFor`（mcp-send-message-ack
   先例）；`await vi.waitFor(() => expect(cond).toBe(true))` 替换
   `sleep(1050)+expect`，预算 10s；贴值租约断言逐个看语义再定（能轮询
   的轮询，语义就是「此刻未过期」的保留墙钟但留足余量）。
3. TDD：护栏测试先红（对任一已登记文件临时删预算验证）再绿；task-runs-v2
   改动后单跑 + 全量轮验证。
4. 验收：冷却态全量 verify 0 失败文件；护栏测试绿；workflow.md 四处
   同步后 `npm run docs:check` 过。

## 4. 验收

- 冷却态 `npm run verify` 全绿（0 失败文件）；`check-scope` 通过。
- 护栏契约测试绿且演示过拦截（删预算即红）。
- task-runs-v2 修复后连续 2 轮全量该文件零翻红（或按降级条款登记）。
- workflow.md / REMAINING-WORK / 本文档 §6 同步。

## 5. 风险

- task-runs-v2 轮询化改动面 6+ 处，若某处语义确属「此刻必须未过期」
  （负向断言），轮询不可用——保留墙钟但把余量从 5ms 放大到安全值，
  并登记该处为「余量型断言」。
- 全量验证轮次本身会加热机器，验收轮之间安排冷却间隔（任务 K/L 经验
  60s+）。

## 6. 执行记录

### 单批收官（2026-10-24，立项 `2d784b5` + 本 `test:` 提交）

**结果：全部范围项落地，无降级条款触发。**

1. **护栏契约测试 `tests/load-sensitive-budget-contract.test.ts`
   （15 用例）**：家族清单 14 成员逐个锁定「源码保留显式预算」（文件 +
   预算正则 + 翻红史 note），清单非空且路径唯一性自检；拦截演示过——
   临时删 channel-turn-runtime 预算即红（5 处红标）、还原即绿。新成员
   约定：下次翻红修复时登记进清单即受保护。
2. **task-runs-v2 时序修复（10 处正向轮询化 + 1 处负向保持）**：
   `sleep` 固定余量 → `vi.waitFor` 轮询等条件成立。关键工程细节：
   **waitFor 的 callback 返回 falsy 不触发重试**——claim 类调用必须
   `expect(claim).toBeTruthy()` 显式抛错才重试（首轮 4 用例翻在此，
   修正后 18/18 绿）。轮询目标选择原则：幂等只读状态
   （getTaskRunById status）或「null 期无副作用」的 claim（首次非空
   即停，租约只发出一次）。保留的 379 处为负向断言（等 1s 延迟后
   「依然不可领」——等待越久越稳，轮询会弱化语义），已注释说明。
   另修正两处侦察漏网：504 段 waitFor 后紧随的 retry 领取、920 段
   预算耗尽循环（循环内 sleep(5) 等 2ms 租约过期被 waitFor 重试间隔
   天然替代）。
3. **container-session-permissions**：断言未动（任务 K 裁决沿用），
   其 describe 120s 预算入护栏清单受保护。
4. **workflow.md 四处同步**：阶段 4 回滚点补 `.gatescope.json` 落档
   与 check-scope 核对；阶段 8 四门禁补机审入口（verify ①②③+格式/
   diff、check-scope ④、hooks 第二道防线、--no-verify 违规）；第三节
   自检清单逐项括注机审命令并修正 lint 行（本仓库未配置 lint）+
   护栏/冷却定性指引；第四节四门禁定义补两命令引用。speckit 命令表
   未动（另一工作法体系）。
5. **收官同步**：REMAINING-WORK 状态快照、本节。
