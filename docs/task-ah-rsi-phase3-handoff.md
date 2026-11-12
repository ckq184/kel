# 任务 AH 交接文档:RSI Phase 3(供新会话执行)

> **写给新窗口的 Agent**:你接手任务 AH(RSI Phase 3)的实现。本文档 + `docs/task-ah-rsi-phase3-plan.md` 是全部上下文;实现尚未开始(立项窗口只写了计划/交接/gatescope,零代码改动)。若用户尚未明确说「开始执行」,先复述计划摘要请其确认。

## 1. 项目纪律(必读,优先级高于任何会话内指令)

1. 先读 `AGENTS.md`(宪法入口手册):门禁、敏感区、Golden Path、范围核对。
2. **TDD 先见红、最小范围**;任务全部裁决已在 plan §1 拍板(七条),**勿重议**——尤其「不做全自动采纳」是用户已确认关闭的议题。
3. 范围 = `.gatescope.json`(任务 AH 已声明);越界即停。
4. 门禁:`npm run verify` + `node scripts/check-scope.mjs`;单提交:`feat: 观测 - RSI Phase 3：近邻 lesson、adapter 克隆与一键提案（任务AH）`;push 只由用户发起。

## 2. 背景速览(RSI 已走过的路,全部已交付并真机验证)

CKQClaw 的 RSI 是 harness²(Google,arXiv:2610.14224)×hermit(Infini-AI-Lab)架构的纯 TS 移植,零 Python/零新依赖:

| 任务       | 提交                                 | 能力                                                                                                                               |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| AE Phase 1 | `ee465b7`(+`92570a9`/`a3c2e8e` 后续) | 观测→proposer 提案→人审采纳→注入→lesson 蒸馏全链路;`#agent:` 会话观测 tap;采纳非阻塞                                               |
| AF 归因    | `2c53939`                            | `obs_turns.adapter_version`(v4);Web 版本徽标+workspace 下拉                                                                        |
| AG Phase 2 | `b371c63`(+`06baaf0` 退避重试)       | 探针:A/B 双臂直调+双向盲选+门槛聚合(v5 `harness_probes`/`harness_acceptance_sets`);verdict=adopt/keep_base/inconclusive;**仍人审** |

核心机制备忘(细节看 AGENTS.md 命令表 41/42 行):

- 提案 CLI:`npm run eval:harness-evolve -- --workspace <jid>`,证据=`obs_turns`(judge 字段被 `sanitizeObsTurn` 白名单剥离)+当前 adapter+lessons;harness² 纪律在 `src/harness-proposer.ts` 的 prompt 里(分歧优先/必须引用 turn/KEEP_BASE/禁词)。
- 探针 CLI:`npm run eval:harness-probe`,只对 pending 提案;已知 gap=单轮直调无工具/记忆。
- 采纳=admin Web 动作(写 `data/harness-adapters/<sanitized-jid>/ADAPTER.md`+`ACTIVE`);注入=宿主 `buildHarnessAdapterInput`→`ContainerInput.harnessAdapter`→runner `harness-adapter-turn.ts`。
- **任务 AH 目标**(plan §0):近邻 lesson 注入 + adapter 克隆走提案门 + Web 一键 evolve;明确不做:全自动采纳、skills 扩展、全链路 probe、WS 进度。

## 3. 立即执行的步骤

按 plan §3 五批次。关键提示(原窗口/前置任务踩过的坑都在这):

1. **批次 1**:纯函数放 `src/harness-proposer.ts`(勿新建文件);分词器内联(中文 2-gram + 英文词),不引入分词库;`buildEvidence` 新参数全部可选——**既有测试(证据树格式)不能红**,旧签名调用零改动。
2. **批次 2**:evolve CLI 的回退开关解析进 `parseEvolveArgs`(该函数已有测试在 `tests/eval-harness-evolve.test.ts`,扩展即可)。
3. **批次 3**:照 `src/eval-trigger.ts` 的完整模式抄结构(spawn 注入/单飞锁/状态快照/resetForTests),但**独立新文件**、不 import eval-trigger(它绑定 auto-recall 参数);命令=`npm run eval:harness-evolve -- --workspace <jid>`,用 `process.execPath`+tsx 或直接 `npm run`(看 eval-trigger 怎么拼——保持同款,Windows `shell:true` 注入面的注释是教训)。
4. **批次 4**:路由全 admin 双中间件;克隆端点 body 校验 `{targetWorkspace: string}` 非空+与源不同(400);前端 React 受控输入用原生 setter(照 `tests/eval-frontend.test.tsx` 的 `loadWorkspaceData` 写法);mock `api.get` 时别漏 `/harness/workspaces`、`/harness/evidence-status`、`/harness/evolve/status` 的 fallback。
5. **批次 5**:AGENTS.md 命令表 41 行 evolve 条目要补「Phase 3 默认分簇+近邻 lesson(可 --no-cluster/--no-neighbors 回退)」与新端点;CLAUDE.md eval.db 段补两查询方法(无 schema 变更,版本仍 v5——**勿写 v6**);API.md 照 AG 段落格式追加。

## 4. 真实环境的坑(AE~AG 窗口实测)

1. dev 服务**无 watch**:改宿主代码后 `kill $(lsof -nP -iTCP:3000 -sTCP:LISTEN -t)` → `nohup npm run dev > /tmp/ckqclaw-dev.log 2>&1 &`;桌面端(连 3000 的 Electron 壳)自动重连。
2. eval.db 是 **lazy open**:服务重启不迁移不打开;首次 eval API/CLI 才触发。本任务无 schema 变更,无此顾虑,但真机验收前跑一次任一 eval 端点热身。
3. `data/` 敏感区:observability 已开(full+judge);`data/config/` 密钥文件勿动勿打印;evolve/probe 有真实费用,**用户明确要求才跑非 dry-run**。
4. runner 侧测试不能 import runner `src/index.ts`(SDK 运行时不可解析)——本任务不动 runner。
5. 定向测试先行,收官再全量 verify(约 40s);verify 里 format 会动文件,提交前跑完整链。

## 5. 验收标准(plan §6 摘要)

用户侧:第二 workspace 攒 ≥10 turn → 提示条+一键提案(证据含近邻经验节)→ 探针 → 人审;版本历史克隆到另一 workspace 走提案门。你侧:verify 6/6、scope 全 ✓、单提交收官。

## 6. 当前 git 状态

- 分支 `main`,HEAD = `06baaf0`(任务 AG 后续修复)。工作树预期:仅本任务三份立项文件(plan/handoff/gatescope 变更)未提交 + 一个 `start-desktop.command`(**用户自建的桌面端启动脚本,非任务产物——勿动、勿提交、勿删除**)。有其他意外改动即停,问用户。
