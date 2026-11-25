# THESIS-32 db.ts 拆分（一）：任务域

| 字段          | 值                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                             |
| 领取人 / 分支 | —                                                                                                  |
| 优先级        | P2                                                                                                 |
| 类型          | 结构重构（搬代码，不改行为）                                                                       |
| 依赖          | THESIS-19、20、26（都改 `src/db.ts`）；池外 ISSUE-26 已合入或已取消                                |
| 阻塞          | 33                                                                                                 |
| 可并行        | ✅ 21 至 25、27 至 31。❌ 19、20、26、33（口径见 [README 第三节](README.md#三并行关系与执行顺序)） |
| 预计改动路径  | `src/db.ts`、`src/db/**`（新建）、`src/store-helpers.ts`、`tests/**`                               |
| 需用户决策    | 否                                                                                                 |
| 来源          | 方案 P7、§7.3                                                                                      |

## 目标

把 `src/db.ts` 里最大的一个领域——定时任务、任务运行、运行通知、运行日志的访问器（约 3,430 行）——搬到 `src/db/tasks.ts`（可再按"任务定义 / 运行 / 通知"细分），`src/db.ts` 对它们再导出。

## 现状（`248c7cb`）

- `src/db.ts` 9,510 行；schema 与迁移已在 `src/db-schema/`，`initDatabase` 是 136 行的外壳。
- 任务域约 :1238–4670，其中运行通知的合并、认领、租约代码约 :3188–4512；`completeTaskRunNotificationAttempt`（:4307，205 行）是 `db.ts` 里唯一超过 200 行的函数。
- 拆分先例：`src/memory-store.ts`、`src/channel-reliability-store.ts`、`src/owner-profile-store.ts` 用 `bind*Database(db)` 绑定连接，共用 `src/store-helpers.ts`。
- 113 个测试 `import '../src/db.js'`，19 个 `vi.mock('../src/db.js')`。

## 约束（db 拆分包通用）

- **`src/db.ts` 保留为唯一入口**：新模块的导出全部经 `db.ts` 再导出；生产代码继续 `import ... from './db.js'`，不得改为直接导入新模块——否则 `vi.mock('../src/db.js')` 拦不到，测试会静默走真库。
- 新模块通过 `db.ts` 提供的连接与预编译语句缓存访问数据库，沿用 `bind*Database` 先例或从 `db.ts` 取连接，二选一写进立项计划；不得各自打开连接。
- 读 `src/db.ts` 源码文本的测试（如 `tests/thesis-14-drop-dead-tables.test.ts`、`tests/thesis-07-*.test.ts`）改读对应新文件，断言不变。
- 不改任何 SQL、事务边界与函数签名。

## 非目标

- 不动 `src/db-schema/` 与迁移链。
- 不合并或简化任务通知的状态机（只搬）。

## 实现步骤

1. 基线全量测试通过。
2. 建 `src/db/`，搬任务域访问器，`db.ts` 再导出；调整内部共享的私有 helper（若被多个领域共用，移到 `src/db/shared.ts` 或 `store-helpers.ts`）。
3. 交付记录给出 `src/db.ts` 改前改后行数。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n "from '\\./db/" -- src ':!src/db.ts' ':!src/db/'` 无结果（生产代码不绕过入口）。
3. **人工冒烟（用户）**：新建、手动运行、暂停、恢复一个定时任务；查看运行记录与日志；重启服务后错过的周期任务记为 missed。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
