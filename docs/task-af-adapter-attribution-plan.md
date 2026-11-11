# 任务 AF 立项:RSI 归因补全 — obs_turns 记录 adapter 版本

> **状态**:2026-11-11 任务 AE 首环跑通(用户确认 RSI 生效)后,用户选定方向 A「归因补全」。基线=开工前 HEAD(`.gatescope.json` base)。
> **前置条件**:任务 AE 全链路(观测→提案→人审采纳→注入→lesson)已交付并在真实 workspace 运行;当前断点:`obs_turns` 不记录 turn 执行时的 adapter 版本,「RSI 生效」无法量化归因。

---

## 0. 一句话结论

`obs_turns` 加 `adapter_version` 列(eval.db v3→v4 前向迁移):观测 tap 在落 turn 时读取该 workspace 当前 ACTIVE adapter 版本(无 adapter=0),此后每个 turn 可按 adapter 版本分组——「v0 的 turn 行为发散、v1 收敛」从肉眼观察变成可查询的证据;配套 Web 补全:真实对话 tab 显示版本徽标、Harness 演化 tab 的 workspace 改下拉(新 `/harness/workspaces` 端点,免手输 JID)。

## 1. 已拍板裁决

1. **归因取值时机=观测 tap 时读文件**(`readAdapterFile(jid)?.version ?? 0`),不从 runner 回传:runner 输出协议不动(避免三侧类型变更与 `make sync-types` 链);adapter 只在 admin 采纳/回滚时变化(低频),「turn 完成时刻的 ACTIVE」与「turn 执行时刻的 ACTIVE」竞态窗口极小,Phase 1 归因精度足够。两处 tap(主链路 processGroupMessages + agent 链路 processAgentConversation)同构补齐。
2. **schema=obs_turns 加列**(`adapter_version INTEGER NOT NULL DEFAULT 0`,0=无 adapter):v4 迁移对既有库用 `ALTER TABLE ADD COLUMN`(v1→v3 均为建新表,首次引入列迁移;迁移幂等:先查 table_info 列存在再 ALTER);拒绝降级沿用。
3. **传递路径**:`TurnObserverResultContext` 加 `adapterVersion?: number`(缺省 0)→ insert 列;`insertTurn`/`ObsTurnInsert`/`ObsTurnRecord` 同步加字段;`listTurns` 返回带出。
4. **workspace 下拉=新只读端点** `GET /api/eval/harness/workspaces`(admin):`obs_turns` distinct workspace_jid(带 turn 数与最近时间)+ `harness_proposals` 有提案的 workspace 并集;Harness 演化 tab 用它渲染下拉,保留手输回退。
5. **版本徽标**:真实对话 tab 每行显示 `adapter v0/v1/…`(v0 弱化为不显或「基线」);Harness 演化 tab 版本历史不变。
6. **不改**:proposer/CLI/采纳链路/runner(本任务纯观测侧+Web)。

## 2. 方案设计

- `src/eval-store.ts`(改):`EVAL_SCHEMA_VERSION=4`;迁移块 `if (version < 4)` 内 ALTER(幂等);`ObsTurnInsert` 加 `adapterVersion: number`;`ObsTurnRow`/mapTurnRow/insertTurn SQL 同步;`listHarnessWorkspaces(): Array<{workspaceJid, turnCount, lastTurnAt, proposalCount}>`(obs_turns 聚合 + proposals 计数并集)。
- `src/turn-observer.ts`(改):`TurnObserverResultContext` 加 `adapterVersion?: number`;insert turn 对象带上。
- `src/index.ts`(改):两处 tap 的 context 加 `adapterVersion: readAdapterFile(chatJid)?.version ?? 0`(import 自 harness-adapter-store;try/catch 由读取函数自身保证)。
- `src/routes/eval.ts`(改):`GET /harness/workspaces`(admin)。
- `web/src/pages/EvalPage.tsx`(改):ObservedTurn 行徽标 `adapter v{n}`(v0 显示「基线」);HarnessEvolvePanel workspace 输入旁加 `<select>`(加载 workspaces 端点,选中即填入输入框,可继续手输)。

## 3. 执行顺序(TDD)

1. **批次 1 存储**:`tests/eval-store.test.ts` 扩展(v3→v4 ALTER 幂等、insertTurn/listTurns 带 adapterVersion、listHarnessWorkspaces 并集与排序、拒绝 v5)。
2. **批次 2 传递**:`tests/turn-observer.test.ts` 扩展(context.adapterVersion 落列、缺省 0)。
3. **批次 3 API**:`tests/eval-routes.test.ts` 扩展(/harness/workspaces 403/200 形状)。
4. **批次 4 前端**:`tests/eval-frontend.test.tsx` 扩展(徽标渲染、下拉存在且选项来自端点)。
5. **批次 5 文档+门禁**:API.md/AGENTS.md/CLAUDE.md → `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - obs_turns 记录 adapter 版本与 workspace 下拉（任务AF）`。

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-af-adapter-attribution-plan.md`
修改:`src/eval-store.ts`、`src/turn-observer.ts`、`src/index.ts`、`src/routes/eval.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-store.test.ts`、`tests/turn-observer.test.ts`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`
(不动:runner 全部、proposer、CLI、harness-adapter-store 的文件读写函数。)

## 5. 风险与边界

1. **v4 列迁移首例**:既有 eval.db(含用户真实观测数据)升级——ALTER ADD COLUMN 带 DEFAULT 幂等安全;迁移前后既有行 adapter_version=0(基线)语义正确;verify 全量+真实库冒烟(升级后 listTurns 正常)。
2. **归因竞态**:tap 时刻 ACTIVE ≠ spawn 时刻 ACTIVE 的窗口(采纳动作与 turn 完成同秒)理论存在,影响仅单 turn 归因,接受。
3. **workspace 并集端点**:obs_turns 无行但 proposals 有(如证据被清)仍显示;两端点均 admin。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):① 服务重启后在既有 workspace 再发 1 条消息 →「真实对话」tab 该行显示 `adapter v1`(此前旧行显示「基线」)→ ② Harness 演化 tab workspace 下拉出现该 workspace 且免手输 → ③ `node -e` 查 eval.db `SELECT adapter_version, COUNT(*) FROM obs_turns GROUP BY 1` 得 v0/v1 分组计数——RSI 前后行为对比自此有量化基线。
