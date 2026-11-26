# CKQClaw 个人版访问边界

本文描述单账号部署下的访问边界。具体中间件与条件分支以代码为准：

- Cookie 会话中间件：`src/middleware/auth.ts`
- 工作区归属判断：`canAccessGroup()`、`canModifyGroup()`、`canDeleteGroup()`（`src/web-context.ts`）
- Host 执行策略：`canExecuteOnHost()`（`src/host-execution-policy.ts`）
- 定时任务授权：`src/task-acl.ts`
- IM owner 命令：`src/im-command-utils.ts`
- 渠道响应对象：`src/im-audience-policy.ts`
- 路由实现：`src/routes/` 与 `src/web.ts`

个人版的访问边界只有两层：

1. **登录会话**：Web/HTTP/WebSocket 侧的有效登录、来源校验与管理操作。
2. **IM 侧访问控制**：渠道消息的发送者身份与命令约束。

工作区归属与 Home/宿主机执行边界保留为纵深防御，不构成额外的多账号授权层。本文的“IM owner（主人）”指工作区上 `owner_im_id` 记录的渠道侧身份。

## 1. 第一层：登录会话

### 1.1 公开接口

| 路由                            | 方法 | 附加条件           |
| ------------------------------- | ---- | ------------------ |
| `/api/auth/status`              | GET  | 无                 |
| `/api/auth/setup`               | POST | 仅用户表为空时可用 |
| `/api/auth/login`               | POST | 登录限流           |
| `/api/auth/avatars/:filename`   | GET  | 仅允许受管头像路径 |
| `/api/config/appearance/public` | GET  | 只返回公开外观     |
| `/api/health`                   | GET  | 不返回敏感运行详情 |

`/ws` 不是公开接口。Upgrade 时必须同时通过 Cookie Session 与 Origin 校验。

### 1.2 登录会话

- Cookie 会话使用 HMAC 签名，密钥来自环境变量、持久文件或首次自动生成。
- 除公开接口外，所有业务 API 路由都经过 `authMiddleware`：缺少有效 Cookie、会话过期、账号被禁用或删除时返回 401/403。历史兼容的 410 入口除外。
- 登录失败统一返回泛化错误；密码校验始终执行 bcrypt 比较（含不存在的账号），避免时序侧信道。
- 登录限流按 `username:ip` 与 `username` 两级计数：默认 5 次 / 15 分钟，按用户名的全局窗口为 1 小时；超限返回 429 与重试秒数。
- 会话、个人资料、密码、头像等接口只作用于当前登录账号，不接受客户端指定其他 owner。

### 1.3 WebSocket

连接建立时绑定登录会话；每个操作仍按当前会话与目标资源复核。

| 操作                             | 要求                                           |
| -------------------------------- | ---------------------------------------------- |
| `terminal_start`                 | `canAccessGroup()`；只支持 Container Workspace |
| `terminal_input` / resize / stop | 必须是当前 WebSocket 已拥有的终端              |
| Docker pull 进度                 | 服务端推送给已登录会话                         |

Origin 校验独立于 HTTP CORS：同源放行；存在 Origin 但不在白名单时拒绝升级。白名单由 `CORS_ALLOWED_ORIGINS` 与 `CORS_ALLOW_LOCALHOST` 控制。不能仅依赖 `terminal_start` 的历史授权；终端 owner 映射和连接关闭清理是协议的一部分。

### 1.4 管理操作

系统只剩管理员一个角色，管理操作只要求有效登录会话：

| 路由族/操作                             | 要求                                         |
| --------------------------------------- | -------------------------------------------- |
| Provider、系统容量、Host 集成、系统外观 | 登录                                         |
| 系统 MCP 写入                           | 登录（唯一账号恒为管理员，可见性语义待统一） |
| `/api/docker/pull`、运行监控管理        | 登录                                         |
| `/api/status/channel-outbox/*` 人工裁决 | 登录                                         |
| `POST /api/groups/:jid/reset-owner`     | 登录的应急入口，同时仍验证目标资源           |

`GET /api/status` 对已登录账号开放。系统 MCP 的 `system` 作用域与 `memberAccess` 不在本层展开。API 不回传 Secret 明文。

Host 执行是额外边界：真正启动 Host Runner 前用 `canExecuteOnHost()` 复查 owner 仍存在且为 active，避免把权限当成工作区行上的永久属性。Home 工作区由服务端强制使用 Host。

### 1.5 数据归属与执行边界（纵深防御）

新建工作区归当前账号；存量数据仍按 `created_by` 判定。归属检查保留。

#### 1.5.1 账号资源

以下资源以登录账号为作用域，不接受客户端指定其他 owner：

| 路由族                                              | 要求                 |
| --------------------------------------------------- | -------------------- |
| `/api/auth/me`、profile、password、sessions、avatar | 登录，仅本人         |
| `/api/agent-profiles/*`                             | 登录，仅本人 Agent   |
| `/api/channel-accounts/*`                           | 登录，仅本人渠道账号 |
| `/api/skills/*`                                     | 登录，仅本人 Skills  |
| 用户级 `/api/mcp-servers/*`                         | 登录，仅本人配置     |

#### 1.5.2 工作区归属

- `canAccessGroup()`：Home Workspace 仅 `created_by`；Web Workspace 仅创建者；IM Chat 优先使用自身 `created_by`，旧记录没有 owner 时通过同 folder 的 Home Workspace 解析，解析失败默认拒绝。
- `canModifyGroup()`：工作区 owner 才能重命名、切换 Agent、修改执行方式、停止或清理会话、写入工作区 Skills/MCP、修改绑定与激活策略。
- `canDeleteGroup()`：Home Workspace 永远不可删除；其他工作区必须通过 `canModifyGroup()`。
- 登录账号不自动绕过工作区所有权；每个账号只能访问自己名下的工作区。
- 查不到资源与无权访问通常都返回 404，避免泄漏资源是否存在。

#### 1.5.3 删除与环境变量

- 删除工作区前会暂停相关序列化键、停止工作区与 Runner，失败时恢复；`GET /api/groups/:jid/delete-impact` 用同一删除边界检查渠道绑定影响面（绑定会话、主 IM 群与话题上下文），且仅接受 `web:` 工作区；定时任务在删除时另行停止，不在该接口返回。
- `GET|PUT /api/groups/:jid/env` 必须先通过 `canAccessGroup()`，且只允许工作区 owner 读写；其他账号（即使同为管理员）不能借角色读取。

#### 1.5.4 Workspace Memory v2

- 读取（列表、搜索、详情、versions）要求 `canAccessGroup()`；创建、更新、忘记要求 `canModifyGroup()`。
- 没有跨 owner bypass；目标 Workspace 或 item 不存在、授权失败均返回 404。
- Scheduled Run 与 SDK Task Sub-Agent 可以读取，但不能写入 Workspace Memory；限制由 MCP 暴露面与主进程 IPC broker 共同执行，不能由模型参数扩大。
- 旧 `/api/memory/sources`、`/api/memory/search`、`/api/memory/file`、`/api/memory/global` 只要求有效登录，但固定返回 410，不提供旧文件读取或兼容写入。

#### 1.5.5 CKQClaw Owner Profile

`GET|PATCH /api/workspaces/:jid/owner-profile` 只接受当前登录账号自己的 Home Workspace，且目标必须绑定内置默认 CKQClaw；管理员账号同样不具有跨 owner bypass。Runtime 侧按 host-issued turn ID 精确匹配当前或已接纳的 queued batch，set/clear/skip 必须匹配当前 active batch；自定义 AgentProfile、Scheduled、Task/Spawn 与 SDK Sub-Agent 上下文拒绝投影和修改。

#### 1.5.6 定时任务与 MCP

- 定时任务的 IPC/MCP 授权以 `canAccessGroup` 为基础；REST 侧 `canViewTask` 同样按工作区归属判定。
- `src/task-acl.ts` 覆盖 `schedule_task`、`pause_task`、`resume_task`、`cancel_task`、`update_task`、`run_task_now`、`stop_task_run`、`restore_task`、`list_task_runs` 与 `list_tasks` 的可见性过滤；允许“目标是 Agent 自身工作区目录”或“该工作区属主同样拥有目标群组”两条路径。
- `isHome` 只保留为能力判定（Script 任务、Host 执行模式、跨组投递），不参与工作区范围判定。任务 `prompt` 属于用户内容，`list_tasks` 不允许跨 owner 枚举。
- Script 任务仅允许 Home Workspace；`adminHostOnlyMode` 开启后 active owner 拥有的工作区与任务强制使用 Host，Container 写入入口拒绝。
- Agent MCP 调用没有 Cookie，但必须携带主进程创建的运行上下文（owner、Workspace/Session 身份、IPC 目录、当前 Turn 路由）；不能根据模型参数自行扩大范围。
- 敏感写操作先停止或暂停相关 Runner，失败时恢复队列，避免半写状态。

## 2. 第二层：IM 侧访问控制

渠道消息先经过访问控制，再进入 Agent。控制点集中在 `src/im-command-utils.ts` 与 `src/im-audience-policy.ts`。

### 2.1 主人认领

- 每个工作区通过 `owner_im_id` 记录渠道侧的 IM owner（主人）身份。
- 可信的 1:1 私聊可以从第一条持久化人类消息学习 owner。
- 未认领群聊不会让第一个发命令的人自动成为 owner；群聊用 `/owner_mention` 显式认领。
- `/release_owner` 清除 owner 与白名单，并把 legacy `owner_mentioned` 降级。
- `reset-owner` 是 owner 离群或换号后的 break-glass。

### 2.2 发送者白名单

- `/allow`、`/disallow` 维护当前工作区的渠道发送者白名单；`/allowlist` 只读展示。
- `/allow`、`/disallow` 在 Handler 内检查发送者是否等于当前 `owner_im_id`，不走通用的 Owner Gate。
- 不同 Provider 的原生 sender ID 命名空间不得混用（例如 QQ C2C 与 Group 使用不同 ID 空间）；owner 比对必须使用渠道适配器传入的规范化 ID。

### 2.3 响应对象与激活

渠道消息先执行响应对象检查，再执行 @/话题激活：

| 策略                             | 行为                             |
| -------------------------------- | -------------------------------- |
| `audience_mode=everyone`         | 所有允许的发送者可以触发         |
| `audience_mode=owner_only`       | 只有 `owner_im_id` 可以触发      |
| `activation_mode=always`         | 无需 @                           |
| `activation_mode=when_mentioned` | 需要首次 @，原生话题激活后可继续 |
| `activation_mode=disabled`       | DM 和群聊都停止响应              |

响应对象和激活方式是独立维度。Legacy `owner_mentioned` 读取时会规范化为 `audience_mode=owner_only + activation_mode=when_mentioned`。

### 2.4 IM 命令

命令由主进程 `handleCommand()` 处理，不经过 Web Middleware，但使用渠道 sender ID 执行独立的 Owner Gate。

| 命令                                 | 要求                                         |
| ------------------------------------ | -------------------------------------------- |
| `/list`、`/ls`、`/status`、`/where`  | 只读                                         |
| `/recall`、`/rc`                     | 只读，带节流                                 |
| `/allowlist`                         | 只读                                         |
| `/clear`、`/bind`、`/unbind`、`/new` | IM owner                                     |
| `/sw`、`/spawn`                      | IM owner                                     |
| `/release_owner`                     | IM owner                                     |
| `/owner_mention`                     | 未认领群的 bootstrap，不可被 Owner Gate 锁死 |
| `/allow`、`/disallow`                | Handler 内检查 IM owner                      |
| `/require_mention`                   | Handler 内按当前 owner/策略检查              |

Owner Gate 的必需命令集合由 `OWNER_REQUIRED_IM_COMMANDS` 定义；未认领群里，owner-required 命令只能先通过 `/owner_mention` 完成认领，只读命令不受影响。

### 2.5 渠道账号与绑定

写操作统一要求目标工作区 `canModifyGroup()`，同时校验 IM Chat 属于同一账号、同一渠道账号，并验证会话类型：

| 绑定                  | 允许目标 | 路由                                              |
| --------------------- | -------- | ------------------------------------------------- |
| Workspace Mount       | 群聊     | `/api/groups/:jid/im-binding`                     |
| Runtime Session Mount | 私聊     | `/api/groups/:jid/sessions/:sessionId/im-binding` |

附加规则：

- `channel_account_id` 必须属于当前账号。
- 账号编码在 JID 中时，必须与数据库记录一致。
- 原生话题容器使用 `thread_map`，不能绑定到一个固定 Session 后吞并所有话题。
- Unbind 必须原子恢复该 Bot 的默认工作区；无法解析默认目标时保留旧绑定并报错。

## 3. 修改访问边界的验证要求

任何访问边界修改至少补充以下测试维度：

1. owner 成功。
2. 非 owner 被拒绝。
3. 跨 owner 访问是否应该被允许必须显式测试；默认不绕过。
4. Host/Container 分支。
5. 资源不存在与跨 owner 资源的返回值。
6. 多渠道账号不能串用凭据或绑定。
7. HTTP、WebSocket、IM、MCP 的同一动作保持一致。
8. 失败路径不留下半写绑定、陈旧 Runner 或已推进游标。

相关现有测试集中在：

- `tests/routes-*-acl.test.ts`
- `tests/owner-gate.test.ts`
- `tests/im-owner-gate.test.ts`
- `tests/im-audience-policy.test.ts`
- `tests/channel-binding-rest-contract.test.ts`
- `tests/channel-account-*.test.ts`
- `tests/mcp-runtime-secret-boundary.test.ts`
- `tests/host-execution-policy.test.ts`

> 历史：本访问边界文档曾包含多账号权限层与工具审批（Approval Gate）。前者随单账号收口删除（THESIS-10、THESIS-11），后者已随任务 U（2026-11-09 综述改造回退）整体移除。
