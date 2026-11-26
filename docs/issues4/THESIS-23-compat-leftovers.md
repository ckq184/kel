# THESIS-23 兼容残留收口与 pre-V5 供应商配置迁移

| 字段          | 值                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                     |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                    |
| 类型          | 兼容收窄                                                                                                                                                                                                                                                                                                                              |
| 依赖          | THESIS-20（`src/middleware/auth.ts` 相邻区域）、THESIS-22（`src/runtime-config.ts`、`src/index.ts`）                                                                                                                                                                                                                                  |
| 阻塞          | 28 至 31                                                                                                                                                                                                                                                                                                                              |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 23 行                                                                                                                                                                                                                                                                                       |
| 预计改动路径  | `src/auth.ts`、`src/config.ts`、`src/middleware/auth.ts`、`src/web.ts`、`src/index.ts`（:634 一带）、`src/schemas.ts`、`src/routes/{config,groups,memory,monitor}.ts`、`src/runtime-config.ts`（pre-V5 段）、`web/src/App.tsx`、`web/src/pages/SettingsPage.tsx`、`tests/**`、`web/tests/**`、`CLAUDE.md`、`docs/API.md`、`README.md` |
| 需用户决策    | **是**：D-K1（D-K2 已定 ①）                                                                                                                                                                                                                                                                                                           |
| 来源          | 方案 P3、§5                                                                                                                                                                                                                                                                                                                           |

## 目标

删掉为"旧客户端、旧部署、旧配置格式"保留的兼容代码。数据库迁移链不动（方案 §3 第 1 条）。

## 现状（`248c7cb`）

| 项                                                      | 位置                                                                                                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未签名旧 cookie 自动升级 `ALLOW_LEGACY_UNSIGNED_COOKIE` | `src/auth.ts:49` 起，`src/middleware/auth.ts` 的升级分支                                                                                                                           |
| 旧 cookie 名与现名相同，每个请求读两遍                  | `src/config.ts:69-70` `LEGACY_SESSION_COOKIE_NAME_*` 及其读取点                                                                                                                    |
| 环境变量别名链                                          | `src/config.ts:13-15`（`CKQCLAW_ASSISTANT_NAME`/`ASSISTANT_NAME`）、:47-49（`CONTAINER_IMAGE` 链）、`src/index.ts:634-635`（`CKQCLAW_WEB_URL`/`PUBLIC_BASE_URL`/`WEB_BASE_URL`）   |
| 已退役设置键：接收后丢弃                                | `src/schemas.ts:638` 起、`src/routes/config.ts:1330` 起（含 `maxConcurrentHostProcesses`、`maxTasksPerUser` 等 6 个）                                                              |
| 返回 410/409 的占位路由                                 | `src/routes/groups.ts:2565`、`src/routes/memory.ts:213`、`src/routes/monitor.ts:362`                                                                                               |
| 前端旧地址重定向                                        | `web/src/pages/SettingsPage.tsx:52` `LEGACY_TAB_ROUTES` 与 `automation` 特判；`web/src/App.tsx` 的 `/groups`、`/skills`、`/mcp-servers` 三个重定向                                 |
| pre-V5 供应商配置迁移                                   | `src/runtime-config.ts`：类型约 :304–357、`readLegacyConfig`（:732）、`readStoredState`（:947）、`migrateV3toV4`（:1093）、`readStoredStateV4`（:1209）里的 V3/V4 分支；测试无引用 |

`CLAUDE.md` §3.2 记录了两层重定向，§4 记录了 `maxConcurrentHostProcesses` 的兼容忽略，§9 记录了别名与 `ALLOW_LEGACY_UNSIGNED_COOKIE`；须同包改写。

## 非目标

- 不动数据库迁移链与 `CURRENT_SCHEMA_VERSION`。
- 不动 `channel_mounts` 双写、`/api/groups/:jid/agents` 命名（不是别名，返回内容更多）。
- 不改供应商 V5 存储格式与 OAuth 闲置字段（第二轮 D-4 ①）。

## 需用户决策（领取前拍板）

| #    | 问题              | 选项                                                                                                                             | 建议                                  |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| D-K1 | 环境变量别名      | ① 每组只留一个正式名：`CKQCLAW_ASSISTANT_NAME`、`CONTAINER_IMAGE`、`CKQCLAW_WEB_URL`，旧名删除；② 只删 cookie 与设置键，别名保留 | ①（前提：用户确认自己的部署没用旧名） |
| D-K2 | pre-V5 供应商配置 | **已定 ①**（v1.1，2026-11-25）：删迁移代码，读到旧版本配置时记错误日志并按"未配置"处理。本机供应商配置已核实为 V5                | —                                     |

## 执行前核实

- 用户确认部署环境（`.env`、启动脚本、Docker 参数）里没有用到将删除的环境变量旧名。代理不读 `data/` 与用户的环境文件。
- 每个退役设置键：确认前端已不提交（`git grep -n <键名> -- web/src`）。旧客户端提交时后端行为改为 Zod 报错还是静默忽略，执行时选与现有 schema 风格一致的一种并写进交付记录。

## 实现步骤（TDD）

1. **Red**：未签名 cookie 被拒；旧环境变量名不再生效；退役设置键不再被接受；占位路由 404；三个前端重定向与 `LEGACY_TAB_ROUTES` 不存在；旧版本供应商配置按未配置处理并记日志。
2. **Green**：逐项删除。
3. 同步 `CLAUDE.md`、`docs/API.md`、`README.md`。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：登录、刷新后保持登录；设置页各标签可切换；供应商列表正常、对话正常；飞书卡片里的 trace 链接（若配置了 `CKQCLAW_WEB_URL`）正常。

## 风险与回滚

- 用了旧环境变量名的部署在升级后会退回默认值。README 第四节要求合入前确认。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
