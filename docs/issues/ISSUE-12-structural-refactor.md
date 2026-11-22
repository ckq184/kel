# ISSUE-12 结构重构：镜像函数收敛与巨型函数拆分

| 字段          | 值                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                   |
| 领取人 / 分支 | issue-12-structural-refactor（基线 29ee7f0，方案见 docs/issue12-structural-refactor-plan.md）                                                                            |
| 优先级        | P3                                                                                                                                                                       |
| 类型          | 纯重构，不改变行为                                                                                                                                                       |
| 依赖          | ISSUE-02、03、05、08、10（必须在这些行为修复和清理完成之后进行）                                                                                                         |
| 阻塞          | 无                                                                                                                                                                       |
| 预计改动路径  | 在拆分方案获批后确定。可能涉及 `src/index.ts`、`src/feishu.ts`、`src/qq.ts`、`src/wechat.ts`、`src/db.ts`、`web/src/pages/AgentProfilesPage.tsx`，以及新拆出来的模块文件 |
| 需用户决策    | **是**：拆分方案需要先经用户批准                                                                                                                                         |
| 来源          | 审查报告 §9、§14.2（这部分由另一份审查发现）                                                                                                                             |

## 背景

`src/index.ts` 有 20176 行，`src/db.ts` 有 12868 行。膨胀的直接原因有两个：两个宿主处理函数互为镜像，以及几个巨型的初始化函数。P0 修复（ISSUE-02、03）会改到这两个镜像函数，所以重构必须排在行为修复之后，否则两次大改会互相冲突。

## 范围

1. **镜像函数收敛**
   - `processGroupMessages`（`src/index.ts:5346`，3634 行）和 `processAgentConversation`（`:13544`，2907 行）。行数已经核实。另一份审查估计两者有 9 组对齐块，重复约 2000 行，这一点还没有逐块比对。
   - 做法：先逐块比对，输出一份镜像块清单，再把 channel-turn 治理脚手架抽成公共模块。
2. **拆分巨型函数**
   - `createFeishuConnection`（`src/feishu.ts`，约 2659 行），以及结构相同的 QQ 和微信连接函数
   - `initDatabase`（`src/db.ts`，约 2110 行）
   - `AgentProfilesPage`：一个函数约 2126 行，里面有 41 个 `useState`
   - `processTaskIpc`（`src/index.ts:11187`，2351 行）、`startIpcWatcher`（`:9767`，1288 行）
3. **收窄导出**：488 个导出只在本文件内使用，去掉多余的 `export`（风格类修改，可以单独提交）。
4. **样板代码**（可选）：
   - `canAccessGroup` 后接 404 的写法出现了约 25 次
   - zod 校验失败返回 400 有 4 种不同写法
   - 测试中的 `asUser`、`createUser` 重复了约 10 次

## 流程要求

1. 领取后先输出拆分方案：每次提交只拆一个单元；写明新模块的边界、接口，以及回滚点。经用户批准后再动手。
2. 每次提交都必须保持行为不变：`npm run verify` 全绿，关键流程（Web、飞书、QQ、微信的对话，定时任务）实机冒烟通过。
3. 不要和任何行为修改混在同一个提交里。

## 验收标准

- 所有测试通过；实机冒烟通过。
- 交付记录里写明每次提交前后的文件行数和函数行数变化。

## 交付记录

**提交范围**：`e15ac6b..25ec785` + 本落档提交，共 105 提交（立项/前置 3 + 波1×41（style:）+ 波2×21 + 波3×8 + 波4×11 + 波5×11 + 波6×6 + 波7×3 + 波8 落档 1）。每个实现提交均过 `npm run verify` 六步门（format:changed→docs:check→三侧 typecheck→全量 vitest→build:all→git diff --check）与 `node scripts/check-scope.mjs`（路径数随模块落地 233→266；`.gatescope.json` 声明扩宽 2 行于 65f528a 留痕：`src/validation-response.ts`、`src/web.ts`）。逐提交行数台账见各提交信息（波 2-7 全量携带；波 1 为机械导出收窄、未逐条携带，属台账偏差，见下"审查处置"）。

**巨石收敛总账**（基线 29ee7f0 → HEAD 25ec785）：

| 文件                                | 前 → 后       | 净变  |
| ----------------------------------- | ------------- | ----- |
| src/index.ts                        | 19127 → 15067 | -4060 |
| src/db.ts                           | 12728 → 10785 | -1943 |
| src/feishu.ts                       | 3781 → 1938   | -1843 |
| src/qq.ts                           | 2159 → 528    | -1631 |
| src/wechat.ts                       | 1564 → 699    | -865  |
| web/src/pages/AgentProfilesPage.tsx | 2191 → 1068   | -1123 |

**新公共层**：`src/db-schema/`×8、`src/ipc/`×10、`src/host-state.ts`、渠道模块 `feishu-*`/`qq-*`/`wechat-*`×21、波 6 四模块（conversation-indicator-ledger 174 行 / streaming-card-lifecycle 199 行 / reply-projection-delivery 162 行 / channel-turn-governance 174 行）、`src/validation-response.ts` 41 行、`src/web-context.ts` groupAccessDeniedResponse、web hooks×4+组件×6+utils×1（1756 行）、`tests/helpers/route-test-user.ts` + 防回潮契约测试。

**波次要点**：波 1 导出收窄；波 2 渠道三函数拆分；波 3 initDatabase 2104 行→142 行壳 + 8 步进模块；波 4 IPC 两函数拆分（processTaskIpc/taskOps 1004 行/watcher 868 行等 10 模块 + host-state）；波 5 页面 2191→1068；波 6 见下；波 7 样板三项（404×30、zod400 四式×33、测试用户 helper×14 文件）。

**波 6 修订收官拍板（用户 2026-11-22 批准"接受现状，修订收官"）**：实交 6 子单元（62b74ce runAgent 泛化、1ef0d77 指标台账 M6、d1b5fdb 卡生命周期 M12/M13/M35、5524e7d M25、bcd0059 M37/M38、fb5ac7b M8/M9）；五处语义分歧中 ①suppressOnRetry ②completePayloadKey（不统一、不做 DB 兼容读取）③commitCursorOnInterrupt ④silentSuccess 探针全部参数化，⑤M17 cursor 校验按计划留 A 侧薄适配层。深水区九镜像族（M7/M11/M16/M17/M22/M24/M27/M30/M36）维持两侧现状，理由：计划 §8.4 风险缓冲条款（40+ 可变闭包状态须先收编）；剩余族为行为分歧（持久化后端/scheduled 扇出/agent 状态机）非复制粘贴型重复；行数预估值在"不改变行为"红线下不可达。`src/streaming-card-lifecycle.ts` 模块头注释已随本提交订正（原指向已取消的 6.5/6.6 迁移预告）。

**审查处置**（双独立审查结论见 `docs/审查记录.md`）：

- 波 1 提交信息无行数台账（历史提交不可回填，登记为台账偏差；实际为 export 关键字机械增删，单提交净变 ≤7 行）。
- tests helper 计划口径（变体 1×12 文件）与本波实交（全仓内联定义合计 14 文件：变体 1×10、owner-profile×1、system-settings×2、interaction×1、memory×1，createUser/seedUser 与上述去重）存在差因，25ec785 未留痕，以本记录为准；计划外第 4（INTERACTION）/第 5（MEMORY）变体已具名导出并入防回潮契约。
- 台账勘误补记（按 6.1 先例）：d1b5fdb 新模块实 199 行（非 215）、index.ts 实净 -69（非 -72）；62b74ce 次级声明"runAgent 247→302 行"中 302 为含 RunAgentTurnOptions/RunAgentOutcome 接口与 JSDoc 的泛化块整体口径，函数本体顶层边界 274 行。
- 实机冒烟：未执行（真实 Provider 会产生费用且需凭据，安全红线禁止写入日志）——按流程要求 §2 如实登记，待用户点验后补记。

**遗留待用户拍板**：31 个死导出处置；真实渠道冒烟清单；是否推送合并 main。
