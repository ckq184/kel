# THESIS-22 IM 配置单一真源：删旧配置与迁移

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                     |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                          |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                         |
| 类型          | 兼容收窄（第二真源与旧迁移）                                                                                                                                                                                                                                                                                                                                               |
| 依赖          | THESIS-19（同在 `src/index.ts` 13447 起的区域）                                                                                                                                                                                                                                                                                                                            |
| 阻塞          | 23、26、28 至 31                                                                                                                                                                                                                                                                                                                                                           |
| 可并行        | ✅ 21、24、25、27、32、33。⚠️ 20（`src/index.ts`、`src/runtime-config.ts` 不同区域）。❌ 19、23、26、28 至 31（口径见 [README 第三节](README.md#三并行关系与执行顺序)）                                                                                                                                                                                                    |
| 预计改动路径  | `src/runtime-config.ts`（旧 IM 配置段）、`src/channel-account-migration.ts`、`src/routes/channel-accounts.ts`、`src/index.ts`（`migrateSystemIMToPerUser`、`syncLegacyConfigToDefaultChannelAccount`、`migrateDataDirectories`、`autoIsolateContext` 接线）、`src/im-context-isolation.ts`、`src/web-context.ts`、`src/schemas.ts`、`tests/**`、`CLAUDE.md`、`docs/API.md` |
| 需用户决策    | **是**：D-I1、D-I2                                                                                                                                                                                                                                                                                                                                                         |
| 来源          | 方案 P3、§5；ISSUE-11 计划中"迁移后消除第二真源"未完成的部分                                                                                                                                                                                                                                                                                                               |

## 目标

渠道配置只认 `channel_accounts`（Web"渠道账号"）。旧的按用户 IM 配置文件、全局飞书配置及其向渠道账号的复制逻辑全部删除；没有界面入口的 `autoIsolateContext` 一并删除。

## 现状（`248c7cb`）

- `src/runtime-config.ts`：旧按用户 IM 配置目录与读写（:2256 起，至约 :2509）、全局飞书配置读写（约 :1669–1717）。
- `src/channel-account-migration.ts`（92 行）：把旧配置复制成默认渠道账号。
- `src/routes/channel-accounts.ts` 约 252–372：注释仍称 `/user-im` 路由存在（ISSUE-11 已删）。
- `src/index.ts`：`migrateSystemIMToPerUser`（:4116，启动时调用于 :13627）、`syncLegacyConfigToDefaultChannelAccount`（:13447）、`movePathWithFallback`/`migrateDataDirectories`（:13521 起）。
- 仍在用的读点：`ownerOpenId` 的两处读取与微信游标镜像（调查时在 `src/index.ts` 约 3447、13023、13408 一带）——这些值已存在渠道账号的密文里，要改为从渠道账号读取，不能直接删。
- `autoIsolateContext`：`src/im-context-isolation.ts`（102 行）、`src/index.ts` 两处接线；`web/src` 零引用，无路由，只能手改旧 json 开启。
- 钉死的测试：`tests/channel-account-startup-contract.test.ts`、`tests/feishu-channel-account-owner.test.ts`、`tests/wechat-account-runtime-contract.test.ts` 按名字切片读 `syncLegacyConfigToDefaultChannelAccount`；`tests/feishu-config-validation.test.ts` 是 `FeishuConfigSchema` 的唯一使用方。

## 非目标

- 不改 `channel_accounts` 表与渠道账号接口。
- 保留 `is_legacy_default` 对旧聊天 JID 的路由（存量聊天记录仍要能回到默认账号）。
- 不改多账号能力（第二轮 §8.3 非目标）。
- 不读 `data/`，不删磁盘上的旧 json 文件（合入后只是不再读取）。

## 需用户决策（领取前拍板）

| #    | 问题                                             | 选项                                                             | 建议                               |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------- |
| D-I1 | 旧 IM 配置文件                                   | ① 不再读取，相关读写、迁移与复制逻辑全删；② 保留只读迁移一个版本 | ①（前提：README 第四节的用户确认） |
| D-I2 | `autoIsolateContext`（新飞书私聊自动建独立会话） | ① 删除；② 保留并补设置界面                                       | ①                                  |

## 执行前核实

- 列出旧配置模块的全部导出与调用方；"仍在用的读点"逐个改为从渠道账号读取后再删。
- 确认启动顺序里删掉三个迁移函数后，渠道账号的加载不依赖它们先跑。

## 实现步骤（TDD）

1. **Red**：启动时不再读取旧 IM 配置路径；`ownerOpenId` 与微信游标从渠道账号读取；`autoIsolateContext` 相关符号零出现。改写三个按名字切片的契约测试，删除 `tests/feishu-config-validation.test.ts`（随 schema 删除）。
2. **Green**：删旧配置读写、迁移、复制与 `autoIsolateContext`。
3. 同步 `CLAUDE.md` §9 末段（Legacy `/api/config/user-im/*` 一句）与 `docs/API.md`。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：重启后飞书、QQ、微信三个渠道账号自动连上并能收发；设置页渠道账号列表正常；飞书新聊天的会话归属与改前一致（`autoIsolateContext` 默认未开启）。

## 风险与回滚

- 若用户仍有只存在于旧 json 里的渠道配置，合入后该渠道不会连接。README 第四节要求合入前确认。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
