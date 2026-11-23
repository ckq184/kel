# ISSUE-16 R2 收尾遗留：group_created 掉线逻辑、待决策项与零散清理

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | `claude/issue-16-r2-closeout-leftovers-2512ab`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 类型          | 掉线逻辑决策、待决策项收口、零散清理、防回归契约测试                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 依赖          | 无（ISSUE-01 至 13、15 已合入 main）                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 预计改动路径  | `web/src/components/layout/AppLayout.tsx`、`src/types.ts`、`src/web.ts`、`src/task-scheduler.ts`（后两项仅在 A 节选 (a) 时）、`src/routes/config.ts`、`src/routes/groups.ts`、`src/group-queue.ts`（仅注释）、`src/qq-streaming-card.ts`、`src/db.ts`、`web/src/stores/agent-profiles.ts`、`web/src/stores/usage.ts`、`web/src/hooks/useAgentProfileForm.ts`、`web/src/utils/toast.ts`、`shared/stream-event.ts` 及三份同步副本、`docs/issues/README.md`，以及相应的 `tests/**` |
| 需用户决策    | **是**：A 节、C 节逐项拍板                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 来源          | 2026-11-23 任务池完成度核查（main HEAD `ccd3b3d`）                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 背景

2026-11-23 对任务池做了一次完成度核查：ISSUE-01 至 13、15 已完成并合入 main，ISSUE-14 仍待领取。核查中发现一处由批量删除造成的掉线逻辑，另外各 issue 交付记录里登记过的待决策项和小遗留，至今没有归属到任何 issue。本 issue 统一收口。

下文行号以 `ccd3b3d` 为准，领取时请按语义重新定位。

## A. 掉线逻辑：WS `group_created` 只剩消费端（需用户决策）

**证据链**

1. 生产者 `broadcastGroupCreated`（原在 `src/web.ts`）从建仓快照 `7f41d5b` 起就没有调用方：`SchedulerDependencies.onWorkspaceCreated` 只有声明、从未被调用，`src/index.ts` 只是把这个函数注入进去。
2. ISSUE-08（`e244bd2`）删除了 `onWorkspaceCreated` 字段和注入，并在交付记录里登记：`broadcastGroupCreated` 是 `group_created` 的唯一生产者，前端仍在订阅，**待用户决策**。
3. ISSUE-06（`68ed290`）把 `AppLayout` 的订阅改成刷新 chat store。修的是消费端，生产者当时已经没有调用方。
4. ISSUE-12 遗留处置（`4a32948`）把 `broadcastGroupCreated` 当作“31 个死导出”之一删除，提交信息没有提到它和 ISSUE-08 那条登记的关系。

**现状**

- `web/src/components/layout/AppLayout.tsx:88-101` 仍在订阅 `group_created`，收到后刷新 chat store 的工作区列表和任务列表。
- `src/types.ts:930` 仍保留这个 WS 消息类型。
- `src/` 和 `shared/` 中已经没有任何生产者。
- 补充调查：当前代码里没有找到定时任务新建工作区的路径。`task-` 前缀只出现在会话 ID（`src/task-scheduler.ts:386`、`:390`、`:1211`）和旧任务工作区的清理逻辑（`:1577-1588`、`:3438-3444`）里。订阅注释所说的“定时任务工作区创建”场景，初步看可能已经不存在，领取后需要复核。

**影响**：删除本身没有引入新的回归，因为生产者早就没有调用方。但功能缺口一直存在：如果后端还有不经过 Web 发起的工作区创建路径，侧边栏不会自动刷新。

**方案（请用户拍板）**

- **(a) 补生产者**：先盘点后端所有不经过 Web 发起的工作区创建路径（定时任务、IM 命令等），在这些路径上恢复广播 `group_created`（走 `src/web.ts` 现有的广播函数），并加测试锁定。
- **(b) 连消费端一起下线**：删除 `AppLayout.tsx` 中的订阅和 `src/types.ts` 中的 `group_created` 变体，同时搜索 `tests/`、`docs/` 中的引用并一起处理。

如果复核确认已经不存在这类创建路径，建议选 (b)。

## B. 防回归：WS 下行消息的生产者/消费者契约测试

ISSUE-13 的三个契约测试覆盖了 StreamEvent、IPC 类型和 HTTP 路由，但没有覆盖 WS 下行消息类型，所以 A 节这种“删了生产者、留着消费者”的情况没有被测试拦下来。

1. 新增一个契约测试（例如 `tests/ws-message-producer-contract.test.ts`）：
   - `src/types.ts` 中 WS 下行消息联合类型的每个 `type`，在 `src/` 里至少要有一个生产点，在 `web/src/` 里至少要有一个消费点；
   - 反过来，`web/src/` 订阅的每个类型都必须存在于这个联合类型中。
   - 消费点的写法不止一种（`wsManager.on('...')`、store 内的分发等），领取时先盘点清楚再写扫描规则。
2. 已知缺口白名单的写法与 ISSUE-13 相同：每一条都要注明 issue 编号。A 节落地后，`group_created` 这一条要同步删除。
3. 测试失败时，提示信息要说明：删除生产者时必须同时处理消费端，掉线逻辑要先登记、由用户决定。
4. 只新增测试文件，不修改 `scripts/verify.mjs` 的六步结构。

## C. 各 issue 登记过的待决策项（逐项请用户拍板）

| #   | 来源                  | 现状                                                                                                                                                                                                                                                                                                               | 可选方案                                       |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| C1  | ISSUE-07 遗留 1       | 通过 PATCH 或 secrets 写入口，可以把**没有 token** 的 third_party 供应商的 Base URL 清空，得到 Base URL 和 Auth Token 都为空的状态，绕过了创建时“二选一”的规则（没有凭据泄露风险）。相关代码在 `src/routes/config.ts`（`a593fa9` 补的合并态校验附近），测试是 `tests/unified-provider-third-party-baseurl.test.ts` | 在这两个写入口也校验“至少填一项” / 维持现状    |
| C2  | ISSUE-07 遗留 3       | `GET\|PUT /api/groups/:jid/mcp` 的 410 路由（`src/routes/groups.ts:2596-2608`）不做鉴权，也不检查资源是否存在。响应是固定常量，没有信息泄露。需要用户显式确认一次                                                                                                                                                  | 确认保持现状 / 改成先鉴权再返回 410            |
| C3  | ISSUE-08 偏差 1       | `src/qq-streaming-card.ts` 中的 `lastAuxFlushTime`、`AUX_FLUSH_INTERVAL`、`buildAuxPrefix`：文件头注释（`:32`）写明了保持休眠的理由（QQ 前缀稳定性），属于意图信号                                                                                                                                                 | 保留，并在注释里补上 issue 引用 / 删除         |
| C4  | ISSUE-08 范围外登记 2 | `src/db.ts` 中的 `advanceSkippedTask`、`clearStaleTaskLeases`、`getDueTasks` 没有生产调用方（`getDueTasks` 在 `src/routes/tasks.ts:572`、`:589` 只出现在注释里），只有 `tests/task-restart-recovery.test.ts` 在调用，属于意图信号                                                                                  | 保留 / 连同测试一起删除，并改写引用它的注释    |
| C5  | ISSUE-08 范围外登记 3 | `web/src/stores/usage.ts` 把后端返回的 `scope`、`dataRange` 归一化后写进 state（`:580-581`），但没有任何组件读取。产出没人消费，需要先判断这是功能缺口还是冗余                                                                                                                                                     | 在用量页展示数据范围 / 从 store 删除这两个字段 |

## D. 零散清理（不需要决策，删除前仍按审查口径交叉核实）

1. **失实注释**：`src/group-queue.ts:892` 的注释写着 “User-level concurrent container limit (billing)”。billing 已在 ISSUE-09 下线，这个上限其实是 ISSUE-07 第 1 项恢复的用户级并发上限。只改注释。（来源：ISSUE-07 遗留 2）
2. **无人读取的字段**：`web/src/stores/agent-profiles.ts:50` 的 `error` 字段没有任何读取方，加载失败已经由 `profilesError` 展示。删除这个字段及其所有写入点。（来源：ISSUE-06 范围外登记）
3. **死分支**：`web/src/hooks/useAgentProfileForm.ts:134` 的 `promptMode !== 'append'`。ISSUE-04 第 ④ 项选 B 之后，这个分支已经不可能为真。原登记位置是 `AgentProfilesPage.tsx:540`，ISSUE-12 拆分后迁到了这里。删除前先确认 `promptMode` 已经没有其他取值来源。（来源：ISSUE-04 遗留）
4. **孤儿导出**：`web/src/utils/toast.ts:193` 的 `shouldEmitBackgroundTaskNotice` 没有生产调用方。4 个测试文件只是在模块 mock 里放了一个同名的 `vi.fn`，并没有测试它（`tests/agent-notice-broadcast-contract.test.ts`、`tests/chat-agent-messages.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts`、`tests/pi-subagent-tool-contract.test.ts`）。删除函数，同时删掉这 4 处 mock 键。（来源：ISSUE-10 遗留）
5. **没有生产者的 StreamEvent 字段**：`shared/stream-event.ts:393` 的 `taskPatch`，runner 和宿主都不产出，Web 也不读取。ISSUE-10 登记的是“`taskPatch` 等没有生产者的字段”，所以领取时要先把 `StreamEvent` 每个字段的生产和消费情况全部扫一遍：有消费者、没有生产者的，按掉线逻辑登记给用户；两端都没有的，直接删除。改完执行 `make sync-types`。
6. **索引状态不一致**：`docs/issues/README.md` 索引表里 ISSUE-12 那一行还写着“进行中”，issue 文件里已经是“已完成”。改成“已完成”。

## 不在本 issue 范围内

- ISSUE-14（Channel Outbox 后台 worker）仍待领取，单独处理。
- 实机验收由用户执行：ISSUE-02、03、04、10、12 的交付记录里都有“待用户实机验收”的项，本 issue 不能代替。
- 远端分支 `claude/project-overview-ed5250`（11-18，13 笔提交，早于任务池，内容与 ISSUE-03、04 重叠）要不要删除，由用户决定并执行。领取本 issue 的会话不要自行删除远端分支。

## 注意

- 遵守 README 中的审查口径：掉线逻辑先请用户拍板；意图信号默认保留；删除前用 `git grep -w` 交叉核实调用方和产出的下游，搜索范围包括 `tests/` 和 `docs/`。
- 批量删除之前，先对照各 issue 交付记录里“待用户决策”的清单，避免把已登记的项当作死代码顺手删掉。A 节的问题就是这样产生的。
- 修改共享类型后执行 `make sync-types`；修改文档后执行 `npm run docs:check`。

## 验收标准

- A 节和 C 节的每一项都有用户的拍板结果，并按结果落地；交付记录里写明每一项最终选了哪个方案。
- B 节的契约测试已经落地，并且在 `npm run verify` 的 test 步骤中运行；白名单的每一条都有 issue 编号；A 节落地后，白名单里不再有 `group_created`。
- D 节逐项勾选，跳过的项写明原因。
- `npm run verify` 和 `node scripts/check-scope.mjs` 都通过。
- 如果 A 节选了 (a)：实机确认，在对应路径上创建工作区后，侧边栏会自动刷新。

## 交付记录

（领取后填写）
