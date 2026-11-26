# 任务 personal-slim：个人版深度裁减与巨型文件瘦身方案（活文档）

> **文件定位**：第三轮裁减的总方案与裁决台账。只定范围、裁决与约束，不写实现；各包按 [README](README.md) 领取，执行时另按 `docs/workflow.md` 立项。
> **当前状态**：v1.1（2026-11-25），基线 main `607d1b6`。已拆成 THESIS-19 至 37，尚未立项。v1.1 相对 v1.0 的改动见 §11。
> **与前两轮的关系**：第一轮裁决见 [`docs/task-thesis-lite-plan.md`](../task-thesis-lite-plan.md) §2，第二轮见 [thesis-trim 方案](../issues2/task-thesis-trim-plan.md) §2。本轮推翻了第二轮的 4 项结论与 §13 对"去数据归属（E3）"的否定（见 §2），已在第二轮方案 §15 登记。其余已定项不重新讨论。
> **行号基准**：`文件:行号` 均为 `607d1b6`。执行时以符号名为锚点 grep 重新定位。

---

## 1. 背景与结论

- **产品定位**：个人自托管。系统里只有一个角色——管理员；每个使用者就是管理员，拥有管理员的全部功能。多用户相关的代码（其他角色、数据归属、按用户的存储与运行时结构）全部裁掉。
- **数据前提**：本机数据库里的账号都是测试账号（2026-11-25 只读核对：`users` 1 行，admin、active），不需要保护或搬迁。按用户存放的旧数据（个人 Skills、MCP、旧 IM 配置、feishu-cli 状态）改用单一位置后不再读取，也不写搬迁代码。
- **代码量现状**（`ca4ebce` 实测）：生产代码约 172k 行（`src/` 112.9k、`web/src/` 51.4k、runner 7.1k、`shared/` 0.6k），测试约 84.8k 行。≥200 行的外层函数 117 个，合计约 54.5k 行。
- **本轮能减多少**：生产代码约 −7.5k 至 −9.5k 行，测试约 −7k 至 −9k 行（其中多用户隔离测试约 6.7k 行）。
- **拆巨型文件不减行数**，它服务的是第二轮方案 §1 说的头号风险"答辩可解释性"：`src/index.ts` 15,036 行，三个函数（`processGroupMessages` 3,093、`processAgentConversation` 2,262、`main` 1,336）占 44%。本轮把低耦合的部分搬出去，目标是 `index.ts` 降到约 10k 行、`db.ts` 变成按领域的模块加一个再导出入口。

## 2. 裁决台账

| #   | 裁决项                                              | 第二轮结论                        | 本轮裁决（2026-11-25，用户拍板）                                                                                                                            | 执行包         |
| --- | --------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| P1  | 角色                                                | D-E1 ②a：只去权限，保留角色       | **只保留管理员一个角色**：`role` 恒为 `admin`，代码、类型、建表默认值、测试夹具里不再出现 `member` 等其他角色；按角色的分支收成管理员分支，角色判断本身删除 | 19、20、21     |
| P2  | 数据归属与按用户作用域（E3）                        | §13 不建议                        | **全部裁减**（v1.1 改裁，推翻 v1.0"保留归属"）                                                                                                              | 34、35、36、37 |
| P3  | 旧格式迁移与兼容代码（第二轮台账 #15）              | 不动                              | **收窄**：删旧配置迁移、兼容别名、退役设置键与占位路由；**数据库迁移链不动**                                                                                | 22、23         |
| P4  | browse / bug-report（第二轮台账 #9）                | 保留不删（bug-report 标"未评估"） | **裁掉 Bug 报告**；browse 保留（选宿主机目录要用）                                                                                                          | 24             |
| P5  | Agent 人设（第二轮台账 #13）                        | 保留                              | **裁掉档案生成/润色**（`/generate`、`/refine-prompt`）；对话式 Agent Builder 与档案管理保留                                                                 | 25             |
| P6  | 飞书卡片三级回退                                    | 未单列                            | 保留                                                                                                                                                        | —              |
| P7  | 巨型文件与巨型函数                                  | 未涉及                            | 拆 `src/index.ts`、`src/db.ts`，并做不需产品决策的安全瘦身；**不合并主/子会话两条流水线**（ISSUE-12 第 6 波结论不变）                                       | 26 至 33       |
| P8  | 按用户存储（Skills、MCP、旧 IM 配置、feishu-cli）   | 未涉及                            | **改用单一位置，不写搬迁**；本机旧测试数据不再读取（磁盘上保留，不删）                                                                                      | 22、36、37     |
| P9  | MCP"系统/个人"两个作用域                            | 未涉及                            | **合并为一个列表**；宿主机 `~/.claude` MCP 导入与工作区 `.mcp.json` 保留                                                                                    | 37             |
| P10 | 13 张表的归属列（`created_by`、`owner_user_id` 等） | 未涉及                            | **列保留、不改表结构**；写入时填唯一账号 id，查询与检查不再使用                                                                                             | 34             |

## 3. 裁剪原则（硬约束）

沿用第二轮方案 §3 的八条（一模块一任务、删前 `git grep -w` 交叉核实、不猜测、独立分支、不绕门禁、前端一并裁净等）。其中第 2 条"表结构只在 §9 里动"在本轮的含义是：**本轮不改表结构**。第 5 条"`data/` 代理不读写"在本轮放宽为：经用户授权，代理可以**只读**查看本机数据库做验证；不写 `data/`。另加四条：

1. **迁移链不动。** `src/db-schema/` 的迁移与 `CURRENT_SCHEMA_VERSION` 本轮一律不改。建表语句里与角色有关的默认值可以改（只影响新库），不新增 schema 版本。
2. **IM 侧访问控制不动。** 机器人主人、发送者白名单、响应对象、激活方式与 IM 命令的主人约束是另一套系统（`group-owner.ts`、`im-audience-policy.ts`、`channel-admission.ts`，字段 `owner_im_id`、`sender_allowlist` 等），它们标识的是 IM 群里的人，不是 CKQClaw 账号。去角色、去归属时只删 Web 账号侧的代码。
3. **归属列保留不读。** `created_by`、`owner_user_id`、`user_id` 等列保留，写入时填唯一账号 id；读路径不再按它们过滤或判断。
4. **不是多用户的分层保留。** Skills 的 builtin/宿主机/项目/工作区各层、宿主机 `~/.claude` 的 Skills 与 MCP 导入、渠道多账号（一个人可以有多个机器人）、头像文件名前缀、`isAdminHome` 所代表的"非主工作区不能建脚本/宿主机任务"的防注入边界（改名 `isHome`）都不是多用户代码，保留。

## 4. 专题 A：只留管理员角色（P1）

### 4.1 关键事实（`ca4ebce` 调查，`607d1b6` 复核锚点）

- 角色判断：后端约 41 个文件 420 行，约 455 行代码在角色分支块内；前端 28 个文件 133 行；runner 7 行；测试 27 个文件。
- `UserRole`（`src/types.ts:645`）含 `member`；建表默认值 `role TEXT NOT NULL DEFAULT 'member'`（`src/db-schema/auth-tables.ts:29`）；测试夹具 `tests/helpers/route-test-user.ts` 的 5 个 helper 默认 `role: 'member'`（16 个测试文件、130 处调用）。
- `adminRoleMiddleware`（`src/middleware/auth.ts:134`）挂载 25 处，被 `tests/thesis-11-drop-permissions.test.ts` 按数量钉死。
- `hasHostExecutionPermission`（`src/web-context.ts:298`）就是 `role === 'admin'`；`canExecuteOnHost`（`src/host-execution-policy.ts:18`）在每次宿主机运行前复查 owner 是否为 active admin。
- `isAdminHome` 69 处：意思是"主工作区且 owner 是 admin"，实际作用是 Agent 能力边界（`src/task-acl.ts:12`）。只留管理员后它等于"是否主工作区"。
- 多用户死代码（THESIS-10 删 `/api/admin` 后无调用方）：`src/index.ts` 13743–13993 的用户禁用与 IM 热重载、`src/im-manager.ts` 的 `sealedUsers`（:151）与 `withUserLock`（:480）等、`adminUserIds`（:139，只写不读）、`src/db.ts` 的 `getActiveAdminCount`（:8911）等四个函数、`beginHostPrivilegeRevocation`（`src/host-execution-policy.ts:5`）、`ownerHomeFolder` 参数（23 处，无人读取）、按用户的容器并发上限 `maxConcurrentContainersPerUser`（admin 恒放行）。
- `reset:admin`（`src/reset-admin.ts`）在用户名不存在时会新建一个 admin。
- THESIS-16 已删资料页角色标签与 MCP 成员访问控件；遗留 `web/src/pages/LoginPage.tsx:115`"多用户"、`web/src/components/settings/AboutSection.tsx:118`"多用户协作"，以及后端"联系管理员"提示（`src/container-image-failure.ts`、`src/provider-failure.ts`、`src/index.ts`）。

### 4.2 风险

1. `adminHostOnlyMode` 是真实功能（工作区与任务统一放到宿主机），它的 SQL 按 `role = 'admin'` 过滤，要改写；设置键 `adminHostOnlyMode` 与环境变量 `ADMIN_HOST_ONLY_MODE` 名称保留，避免旧的 `system-settings.json` 与部署配置失效。
2. 被锁定现设计的契约测试与文档：`tests/thesis-11-drop-permissions.test.ts`、`tests/thesis-13-personal-docs.test.ts`、`docs/ACL-MATRIX.md`、`CLAUDE.md` §8、`README.md`，须与代码同包修改。

## 5. 专题 B：兼容代码收窄（P3）

- **IM 配置第二真源**：ISSUE-11 删了 `/api/config/user-im/*` 路由，但背后的存储层仍在：`src/runtime-config.ts` 2198 起的旧按用户 IM 配置读写（它仍是 `autoIsolateContext`、飞书 `ownerOpenId`、微信游标三个值的实际存储）、全局飞书配置、`src/channel-account-migration.ts`（92 行）、`src/routes/channel-accounts.ts` 252–372 的复制逻辑、`src/index.ts` 的 `migrateSystemIMToPerUser`（:4116）、`syncLegacyConfigToDefaultChannelAccount`（:13447）与 14666–14794 的按用户投影循环。`autoIsolateContext`（`src/im-context-isolation.ts`，102 行）没有界面也没有路由。
- **小兼容残留**：`ALLOW_LEGACY_UNSIGNED_COOKIE`（`src/auth.ts`）；与现名相同的旧 cookie 名（`src/config.ts:69-70`）；环境变量别名链（`src/config.ts:13-15` 的 `ASSISTANT_NAME`、:47-49 的 `CONTAINER_IMAGE`、`src/index.ts:634` 的 `PUBLIC_BASE_URL`/`WEB_BASE_URL`）；已退役设置键的接收与丢弃（`src/schemas.ts:638`、`src/routes/config.ts:1330`）；返回 410/409 的占位路由（`src/routes/groups.ts:2565`、`src/routes/memory.ts:213`、`src/routes/monitor.ts:362`）；`LEGACY_TAB_ROUTES`（`web/src/pages/SettingsPage.tsx:52`）与 `web/src/App.tsx` 的三个路由重定向；`migrateDataDirectories`（`src/index.ts:13521`）。
- **pre-V5 供应商配置迁移**：`src/runtime-config.ts` 的 `readLegacyConfig`、`readStoredState`、`migrateV3toV4` 及 `readStoredStateV4` 里的 V3/V4 分支，约 430 行。本机供应商配置已核实为 V5。

## 6. 专题 C：裁两项 AI 辅助功能（P4、P5）

- **Bug 报告**：侧栏与"关于"页的"报告问题"按钮。后端（`src/routes/bug-report.ts`，挂载在 `src/web.ts:229`）调模型整理描述与脱敏日志，再用本机 `gh` 向写死的上游仓库开 issue。约 −1,080 行。
- **档案生成/润色**：Agent 管理页的 AI 助手（`web/src/components/agents/AgentPromptAssistant.tsx`），后端 `POST /api/agent-profiles/generate`（`src/routes/agent-profiles.ts:193`）与 `/:id/refine-prompt`（:364），实现在 `src/agent-profile-generator.ts`。约 −780 行。
- 两者都调用 `sdkQuery`；裁掉后 `sdkQuery` 仍有 `/recall`、对话标题、AI 解析定时任务三个调用方。

## 7. 专题 D：瘦身与拆分（P7）

### 7.1 安全瘦身（真正减行，约 −1.4k）

不改行为、不需要产品决策的重复与死代码：MCP 任务工具（`container/agent-runner/src/mcp-tools.ts` 的 pause/resume/cancel/stop/restore）与宿主侧 `src/ipc/task-ops.ts` 的修订冲突块改成工厂；`web/src/components/common/EmojiPicker.tsx` 的表情表；`src/index.ts` 30 条整行未用的 import（归 THESIS-28）；零引用导出；仅测试可达的生产函数；IPC 依赖接口的重复声明；`src/routes/files.ts` 的重复路径校验；完全相同的函数体；6 份图片 MIME 映射。

### 7.2 拆分 `src/index.ts`

- 障碍：`registeredGroups`（:645）、`sessions`、`lastAgentTimestamp`、`globalMessageCursor` 是模块级 `let`。先扩展 `src/host-state.ts` 提供读写器。
- 低耦合簇：IM 斜杠命令（约 1,100 行）、IM 投递加指示器与流式缓冲（约 1,200 行）、IM 连接回调加渠道账号重载与健康检查（约 1,800 行）。
- 成本：42 个测试按函数名切片读 `src/index.ts` 源码；`tests/no-duplicate-helpers-contract.test.ts` 钉死部分 helper 的定义文件；`tests/ipc-type-bidirectional-contract.test.ts` 扫描 IPC 类型字面量。

### 7.3 拆分 `src/db.ts`

- Schema 与迁移已在 `src/db-schema/`。剩余约 9k 行访问器按领域分布，任务域约 3,430 行最大。拆分先例：`memory-store.ts`、`channel-reliability-store.ts`、`owner-profile-store.ts` 的 `bind*Database(db)`。
- 硬约束：113 个测试 `import '../src/db.js'`，19 个 `vi.mock('../src/db.js')`；`db.ts` 必须保留为再导出入口。

## 8. 专题 E：去数据归属（P2、P10）

### 8.1 检查与过滤（THESIS-34）

- `canAccessGroup`/`canModifyGroup`/`canDeleteGroup`（`src/web-context.ts:309`、:353、:378）约 99 处调用，`groupAccessDeniedResponse` 36 处。收为"资源存在"检查；"主工作区不可删除"这条规则保留（它不是归属规则）。
- 约 29 条 SQL 按归属列过滤：`agent_profiles` 6、`agent_builder_drafts` 5、`channel_accounts` 11、`registered_groups.created_by` 5、置顶 2；对应的 `*ForUser`/`*ByOwner` 访问器收成不过滤的版本。
- `src/task-acl.ts`（75 行）的 owner 部分、`src/owner-gate.ts`（29 行）、旧 IM 兄弟主工作区回退（`src/web-context.ts` 314–328、358–368）、`getUserHomeGroup`（`src/db.ts:8006`，11 处调用）改为取唯一主工作区（`is_home = 1`）、`is_my_home`→`is_home`（后端 3 处、前端 8 个文件）、监控页 owner 名称。
- 有附加含义、要改写而不是直接删的：主工作区与内置 Agent 档案的绑定（`src/db.ts` 6036–6044、6188–6196，改为只看 `is_home`）；飞书群白名单回填（`src/db.ts` 7445–7470，保留按渠道账号的版本）；渠道账号默认工作区（改为"主工作区"）；任务输出路由（`src/task-utils.ts` 按 `created_by` 选 IM 渠道，改为常量）。
- 主工作区命名：现有库的主工作区目录名保持不变（`web:main` 或 `web:home-{id}`），不做目录改名。
- 测试：ACL 隔离套件约 4.7k 行删除（`routes-agents-acl`、`routes-groups-owner-acl`、`routes-messages-acl`、`routes-workspace-config-acl`、`routes-stop-interrupt-acl`、`task-acl`、`user-home-isolation`、`owner-gate` 等），其中"资源不存在返回 404""主工作区不可删""IM 侧访问控制"的用例保留或改写。

### 8.2 运行时结构（THESIS-35）

- `src/im-manager.ts` 的"用户→渠道"两级映射（`userId` 138 处）收成按渠道账号的一级映射；渠道多账号键保留。
- WebSocket 按用户过滤：`src/group-broadcast-acl.ts`（64 行）与 `src/web.ts` 的 `allowedUserIds`（21 处），约 110 行。注意：现在 owner 无法解析时广播会被丢弃，删除后改为广播给已登录会话。
- 启动时的 `listUsers()` 循环（为每个用户建主工作区、按用户同步群信息）；能力锁 `user:{id}` 键（`src/capability-lock.ts:9`）、配对码与凭据认领的用户键；前端 `localStorage` 按用户的键（`useDisplayMode.ts`、`task-run-idempotency.ts`）。

### 8.3 按用户存储（THESIS-36、37）

- Skills：`data/skills/{userId}/` 改为 `data/skills/`（`src/routes/skills.ts:112` 起，`agent-profile-policy.ts`、`agent-builder.ts`、`agent-capability-preview.ts`、`claude-context-resolver.ts`、`container-runner.ts` 各一处）；派生缓存 `data/agent-profile-runtime/{ownerId}/` 去掉 owner 段（`src/container-runner.ts:615`）。
- feishu-cli 状态：`data/config/user-cli/{ownerId}/feishu-cli/` 改为固定路径（`src/container-runner.ts:1161` 起），容器内挂载点 `/home/node/.feishu-cli` 不变。
- MCP：`data/mcp-servers/{userId}/` 与伪用户 `system` 两份存储合并为 `data/mcp-servers/servers.json` + `secrets.json`；删作用域分层与优先级（`src/mcp-utils.ts` 433–474）、`scopeOwnerId`、按用户循环、合并 GET、按作用域失效、`system` 锁键、`memberAccess` 可见性层（约 170 行）；前端单列表。`agent_profiles.runtime_policy` 里存的 `system:`/`user:` 前缀引用不再识别，按"缺失能力"让配置失败、提示重选（CLAUDE.md §5"不得静默替换"）。
- 风险：合入后本机旧的个人 Skills、MCP、feishu-cli 登录状态都要重新配置（P8 已接受）。

## 9. 已评估、未采纳（备查）

| 建议                                                               | 结论                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| 归属列加 v80 迁移删除                                              | 用户选"列保留不读"（P10）；删列要重建 8 张表与唯一索引      |
| 按用户旧数据写一次性搬迁                                           | 用户选"不搬，直接弃用"（P8）；本机均为测试数据              |
| 把 `home-{id}` 主工作区目录改名为 `main`                           | 要搬 `data/groups`、`sessions`、`ipc`、`env` 多处目录；不做 |
| 迁移链压成 v79 基线                                                | 用户选"迁移链不动"                                          |
| 裁对话式 Agent Builder                                             | 保留：与档案生成二选一，留安全设计更完整的一种              |
| 飞书卡片只留流式模式                                               | 保留三级回退：省的行数不多，风险在飞书线上且只能实机验证    |
| 合并主/子会话流水线（约 −600 至 −1,000）                           | 推翻 ISSUE-12 第 6 波结论，且有测试钉死变量名；不做         |
| 拆 `web/src/stores/chat.ts`（4,084）与大组件                       | 本轮只拆后端两个文件；前端留待以后                          |
| 三处 IM 绑定端点合并、IM 三渠道连接收敛、容器/宿主 Runner 共用核心 | 都是活代码且有行为差异，收益 100–300 行，风险中等；不纳入   |
| `docs/` 历史 plan 文档归档（约 6k 行）                             | 不是代码，未纳入；需要时单独处理                            |

## 10. 部署前置（本机，2026-11-25 只读核实）

见 [README 第四节](README.md#四部署前置与用户操作代理不能代办)。

## 11. 变更记录

| 日期       | 版本 | 变更                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-25 | v1.0 | 立项：三路调查（角色与归属、巨型文件与函数、其他可裁项）后与用户讨论拍板 P1 至 P7，拆成 THESIS-19 至 33                                                                                                                                                                                                                                       |
| 2026-11-25 | v1.1 | 用户改裁：P1 由"去掉角色"改为"只保留管理员一个角色"；P2 由"保留数据归属"改为"多用户代码全部裁减"；新增 P8（按用户存储改单一位置、不搬迁）、P9（MCP 合并为一个列表）、P10（归属列保留不读）；本机账号均为测试账号，THESIS-19 的 D-P1/D-P3、THESIS-22 的 D-I1/D-I2、THESIS-23 的 D-K2 改为已定；新增 THESIS-34 至 37；§3 放宽为可只读查看数据库 |
