# 任务 AE 立项:RSI Phase 1 — harness adapter 提案与采纳(prompt-only)

> **状态**:2026-11-11 用户提出「把 harness²/hermit 的 RSI 架构运用到 CKQClaw」,方案经用户确认后按宪法立项。基线=开工前 HEAD(`.gatescope.json` base;实现 diff 基线=立项提交)。
> **回滚点**:`.gatescope.json` 声明的 base。
> **前置条件**:任务 AB(eval.db+obs_turns+RecallJudge)、AD(评测集管理)已交付;`obs_turns` 已逐 turn 落库,`recall-judge.ts` 提供直连 OpenAI-compatible 端点+熔断+prompt hash 的 LLM-as-judge 先例。

---

## 0. 一句话结论

CKQClaw 获得 RSI 闭环的最小可用人审版:每个 workspace 一个**外挂 harness adapter**(`ADAPTER.md`,prompt-only,hermit prompt_only 模板同款最小形态),由 `scripts/eval-harness-evolve.ts` 读 `obs_turns` 证据(剥离 judge 字段的泄漏防线,harness² 纪律)→ LLM proposer 产出结构化提案(必须引用具体 turn 时刻,KEEP_BASE 合法)→ eval.db v3 落库 → Web「评测」页 admin-only「Harness 演化」tab 查看 diff/依据并**人审采纳/拒绝** → 采纳后经 ContainerInput 注入 runner prompt(与 workspace memory 同链),版本化可回滚;采纳时 reflect 产出 cue/lesson/evidence 三字段 lesson(三缺一不写,宁缺毋滥)。执行侧 Pi runner 零逻辑改动(仅拼一个 block)。

## 1. 已拍板裁决(技术选型按先例,无需用户再确认)

1. **adapter 表示=prompt-only 单文件**:`data/harness-adapters/<workspaceJid>/ADAPTER.md`,上限 16,384 字节(hermit prompt_only 模板 40KB 的收紧取值;PromptPlan 预算护栏之外的独立硬上限)。Phase 2 才扩展 skills/ 目录与数据化 manifest(hermit adapter.yaml 的 learnable/fixed 声明),Phase 1 可训练面以代码常量表达。
2. **存储=eval.db 加表**(`user_version 2→3` 前向迁移,拒绝降级沿用):`harness_proposals`、`harness_versions`、`harness_lessons` 三表(见 §2 schema)。adapter 正文双落:表内(版本快照/提案全文)+ 文件系统 `ADAPTER.md`(runner 注入读文件,不查 DB——runner 与 DB 无连接,文件 IPC 是既有边界)。
3. **proposer=直连 LLM 单次结构化调用**(recall-judge 同款模式:OpenAI-compatible `/chat/completions`、端点取 auto-memory llm 配置、prompt version hash、连续失败熔断),**不是** agentic 子进程:prompt-only 单文件提案不需要 agentic 编辑面,harness² 的 agentic proposer 推迟到 Phase 2 扩展 skills 时再评估。
4. **泄漏防线三道**(harness² 纪律):① 证据构建剥离 `obs_turns.judge_*` 全部字段(评分永不进 proposer 上下文);② `validateAdapterMd` 扫描 adapter 正文禁词(score/rubric/grader/评测关键词——防 proposer 写「讨好 judge」的指令);③ 提案 evidence 必须引用具体 turn_id+原文片段,引不出=提案 invalid。
5. **信号纪律进 prompt**(harness² HOW TO DECIDE):同类任务 turn 间分歧优先于一致失败;单样本证据标注弱;「什么都不改」(KEEP_BASE)是合法输出;每条编辑须可追溯到轨迹时刻。
6. **采纳=admin only 人审**(`manage_system_config`,与评测集 tab 同级):采纳/拒绝/回滚都是显式按钮动作=敏感区批准动作;无任何自动采纳路径(Phase 1 明确不做,Phase 2 才引入探针门槛)。
7. **注入链=decorateInitialUserTurn**,与 workspaceMemoryTurn.block 同位拼接(CLAUDE.md 既有先例),全渠道生效;adapter block 带 `version` 标记行,obs 归因可追溯。宿主读文件→`ContainerInput` 新可选字段→runner 拼 block(runner 不感知 RSI 概念)。
8. **lesson=采纳时 reflect**:采纳动作触发一次 LLM reflect(同 proposer 端点),产出 cue/lesson/evidence(+可选 confidence),三字段缺一整条不落库;Phase 1 起 lesson 即进 proposer 证据树(improvement harness 双层递归的最小形态)。
9. **CLI=手动触发、有费用、不进门禁**:`npm run eval:harness-evolve -- --workspace <jid> [--limit N]`(package.json scripts 增行,照 eval-auto-recall 先例)。
10. **workspace 边界**:adapter 按 `workspace_jid` 隔离(与 obs_turns 同键);无 workspace 归属的 turn 不参与。跨 workspace 迁移=Phase 3。

## 2. 方案设计

### 2.1 eval.db v3 schema(三表)

```sql
CREATE TABLE IF NOT EXISTS harness_proposals (
  id TEXT PRIMARY KEY,              -- hp_<uuid>
  workspace_jid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|adopted|rejected|invalid
  adapter_md TEXT NOT NULL,         -- 提案全文(KEEP_BASE 时为空串)
  keep_base INTEGER NOT NULL DEFAULT 0,
  diff_json TEXT,                   -- 与当时 active 版本的 unified diff(展示用)
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL,      -- [{turn_id, input_excerpt, output_excerpt, why}]
  baseline_version INTEGER,         -- 提案时的 active 版本(0=无)
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS harness_versions (
  id TEXT PRIMARY KEY,              -- hv_<uuid>
  workspace_jid TEXT NOT NULL,
  version INTEGER NOT NULL,         -- workspace 内 1 递增
  proposal_id TEXT,
  adapter_md TEXT NOT NULL,
  adopted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_jid, version)
);
CREATE TABLE IF NOT EXISTS harness_lessons (
  id TEXT PRIMARY KEY,              -- hl_<uuid>
  workspace_jid TEXT NOT NULL,
  cue TEXT NOT NULL,
  lesson TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
```

### 2.2 模块

- **`src/harness-adapter-store.ts`**(新):`validateAdapterMd(text)`(空/超限/禁词→issues 数组);`buildAdapterBlock({version, text})`(带版本标记行的 block 文本,纯函数);`saveAdapterFile(workspaceJid, text)`(写 `data/harness-adapters/<jid>/ADAPTER.md`);`readAdapterFile(workspaceJid)`;eval-store 三表的薄封装 CRUD 由 eval-store 自持(照 eval_datasets 先例),本模块只做文件+校验+block 纯函数。
- **`src/harness-proposer.ts`**(新):`PROPOSER_PROMPT_VERSION`;`buildEvidence({turns, currentAdapterMd, lessons})` 纯函数(组装证据文本,turns 已由调用方剥离 judge 字段);`proposerPrompt(evidence)`;`parseProposerResponse(raw)`(JSON→{keep_base, adapter_md, rationale, evidence[]},结构非法返回 null);`PROPOSER_CONSECUTIVE_FAILURE_BREAK=5` 熔断;`reflectPrompt(...)`/`parseReflectResponse(raw)`(三字段校验)。
- **`src/eval-store.ts`**(改):v3 迁移+`listHarnessProposals`/`getHarnessProposal`/`insertHarnessProposal`/`decideHarnessProposal`(adopted/rejected 状态机:仅 pending 可决)/`insertHarnessVersion`(workspace 内 max+1)/`listHarnessVersions`/`getActiveHarnessVersion`(max version)/`insertHarnessLesson`/`listHarnessLessons`。
- **`src/container-runner.ts`**(改):组装 ContainerInput 时读 `readAdapterFile`+active version→新字段 `harnessAdapter?: { text, version }`(读失败/无文件=undefined,零影响)。
- **`container/agent-runner/src/types.ts` + `index.ts`**(改):ContainerInput 类型加可选字段;`decorateInitialUserTurn` 链最前拼 `buildAdapterBlock` 等价 block(runner 内本地纯函数拼,不 import 宿主模块)。
- **`src/routes/eval.ts`**(改,全部 admin):
  - `GET /harness/proposals?workspace=<jid>` 列表(不含 adapter_md 正文,含状态/rationale 摘要/model/created_at)
  - `GET /harness/proposals/:id` 详情(全文+diff+evidence)
  - `POST /harness/proposals/:id/adopt`(校验 validateAdapterMd、写文件、插 version、reflect lesson、状态机)
  - `POST /harness/proposals/:id/reject`(状态机)
  - `GET /harness/versions?workspace=<jid>`(版本列表,active 标记)
  - `POST /harness/versions/:id/rollback`(active 指针=该 version;实现=用该 version 的 adapter_md 重写文件+新插一条 version 记录?**否**——回滚=文件写回该版本内容,versions 表不动,另加 `active_version` 概念存文件侧 `<dir>/ACTIVE` 记录当前生效版本号,避免版本表被回滚污染)
- **`scripts/eval-harness-evolve.ts`**(新):`--workspace <jid> [--limit 40] [--dry-run]`;流程=查 obs_turns(剥离 judge 字段)→ lessons → evidence → LLM propose → parse → validate → 落 proposal(pending);`--dry-run` 只打印不落库。
- **`web/src/pages/EvalPage.tsx`**(改):admin-only「Harness 演化」tab:workspace 选择(取自 obs_turns distinct workspace_jid+已有 proposals)→ 提案列表(状态徽标)→ 详情面板(渲染 diff、rationale、evidence 卡片:turn 摘录+理由)→ 采纳/拒绝按钮(确认弹窗:采纳=写入该 workspace adapter)→ 版本历史(active 高亮+回滚按钮)→ lesson 列表(只读)。

### 2.3 注入格式

```
<!-- ckqclaw-harness-adapter v{version} -->
# Workspace Harness Adapter
{adapter_md}
<!-- /ckqclaw-harness-adapter -->
```

拼在 `decorateInitialUserTurn` 链最前(先于 workspace memory block),后端续既有 `{block}\n\n{message}` 惯例。

## 3. 执行顺序(TDD,每批次先写测试见红)

1. **批次 1 存储**:扩展 `tests/eval-store.test.ts`(v2→v3 迁移幂等+三表 CRUD+状态机+唯一版本号+拒绝 v4)。
2. **批次 2 纯函数**:`tests/harness-adapter-store.test.ts`(校验空/超限/禁词/block 格式/文件读写)+ `tests/harness-proposer.test.ts`(证据构建剥离 judge 字段、prompt hash 稳定、parse 成功/畸形/KEEP_BASE、reflect 三缺一拒收)。
3. **批次 3 注入**:runner 侧测试(ContainerInput 带字段→block 拼接;无字段→行为与今天逐字节一致)+ 宿主 `container-runner.ts` 组装测试。
4. **批次 4 API**:扩展 `tests/eval-routes.test.ts`(401/403、列表形状、采纳全链路:校验失败 400/文件写入/版本插入、拒绝、回滚 ACTIVE 语义、非 pending 409)。
5. **批次 5 CLI+前端**:CLI dry-run/落库测试;扩展 `tests/eval-frontend.test.tsx`(tab 门控/列表/详情/采纳拒绝回滚交互)。
6. **批次 6 文档+门禁**:API.md/AGENTS.md/CLAUDE.md/package.json → `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - RSI Phase 1：harness adapter 提案与人审采纳（任务AE）`。

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-ae-rsi-phase1-plan.md`、`src/harness-adapter-store.ts`、`src/harness-proposer.ts`、`scripts/eval-harness-evolve.ts`、`tests/harness-adapter-store.test.ts`、`tests/harness-proposer.test.ts`
修改:`src/eval-store.ts`、`src/routes/eval.ts`、`src/container-runner.ts`、`container/agent-runner/src/types.ts`、`container/agent-runner/src/index.ts`、`container/agent-runner/tests/`(既有 runner 测试文件)、`web/src/pages/EvalPage.tsx`、`tests/eval-store.test.ts`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx`、`package.json`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`
(不动:`recall-judge.ts` 逻辑(仅参考先例)、`turn-observer.ts`、平台 `prompts/`、`mcp-tools.ts`、Pi SDK。)

## 5. 风险与边界

1. **eval.db v2→v3**:仅加三表+索引,前向迁移,拒绝降级(>3 报错)沿用;双写进程(WAL)模式不变。
2. **obs_turns 隐私进 LLM**:proposer 证据含真实对话文本,走 auto-memory llm 端点(与 RecallJudge 同通道同密级);evidence_json 落库含摘录(≤200 字/条,截断)。
3. **证据不足**:workspace 无 turn(或 <5 条)→ CLI 明确报错退出「证据不足,KEEP_BASE」,不产提案。
4. **费用**:每次 CLI 运行=1 次 proposer 调用(+采纳时 1 次 reflect),glm-flash 级成本;熔断 5 连败停。
5. **注入回归**:adapter 文件缺失/字段 undefined 时拼装链输出必须与今天逐字节一致(测试锁定);block 总长进 PromptPlan 既有预算护栏(50k 警告/100k 硬限)。
6. **回滚语义**:rollback 只改 ACTIVE 指针+文件,不产生新 version 记录,versions 表保持「被采纳过的历史」纯追加语义。
7. **敏感区合规**:adapter 落 `data/harness-adapters/`(gitignored 运行时数据);采纳/回滚=admin 显式动作;平台层零改动。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):① 跑若干真实对话产生 obs_turns → ② `npm run eval:harness-evolve -- --workspace <jid> --dry-run` 打印提案与依据 → ③ 去掉 --dry-run 落库 → ④ 评测页「Harness 演化」tab(admin)看到 pending 提案、diff、evidence → ⑤ 采纳 → `data/harness-adapters/<jid>/ADAPTER.md` 与 `ACTIVE` 出现、版本表+1、(可能)lesson 生成 → ⑥ 该 workspace 下一条对话的 prompt 含版本标记 block(turn 日志或 debug 验证)→ ⑦ 回滚到无 adapter 状态后拼装输出与改动前逐字节一致。
