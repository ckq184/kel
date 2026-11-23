# 任务池：死代码与臃肿审查 R2 的后续工作

> 来源：[死代码与臃肿审查 R2](../dead-code-review-r2.md)，基线 `3f34cf7`。
> 拆分原则：每个 issue 是一个可以独立验收、单独立项的工作包，标明了依赖关系和预计改动的文件，尽量避免两个会话同时改同一批文件。
> 派发方式：由用户在新的 agent 会话里指定 issue 编号来领取。

---

## 一、领取与交付流程（所有 issue 通用）

1. **确认可以开工**：issue 状态为“待领取”，依赖的 issue 已完成；或者 issue 里注明“可并行”。
2. **准备环境**：新 worktree 缺少 `web/` 和 `container/agent-runner/` 的依赖，先在这两个目录和根目录各执行一次 `npm ci`，否则 `npm run verify` 会在 typecheck 阶段失败。
3. **领取**：在你的分支里修改 issue 文件的元信息：状态改为“进行中”，领取人写会话名或分支名；同时更新本文件索引表里对应的那一行。这个改动随立项提交一起提交。
4. **按 `docs/workflow.md` 的标准流程执行**：
   - 需求采访：凡是 issue 中标注“需用户决策”的项，**先列出方案请用户拍板，不要自行决定**；
   - 立项：编写 `docs/<任务名>-plan.md`，并写入 `.gatescope.json`（`base` 填开工前的 HEAD，`allow` 列出允许改动的路径）；
   - 实现；
   - 验证：依次执行 `npm run verify`（六步门禁）和 `node scripts/check-scope.mjs`。
5. **提交**：提交信息首行格式为 `type: 范围 - 摘要`（例如 `fix: Pi事件 - 流事件补盖turnId`），由 commit-msg 钩子校验。合入 main 由用户决定。
6. **交付**：把 issue 状态改为“已完成”，在 issue 文件末尾的“交付记录”里写明提交号、验证结果，以及与 issue 描述的偏差。
7. **发现范围外的新问题**：不要扩大本 issue 的范围。在本目录新建 issue（编号顺延），或者在交付记录里登记。

### 用户定下的审查口径（所有 issue 都必须遵守）

- **掉线逻辑**（消费者还在，生产者没了）：不要直接删，先让用户决定是补生产者，还是连消费端一起下线。
- **意图信号**（有专门测试，或注释写明了设计动机）：默认保留，删除前必须经用户确认。
- **删除前要再次交叉核实**：用 `git grep -w` 检查调用方，同时检查它的产出还有没有下游在用；搜索范围要包括 `tests/` 和 `docs/`。

### 其他约束（摘自 CLAUDE.md）

- 修改共享类型后执行 `make sync-types`；修改 Prompt 后要确保 `scripts/check-agent-runner-prompts.sh` 通过；修改文档后执行 `npm run docs:check`。
- 修改数据库：新增 migration、升级 `CURRENT_SCHEMA_VERSION`、补迁移测试，并在**同一个提交**里更新 `tests/db-upgrade-safety.test.ts` 的 head pin。
- 真实 Provider 测试会产生费用。不要把凭据、Endpoint、模型名或未脱敏的回复写进日志或 issue。

---

## 二、索引

| 编号                                                            | 标题                                                     | 优先级 | 依赖                | 需用户决策           | 状态   |
| --------------------------------------------------------------- | -------------------------------------------------------- | ------ | ------------------- | -------------------- | ------ |
| [ISSUE-01](ISSUE-01-p0-runtime-confirmation.md)                 | P0 实机确认（只读诊断）                                  | P0     | 无                  | 否                   | 已完成 |
| [ISSUE-02](ISSUE-02-pi-stream-stamping-and-message-boundary.md) | Pi 事件契约（一）：流式盖章与消息边界                    | P0     | 01                  | 部分（已决策 a1）    | 已完成 |
| [ISSUE-03](ISSUE-03-pi-subagent-and-tool-card.md)               | Pi 事件契约（二）：子代理与工具卡                        | P0     | 01、02              | 部分（已决策 A）     | 已完成 |
| [ISSUE-04](ISSUE-04-pi-runtime-settings-and-credentials.md)     | Pi 运行时设置与凭据（6 项“设置不生效”）                  | P0     | 01（仅 OAuth 一项） | **是**               | 已完成 |
| [ISSUE-05](ISSUE-05-behavior-small-fixes.md)                    | 行为级小修：孤儿结果文件、溢出标记、/pair 正则、safeRoot | P1     | 无                  | 部分                 | 已完成 |
| [ISSUE-06](ISSUE-06-frontend-dropped-logic.md)                  | 前端掉线逻辑修复                                         | P1     | 无                  | 部分                 | 已完成 |
| [ISSUE-07](ISSUE-07-backend-dropped-logic-decisions.md)         | 后端掉线逻辑与意图项：决策与落地                         | P1     | 无                  | **是**               | 已完成 |
| [ISSUE-08](ISSUE-08-dead-code-batch1-orphans.md)                | 死代码批 1：孤儿函数、局部死代码、类成员（不涉及 DB）    | P2     | 无                  | 否                   | 已完成 |
| [ISSUE-09](ISSUE-09-dead-code-batch2-billing-and-db.md)         | 死代码批 2：billing 残留与 DB 死表死列迁移               | P2     | 07（仅 3 个列）     | 部分                 | 已完成 |
| [ISSUE-10](ISSUE-10-dead-code-batch3-legacy-consumers.md)       | 死代码批 3：Claude SDK 遗留消费端与无人消费的链路        | P2     | 02、03、04          | 部分                 | 已完成 |
| [ISSUE-11](ISSUE-11-compat-and-duplicate-convergence.md)        | 兼容层下线与重复实现收敛                                 | P3     | 06                  | **是**               | 已完成 |
| [ISSUE-12](ISSUE-12-structural-refactor.md)                     | 结构重构：镜像函数收敛与巨型函数拆分                     | P3     | 02、03、05、08、10  | **是**（已三项拍板） | 已完成 |
| [ISSUE-13](ISSUE-13-docs-drift-and-regression-contracts.md)     | 文档漂移修正与防回归契约测试                             | P3     | 04（仅文档部分）    | 否                   | 已完成 |
| [ISSUE-14](ISSUE-14-channel-outbox-worker.md)                   | Channel Outbox 后台 worker：重启后 retry_wait 自动重投   | P2     | 无                  | **是**               | 已完成 |
| [ISSUE-15](ISSUE-15-windows-test-compat.md)                     | Windows 测试兼容性：CRLF 源码锚点与路径分隔符归一        | P1     | 无                  | 否                   | 已完成 |
| [ISSUE-16](ISSUE-16-r2-closeout-leftovers.md)                   | R2 收尾遗留：group_created 掉线逻辑、待决策项与零散清理  | P2     | 无                  | **是**               | 已完成 |
| [ISSUE-17](ISSUE-17-stream-event-consumer-only-fields.md)       | StreamEvent 只有消费者的字段：逐字段决定补生产者还是下线 | P3     | 无                  | **是**               | 待领取 |

状态取值：待领取、进行中、待用户决策、已完成、已取消。

---

## 三、建议的启动顺序

| 波次   | 可以同时开的 issue                                  | 说明                                                                                                                                                               |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 第一波 | 01、05、06、07、08，以及 13 的契约测试部分          | 彼此没有依赖。01 是只读诊断，结论会决定 02、03、04 的范围；05 与 13（契约测试部分）已完成                                                                          |
| 第二波 | 02（等 01）、04（等 01）                            | 04 和 02 都要改 `pi-index.ts`，但改的是不同区域，可以并行；合入前先 rebase 最新的 main                                                                             |
| 第三波 | 03（等 02）、09（等 07）、11（等 06）               | 03 和 02 改同一个事件映射函数，必须串行                                                                                                                            |
| 第四波 | 10（等 02、03、04）                                 | 先确定哪些消费端被救活，再删剩下的                                                                                                                                 |
| 第五波 | 12（等 02、03、05、08、10）、13 的文档部分（等 04） | 结构重构放在行为修复全部完成之后；13 已完成，其 4 个挂靠子项（上下文窗口行、/mcp 不持久化描述、user-im 标注、uncertain outbox 描述）由 04/07/11 的实现提交顺带更新 |

**为什么不能先删死代码**：10 号要删的消费端（hook、raw_sdk_event 等），有一部分可能要在 02、03 里复用；`extractSkillName`、`summarizeToolInput` 也可能被 03 接回生产链路。所以 08 号明确排除了这几项，10 号必须等 02、03、04 完成后再开工。

---

## 四、文件冲突提示

| 文件                                                 | 涉及的 issue               | 建议                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container/agent-runner/src/runtime/pi/pi-runner.ts` | 02、03、10                 | 按 02 → 03 → 10 串行                                                                                                                                                            |
| `container/agent-runner/src/pi-index.ts`             | 02、04、07                 | 改动区域不同，可以并行，合入前 rebase                                                                                                                                           |
| `src/index.ts`                                       | 02、03、05、07、08、10、12 | 各 issue 改的区域不同。12 必须最后做                                                                                                                                            |
| `web/src/stores/chat.ts`                             | 03、06、08、10、11         | 03 先做，其余合入前 rebase                                                                                                                                                      |
| `src/group-queue.ts`                                 | 05、07、08                 | 改的方法不同，可以并行                                                                                                                                                          |
| `src/db.ts`                                          | 08、09                     | 09 涉及迁移，建议在 08 之后做                                                                                                                                                   |
| `shared/stream-event.ts`                             | 02、10、13                 | 改动后执行 `make sync-types`；13 已完成（其契约测试只读本文件）——02/10 增删事件类型会使 `tests/stream-event-producer-contract.test.ts` 按设计报红，须按其失败提示同步更新白名单 |
