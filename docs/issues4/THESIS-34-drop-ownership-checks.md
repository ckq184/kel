# THESIS-34 去数据归属：检查与过滤

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                     |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                          |
| 优先级        | P1                                                                                                                                                                                                                                                                                                                                                                                                         |
| 类型          | 裁减（多用户归属）                                                                                                                                                                                                                                                                                                                                                                                         |
| 依赖          | THESIS-19、20（路由里角色判断与归属检查交织，先去角色）                                                                                                                                                                                                                                                                                                                                                    |
| 阻塞          | 26、28 至 33、35                                                                                                                                                                                                                                                                                                                                                                                           |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 34 行                                                                                                                                                                                                                                                                                                                                                            |
| 预计改动路径  | `src/web-context.ts`、`src/routes/**`、`src/db.ts`（按归属过滤的访问器）、`src/task-acl.ts`、`src/owner-gate.ts`（删除）、`src/task-utils.ts`、`src/task-scheduler.ts`、`src/index.ts`、`src/ipc/**`、`src/channel-mount-service.ts`、`src/channel-account-routing.ts`、`src/container-runner.ts`、`web/src/**`（`is_my_home`）、`tests/**`、`docs/ACL-MATRIX.md`、`docs/API.md`、`CLAUDE.md`、`README.md` |
| 需用户决策    | 否（方案 P2、P10 已定）                                                                                                                                                                                                                                                                                                                                                                                    |
| 来源          | 方案 P2、P10、§8.1                                                                                                                                                                                                                                                                                                                                                                                         |

## 目标

Web 账号侧不再有"这个资源属于哪个用户"的判断：归属检查收成"资源存在"检查，查询不再按归属列过滤。归属列保留不删，写入时填唯一账号 id（方案 P10）。

## 现状（`607d1b6`）

- `canAccessGroup`、`canModifyGroup`、`canDeleteGroup`（`src/web-context.ts:309`、:353、:378）约 99 处调用；`groupAccessDeniedResponse` 36 处（`src/routes/agents.ts`、`config.ts`、`files.ts` 等）。
- 按归属列过滤的 SQL 约 29 条：`agent_profiles` 6、`agent_builder_drafts` 5、`channel_accounts` 11（`src/db.ts` 7085–7294）、`registered_groups.created_by` 5（`src/db.ts` 7451、7515、8011、8655、9027 一带）、置顶 2；对应 `*ForUser`/`*ByOwner` 访问器。
- `src/task-acl.ts`（75 行）的 owner 判断；`src/owner-gate.ts`（29 行，6 处调用）；旧 IM 兄弟主工作区回退（`src/web-context.ts` 314–328、358–368）。
- `getUserHomeGroup`（`src/db.ts:8006`）11 处调用；主工作区命名 `web:main` / `web:home-{id}`（`src/db.ts:8043-8044`）；`is_my_home`（`src/routes/groups.ts` 3 处、前端 8 个文件）。
- 监控页 owner 名称（`src/routes/monitor.ts` 296–322）。
- 有附加含义、要改写而不是直接删的四处：主工作区与内置 Agent 档案的绑定（`src/db.ts` 6036–6044、6188–6196）；飞书群白名单回填（`src/db.ts` 7445–7470，保留 7507–7526 按渠道账号的版本）；渠道账号默认工作区（`src/db.ts` 8360–8370、`src/channel-account-routing.ts`）；任务输出路由按 `created_by` 选 IM 渠道（`src/task-utils.ts`、`src/task-scheduler.ts`）。
- 隔离测试：`tests/routes-agents-acl.test.ts`（1,342）、`routes-groups-owner-acl`（1,396）、`routes-messages-acl`（396）、`routes-workspace-config-acl`（249）、`routes-stop-interrupt-acl`（144）、`task-acl`（143）、`user-home-isolation`（75）、`owner-gate`（108），合计约 3.85k 行；另有 `tests/helpers/route-test-user.ts` 的多用户夹具。

## 非目标

- 不删归属列、不改唯一索引、不新增 schema 版本（方案 P10、§3 第 1 条）。
- 不改 IM 侧访问控制（`owner_im_id`、`sender_allowlist`、`audience_mode` 等，方案 §3 第 2 条）。
- 不改主工作区的现有目录名。
- 不动运行时结构（IM 管理器、WebSocket、启动循环，归 THESIS-35）与按用户存储（THESIS-36、37）。

## 执行前核实

- 逐个调用点区分三类：① 纯归属判断（删）；② 兼做"资源不存在返回 404"（保留存在性检查）；③ 有附加含义的四处（按"现状"改写）。
- `canDeleteGroup` 里"主工作区不可删除"的规则保留。
- 写入路径：确认所有新建记录仍写入归属列（填唯一账号 id），避免 `NOT NULL` 约束失败。
- 可以只读查看本机数据库核对现有记录的归属列分布（方案 §3 放宽项）。

## 实现步骤（TDD）

1. **Red**：新增契约用例——`src/` 不再出现 `canAccessGroup`/`canModifyGroup`/`canDeleteGroup`（或其等价归属判断）、`owner-gate`、`getUserHomeGroup`、`is_my_home`；不存在的工作区仍返回 404；主工作区删除仍被拒；任务输出仍路由到 IM。
2. **Green**：删归属检查与过滤，改写四处附加含义；删隔离测试套件，把其中 404、主工作区不可删、IM 侧访问控制的用例迁到保留的测试文件。
3. 文档：`docs/ACL-MATRIX.md` 改写为三层（登录会话、宿主机执行、IM 侧访问控制）；`CLAUDE.md` §8 去掉"数据归属检查"一条；`README.md`、`docs/API.md` 同步；`tests/thesis-13-personal-docs.test.ts` 的断言随之更新。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n -E "canAccessGroup|canModifyGroup|canDeleteGroup|getUserHomeGroup|is_my_home|owner-gate" -- src web/src` 只剩否定断言。
3. **人工冒烟（用户）**：工作区列表、新建与删除工作区（主工作区不可删）、Agent 档案列表与编辑、渠道账号列表、定时任务列表与运行结果推送到 IM。

## 风险与回滚

- 改动面最大的包之一（后端约 15 个文件、约 4k 行测试）。建议按"Web 路由 → DB 访问器 → 任务与 IPC → 前端"分提交，每个提交单独全绿。
- 回滚：`git revert` 对应提交区间。

## 交付记录

（待填）
