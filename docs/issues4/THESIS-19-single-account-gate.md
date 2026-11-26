# THESIS-19 单账号收口：多用户死代码与 reset:admin

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                     |
| 领取人 / 分支 | claude/thesis-19-single-account-gate                                                                                                                                                                                                                                                                                                                                                       |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                         |
| 类型          | 裁减（死代码与第二账号入口）                                                                                                                                                                                                                                                                                                                                                               |
| 依赖          | 无（issues3 全部合入后开工）                                                                                                                                                                                                                                                                                                                                                               |
| 阻塞          | 20、21、22、23、26、27、28 至 37                                                                                                                                                                                                                                                                                                                                                           |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 19 行                                                                                                                                                                                                                                                                                                                                            |
| 预计改动路径  | `src/index.ts`（13743–14041、14291–14310）、`src/im-manager.ts`、`src/web-context.ts`、`src/db.ts`（用户访问器段）、`src/host-execution-policy.ts`、`src/runtime-config.ts`、`src/routes/config.ts`、`src/schemas.ts`、`src/group-queue.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`、`src/claude-context-resolver.ts`、`src/task-routing.ts`、`src/reset-admin.ts`、`tests/**` |
| 需用户决策    | 否（v1.1：本机账号均为测试账号，原 D-P1 至 D-P3 已定）                                                                                                                                                                                                                                                                                                                                     |
| 来源          | 方案 P1、§4                                                                                                                                                                                                                                                                                                                                                                                |

## 目标

删掉 THESIS-10 删除用户管理后留下的多用户死代码，并堵上 `reset:admin` 新建第二个账号的入口。这是去角色（THESIS-20、21）与去归属（THESIS-34 至 37）的第一步。

## 已定事项（v1.1，2026-11-25）

| 原决策                              | 结论                           | 依据                                                                                   |
| ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| D-P1 启动时停用多余账号             | **不做**                       | 本机账号均为测试账号（用户确认）；只留管理员一个角色后，任何账号都是管理员，不存在越权 |
| D-P2 `reset:admin` 对不存在的用户名 | **报错退出**，只能重置唯一账号 | 方案 P1                                                                                |
| D-P3 按用户容器并发上限             | **删除**                       | 方案 P2：多用户代码全部裁减；admin 本来就恒放行                                        |

## 现状（`607d1b6`）

- `reset:admin`（`src/reset-admin.ts` 40–51）在用户名不存在时会新建一个 admin。
- 无调用方的多用户代码：
  - `src/index.ts`：`reloadFeishuConnection`（13743）、`reloadUserIMConfig`（13787）、`reconnectUserIMChannels`（13952）及 `main` 里 14015–14041 的接线；`src/web-context.ts` 61–69、77–88、93–103、117 的对应依赖声明。`syncLegacyConfigToDefaultChannelAccount`（13447）与 `migrateDataDirectories`（13521）归 THESIS-22。
  - `src/im-manager.ts`：`adminUserIds`（:139，只写不读，写入点 `src/index.ts` 14682–14685）、`sealedUsers`（:151）、`withUserLock`（:480）、`disconnectAllUserChannels`、`markUserReconnectable`、`disconnectUser*`、`is{Feishu,QQ,WeChat}Connected`（480–502、1476–1525 及 255、564、583、635 的检查）。
  - `src/db.ts`：`getActiveAdminCount`（:8911）、`updateUserFieldsAndForceRuntimesToHost`（:9019）、`deleteUser`（:9041，只有测试调用）、`restoreUser`（:9054）。
  - `src/host-execution-policy.ts`：`beginHostPrivilegeRevocation`、`endHostPrivilegeRevocation`（:5–11，只有测试调用）。
  - `ownerHomeFolder` 参数（23 处）：`src/claude-context-resolver.ts:42` 声明未用，`src/task-routing.ts` 198–218 注明未用；传递点在 `src/index.ts`、`src/container-runner.ts`、`src/task-scheduler.ts`。
- 按用户容器并发上限：`src/runtime-config.ts` 2464–2465、2871–2912，`src/index.ts` 14291–14310 的 `setUserConcurrentLimitChecker` 接线，`src/group-queue.ts` 268–270、738–742、892–897，`src/schemas.ts:629`，`src/routes/config.ts:1301`。测试 `tests/group-queue-user-concurrency.test.ts`（258）、`tests/system-settings-per-user-echo.test.ts`（149）。

## 非目标

- 不删 `users` 表的任何列，不新增 schema 版本。
- 不改角色判断（THESIS-20）与归属判断（THESIS-34）。
- 不改登录限流、设备会话、个人资料、首启创建账号。
- 不改全局容器并发上限 `maxConcurrentContainers`。

## 执行前核实

- 每个待删符号重新 `git grep -n -w <符号> -- . ':!docs'`，确认只有定义与测试引用。和本 issue 不一致就停下报告。
- 可以只读查看本机数据库核对 `users` 表（方案 §3 放宽项）。

## 实现步骤（TDD）

1. **Red**：`reset:admin` 对不存在的用户名报错、对唯一账号能重置密码；待删符号的否定断言；系统设置接口不再回显 `maxConcurrentContainersPerUser`。
2. **Green**：改 `reset:admin`；删除死代码与按用户并发上限；删两个专属测试文件。
3. 同步 `docs/API.md`（系统设置字段）。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 待删符号 `git grep -w` 只剩否定断言。
3. **人工冒烟（用户）**：重启服务后正常登录；系统设置能保存；`npm run reset:admin` 对不存在的用户名报错。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

- **提交**：`6683962`（立项）、`0f60415`（实现），审查记录、交付记录与文档收口随本提交（分支 `claude/thesis-19-single-account-gate`，基于 main `48903d0`；合入 main 时取本包 gatescope 并把 base 重置为合并前 main tip）。
- **实现**：
  - `reset:admin` 抽出 `resetAdminAccount`，用户名不存在时抛 `ResetAdminError('User not found: …')` 并退出码 1，不再 `createUser`；CLI 入口用 realpath 判定，测试导入不会执行 `main()`。
  - 删除 `src/index.ts` 的 `reloadFeishuConnection`、`reloadUserIMConfig`、`reconnectUserIMChannels` 与 `startWebServer` 接线、`isUser*Connected`/`isFeishuConnected` 接线、`registerAdminUser` 循环、按用户并发 checker 接线。
  - `src/im-manager.ts` 删除 `adminUserIds`、`sealedUsers`/`userLocks`/`withUserLock`、`disconnectAllUserChannels`、`markUserReconnectable`、`disconnectUser{Feishu,QQ,WeChat}`、`is{Feishu,QQ,WeChat}Connected`；`connectChannel` 只保留 channel 锁。
  - `src/db.ts` 删除 `getActiveAdminCount`、`updateUserFieldsAndForceRuntimesToHost`、`deleteUser`、`restoreUser`；`src/host-execution-policy.ts` 删除 test-only revocation 窗口，`canExecuteOnHost` 只查 role/status。
  - 删除 `ownerHomeFolder` 转发链（`claude-context-resolver` 声明、`container-runner` 透传、`index`/`task-scheduler` 计算与实参）。
  - 删除 `maxConcurrentContainersPerUser` 全链路（runtime-config 字段/默认值/normalize/env/helper/checker、schemas、routes/config、group-queue、index 接线），系统设置接口不再回显；`docs/API.md` 补删除与严格拒绝说明。
  - 删除两个专属测试文件；新增 `tests/thesis-19-single-account-gate.test.ts`（行为 4 例、系统设置 2 例、源码契约 7 例）。
- **验证**：`npm run verify` 六步全绿（369 文件，3035 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 30 路径全在声明范围内；`npm run docs:check` 158 个 Markdown；受影响测试文件 shuffle seed 1337 全绿；CLI 在临时 cwd 冒烟：未知用户名 exit 1、不建号，现有账号重置 exit 0。
- **偏差**：
  1. `src/task-routing.ts` 的 `resolveBroadcastFolder(sourceFolder, _ownerHomeFolder)` 见证参数及其 4 条 fix-F 用例按 2026-11-26 用户裁决保留；`src/task-routing.ts`、`src/ipc/task-dispatch.ts`、`src/ipc/watcher.ts` 未改。
  2. `PUT /api/config/system` 带 `maxConcurrentContainersPerUser` 由旧行为 200 改为 strict schema 400（该字段已删除且 `web/` 全仓无引用）；已写入 `docs/API.md`。
  3. `tests/mcp-runtime-secret-boundary.test.ts` 因 `buildVolumeMounts` 删除第 5 个位置参数，去掉一个 `undefined` 占位；`tests/routes-provider-runtime-apply.test.ts` 的容量排队改用全局 `maxConcurrentContainers`；`tests/group-queue-host-session-concurrency.test.ts`、`tests/im-manager-channel-accounts.test.ts`、`tests/claude-context-resolver.test.ts`、`tests/owner-gate.test.ts` 同步适配。
- **范围外登记**：`GroupQueue.hasDirectActiveRunner` / `countActiveTaskRunners` 因删除 checker 接线成为零调用，按非目标不删（归 THESIS-26）；`syncLegacyConfigToDefaultChannelAccount` 归 THESIS-22；`tests/provider-model-fallback-contract.test.ts:25` 的 `ownerHomeFolder` 否定断言已无实际防回归意义；`src/index.ts` 的 `resolveBroadcastFolder` 未用 import 归 THESIS-28；`src/channel-admission.ts:85` 注释仍提 sealed（IM 侧访问控制非目标）。
- **未实机验收**：用户需重启服务后正常登录、保存系统设置、执行 `npm run reset:admin` 验证未知用户名报错。Container 镜像无需重建（未改 runner/容器）。
