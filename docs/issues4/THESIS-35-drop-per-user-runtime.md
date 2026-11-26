# THESIS-35 运行时结构去用户维度

| 字段          | 值                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                     |
| 优先级        | P2                                                                                                                                                                                                                                                                                    |
| 类型          | 裁减（多用户运行时结构）                                                                                                                                                                                                                                                              |
| 依赖          | THESIS-19、20、22（`src/im-manager.ts`、`src/index.ts`）、34（WebSocket 过滤依赖归属判断）                                                                                                                                                                                            |
| 阻塞          | 28 至 31                                                                                                                                                                                                                                                                              |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 35 行                                                                                                                                                                                                                                       |
| 预计改动路径  | `src/im-manager.ts`、`src/web.ts`、`src/group-broadcast-acl.ts`（删除）、`src/index.ts`（启动循环）、`src/capability-lock.ts`、`src/channel-pairing.ts`、`src/web-context.ts`、`web/src/hooks/useDisplayMode.ts`、`web/src/utils/task-run-idempotency.ts`、`tests/**`、`web/tests/**` |
| 需用户决策    | 否（方案 P2 已定）                                                                                                                                                                                                                                                                    |
| 来源          | 方案 P2、§8.2                                                                                                                                                                                                                                                                         |

## 目标

运行时不再按用户分组：IM 连接只按渠道账号管理，WebSocket 不再按用户过滤，启动时不再遍历用户，锁与配对码不再带用户键。

## 现状（`607d1b6`）

| 结构                         | 位置                                                                                                                             | 约行数       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| IM 管理器"用户→渠道"两级映射 | `src/im-manager.ts` 54–55、138–157、246–280、535–541、922–951、958–982（`userId` 138 处）                                        | ~100（净减） |
| WebSocket 按用户过滤         | `src/group-broadcast-acl.ts`（64 行，整文件）；`src/web.ts` 1128–1153、1185–1211、1571–1629、2228–2261（`allowedUserIds` 21 处） | ~110         |
| 启动时 `listUsers()` 循环    | `src/index.ts` 4261–4283（为每个用户保证主工作区）、4477–4485（按已连接用户同步群）。旧 IM 投影与迁移循环归 THESIS-22            | ~90          |
| 锁与配对的用户键             | `src/capability-lock.ts:9`（`user:{id}`）、`src/channel-pairing.ts` 25–26、`src/im-manager.ts` 221、237、509                     | ~45          |
| 前端按用户的本地存储键       | `web/src/hooks/useDisplayMode.ts` 9–10、`web/src/utils/task-run-idempotency.ts` 11–12                                            | ~10          |

测试：`tests/im-manager-owner-fallback.test.ts`（256）、`tests/group-broadcast-acl.test.ts`（135）、`tests/capability-lock.test.ts`（70，多用户部分），以及 `tests/capability-runtime-mutation.test.ts` 81–120。

## 非目标

- 渠道多账号保留：IM 管理器的键从"用户 + 渠道"收成"渠道账号"，不是收成"每种渠道一个"。
- 旧数据行没有 `channel_account_id` 时按渠道类型找默认账号的路径保留（`src/im-manager.ts` 930–937 的 provider 查找部分）。
- 不改 IM 侧访问控制。

## 行为变化（须写进交付记录）

- 现在若某工作区的 owner 无法解析，相关广播会被丢弃；改后广播发给所有已登录会话（只有一个账号）。

## 执行前核实

- `src/web.ts` 的 WebSocket 鉴权（Cookie 会话、Origin 校验）与按用户过滤是两件事，鉴权保留，只删过滤。
- 列出 `src/im-manager.ts` 每个对外方法的调用方，确认去掉 `userId` 参数后签名的连锁改动范围。

## 实现步骤（TDD）

1. **Red**：两个渠道账号同时在线时消息各自路由正确（回归）；WebSocket 新消息广播到已登录会话；`group-broadcast-acl` 与 `allowedUserIds` 零出现；能力锁不再有 `user:` 键。
2. **Green**：按"现状"逐项改；删除或改写上列测试。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：浏览器里发消息能实时看到回复；在 IM 里发消息，Web 端实时出现；停用再启用一个渠道账号能重连；重启服务后渠道自动连上。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
