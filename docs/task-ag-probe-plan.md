# 任务 AG 立项:RSI Phase 2 — 探针（A/B 双跑 + 匿名盲选，辅助人审）

> **状态**:2026-11-11 任务 AF 收官后,用户指示「启动 Phase 2 探针立项,先确定范围,确认后执行;交接新窗口开发」。本文档即范围声明,**不含任何代码改动**;实现由新会话按 §3 批次执行。
> **基线**:`.gatescope.json` base = `2c53939`(任务 AF 收官提交)。
> **前置条件**:任务 AE（RSI Phase 1 全链路）+ AE 后续两修复 + AF（adapter_version 归因）已交付并在真实 workspace 运行;`RecallJudge` 提供 LLM-as-judge 直连先例;`eval-trigger` 提供子进程+WS 先例（本任务不启用）。

---

## 0. 一句话结论

给 harness 提案加**探针报告**:采纳前对「当前 adapter vs 提案 adapter」做单轮 LLM 直调双臂 A/B——同一验收问题集、两种 prompt 各跑一遍,匿名化后交 glm-flash 盲选(双向 swap 消位置偏置),按多数票 + 行为要点命中数产出 ADOPT/KEEP_BASE 建议,报告落库附在提案上——**仍由 admin 人审决定采纳**,探针只把「读提案猜效果」升级为「看对比数据拍板」。Phase 3 才议自动采纳。

## 1. 已拍板裁决(范围边界,新会话无需重议)

1. **probe 执行通路 = 单轮 LLM 直调**(recall-judge 同款 client:OpenAI-compatible 端点、温度 0),**不跑完整 runner**:双臂 prompt = 简化平台头(identity 摘要) + `buildAdapterBlock`(v_n / 提案) + 验收问题。理由:Phase 2 的 adapter 是 prompt-only,其价值全部体现于回复文本行为;直调便宜/快/确定。**gap 声明**(写入报告与文档):工具使用、记忆召回类改进探不出——Phase 3 若 adapter 扩展 skills/ 再议全链路 probe。
2. **验收集(acceptance set)按 workspace 一份**:`{queries: [{id, text, expectNotes: string[]}]}`,expectNotes = 行为要点(如「开头声明文件名与记录数」「联系方式脱敏」),非精确答案;题数 1–10,缺省建议 5。来源:admin 手写 JSON 编辑器(Web 文本区 + 校验,不做表格编辑器——评测集 tab 的复杂度不引入)。
3. **盲选 judge**:glm-flash,输入 = 问题 + expectNotes + 两个匿名回复(A/B 随机),输出 `{prefer: 'A'|'B'|'tie', per_note: {note: 'A'|'B'|'tie'}[], reasoning}`;**每题双向各判一次**(swap 消位置偏置),两判不一致记 tie。多数票(胜出题数)定胜负。
4. **门槛(gate)**:建议 ADOPT 需同时满足 ①胜出题数 > 落败题数 ②expectNotes 总命中数(按 judge per_note 聚合)不低于基线臂。否则建议 KEEP_BASE。报告只是**建议**,采纳/拒绝仍走任务 AE 的 admin 动作。
5. **泄漏纪律延续**(harness² 三重防线):proposer 证据树**永不包含**验收集与探针报告——防提案者面向探针优化;验收集与 grader 材料同属 admin-only 面。
6. **存储 = eval.db v5 加两表**(`harness_acceptance_sets`、`harness_probes`),全 CREATE 新表,无列迁移(低于 v4 风险);拒绝降级沿用。
7. **CLI 先行、手动触发、有费用、不进门禁**:`npm run eval:harness-probe -- --workspace <jid> --proposal <id> [--dry-run]`;`--dry-run` 打印双臂计划与费用估算不调 LLM。Web 只读展示报告;Web 触发/WS 进度留 Phase 3(eval-trigger 模式)。
8. **不动**:任务 AE 的采纳链路/状态机、proposer、runner、observability——探针是纯旁路。

## 2. 方案设计(文件级)

### 2.1 eval.db v5 schema

```sql
CREATE TABLE IF NOT EXISTS harness_acceptance_sets (
  workspace_jid TEXT PRIMARY KEY,
  queries_json TEXT NOT NULL,          -- [{id, text, expectNotes[]}]
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_probes (
  id TEXT PRIMARY KEY,                 -- hpr_<uuid>
  proposal_id TEXT NOT NULL,
  workspace_jid TEXT NOT NULL,
  baseline_version INTEGER NOT NULL,   -- 提案基线（ACTIVE 当时）
  verdict TEXT NOT NULL,               -- 'adopt' | 'keep_base' | 'inconclusive'
  rounds_won INTEGER NOT NULL,         -- 提案臂胜出题数
  rounds_lost INTEGER NOT NULL,
  rounds_tied INTEGER NOT NULL,
  notes_baseline_hit INTEGER NOT NULL, -- expectNotes 命中数（基线臂）
  notes_proposed_hit INTEGER NOT NULL,
  rounds_json TEXT NOT NULL,           -- 逐题：[{queryId, baselineText, proposedText, judgeA, judgeB(swap), noteHits}]
  cost_usd REAL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 2.2 模块

- **`src/harness-probe.ts`**(新,纯函数):`AcceptanceQuery` 类型 + `validateAcceptanceSet(queries)`(题数 1–10、text 非空、expectNotes ≥1、id 唯一);`probeArmPrompt({question, adapterBlock})`(双臂共用模板);`blindJudgePrompt({question, expectNotes, replyA, replyB})`/`parseBlindJudge(raw)`;`aggregateVerdict(rounds)`(票数+要点命中+门槛→adopt/keep_base/inconclusive);`swapLabels` 辅助。
- **`src/eval-store.ts`**(改):v5 迁移;`getAcceptanceSet/upsertAcceptanceSet`;`insertHarnessProbe/listHarnessProbes(proposalId)`。
- **`scripts/eval-harness-probe.ts`**(新):加载提案(必须 pending)+当前 ACTIVE + 验收集 → 逐题双臂生成(直调)→ 双向盲选 → 聚合 → 报告落库;`--dry-run` 只打印计划;费用累计打印。
- **`src/routes/eval.ts`**(改,admin):`GET|PUT /harness/acceptance/:workspace`(验收集读写,PUT 过 validateAcceptanceSet);`GET /harness/probes?proposal=<id>`(报告列表);提案详情响应附带最新探针摘要(verdict/票数)。
- **`web/src/pages/EvalPage.tsx`**(改):Harness 演化 tab 两个只读区——提案详情下方「探针报告」(verdict 徽标、票数对比、逐题双臂文本对照、judge 理由);「验收集」卡片(文本区 JSON 编辑+校验错误展示+保存)。
- **`package.json`**:`"eval:harness-probe": "tsx scripts/eval-harness-probe.ts"`。

### 2.3 泄漏防线落点

- `buildEvidence`(proposer)**不改动**即天然满足(它只吃 obs_turns/adapter/lessons);
- 探针报告与验收集仅 admin 面,proposer CLI 无法读取(不经 eval-store 的这两组方法)。

## 3. 执行顺序(TDD,每批次先写测试见红;新会话按此执行)

| 批次      | 动什么文件                                                                                                      | 交付                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1 存储    | `src/eval-store.ts`、`tests/eval-store.test.ts`                                                                 | v5 两表 + CRUD + 迁移幂等 + 拒绝 v6                                                                                             |
| 2 纯函数  | `src/harness-probe.ts`(新)、`tests/harness-probe.test.ts`(新)                                                   | 校验/双臂 prompt/盲选 parse/聚合门槛(含 tie、swap 不一致、命中数不降)                                                           |
| 3 CLI     | `scripts/eval-harness-probe.ts`(新)、`package.json`、`tests/eval-harness-probe.test.ts`(新)                     | 参数解析/dry-run/费用护栏(题数>10 拒跑)                                                                                         |
| 4 API+Web | `src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx` | 验收集端点(校验 400)、报告端点、提案详情探针摘要、前端两区                                                                      |
| 5 收官    | `docs/API.md`、`AGENTS.md`、`CLAUDE.md`                                                                         | 文档 → `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - RSI Phase 2 探针：A/B 双跑与盲选报告（任务AG）` |

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-ag-probe-plan.md`、`docs/task-ag-probe-handoff.md`、`src/harness-probe.ts`、`scripts/eval-harness-probe.ts`、`tests/harness-probe.test.ts`、`tests/eval-harness-probe.test.ts`
修改:`src/eval-store.ts`、`src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-store.test.ts`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx`、`package.json`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`

## 5. 风险与边界

1. **probe↔真实行为 gap**(最大风险):单轮直调无工具/无记忆/无渠道——工具类 adapter 改进探不出。缓解:报告显式标注覆盖面;采纳仍人审;Phase 3 再议全链路。
2. **judge 偏置**:位置偏置→双向 swap;长度偏置→judge prompt 明示「长度不是质量」;模型偏置→judge 模型与 proposer 同端点(已知局限,Phase 3 可换 judge 模型维度)。
3. **费用**:每题 = 2 生成 + 2×2 判定 = 6 次 flash 调用,5 题 ≈ 30 次;`--dry-run` 先看计划;题数硬上限 10;手动触发不进门禁。
4. **验收集质量**:太松判不出差异、太紧误杀——expectNotes 必填 + 建议从 obs_turns 真实问题导入(手抄,Phase 2 不做自动导入)。
5. **提案-探针串通**:proposer 永不见验收集(§2.3);若未来放开需重新评审。
6. **schema v5**:纯加表,风险低于 v4(列迁移);迁移幂等 + 拒绝降级沿用。
7. **竞态**:probe 运行中提案被采纳/拒绝→报告照常落库,详情页按提案当前状态展示(报告只是历史证据)。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):① Harness 演化 tab 为该 workspace 写入 4–5 题验收集(含「总结表格」类真实问题+要点)→ ② 跑一次 evolve 产出新提案 → ③ `npm run eval:harness-probe -- --workspace <jid> --proposal <id> --dry-run` 看计划 → ④ 去掉 --dry-run 跑真报告(约 30 次 flash 调用)→ ⑤ 提案详情显示探针报告(票数/逐题对照/judge 理由/verdict)→ ⑥ 依据报告人审采纳或拒绝 → ⑦ obs_turns 归因列继续累积版本分组数据。
