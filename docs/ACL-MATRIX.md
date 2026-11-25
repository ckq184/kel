# CKQClaw 个人版访问边界

本文描述单账号部署下的访问边界。具体中间件与条件分支以代码为准：

- Cookie 会话与 admin 角色中间件：`src/middleware/auth.ts`
- 工作区归属判断：`canAccessGroup()`、`canModifyGroup()`、`canDeleteGroup()`（`src/web-context.ts`）
- Host 执行策略：`hasHostExecutionPermission()`（`src/web-context.ts`）、`canExecuteOnHost()`（`src/host-execution-policy.ts`）
- IM 主人命令：`src/im-command-utils.ts`
- 渠道响应对象：`src/im-audience-policy.ts`
- 路由实现：`src/routes/` 与 `src/web.ts`

个人版的访问边界只有两层：

1. **登录会话**：Web/HTTP/WebSocket 侧的有效登录、来源校验与管理操作。
2. **IM 侧访问控制**：渠道消息的发送者身份与命令约束。

工作区归属与 admin 角色检查保留为纵深防御，不构成额外的多账号授权层。

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
- 除公开接口外，所有 HTTP 路由都经过 `authMiddleware`：缺少有效 Cookie、会话过期、账号被禁用或删除时返回 401/403。
- 登录失败统一返回泛化错误；密码校验始终执行 bcrypt 比较（含不存在的账号），避免时序侧信道。
- 登录限流按 `username:ip` 与 `username` 两级计数：默认 5 次 / 15 分钟，按用户名的全局窗口为 1 小时；超限返回 429 与重试秒数。
- 会话、个人资料、密码、头像等接口只作用于当前登录账号，不接受客户端指定其他 owner。

### 1.3 WebSocket

连接建立时把认证账号 ID 与角色固定到 Session；每个操作仍重新检查目标资源。

| 操作                             | 要求                               |
| -------------------------------- | ---------------------------------- |
| `terminal_start`                 | Access；只支持 Container Workspace |
| `terminal_input` / resize / stop | 必须是当前 WebSocket 已拥有的终端  |
| Docker Build 流                  | admin 角色                         |

Origin 校验独立于 HTTP CORS：同源放行；存在 Origin 但不在白名单时拒绝升级。白名单由 `CORS_ALLOWED_ORIGINS` 与 `CORS_ALLOW_LOCALHOST` 控制。不能仅依赖 `terminal_start` 的历史授权；终端 owner 映射和连接关闭清理是协议的一部分。

### 1.4 管理操作与 admin 角色

唯一账号在初始化后恒为 admin。系统级写操作使用 `adminRoleMiddleware`：

| 路由族/操作                             | 要求                                  |
| --------------------------------------- | ------------------------------------- |
| Provider、系统容量、Host 集成、系统外观 | admin 角色                            |
| 系统 MCP 写入                           | admin 角色                            |
| `/api/docker/pull`、运行监控管理        | admin 角色                            |
| `/api/status/channel-outbox/*` 人工裁决 | admin 角色                            |
| `POST /api/groups/:jid/reset-owner`     | admin break-glass，同时仍验证目标资源 |

只读的 `GET /api/status` 仍对已登录账号开放。系统 MCP 默认仅 admin 可用；显式设置为 shared 后才进入 Agent 的有效能力清单。API 不回传 Secret 明文。

Host 执行是额外边界：`hasHostExecutionPermission()` 要求 admin 角色；真正启动 Host Runner 前还会用 `canExecuteOnHost()` 复查 owner 当前仍是 active admin，避免把权限当成工作区行上的永久属性。

### 1.5 数据归属与执行边界（纵深防御）

单账号下当前账号即所有工作区的 owner，但归属检查仍保留：

- `canAccessGroup()`：Home Workspace 仅 `created_by`；Web Workspace 仅创建者；IM Chat 优先使用自身 `created_by`，旧记录没有 owner 时通过同 folder 的 Home Workspace 解析，解析失败默认拒绝。
- `canModifyGroup()`：工作区 owner 才能重命名、切换 Agent、修改执行方式、停止或清理会话、写入工作区 Skills/MCP、修改绑定与激活策略。
- `canDeleteGroup()`：Home Workspace 永远不可删除；其他工作区必须通过 Modify。
- admin 不自动绕过工作区所有权；存量其他账号只能访问自己名下的工作区。
- 查不到资源与无权访问通常都返回 404，避免泄漏资源是否存在。
- 执行环境变量、Host 分支与容器分支仍按 owner/admin 双重校验；非 admin 的 Host 请求会被拒绝。
- 定时任务的 IPC/MCP 面授权与 Web 面同源，均为 `canAccessGroup`；`isAdminHome` 只保留为能力判定，不参与工作区范围判定。
- Agent MCP 调用没有 Cookie，但必须携带主进程创建的运行上下文（owner、Workspace/Session 身份、IPC 目录、当前 Turn 路由）；不能根据模型参数自行扩大范围。
- 敏感写操作先停止或暂停相关 Runner，失败时恢复队列，避免半写状态。

## 2. 第二层：IM 侧访问控制

渠道消息先经过访问控制，再进入 Agent。控制点集中在 `src/im-command-utils.ts` 与 `src/im-audience-policy.ts`。

### 2.1 主人认领

- 每个工作区通过 `owner_im_id` 记录渠道侧的主人身份。
- 可信的 1:1 私聊可以从第一条持久化人类消息学习 owner。
- 未认领群聊不会让第一个发命令的人自动成为 owner；群聊用 `/owner_mention` 显式认领。
- `/release_owner` 清除 owner 与白名单，并把 legacy `owner_mentioned` 降级。
- admin 的 `reset-owner` 是 owner 离群或换号后的 break-glass。

### 2.2 发送者白名单

- `/allow`、`/disallow` 与 `/allowlist` 维护当前工作区的渠道发送者白名单。
- 白名单命令在 Handler 内检查发送者是否等于当前 `owner_im_id`，不走通用的 Owner Gate。
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
| `/clear`、`/bind`、`/unbind`、`/new` | IM Owner                                     |
| `/sw`、`/spawn`                      | IM Owner                                     |
| `/release_owner`                     | IM Owner                                     |
| `/owner_mention`                     | 未认领群的 bootstrap，不可被 Owner Gate 锁死 |
| `/allow`、`/disallow`                | Handler 内检查 IM Owner                      |
| `/require_mention`                   | Handler 内按当前 owner/策略检查              |

Owner Gate 的必需命令集合由 `OWNER_REQUIRED_IM_COMMANDS` 定义；未认领工作区只允许 `/owner_mention` 完成 bootstrap。

### 2.5 渠道账号与绑定

写操作统一要求目标工作区 Modify，同时校验 IM Chat 属于同一账号、同一渠道账号，并验证会话类型：

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
3. admin 是否应该绕过必须显式测试；默认不绕过。
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

> 历史：本矩阵曾包含多账号权限层与工具审批（Approval Gate）。前者随单账号收口删除（THESIS-10、THESIS-11），后者已随任务 U（2026-11-09 综述改造回退）整体移除。
