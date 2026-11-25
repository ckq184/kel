# 任务 personal-slim：个人版深度裁减与巨型文件瘦身方案（活文档）

> **文件定位**：第三轮裁减的总方案与裁决台账。只定范围、裁决与约束，不写实现；各包按 [README](README.md) 领取，执行时另按 `docs/workflow.md` 立项。
> **当前状态**：v1.0（2026-11-25），基线 main `248c7cb`。已拆成 THESIS-19 至 33，尚未立项。
> **与前两轮的关系**：第一轮裁决见 [`docs/task-thesis-lite-plan.md`](../task-thesis-lite-plan.md) §2，第二轮见 [thesis-trim 方案](../issues2/task-thesis-trim-plan.md) §2。本轮推翻了第二轮的 4 项结论（见 §2），已在第二轮方案 §15 登记。其余已定项不重新讨论。
> **行号基准**：`文件:行号` 均为 `248c7cb`。执行时以符号名为锚点 grep 重新定位。

---

## 1. 背景与结论

- **产品定位**：个人自托管，只有一个账号，不再区分管理员与成员。第二轮为求稳保留了 `role` 与数据归属检查（D-E1 ②a），理由是"对唯一账号恒为真"。本轮用户改裁：角色概念整体去掉；数据归属保留。
- **代码量现状**（`ca4ebce` 实测）：生产代码约 172k 行（`src/` 112.9k、`web/src/` 51.4k、runner 7.1k、`shared/` 0.6k），测试约 84.8k 行。≥200 行的外层函数 117 个，合计约 54.5k 行。
- **本轮能减多少**：生产代码约 −4.5k 至 −6k 行，测试约 −1.5k 至 −2.5k 行。这只占总量的 3% 左右——大块代码都在仍然保留的核心模块里（IM 管道、调度、Agent 运行时）。
- **拆巨型文件不减行数**，它服务的是第二轮方案 §1 说的头号风险"答辩可解释性"：`src/index.ts` 15,036 行，三个函数（`processGroupMessages` 3,093、`processAgentConversation` 2,262、`main` 1,336）占 44%。本轮把低耦合的部分搬出去，目标是 `index.ts` 降到约 10k 行、`db.ts` 变成按领域的模块加一个再导出入口。

## 2. 裁决台账

| #   | 裁决项                                 | 第二轮结论                        | 本轮裁决（2026-11-25，用户拍板）                                                                                      | 执行包     |
| --- | -------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | 管理员/成员角色（E2b）                 | D-E1 ②a：只去权限，保留角色       | **去掉角色**。`users.role` 列作为存储保留但不再读取；先在代码层保证只有一个可用账号                                   | 19、20、21 |
| P2  | 数据归属（E3）                         | §13 不建议                        | **维持保留**。`canAccessGroup` 等继续承担存在性与主工作区判断                                                         | —          |
| P3  | 旧格式迁移与兼容代码（第二轮台账 #15） | 不动                              | **收窄**：删旧配置迁移、兼容别名、退役设置键与占位路由；**数据库迁移链不动**                                          | 22、23     |
| P4  | browse / bug-report（第二轮台账 #9）   | 保留不删（bug-report 标"未评估"） | **裁掉 Bug 报告**；browse 保留（选宿主机目录要用）                                                                    | 24         |
| P5  | Agent 人设（第二轮台账 #13）           | 保留                              | **裁掉档案生成/润色**（`/generate`、`/refine-prompt`）；对话式 Agent Builder 与档案管理保留                           | 25         |
| P6  | 飞书卡片三级回退                       | 未单列                            | 保留                                                                                                                  | —          |
| P7  | 巨型文件与巨型函数                     | 未涉及                            | 拆 `src/index.ts`、`src/db.ts`，并做不需产品决策的安全瘦身；**不合并主/子会话两条流水线**（ISSUE-12 第 6 波结论不变） | 26 至 33   |

## 3. 裁剪原则（硬约束）

沿用第二轮方案 §3 的八条（一模块一任务、删前 `git grep -w` 交叉核实、不猜测、`data/` 代理不读写、独立分支、不绕门禁、前端一并裁净等），其中第 2 条"表结构只在 §9 里动"在本轮的含义是：**本轮不改表结构**。另加三条：

1. **迁移链不动。** `src/db-schema/` 的迁移与 `CURRENT_SCHEMA_VERSION` 本轮一律不改；THESIS-19 若需要把多余账号置为停用，走启动时的数据修正，不新增 schema 版本。
2. **IM 侧访问控制不动。** 机器人主人、发送者白名单、响应对象、激活方式与 IM 命令的主人约束是另一套系统（`group-owner.ts`、`im-audience-policy.ts`、`channel-admission.ts` 等），与 Web 账号角色无关。去角色时只删 Web 侧的角色判断。
3. **存储键保留。** `created_by`、`owner_user_id`、`data/skills/{userId}`、`data/mcp-servers/{userId}`、`users.role` 等是存储格式的一部分；本轮只删"按角色分支"的代码，不删列、不迁目录。

## 4. 专题 A：单账号与去角色（P1）

### 4.1 关键事实（`ca4ebce` 调查，`248c7cb` 复核锚点）

- 角色判断：后端约 41 个文件 420 行，约 455 行代码在角色分支块内；前端 28 个文件 133 行；runner 7 行；测试 27 个文件。
- `adminRoleMiddleware`（`src/middleware/auth.ts:134`）挂载 25 处（`routes/config.ts` 21、`routes/monitor.ts` 4），被 `tests/thesis-11-drop-permissions.test.ts` 按数量钉死。
- `hasHostExecutionPermission`（`src/web-context.ts:298`）就是 `role === 'admin'`，引用 46 处；`canExecuteOnHost`（`src/host-execution-policy.ts:18`）在每次宿主机运行前复查 owner。
- `canAccessGroup` 等（`src/web-context.ts:309` 起）的 `role` 参数从未被读取，47 处调用仍在传。
- `isAdminHome` 69 处：意思是"主工作区且 owner 是 admin"，实际作用是 Agent 能力边界——防止非主工作区里的提示词注入去创建脚本任务或宿主机任务（`src/task-acl.ts:12`）。单账号下它等于"是否主工作区"。
- 多用户死代码（THESIS-10 删 `/api/admin` 后无调用方）：`src/index.ts` 13447–13993 的用户禁用与 IM 热重载、`src/im-manager.ts` 的 `sealedUsers`（:151）与 `withUserLock`（:480）等、`adminUserIds`（:139，只写不读）、`src/db.ts` 的 `getActiveAdminCount`（:8911）等四个函数、`beginHostPrivilegeRevocation`（`src/host-execution-policy.ts:5`）、按用户的容器并发上限 `maxConcurrentContainersPerUser`（`src/runtime-config.ts:2523`，消费方在 `src/index.ts:14300`；唯一账号是 admin 时恒放行）。
- `reset:admin`（`src/reset-admin.ts`）在用户名不存在时会**新建一个 admin**，是残留的第二账号入口。

### 4.2 风险

1. **角色检查大多其实是宿主机执行的安全闸门。** 库里若还有其他 `active` 账号（第二轮 D-E5 ② 从未书面确认清理），去掉角色后它们就能在宿主机执行命令。所以 THESIS-19 必须先合入：代码层保证只有一个可用账号。
2. `adminHostOnlyMode` 是真实功能（工作区与任务统一放到宿主机），它的 SQL 按 `role = 'admin'` 过滤，要改写；设置键 `adminHostOnlyMode` 与环境变量 `ADMIN_HOST_ONLY_MODE` 名称保留，避免旧的 `system-settings.json` 与部署配置失效。
3. MCP `memberAccess` 已持久化在 `data/mcp-servers/system/servers.json`；删除后旧值读时忽略即可。
4. 被锁定现设计的契约测试与文档：`tests/thesis-11-drop-permissions.test.ts`、`tests/thesis-13-personal-docs.test.ts`、`docs/ACL-MATRIX.md`、`CLAUDE.md` §8、`README.md`，须与代码同包修改。

## 5. 专题 B：兼容代码收窄（P3）

- **IM 配置第二真源**：ISSUE-11 删了 `/api/config/user-im/*` 路由，但背后的存储层仍在：`src/runtime-config.ts` 2256 起的旧按用户 IM 配置读写、全局飞书配置、`src/channel-account-migration.ts`（92 行）、`src/routes/channel-accounts.ts` 252–372 的复制逻辑、`src/index.ts` 的 `migrateSystemIMToPerUser`（:4116）与 `syncLegacyConfigToDefaultChannelAccount`（:13447）。`autoIsolateContext`（`src/im-context-isolation.ts`，102 行）没有界面也没有路由，只能手改旧 json 开启。
- **小兼容残留**：`ALLOW_LEGACY_UNSIGNED_COOKIE`（`src/auth.ts:49`）；与现名相同的旧 cookie 名（`src/config.ts:69-70`）导致每个请求读两遍；环境变量别名链（`src/config.ts:13-15` 的 `ASSISTANT_NAME`、:47-49 的 `CONTAINER_IMAGE`、`src/index.ts:634` 的 `PUBLIC_BASE_URL`/`WEB_BASE_URL`）；已退役设置键的接收与丢弃（`src/schemas.ts:638`、`src/routes/config.ts:1330`）；返回 410/409 的占位路由（`src/routes/groups.ts:2565`、`src/routes/memory.ts:213`、`src/routes/monitor.ts:362`）；`LEGACY_TAB_ROUTES`（`web/src/pages/SettingsPage.tsx:52`）与 `web/src/App.tsx` 的三个路由重定向；`migrateDataDirectories`（`src/index.ts:13521`）。
- **pre-V5 供应商配置迁移**：`src/runtime-config.ts` 的 `readLegacyConfig`（:732）、`readStoredState`（:947）、`migrateV3toV4`（:1093）及 `readStoredStateV4`（:1209）里的 V3/V4 分支，约 430 行，测试里没有引用。
- **风险**：这些代码保护"从任意旧版本升级"。个人单实例已在 v79，但旧 json 文件是否已全部迁入渠道账号、供应商配置是否已是 V5，代理不能读 `data/` 核实，必须由用户确认（README 第四节）。

## 6. 专题 C：裁两项 AI 辅助功能（P4、P5）

- **Bug 报告**：侧栏与"关于"页的"报告问题"按钮。后端（`src/routes/bug-report.ts`，挂载在 `src/web.ts:229`）调模型整理描述与脱敏日志，再用本机 `gh` 向写死的上游仓库开 issue。个人版下等于给自己提 issue。约 −1,080 行。
- **档案生成/润色**：Agent 管理页的 AI 助手（`web/src/components/agents/AgentPromptAssistant.tsx`），后端 `POST /api/agent-profiles/generate`（`src/routes/agent-profiles.ts:193`）与 `/:id/refine-prompt`（:364），实现在 `src/agent-profile-generator.ts`。与对话式 Agent Builder 功能重叠。约 −780 行。
- 两者都调用 `sdkQuery`；裁掉后 `sdkQuery` 仍有 `/recall`、对话标题、AI 解析定时任务三个调用方，不受影响。

## 7. 专题 D：瘦身与拆分（P7）

### 7.1 安全瘦身（真正减行，约 −1.4k）

不改行为、不需要产品决策的重复与死代码：MCP 任务工具（`container/agent-runner/src/mcp-tools.ts:1360` 起的 pause/resume/cancel/stop/restore）与宿主侧 `src/ipc/task-ops.ts` 的修订冲突块改成工厂；`web/src/components/common/EmojiPicker.tsx` 的每行一个表情的表；`src/index.ts` 30 条整行未用的 import；6 个零引用导出；仅测试可达的生产函数；IPC 依赖接口的重复声明；`src/routes/files.ts` 的重复路径校验；完全相同的函数体（如 `runtimeMutationFailure`、`envRowsToText`）；6 份图片 MIME 映射。

### 7.2 拆分 `src/index.ts`

- 障碍：`registeredGroups`（:645）、`sessions`、`lastAgentTimestamp`、`globalMessageCursor` 是模块级 `let`，被多处重新赋值。先扩展 `src/host-state.ts`（现 73 行，ISSUE-12 为 turn 注册表建立）提供读写器。
- 低耦合簇：IM 斜杠命令（`handleCommand` :2829 至 `/spawn`，约 1,100 行）、IM 投递（`deliverScopedChannelOutput` :1971、`sendImWithRetry` :2120 一带，约 930 行）加指示器与流式缓冲（约 280 行）、IM 连接回调（`buildOnNewChat` :11830 至 :13153，约 1,320 行）加渠道账号重载与健康检查（约 540 行）。
- 成本：42 个测试按函数名切片读 `src/index.ts` 源码，要改为读新文件；`tests/no-duplicate-helpers-contract.test.ts` 钉死部分 helper 的定义文件；`tests/ipc-type-bidirectional-contract.test.ts` 扫描 `src/index.ts` 里的 IPC 类型字面量。

### 7.3 拆分 `src/db.ts`

- Schema 与迁移已在 `src/db-schema/`。剩余约 9k 行访问器按领域分布：任务/运行/通知/日志约 3,430 行（最大），Agent 档案约 1,370，工作区投影约 570，渠道账号约 400，注册群与挂载约 690，工作区重建与删除约 450，用户与会话约 480，子 Agent 约 340。
- 已有拆分先例：`memory-store.ts`、`channel-reliability-store.ts`、`owner-profile-store.ts` 用 `bind*Database(db)` 加 `store-helpers.ts`。
- 硬约束：113 个测试 `import '../src/db.js'`，19 个 `vi.mock('../src/db.js')`。`db.ts` 必须保留为再导出入口，生产模块继续经它导入，否则这些 mock 会静默失效。

## 8. 已评估、未采纳（备查）

| 建议                                                               | 结论                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 去数据归属（E3）                                                   | 用户维持保留（P2）。另需删约 4.7k 行隔离测试，且 `created_by` 是存储键 |
| 迁移链压成 v79 基线                                                | 用户选"迁移链不动"                                                     |
| 裁对话式 Agent Builder                                             | 保留：与档案生成二选一，留安全设计更完整的一种                         |
| 飞书卡片只留流式模式                                               | 保留三级回退：省的行数不多，风险在飞书线上且只能实机验证               |
| 合并主/子会话流水线（约 −600 至 −1,000）                           | 推翻 ISSUE-12 第 6 波结论，且有测试钉死变量名；不做                    |
| 拆 `web/src/stores/chat.ts`（4,084）与大组件                       | 本轮只拆后端两个文件；前端留待以后                                     |
| 三处 IM 绑定端点合并、IM 三渠道连接收敛、容器/宿主 Runner 共用核心 | 都是活代码且有行为差异，收益 100–300 行，风险中等；不纳入              |
| `docs/` 历史 plan 文档归档（约 6k 行）                             | 不是代码，未纳入；需要时单独处理                                       |

## 9. 变更记录

| 日期       | 版本 | 变更                                                                                                    |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------- |
| 2026-11-25 | v1.0 | 立项：三路调查（角色与归属、巨型文件与函数、其他可裁项）后与用户讨论拍板 P1 至 P7，拆成 THESIS-19 至 33 |
