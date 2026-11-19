# 任务立项：批次1 代码注释——三侧高价值热点

> - **立项日期**：2026-11-19
> - **base**：`5bd5c75`（开工前 HEAD，工作树干净）
> - **状态**：已批准（用户确认两个取舍：全中文注释；批次制推进，本任务只做批次1）
> - **性质**：纯注释新增，零行为变更（TDD 不适用——无可测行为差异；验收 = verify 六步全绿 + diff 纯注释新增 + check-scope 全在声明范围内）

## 1. 背景与取证

全库约 18.4 万行、360+ 文件，注释密度三侧极不均（2026-11-19 抽样统计）：

| 侧                                   | 规模                   | 注释密度            | 主要洼地                                                                                                                                                                                                                                                     |
| ------------------------------------ | ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 后端 `src/`                          | 163 文件 / ~117,681 行 | ~8.9%               | `channel-reliability-store.ts`（2.9%）、`memory-store.ts`（2.4%）、`skill-import-service.ts`（零）、`routes/workspaces.ts`（零）、`memory-service.ts` / `agent-builder.ts`（各仅 6 行）；巨型文件 `index.ts`（20,150 行）与 `db.ts`（12,838 行）无文件头导览 |
| 前端 `web/src/`                      | ~190 文件 / ~58,979 行 | **~2.1%（最薄弱）** | `pages/` 近零（AgentProfilesPage 2312 行/7 注释、MemoryPage 1597/2、UsagePage 1290/3）；零注释 store：`users.ts`、`groups.ts`、`channel-accounts.ts`、`container-env.ts`；`App.tsx` 路由真相源无文件头、逐路由无注释                                         |
| runner `container/agent-runner/src/` | ~7,150 行              | ~9.2%               | `prompt-plan.ts`（294 行/7 注释）、`pi-session.ts`、`pi-subagents.ts` 等适配层                                                                                                                                                                               |

历史取证：docs/ 中从未立项过补注释任务（既往只在死代码修剪中连带删过时注释）；`docs/constitution.md` 无注释风格条款，唯一相关是禁止行为第 5 条"通过注释……绕过错误"；`scripts/check-docs.mjs` 不解析源码注释，补注释不会触发 docs:check 失败。

已有可效仿范本（新注释风格的对齐基准）：

- `src/feishu-mention-gate.ts`——中文文件头写设计动机与历史 bug（fail-open→fail-closed），最佳范本；
- `src/group-queue.ts`——接口字段单行 `/** */`；
- `web/src/stores/chat.ts`——`// ─── 分段横幅 ───` + 解释性段落；
- `src/feishu-streaming-card.ts` / `src/qq.ts`——协议特性清单式头注释。

## 2. 方案

### 2.1 注释风格约定（长期沿用，落档于此）

1. **全中文**新增注释；既有注释（含英文）一律保留，不重写不翻译。
2. **只增不改**：diff 为纯注释新增，不改任何代码语义。
3. 三层次：
   - 文件头 `/** */`：模块职责、边界、关键机制、**为什么这么设计**（效仿 feishu-mention-gate.ts）；
   - 导出级 `/** */`：主要导出函数/接口/类型的契约说明；接口字段单行 `/** */`（效仿 group-queue.ts）；
   - 行内 `//`：只写"为什么"与坑，不复述代码可见的"是什么"（效仿 chat.ts）。
4. 按体积分层：**巨型（>3000 行）只做文件头导览 + 顶层分区注释**，不逐函数；中型（500–3000 行）文件头 + 主要导出；小型文件头 + 必要处。
5. TSX 内注释用 `{/* */}`；不确定的事实不写（标 TODO 或省略，宪法"禁止猜测"）；注释禁止出现密钥/敏感值；不得用注释绕过任何检查。

### 2.2 批次1 目标文件（20 个）

**shared（1）**：`shared/stream-event.ts`——为裸字段补中文 JSDoc（保留既有英文头与既有字段注释），改后必跑 `make sync-types` 同步三副本。

**后端（8）**：

- `src/index.ts`、`src/db.ts`——文件头导览 + 顶层分区注释（index.ts：启动编排/消息路由/IPC 消费/stream→卡片转发/健康检查；db.ts：建表分区、prepared-statement 缓存、schema 迁移机制——`_new` 表重建、增列）；
- `src/web.ts`（无文件头）、`src/channel-reliability-store.ts`（密度 2.9%）；
- `src/skill-import-service.ts`（零注释、安全敏感：zip 解压/git clone/配额限制）、`src/memory-service.ts`、`src/agent-builder.ts`；
- `src/routes/workspaces.ts`（零注释）。

**前端（8）**：

- `web/src/App.tsx`：文件头 + 路由表逐路由注释；
- `web/src/pages/AgentProfilesPage.tsx`、`MemoryPage.tsx`、`UsagePage.tsx`：文件头 + 分区；
- `web/src/stores/users.ts`、`groups.ts`、`channel-accounts.ts`、`container-env.ts`（均零注释）：文件头 + 关键 state/action。

**runner（3）**：`container/agent-runner/src/prompt-plan.ts`、`container/agent-runner/src/runtime/pi/pi-session.ts`、`container/agent-runner/src/runtime/pi/pi-subagents.ts`。

### 2.3 后续批次路线图（本任务不做，仅落档）

- **批次2**：后端 routes/ 其余（config/groups/agents/admin/tasks/skills/channel-accounts/monitor…）、`task-scheduler.ts` 调度状态机、`group-queue.ts` 流程、`container-runner.ts`、`feishu.ts`、`runtime-config.ts`；
- **批次3**：前端 `components/` 各域（chat 外）、剩余 stores/hooks/lib/utils、`features/`；
- **批次4**：`scripts/`、runner 其余适配层、`electron/`、小型杂项。

## 3. 裁决

- 采用"批次1 高价值热点先行"而非全库一次做完（用户确认）——全库约 360 文件一次改动违背宪法 1.5 最小范围修改，diff 无法审查。
- 新增注释统一中文（用户确认）——项目长期文档全中文、近期注释趋势亦中文；既有英文注释保留不动。
- 是否把 2.1 风格约定升级为 AGENTS.md/CLAUDE.md 长期条款：**本任务不做**，待批次推进稳定后由用户单独决定。

## 4. 已知边界

- `src/index.ts` / `src/db.ts` 仅导览级注释，单文件新增注释控制在数十行内；
- `shared/stream-event.ts` 的既有英文头注释及其"DO NOT edit copies"语义保留；三副本由 `make sync-types` 生成，不手改；
- 注释内容只写代码中可取证的事实；理解不到位的机制宁缺毋滥。

## 5. 不做

- 不改任何代码语义/格式重排/重构；
- 不重写、不翻译既有英文注释；
- 不改 AGENTS.md / CLAUDE.md / docs/constitution.md；
- 不碰敏感区域（`data/`、密钥、构建产物）；
- 不引入依赖、不加 lint 规则。

## 6. 步骤

1. 立项落档（本文档 + `.gatescope.json`）→ `docs: 立项 - …` 提交；
2. 按序补注释：shared → 后端 → 前端 → runner（每文件先读懂再写，禁止编造机制）；
3. `make sync-types`（stream-event.ts 改后）；
4. `npm run format:changed` → `npm run verify`（六步全绿）；
5. `node scripts/check-scope.mjs`（exit 0）；
6. `docs: 三侧高价值热点 - 补写批次1中文注释（20文件，纯注释新增）` 提交。

## 7. 风险与未验证项

- **Prettier 重排**：新注释插入可能触发周边行重排——`format:changed` 先行，verify 把关；
- **TSX 注释语法**：JSX 内必须 `{/* */}`，写错会 typecheck 失败（verify 拦截）；
- **巨型文件误判分区**：index.ts / db.ts 的分区导览以 grep 分节横幅与顶层定义取证，取证不到的分区不写；
- **注释过期风险**：注释描述现状快照，后续代码变更须同步注释——该纪律留待批次路线图稳定后决定是否写入条款。
