# THESIS-19 单账号收口：强制唯一账号与多用户死代码

| 字段          | 值                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                          |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                               |
| 优先级        | P1                                                                                                                                                                                                                                                                                                              |
| 类型          | 裁减（前置闸门 + 死代码）                                                                                                                                                                                                                                                                                       |
| 依赖          | 无（issues3 全部合入后开工）                                                                                                                                                                                                                                                                                    |
| 阻塞          | 20、21、22，以及间接的 23、26 至 33                                                                                                                                                                                                                                                                             |
| 可并行        | ✅ 24、25。其余均 ❌（本包是它们的前置）（口径见 [README 第三节](README.md#三并行关系与执行顺序)）                                                                                                                                                                                                              |
| 预计改动路径  | `src/middleware/auth.ts`、`src/routes/auth.ts`、`src/index.ts`（启动段、13447–13993、14290–14305）、`src/im-manager.ts`、`src/db.ts`（用户访问器段）、`src/host-execution-policy.ts`、`src/runtime-config.ts`、`src/routes/config.ts`、`src/schemas.ts`、`src/reset-admin.ts`、`src/web-context.ts`、`tests/**` |
| 需用户决策    | **是**：D-P1 至 D-P3                                                                                                                                                                                                                                                                                            |
| 来源          | 方案 P1、§4                                                                                                                                                                                                                                                                                                     |

## 目标

去角色（THESIS-20、21）之前，先在代码层保证系统里只有一个可用账号，并删掉多用户留下的死代码。合入后，"角色判断恒为真"不再依赖"库里恰好只有一个账号"这个未经确认的前提。

## 现状（`248c7cb`）

- 登录只检查 `status === 'active'`；第二轮 D-E5 ②（清理其他 active 账号）从未书面确认。
- `reset:admin`（`src/reset-admin.ts`，54 行）在用户名不存在时会新建一个 admin。
- 无调用方的多用户代码（THESIS-10 删 `/api/admin` 后遗留）：
  - `src/index.ts`：`syncLegacyConfigToDefaultChannelAccount` 之后的 `reloadFeishuConnection`（:13744）、`reloadUserIMConfig`（:13788）、`reconnectUserIMChannels`（:13957）及其在 `main` 里的接线（:14015–14017 一带）。注意：`syncLegacyConfigToDefaultChannelAccount`（:13447）与 `migrateDataDirectories`（:13521）归 THESIS-22，本包不动。
  - `src/im-manager.ts`：`adminUserIds`（:139，只写不读）、`sealedUsers`（:151）、`withUserLock`（:480）、`disconnectAllUserChannels`、`markUserReconnectable`、`disconnectUser*`、`is{Feishu,QQ,WeChat}Connected`；`src/web-context.ts` 里对应的未用依赖字段。
  - `src/db.ts`：`getActiveAdminCount`（:8911）、`updateUserFieldsAndForceRuntimesToHost`（:9019）、`deleteUser`（:9041，只有测试调用）、`restoreUser`（:9054）。
  - `src/host-execution-policy.ts`：`beginHostPrivilegeRevocation`、`endHostPrivilegeRevocation`（:5-11，只有测试调用）。
- 按用户的容器并发上限 `maxConcurrentContainersPerUser`：设置定义 `src/runtime-config.ts:2523`、归一 :2754，接口回显 `src/routes/config.ts:1301`，消费方 `src/index.ts:14300` 的 `setUserConcurrentLimitChecker`。唯一账号是 admin 时恒放行；无界面。测试 `tests/group-queue-user-concurrency.test.ts`（258 行）、`tests/system-settings-per-user-echo.test.ts`（149 行）。

## 非目标

- 不删 `users` 表的任何列，不新增 schema 版本（方案 §3 第 1 条）。
- 不改角色判断本身（THESIS-20）。
- 不改登录限流、设备会话、个人资料、首启创建账号。
- 不改全局容器并发上限 `maxConcurrentContainers`。

## 需用户决策（领取前拍板）

| #    | 问题                           | 选项                                                                                                                                                                                                                          | 建议 |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| D-P1 | 怎么保证只有一个可用账号       | ① 启动时幂等修正：保留最早创建的 active admin，其余 active 账号置为 `disabled`（写日志，不删行，可手工恢复）；② 不改数据，登录与会话校验只接受"唯一账号"的 id；③ 不改数据，检测到多于一个 active 账号就拒绝启动并提示用户处理 | ①    |
| D-P2 | `reset:admin` 在用户名不存在时 | ① 报错退出，只能重置唯一账号的密码；② 维持现状                                                                                                                                                                                | ①    |
| D-P3 | 按用户的容器并发上限           | ① 删除设置、接线与两个测试文件；② 保留                                                                                                                                                                                        | ①    |

D-P1 ① 的理由：② 要在每个认证入口加判断，③ 会让服务在用户不知情时起不来；① 只在启动时改一次状态字段，停用账号的工作区与渠道账号原样保留。D-P3 的背景：ISSUE-07 曾按系统设置刻意恢复这个上限，当时还是多用户。

## 执行前核实

- 每个待删符号重新 `git grep -n -w <符号> -- . ':!docs'`，确认只有定义与测试引用。和本 issue 不一致就停下报告。
- D-P1 ①：确认 `users` 表的"最早创建"判据（`created_at`）与首启创建路径（`POST /api/auth/setup`）一致；确认停用账号的会话会被清掉（复用现有停用逻辑，不新写）。

## 实现步骤（TDD）

1. **Red**：启动修正用例——库里有两个 active admin 与一个 member 时，启动后只剩最早的 admin 为 active，日志记录被停用的账号 id；只有一个账号时不写库。`reset:admin` 对不存在的用户名报错。待删符号的否定断言。
2. **Green**：实现启动修正（按 D-P1）；改 `reset:admin`；删除死代码与（按 D-P3）按用户并发上限。
3. 同步 `docs/API.md`（若系统设置回显字段变化）。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 待删符号 `git grep -w` 只剩否定断言。
3. **人工冒烟（用户）**：重启服务后能正常登录；设置页系统设置能保存；`npm run reset:admin` 对不存在的用户名给出错误。

## 风险与回滚

- D-P1 ① 会改账号状态。回滚代码不会自动恢复被停用的账号；交付记录写明恢复方法（把对应行的 `status` 改回 `active`，由用户执行）。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
