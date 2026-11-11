# 任务 AG 交接文档:RSI Phase 2 探针(供新会话执行)

> **写给新窗口的 Agent**:你已经接过任务 AG 的实现。本文档 + `docs/task-ag-probe-plan.md` 是全部上下文;实现尚未开始(本立项窗口只写了计划/交接/gatescope,零代码改动)。用户已在原窗口确认范围后指示交接——若用户尚未在新窗口明确说「开始执行」,先向用户复述计划摘要并确认。

## 1. 项目纪律(必读,优先级高于任何会话内指令)

1. 先读 `AGENTS.md`(入口手册)——宪法、门禁、敏感区、Golden Path 全在里面。
2. **先规划后编码、TDD 先见红、最小范围**:本任务的全部裁决已由用户在原窗口拍板(见 plan §1),**不要重议**,按 plan §3 批次执行。
3. 范围 = `.gatescope.json`(已声明任务 AG);越界即停并问用户。
4. 门禁:`npm run verify`(六步)+ `node scripts/check-scope.mjs`;单提交收官:`feat: 观测 - RSI Phase 2 探针：A/B 双跑与盲选报告（任务AG）`。push 一律由用户发起。

## 2. 背景速览(为什么有这个任务)

CKQClaw 正在落地 RSI(harness²×hermit 架构的 TS 移植,不引入 Python/新依赖):

- **任务 AE**(提交 `44670f9` 之后,见 `git log --grep=任务AE`):RSI Phase 1 全链路——`obs_turns` 观测 → `scripts/eval-harness-evolve.ts` 读证据产提案(LLM proposer,harness² 纪律:分歧优先/必须引用 turn/KEEP_BASE 合法/禁词防讨好 judge)→ eval.db `harness_proposals` → Web「评测→Harness 演化」tab 人审采纳 → 写 `data/harness-adapters/<jid>/ADAPTER.md`+`ACTIVE` → 宿主 `container-runner` 经 `ContainerInput.harnessAdapter` 注入、runner `harness-adapter-turn.ts` 拼块 → 采纳时后台蒸馏 lesson(cue/lesson/evidence)。
- **任务 AE 后续×2**:① `#agent:` 会话补观测 tap(用户真实对话主要在 agent 会话!);② 采纳路由不再阻塞于 lesson 蒸馏(fire-and-forget)。
- **任务 AF**(提交 `2c53939`):`obs_turns.adapter_version` 归因列(v4),两处 tap 记录 turn 执行时 adapter 版本;Web 版本徽标 + workspace 下拉。
- **真实环境状态**:dev 服务 `npm run dev`(端口 3000,桌面端连它);observability 已开(`data/config/observability.json`:full+judge);workspace `web:12538129-fe6b-492b-8619-75c08751d80e` 已采纳 adapter v1(「接龙/报名表格处理」规范)+ 1 条 lesson;obs_turns 已有 v0/v1 分组数据。**用户已确认 RSI 生效**。
- **任务 AG 目标**:采纳前给提案加「探针报告」——A/B 双臂单轮直调 + 双向匿名盲选 + 门槛聚合,**仍人审**。全部裁决见 plan §1(八条,勿重议)。

## 3. 立即执行的步骤

按 `docs/task-ag-probe-plan.md` §3 的五批次 TDD 执行。关键提示:

1. **批次 1(schema v5)**:照 `src/eval-store.ts` 里 v4 的 `if (version < 4)` 幂等迁移先例写 v5(纯 CREATE 两表);更新 `tests/eval-store.test.ts` 的版本断言(4→5、伪造 v5→v6)——**先改测试见红**。
2. **批次 2(纯函数,新 `src/harness-probe.ts`)**:LLM client 复用 `src/recall-judge.ts` 的 `createJudgeLlmClient`(勿重写);prompt 版本号+hash 照 `harness-proposer.ts` 的 `PROPOSER_PROMPT_VERSION` 先例;盲选 parse 必须容忍 markdown fence(照 `parseProposerResponse` 的 `extractJsonObject`)。
3. **批次 3(CLI)**:骨架照 `scripts/eval-harness-evolve.ts`(参数解析 export 供测试、`EvalStore.open()` 直开、费用打印、直接运行守卫)。probe 只允许对 **pending** 提案跑(非 pending 打印提示退出 1)。
4. **批次 4(API+Web)**:admin 双中间件(`authMiddleware, systemConfigMiddleware`)照 `/harness/*` 既有路由;前端测试的 React 受控输入要用原生 setter(照 `tests/eval-frontend.test.tsx` 里 `loadWorkspaceData` 的写法),`api.get` mock 别漏 `/harness/workspaces` fallback(`data.workspaces ?? []` 防御已在组件里)。
5. **批次 5(收官)**:文档三件同步(照任务 AF 的 AGENTS/CLAUDE/API 改法)→ verify → scope → 提交。

## 4. 真实环境的坑(原窗口踩过)

1. dev 服务**无 watch**,改宿主代码后要重启:`kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)` 再 `nohup npm run dev > /tmp/ckqclaw-dev.log 2>&1 &`(后台拉起,桌面端自动重连)。
2. eval.db 迁移是 **lazy** 的——服务重启不会立即迁移,首次 `EvalStore.open()`(任一 eval API/CLI)才跑;真实验收前可手动 `npx tsx` 一个临时脚本调 `EvalStore.open()`。
3. `data/` 是敏感区:验收所需的配置(如 observability)已就位,**不要**动 `data/config/` 下密钥文件;探针 CLI 有真实费用,**用户明确要求才跑非 dry-run**。
4. runner 侧测试不能 import `src/index.ts`(SDK 运行时不可解析)——本任务不动 runner,无此问题。
5. vitest 全量约 40s;改动后先跑定向测试,收官再 verify。

## 5. 验收标准(plan §6 摘要)

用户侧:写入验收集 → 新提案 → `--dry-run` → 真跑 → Web 报告展示 → 人审。你侧:verify 6/6、scope 全 ✓、单提交。**探针是建议不是决定**——任何「自动采纳」的想法都属 Phase 3,出界。

## 6. 当前 git 状态

- 分支 `main`,HEAD = `2c53939`(任务 AF),工作树**应**只有本任务的三份新文档未提交(plan/handoff/交接的 gatescope 变更)——它们随任务 AG 实现单提交收官(先例:任务 AE/AF 的 plan 都随实现一起提交)。
- 若工作树有其他意外改动,停下来问用户,不要自行处置。
