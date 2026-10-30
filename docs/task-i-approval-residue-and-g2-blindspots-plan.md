# 任务 I：审批残留再生修复 + G2 恢复监视盲区收口

> **文档定位**：用户 2026-10-22 批准的两项小立项，自包含交接。建议注入语：
> **「阅读 docs/task-i-approval-residue-and-g2-blindspots-plan.md，开工。」**
> **基线（回滚点）**：`f782bd0`。**模式**：同任务 H 链——TDD、每任务一提交
> （两任务各一枚 `fix:`）、真机验证、交付报告附六门禁证据。

## 0. 一句话结论

任务 I1 = 审批「决定后 pending 文件残留再生」修复（`decideApproval` 决定后
清文件 + 扫描对已决定残留自愈 + `listPendingApprovals` 名实修正），让 H3 的
「重放噪音清零」成果持久；任务 I2 = G2 恢复监视盲区收口（冷启动查询补债务
锚点 + 恢复扫描与消息循环解耦），并修正任务 H 遗留的一处错误结论。

## 1. 任务 I1：审批残留再生修复

### 证据

- `src/approval-service.ts` `decideApproval`：原子写 `decisions/{id}.json`
  → 更新 DB → 通知，**从不删除 `pending/{id}.json`**。每次审批后磁盘残留
  一个已决定文件；server 每次启动 `scanApprovalRequests` 对它重放一行
  「Tool approval requested by runner」info 日志（H3 实测 11 行）。
- H3 手动清零只是止血；下一次审批即再生（H3 验收自产的 `0310ab95` 即证）。
- `listPendingApprovals`（db.ts）名为 pending 实则返回全量历史（无状态
  过滤）；三个调用方（/approvals 列表、by-id 查找、IM 前缀匹配）**都刻意
  要全量**，无调用方需要 pending-only——问题是名字撒谎。

### 设计

1. `decideApproval`：DB 更新成功（`decided === true`）后删除
   `pending/{id}.json`（try/catch + warn，失败不回滚——退化为现状，可再清）。
   顺序：decisions 文件 → DB → unlink pending（runner 只消费 decisions，
   与 unlink 无竞态）。`decided === false`（并发已决定）不删。
2. 扫描自愈：`scanApprovalRequests` 对「DB 行已存在且 status 已 decided」
   的 pending 文件——跳过 info 日志、debug 记一行清理、**直接删除残留文件**
   （对任何历史遗留自愈，不只防再生）。真 pending（inserted 或 status
   pending）保持现行为（info 日志、不重复通知）。
3. `listPendingApprovals` → 改名 `listApprovals` + 文档注释明确「全量历史，
   含已决定」；更新 3 处调用（routes/approvals.ts ×2、index.ts IM
   /approve|/deny）与导出。

### 验收（TDD + 真机）

- 红：`decideApproval` 后 pending 文件仍在。
- 绿：决定后文件删除；decisions 文件照旧落盘；DB 行 decided；扫描对
  decided 残留不产 info 日志并删除文件；对真 pending 行为不变。
- 真机：构建重启后走一轮 send_file 审批 → 批准后 pending 目录无新残留 →
  再重启启动日志零重放。

## 2. 任务 I2：G2 恢复监视盲区收口

### 证据（含对任务 H 记录的一处修正）

- **盲区 1（11:10 事故的真正不恢复机理）**：冷启动消息不经 IPC 注入（随
  runner bootstrap prompt 走），而 `runForGroup` 启动即三连清
  `pendingMessages=false; ipcOwedSinceAt=null; queryInFlight=true` → 查询
  若僵死，`snapshotStuckRecoveryCandidate` 的两个候选条件（pendingMessages /
  hasIpcOwed）**恒假 → 永不产生候选**，探活与 10 分钟天花板全程不触发。
  暖路径（IPC follow-up 注入 `??=` 设债）无此问题——H2 复现里新 server
  的 A2 正是暖路径才出现了候选与天花板重启。
- **修正**：任务 H §7 原记「轮询循环阻塞在 `processGroupMessages` 内，扫描
  根本不跑」**不成立**——`runForGroup` 为 fire-and-forget、runner 输出走
  回调，消息循环不 await 查询完成；11:10–11:26 无探活日志的充分解释就是
  无候选（扫描照跑，无候选即无日志）。随本任务在 §7 就地修正。
- **盲区 2（脆弱性，非本次事故机理）**：恢复扫描内嵌在消息循环（每 15 轮
  计数触发）。循环内的渠道发送等 await 一旦挂起，恢复扫描随之停摆——而
  恰恰是系统异常时最需要恢复。解耦为独立定时器，严格更稳。

### 设计

1. `runForGroup` 启动时 `state.ipcOwedSinceAt = Date.now()`（冷启动 prompt
   即 owed work，与暖路径 #618 债务钟语义一致；`markRunnerQueryIdle` 查询
   终态照旧清零；`runTask` 不动——`activeRunnerIsTask` 本就被候选排除）。
   抽出纯函数 `beginQueryLifecycle(state, now)` 便于单测。
2. 恢复扫描解耦：新增 `startStuckRunnerScan()/stopStuckRunnerScan()`
   （独立 `setInterval`，间隔 = 现有效节奏 15 × POLL_INTERVAL，unref），
   消息循环移除计数器；纯函数决策（`decideStuckRunnerRecovery` 等）不动。

### 验收（TDD）

- 红：冷启动生命周期（`beginQueryLifecycle`）后 `ipcOwedSinceAt` 为 null
  → 绿：为 number；且 `getStuckPendingGroups` 对「仅 queryInFlight、无
  pendingMessages、债务超阈」的态产出 `ipc_injected` 候选（新用例）。
- 既有 group-queue-stuck-recovery / stuck-runner-recovery-policy 用例全绿。
- 真机：盲区 1 的完整僵死场景需故障注入，本任务以单测覆盖 + 冷启动发消息
  冒烟（消息正常处理、恢复监视无异常日志）；修复使冷启动僵死可见的机理由
  单测固化。

## 3. 非目标

- 审批超时（runner 侧 timeoutMs 到期）后的 pending/DB 行清理策略。
- `runTask` 任务的僵死恢复（候选显式排除 task runner，另议）。
- Windows 全量 vitest 基线修绿、verify/hooks 机审（另行立项）。

## 4. 执行记录（2026-10-22）

- **I1（`c90e49d`）**：TDD 4 新用例（3 个先红——决定后文件残留×2、扫描
  自愈残留文件仍在；1 个锁定真 pending 重放日志行为防回归）后全绿；实现
  即设计三条（决定后 unlink / 扫描自愈+跳重放日志 / 改名
  `listApprovals`+文档注释）。真机：重启 → send_file 审批一轮（请求
  842ab4de → 批准 ok）→ **pending 目录 0 文件**（修复前必留一个）→ 再重启
  启动日志重放 0 行、全日志仅 5 行纯启动信息。
- **I2（`3ebfdd7`）**：TDD 2 新用例（`beginQueryLifecycle` 锚点先红后绿；
  冷启动僵死形状 → `ipc_injected` 候选可见性固化）；stuck 相关 28 用例全
  绿。真机：冷启动发消息（即上述 send_file 轮）全链正常，恢复扫描独立
  定时器无异常日志。完整僵死场景需故障注入，机理由单测固化（§2 验收口径）。
- 两枚 `fix:` 提交各自六步门禁全过（vitest 失败文件集 33 与 H1 基线零差异、
  三侧 typecheck、build:all、git diff --check）。§7 修正随立项提交
  `948b5a0` 落档。
