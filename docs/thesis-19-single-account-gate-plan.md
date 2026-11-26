# 任务立项：THESIS-19 单账号收口（多用户死代码与 reset:admin）

> 立项日期：2026-11-26｜base：`48903d0`（main tip，personal-slim v1.1 文档合入后）｜分支：`claude/thesis-19-single-account-gate`
> 来源：[docs/issues4/THESIS-19-single-account-gate.md](issues4/THESIS-19-single-account-gate.md)

## 0. 需求采访结论

- **已定事项（v1.1）**：D-P1 不做启动停用；D-P2 `reset:admin` 对不存在的用户名报错退出，只能重置唯一账号；D-P3 删除按用户容器并发上限（admin 恒放行）。
- **完成条件**：issue 清单内符号在 `src/` 只剩否定断言/保留的见证参数；`reset:admin` 不再新建账号；系统设置接口不再回显 `maxConcurrentContainersPerUser`；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- **约束**：不改 `users` 表结构与迁移链；不改角色判断（THESIS-20）与归属判断（THESIS-34）；不改登录限流、设备会话、个人资料、首启创建账号；不改全局并发 `maxConcurrentContainers`；不动 `data/` 与密钥。
- **2026-11-26 用户裁决（范围差异）**：`src/task-routing.ts` 的 `resolveBroadcastFolder(sourceFolder, _ownerHomeFolder)` **保留**。该参数是 fix F 的“见证参数”，故意不读，配合 `tests/task-routing-decision.test.ts` 4 条用例锁定“广播必须用 sourceFolder，不能回退 owner home”。因此 `src/task-routing.ts`、`src/ipc/task-dispatch.ts`、`src/ipc/watcher.ts` 与 `tests/task-routing-decision.test.ts` 不在本包改动范围；THESIS-19 只删无人读取的转发链。

## 1. 执行前核实（base `48903d0`）

| 项                       | 复核结论                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset:admin`            | `src/reset-admin.ts:40-51` 在用户名不存在时 `createUser`；无现存测试。脚本顶层 `void main()`，直接 import 会执行入口，需先抽出可测函数并加 CLI 入口判定。                                                                                                                                                                                            |
| index 用户热重载         | `reloadFeishuConnection`（:13744）、`reloadUserIMConfig`（:13788）、`reconnectUserIMChannels`（:13957）及 `startWebServer` 接线（:14015-14017）无其他调用方；`web-context.ts` 的三个同名依赖只有声明与接线，无消费方。                                                                                                                               |
| index 连接状态接线       | `isUserFeishuConnected`/`isUserQQConnected`/`isUserWeChatConnected`/`isFeishuConnected` 只出现在 `web-context.ts` 声明与 `index.ts` 接线；`isAnyFeishuConnected` 仍被 :14808 使用，保留。                                                                                                                                                            |
| index 启动 admin 注册    | `registerAdminUser` 唯一写入点 :14684，`adminUserIds` 只写不读。                                                                                                                                                                                                                                                                                     |
| im-manager 用户级隔离    | `sealedUsers`/`userLocks`/`withUserLock` 只被 `connectChannel` 与 `disconnectAllUserChannels` 使用；`markUserReconnectable` 只被待删的重连函数使用；`disconnectUser{Feishu,QQ,WeChat}` 只被待删的 reload 使用；`is{Feishu,QQ,WeChat}Connected` 只被待删接线使用。                                                                                    |
| db 用户访问器            | `getActiveAdminCount`、`updateUserFieldsAndForceRuntimesToHost`、`deleteUser`、`restoreUser` 均无生产调用；`deleteUser` 仅 `tests/owner-gate.test.ts:83` 注释提及。`forceActiveAdminRuntimesToHost` 仍被启动与设置路由使用，保留。                                                                                                                   |
| host-execution-policy    | `beginHostPrivilegeRevocation`/`endHostPrivilegeRevocation` 只被 `tests/host-execution-policy.test.ts` 使用；`canExecuteOnHost` 的 in-flight 复查随之简化为 role/status 检查。                                                                                                                                                                       |
| `ownerHomeFolder` 转发链 | `claude-context-resolver.ts:42` 声明未读；`container-runner.ts` 9 处逐层透传；`index.ts` 计算 + 2 处实参；`task-scheduler.ts` 计算 + 实参。以上全部删除。`task-routing.ts` 见证参数按用户裁决保留（见 §0），因此全仓仍会看到 3 行注释。                                                                                                              |
| 按用户并发上限           | `runtime-config.ts` 接口/默认值/normalize/env 回退 + `nullableLimitField` + `createUserContainerConcurrencyChecker`；`index.ts:14293-14310` 接线；`group-queue.ts` 字段/setter/`hasCapacityFor`；`schemas.ts:629`；`routes/config.ts:1301`。                                                                                                         |
| 额外受影响测试           | `channel-account-startup-contract`（2 条断言待删函数）、`group-queue-host-session-concurrency`（1 行 checker）、`routes-provider-runtime-apply`（用 checker 制造容量排队，需改用全局容器容量）、`im-manager-channel-accounts`（调用待删 `disconnectUserFeishu`）、`claude-context-resolver`（8 处待删字段）、`owner-gate`（注释提及 `deleteUser`）。 |
| 文档                     | `docs/API.md` 只列 `GET / PUT /api/config/system`，未列任何系统设置字段；无可删字段说明（交付记录说明）。`CLAUDE.md` 只提全局 `maxConcurrentContainers`，不动。                                                                                                                                                                                      |

与 issue 的差异：

1. `ownerHomeFolder` 的 task-routing 见证参数与其测试保留（§0 用户裁决）；issue 的“23 处”按转发链执行，`src/task-routing.ts` 不改。
2. issue 未列出的 `tests/routes-provider-runtime-apply.test.ts`、`tests/group-queue-host-session-concurrency.test.ts`、`tests/im-manager-channel-accounts.test.ts`、`tests/claude-context-resolver.test.ts`、`tests/owner-gate.test.ts`、`tests/mcp-runtime-secret-boundary.test.ts` 落在 `tests/**` 范围内，需同步适配。

## 2. 方案（TDD）

### 2.1 Red

新增 `tests/thesis-19-single-account-gate.test.ts`：

1. **reset:admin 行为**（mock `config` 到临时 DATA_DIR）：
   - 不存在的用户名调用 `resetAdminAccount` 抛错，`users` 行数不增加；
   - 已存在的账号可重置密码：新 hash 可校验、旧 session 被删、role/status 恢复为 admin/active；
   - 短密码抛错。
2. **源码契约**：以下符号在 `src/` 零出现：
   `reloadFeishuConnection`、`reloadUserIMConfig`、`reconnectUserIMChannels`、
   `adminUserIds`、`registerAdminUser`、`sealedUsers`、`withUserLock`、
   `disconnectAllUserChannels`、`markUserReconnectable`、`disconnectUserFeishu/QQ/WeChat`、
   `isFeishuConnected`、`isQQConnected`、`isWeChatConnected`、
   `getActiveAdminCount`、`updateUserFieldsAndForceRuntimesToHost`、`deleteUser`、`restoreUser`、
   `beginHostPrivilegeRevocation`、`endHostPrivilegeRevocation`、
   `maxConcurrentContainersPerUser`、`MAX_CONCURRENT_CONTAINERS_PER_USER`、
   `createUserContainerConcurrencyChecker`、`setUserConcurrentLimitChecker`；
   以及 `ownerHomeFolder` 在 `claude-context-resolver.ts`、`container-runner.ts`、`index.ts`、`task-scheduler.ts` 零出现。
3. **系统设置接口**：`GET /api/config/system` 响应不含 `maxConcurrentContainersPerUser`；`PUT` 带该字段因 strict schema 返回 400，且不持久化。

同步修改锁定测试：

- `tests/channel-account-startup-contract.test.ts`：删除依赖 `reloadUserIMConfig`/`reconnectUserIMChannels` 的两条用例，保留启动投影与飞书同步调度两条。
- `tests/group-queue-host-session-concurrency.test.ts`：删除 `setUserConcurrentLimitChecker` 注入，host 模式不受容量限制的断言保留。
- `tests/routes-provider-runtime-apply.test.ts`：容量排队改用 `saveSystemSettings({ maxConcurrentContainers: 1 })` + 一个阻塞的容器 runner 占满槽位；断言“runtime apply 不丢弃排队中的 descendant 任务”不变。
- `tests/im-manager-channel-accounts.test.ts`：`disconnectUserFeishu` 改为公开的 `disconnectChannel(userId, 'feishu')`。
- `tests/host-execution-policy.test.ts`：删除 revocation 用例与 import；保留 active admin/status 判定。
- `tests/claude-context-resolver.test.ts`：删除 8 处 `ownerHomeFolder` 入参。
- `tests/owner-gate.test.ts`：注释改为“删除账号是软删除（status='deleted'）”，不再提 `deleteUser`。
- 删除 `tests/system-settings-per-user-echo.test.ts`、`tests/group-queue-user-concurrency.test.ts`。

在 base 上运行新契约应失败（Red）；`reset:admin` 行为用例在抽出可测函数后、改行为前应因“未知用户仍会新建”失败。

### 2.2 Green

1. **reset-admin**：抽出 `resetAdminAccount(username, password)`；用户名不存在抛 `ResetAdminError('User not found: …')`，不再 `createUser`；CLI 入口判定后 `main()` 负责 usage/错误输出与退出码。
2. **index**：删除三个热重载函数与 `startWebServer` 接线、`isUser*`/`isFeishuConnected` 接线、`registerAdminUser` 循环、按用户并发 checker 接线；删除 `resolveOwnerHomeFolder` 与两处 `ownerHomeFolder` 实参；清理因此不再使用的 import。
3. **web-context**：删除 7 个无消费方的可选依赖声明。
4. **im-manager**：删除 admin 注册表、user 锁/sealed 机制（`connectChannel` 只保留 channel 锁）、`disconnectAllUserChannels`、`markUserReconnectable`、`disconnectUser*`、`is{Feishu,QQ,WeChat}Connected`；`scopeConnectOpts` 去掉 sealed 检查。
5. **db**：删除四个零调用用户访问器；`forceActiveAdminRuntimesToHost` 与 `AdminHostOnlyMigrationResult` 保留。
6. **host-execution-policy**：删除 revocation 集合与 begin/end；`canExecuteOnHost` 只查 role/status。
7. **ownerHomeFolder 转发链**：删除 `ClaudeContextPlanArgs` 字段、`buildVolumeMounts`/`runContainerAgent`/`runHostAgent`/`runAgentWithModelFallback` 参数与 `buildClaudeContextPlan`/`runFn` 实参；`index.ts`/`task-scheduler.ts` 删除计算。
8. **按用户并发**：删 `runtime-config` 字段/默认值/normalize/env/helper/checker 与 `stripVirtualJidSuffix` import；删 `schemas`、`routes/config`、`group-queue` 对应字段/setter/判定；`index.ts` 删接线。
9. 同步 §2.1 测试与 `docs/API.md`（实际无字段可删，交付记录说明）。

### 2.3 Refactor / 门禁

- `git grep -n -w -E "<清单符号>" -- src tests` 只剩否定断言（`ownerHomeFolder` 只余 task-routing 见证参数及其注释/测试）。
- `npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`。
- `npm run reset:admin -- ghost <password>` 在临时 cwd 冒烟：报错退出码 1；`npm run reset:admin -- admin <password>` 只在账号存在时成功（不在真实 `data/` 上执行）。

## 3. 任务拆解

| #   | 任务               | 主要文件                                                                                                | 独立验收                                           |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| T1  | 立项               | 本文件、`.gatescope.json`                                                                               | check-scope 通过；base 记录为 `48903d0`            |
| T2  | Red 契约           | 新测试、6 个锁定测试、删 2 个测试                                                                       | 新契约在 base 上失败；行为用例定位到“未知用户新建” |
| T3  | reset-admin Green  | `src/reset-admin.ts`                                                                                    | 未知用户报错；唯一账号可重置；CLI 入口正常         |
| T4  | 死代码 Green       | `src/index.ts`、`src/im-manager.ts`、`src/web-context.ts`、`src/db.ts`、`src/host-execution-policy.ts`  | 清理符号零出现；相关测试通过                       |
| T5  | ownerHomeFolder 链 | `src/claude-context-resolver.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`、`src/index.ts`    | 四处零出现；task-routing 见证参数与用例保留        |
| T6  | 按用户并发 Green   | `src/runtime-config.ts`、`src/schemas.ts`、`src/routes/config.ts`、`src/group-queue.ts`、`src/index.ts` | 字段/setter/checker 零出现；系统设置接口不回显     |
| T7  | 门禁与交付         | 全范围、issue/README/方案台账/审查记录                                                                  | verify 六步全绿；check-scope 通过                  |

回滚点：base `48903d0`；每个提交可单独 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-19-single-account-gate-plan.md`、`docs/issues4/THESIS-19-single-account-gate.md`、`docs/issues4/README.md`、`docs/issues4/task-personal-slim-plan.md`、`docs/审查记录.md`、`src/index.ts`、`src/im-manager.ts`、`src/web-context.ts`、`src/db.ts`、`src/host-execution-policy.ts`、`src/claude-context-resolver.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`、`src/runtime-config.ts`、`src/schemas.ts`、`src/routes/config.ts`、`src/group-queue.ts`、`src/reset-admin.ts`、`tests/thesis-19-single-account-gate.test.ts`、`tests/channel-account-startup-contract.test.ts`、`tests/group-queue-host-session-concurrency.test.ts`、`tests/routes-provider-runtime-apply.test.ts`、`tests/host-execution-policy.test.ts`、`tests/im-manager-channel-accounts.test.ts`、`tests/claude-context-resolver.test.ts`、`tests/owner-gate.test.ts`、`tests/mcp-runtime-secret-boundary.test.ts`、`tests/system-settings-per-user-echo.test.ts`、`tests/group-queue-user-concurrency.test.ts`。

与 issue“预计改动路径”的差异：不含 `src/task-routing.ts`（见证参数保留），不含 `docs/API.md`（无字段可删）。

## 5. 验收条件

1. issue 清单内符号在 `src/` 零出现；`ownerHomeFolder` 仅余 task-routing 见证参数/注释与测试。
2. `reset:admin` 对不存在的用户名报错退出，只重置现有账号。
3. `GET/PUT /api/config/system` 不再出现 `maxConcurrentContainersPerUser`。
4. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 新契约在 base 上失败、实现后通过（非空转）。
6. **人工冒烟（用户）**：重启服务后正常登录；系统设置能保存；`npm run reset:admin` 对不存在的用户名报错。

## 6. 非目标

- 不删 `users` 表任何列、不改迁移链与 `CURRENT_SCHEMA_VERSION`。
- 不改角色判断（THESIS-20）与归属判断（THESIS-34）；`getUserHomeGroup`、`is_home`、ACL 不动。
- 不改登录限流、设备会话、个人资料、首启创建账号。
- 不改全局 `maxConcurrentContainers`。
- 不动 task-routing 见证参数、`src/ipc/task-dispatch.ts`、`src/ipc/watcher.ts` 及其回归测试。
- 不做清单外“顺手清理”（如 index 里已被忽略的 `resolveBroadcastFolder` 未用 import 只登记）。
- 不执行 `npm run test:real-model`、不写 `data/`。

## 7. 风险与回滚

- 纯删除与等价改写；`reset:admin` 是唯一行为变化（未知用户不再建号），符合 D-P2。
- 系统设置旧文件里残留的 `maxConcurrentContainersPerUser` 会被 normalize 忽略，不报错、不回写。
- 回滚：`git revert <提交号>`；无数据、schema 与对外接口字段新增。
