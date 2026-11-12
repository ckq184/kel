# 任务 AH 立项:RSI Phase 3 — 跨 workspace 复用与提案流水线(半自动)

> **状态**:2026-11-12 任务 AG(Phase 2 探针)收官后(`06baaf0`),用户指示写 Phase 3 交接文档、新窗口执行。本文档即范围声明,**零代码改动**。
> **基线**:`.gatescope.json` base = `06baaf0`。
> **前置条件**:AE(Phase 1 全链路)+AF(adapter_version 归因)+AG(探针)已交付;`harness_lessons` 已有真实 lesson;`eval-trigger.ts` 提供宿主 spawn 子进程+状态快照先例。

---

## 0. 一句话结论

RSI 从「单 workspace 手动循环」升级为「跨 workspace 复利 + 一键流水线」,三件事:① **近邻 lesson 注入**——proposer 证据树带上其他 workspace 的可迁移经验(词面 cue 匹配 top-3,hermit 可迁移性卖点);② **adapter 克隆**——任一历史版本可作为**其他 workspace 的新提案**进入正常人审+探针流程(复用走提案门,不直写);③ **Web 一键 evolve**——Harness 演化 tab 显示「自上次提案后已攒 N 条新证据」提示条 + admin 一键触发 evolve 子进程(照 eval-trigger 模式,省去 CLI 手跑)。**继续不做全自动采纳**(宪法人审门 + 探针已知 gap)。

## 1. 已拍板裁决(新会话勿重议)

1. **不做全自动采纳**——AG 的「Phase 3 才议自动采纳」经议:继续人审。理由:①采纳=写敏感区,人审是宪法授权路径;②探针已知 gap(单轮直调探不出工具/记忆类改进)使其判定不足以独担采纳决策;③半自动流水线已消除大部分操作成本。此议题关闭,除非用户重开。
2. **近邻 lesson = 词面匹配,不引入向量/embedding**(运行时依赖冻结+probe/evolve 均不依赖 embedder):`pickNeighborLessons({selfJid, selfTurnTexts, allLessons, limit=3})`——排除本 workspace 已注入的 lesson,cue 分词(中文按 2-gram,英文按词)与最近 turn 文本的重合度打分 top-3;proposer prompt 中明示「来自其他 workspace 的参考性经验,可能不适用,引用需谨慎」。**泄漏纪律不破**:lesson 是行为教训(不含评分/验收集内容),AE 已注入本 workspace lesson,跨 workspace 仅扩大池子。
3. **证据分簇信号(分歧优先的自动化前置)**:`clusterTurns(turns)` 纯函数——按 channel+时间窗(30 分钟)分簇,簇内按输入文本相似度(公共词占比)合并,输出 `[{clusterId, turns, inputVariance: 0-1}]`;evolve 证据树按簇组织(簇标题标注分歧度),proposer prompt 不变(它已经懂得用分歧信号,现在把分歧算好摆出来)。`--no-cluster` 开关保留旧行为。启发式质量风险→仅作辅助信号,不做门槛。
4. **adapter 克隆走提案门**:`POST /harness/versions/:id/clone` body `{targetWorkspace}`(admin)——以该版本全文为目标 workspace 新建 **pending 提案**(rationale 标注「克隆自 <source> v<n>」、evidence 空、baseline=目标当前 ACTIVE),后续走正常人审+探针。**绝不直写目标文件**。
5. **Web 一键 evolve = 照 eval-trigger 模式新建 `src/harness-evolve-trigger.ts`**(spawn `npm run eval:harness-evolve -- --workspace <jid>`;状态快照+日志行;单飞锁:运行中重复触发 409;15 分钟超时 kill):**不复用/不改动 eval-trigger.ts**(它绑定 auto-recall 参数拼装)。触发=admin;`WS 事件 evolve_log/evolve_complete` 本期不做(前端轮询状态端点足够,避免 WS ACL 面扩张)。
6. **新证据计数 = 动态查询,不新增配置**:`GET /harness/evidence-status?workspace=<jid>`(admin)返回 `{turnsSinceLastProposal, lastProposalAt, activeVersion}`——阈值判断纯前端(≥10 显示提示条),阈值不进 observability 配置(少一个配置面)。
7. **不做(明确出界)**:skills/工具面扩展(等工具行为改进的真实需求)、全链路 probe、WS 进度、自动 probe、lesson 向量检索。

## 2. 方案设计(文件级)

- **`src/harness-proposer.ts`**(改):`pickNeighborLessons`(§1-2 打分纯函数,分词器内联)+ `clusterTurns`(§1-3)+ 两者单元可测;`buildEvidence` 加可选参数 `{clusters?, neighborLessons?}` 渲染两节。
- **`src/eval-store.ts`**(改,**不加 schema 版本**:纯方法新增)——`listAllHarnessLessons(limit=500)`(全 workspace,带 workspaceJid 字段)、`countTurnsSince(workspaceJid, sinceIso)`。
- **`scripts/eval-harness-evolve.ts`**(改):默认启用分簇+近邻 lesson(`--no-cluster`/`--no-neighbors` 回退);stderr 打印簇数与近邻数(审计)。
- **`src/harness-evolve-trigger.ts`**(新):`startHarnessEvolveRun({workspace, actor})`/`getHarnessEvolveTriggerState()`/`resetHarnessEvolveTriggerForTests()`,依赖注入 `spawn`(照 eval-trigger 的 injectEvalTriggerDeps 先例)。
- **`src/routes/eval.ts`**(改,admin):`POST /harness/versions/:id/clone`;`GET /harness/evidence-status?workspace=`;`POST /harness/evolve/trigger`(body `{workspace}`;运行中 409);`GET /harness/evolve/status`。
- **`web/src/pages/EvalPage.tsx`**(改):Harness 演化 tab 顶部提示条(`turnsSinceLastProposal ≥10` 时显示「已攒 N 条新证据」+「生成提案」按钮→轮询 status→完成即刷新列表);版本历史行加「克隆到…」(小输入框填目标 JID+确认)。
- **`package.json`**:无新 script(CLI 不变)。

## 3. 执行顺序(TDD,每批次先见红)

| 批次          | 动什么文件                                                                                                      | 交付                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 纯函数+存储 | `src/harness-proposer.ts`、`src/eval-store.ts`、`tests/harness-proposer.test.ts`、`tests/eval-store.test.ts`    | pickNeighborLessons(排除自 ws/词面打分/top-3/空安全)、clusterTurns(时间窗/相似合并/方差信号)、两查询方法     |
| 2 CLI         | `scripts/eval-harness-evolve.ts`、`tests/eval-harness-evolve.test.ts`                                           | 默认启用+两个回退开关+审计打印                                                                               |
| 3 触发器      | `src/harness-evolve-trigger.ts`(新)、`tests/harness-evolve-trigger.test.ts`(新)                                 | spawn 注入可测、单飞锁、状态快照、超时 kill                                                                  |
| 4 API+Web     | `src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx` | clone(409 目标同名保护不需要——提案可并存;404 校验)/evidence-status/trigger+status;提示条与按钮交互、克隆入口 |
| 5 收官        | `docs/API.md`、`AGENTS.md`、`CLAUDE.md`                                                                         | 文档 → verify → scope → 单提交 `feat: 观测 - RSI Phase 3：近邻 lesson、adapter 克隆与一键提案（任务AH）`     |

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-ah-rsi-phase3-plan.md`、`docs/task-ah-rsi-phase3-handoff.md`、`src/harness-evolve-trigger.ts`、`tests/harness-evolve-trigger.test.ts`
修改:`src/harness-proposer.ts`、`src/eval-store.ts`、`scripts/eval-harness-evolve.ts`、`src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/harness-proposer.test.ts`、`tests/eval-store.test.ts`、`tests/eval-harness-evolve.test.ts`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`

## 5. 风险与边界

1. **词面匹配误配**(中文 2-gram 噪声):top-3+prompt 免责声明+`--no-neighbors` 回退;lesson 注入是辅助信号非门槛,坏 lesson 最多浪费 proposer 注意力,不产生错误采纳(人审+探针仍在)。
2. **分簇启发式误簇**:同上,仅辅助呈现;`--no-cluster` 保底;旧行为测试保留。
3. **一键触发的费用失控**:单次=1 次 proposer flash 调用;admin-only+单飞锁+超时 kill;提示条阈值前端控制。
4. **克隆跨 workspace 的隐私面**:adapter 正文可能含源 workspace 的业务细节——克隆是 admin 显式动作(输入目标 JID+确认),提案在目标 workspace 的人审可见全文,信息流经 admin——与 lesson 跨 ws 同级,可接受。
5. **eval-store 方法新增无 schema 变更**:纯读方法,零迁移风险;`listAllHarnessLessons` limit 500 防大库。
6. **状态轮询的简单性取舍**:不做 WS——前端 2s 轮询 status 端点,完成即停;若未来要 WS 再立项。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):① 在第二个 workspace 攒 ≥10 条 turn → ② 该 workspace 提示条出现,点「生成提案」→ 状态轮询到完成,列表出现新 pending 提案,证据树含「近邻经验」节(来自 ws-1 的 lesson)→ ③ 对该提案跑探针(AG 链路)→ 人审 → ④ 在 ws-1 版本历史点「克隆到」ws-2 → ws-2 出现克隆提案 → ⑤ 全程 obs_turns 归因列持续累积。
