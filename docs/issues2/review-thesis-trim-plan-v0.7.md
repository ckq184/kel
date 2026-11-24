# 审核报告：毕设裁减方案 v0.7 与代码的漂移、可行性与优化

> **审核对象**：[`task-thesis-trim-plan.md`](task-thesis-trim-plan.md) 草案 v0.7。
> **代码基线**：main `d6e04aa`，即方案声明的行号基准，因此行号可以直接逐条比对。
> **审核日期**：2026-11-24。
> **方法**：对方案里的 `文件:行号`、函数名、路由、行数、测试文件和调用点逐条核对，覆盖 §4 至 §11 的锚点约 150 处。对"只在 X 处被调用""零引用""官方专用"这类结论，用 `git grep -w` 重新查一遍调用方，范围包含 `tests/`。没有读写 `data/`。
> **处置**：下面的漂移和优化都已回写进方案 v0.8（见方案 §15），拆出的任务见 [任务池 README](README.md)。

---

## 一、总体结论

- **行号基准可信。** 抽查的锚点绝大多数精确命中，包括函数定义行、路由行、Schema 枚举行、测试行号和文件行数，说明方案确实是在 `d6e04aa` 上测的。
- **有 7 处实质漂移，不改会导致执行出错**（第二节 S1 至 S7）。其中 S1、S2、S4、S7 会改变删除范围或风险判断。
- **有 8 处数字、措辞或清单上的小漂移**（第三节），不影响结论，已顺手更正。
- **11 个执行时核实项可以提前结案**（第四节），其中 V-C1 的结论与方案相反。
- **可行性**：6 个待执行专题都可行。需要调整方案的有 3 处：§6 停记账的范围、§5 凭据链的删除分类、§8 E2 的层级划分（第五节）。

## 二、实质漂移（必须改）

### S1　§6 写账本的调用点不是两处，飞书费用一行来自定价层

- **方案原文**：§6.3 说记账层"调用点两处：`src/index.ts:1820-1822` 的 `recordUsageEvent` 包装，`src/task-scheduler.ts:1208` 的 `recordIsolatedTaskUsage`"。§6.9 和 V-C1 认为飞书卡片的费用一行"取自 `usage` 流事件自带的费用，不属于模型单价功能"。
- **实际情况**：
  - `writeUsageRecords`（`src/index.ts:1792` 定义，:1820-1822 是函数体）在 `src/index.ts` 里有 **4 处调用**：:6090、:6410、:10041、:10190。另有 `src/task-scheduler.ts:1208` 一处，共 5 处。
  - 其中 :6090 和 :10041 是"推送前先计价"：拿账本经 Kaboo 计价算出的 `providerEstimatedCostUSD` 覆盖流事件的 `usage.costUSD`，然后才推给 Web 和飞书（代码注释写着"与账本相同的 Kaboo 计价入口"）。
  - 飞书卡片的 `formatFeishuUsageNote`（`src/feishu-usage-display.ts:67`）只在 `costUSD > 0` 时显示费用，而这个 `costUSD` 已经被定价层覆盖过。Pi 给第三方端点注册的单价全是 0（`pi-provider.ts:205` 自定义分支 `cost: { input: 0, … }`），所以费用一行目前完全靠定价层算出来。
- **影响**：
  1. L2 的删除范围要覆盖全部 5 处调用。
  2. V-C1 的结论反过来了：定价下线后，飞书费用一行会**自然消失**。D-C3 的选项 ①"保持现状"已经不可能原样保持，选项需要重写（见 O5）。
  3. 气泡回写的 `costUSD` 同样来自账本。

### S2　§5.4 C2 的 `oauthAccount` 剥离和残留凭据清理属于第三方分支

- **方案原文**：C2 要删除 `src/container-runner.ts` 的 `.credentials.json` 写入（:1281 起、:2401 起）和"`oauthAccount` 剥离（:2355-2384）"。
- **实际情况**：:2355-2384 的剥离代码位于 `if (hostEnv['ANTHROPIC_BASE_URL'])` 也就是**第三方分支**内部，作用是防止宿主机 `~/.claude.json` 里的 OAuth 登录态劫持第三方请求。:1294-1303 和 :2388-2398 删除残留 `.credentials.json` 的代码同样在第三方分支里。容器模式的 `getContainerClaudeJsonPath`（:150-180）也会剥离 `oauthAccount`，原因相同。
- **影响**：这几段是保护第三方路径的代码，不是官方专用代码，不能按"官方分支"删掉。真正官方专用的只有两段写入：:1281-1292 和 :2401-2411，条件都是 `mergedConfig.claudeOAuthCredentials`。剥离和清理这几段改列入"不动清单"。如果日后想确认 Pi 运行时是否还读 `.claude.json`，需要另立核实项，不属于本专题。

### S3　§5 "四处已配置判断"里有一处不是判断，另一处删掉会失效

- **`src/routes/groups.ts:2565-2566` 不是"已配置判断"。** 它是工作区"容器环境变量"PUT 路由（`ContainerEnvPanel` 的后端）对 `claudeCodeOauthToken` 的写入，属于 D-3 的范围。
- **`src/routes/bug-report.ts:77-81` 只认官方凭据。** 它只看 `anthropicApiKey || claudeCodeOauthToken || claudeOAuthCredentials`，所以现在只配了第三方（Base URL + Auth Token）的用户已经被判为"Claude 不可用"（存量缺陷）。如果只是"去掉官方凭据"，它会恒为 false。必须改写为第三方判定，不能只删。
- **`anthropicApiKey` 不是官方专用字段。** runner 的第三方分支用 `input.apiKey?.trim() || input.authToken?.trim()` 作为注册密钥（`pi-provider.ts:180`），也就是说第三方可以走 x-api-key 模式。第三方表单不暴露这个字段，但环境变量回退和存量数据会用到。§5.3 的字段分类要改成：官方专用只有 `claudeCodeOauthToken` 和 `claudeOAuthCredentials`，`anthropicApiKey` 是共用字段。`src/routes/auth.ts:107-114` 的 `hasOfficial` 去掉之后，不能误伤"Base URL + API Key"的第三方配置。
- `src/agent-profile-generator.ts:29-37` 已经包含 `anthropicAuthToken`，去掉两个官方字段后仍然可用。

### S4　§8 E2"去角色与权限"只算了权限，漏掉了角色

- **方案原文**：§8.4 和 §8.5 只统计了 `requirePermission` 及其派生中间件（约 58 行）和前端 25 个文件的权限门，E2 估算约 450 行。
- **实际情况**：
  - 中间件实际是 4 个由 `requirePermission` 派生，另有 1 个 `adminRoleMiddleware` 按**角色**判断，在 `src/routes/config.ts` 挂载 5 处，不是由权限派生的。全仓引用 55 行。
  - 后端有 **86 处** `role === 'admin'` 或 `role !== 'admin'` 判断，分布在 `src/index.ts`（21）、`src/routes/groups.ts`（20）、`src/routes/tasks.ts`（18）、`src/ipc/task-ops.ts`（15）、`src/ipc/task-dispatch.ts`（12）、`src/container-runner.ts`（12）、`src/routes/monitor.ts`（9）等文件。
  - "管理员主工作区"相关标识（`isAdminHome`、`is_admin_home` 等）有 69 处引用。主机执行、脚本任务、管理员纯宿主机模式都按角色判定。
- **影响**："去角色"的实际规模远超 450 行，而且与调度、IPC、执行模式纠缠在一起。建议把 E2 拆成两层：**E2a 去权限**（权限名、权限模板、`requirePermission` 及其 4 个派生中间件、`manage_group_env` 判断、前端 `canManage*` 与 `requiredPermission`）和 **E2b 去角色**。推荐只做 E2a：保留 `role` 列和 admin 语义，唯一账号恒为 admin，角色判断恒为真。这和方案不做 E3 的理由相同。

### S5　§11.5 D-H1 的前提不成立

- `BalancingConfig` 不是零引用：同文件的 `ProvidersListResponse.balancing` 用到它，而 `ProvidersListResponse` 被 `ClaudeProviderSection.tsx:49` 使用。它只是没有被其他文件 import，`export` 多余而已。
- `withAgentContextSource` 被 `tests/frontend-agent-product-contract.test.ts` 专门测试。按[审查口径](../issues/README.md)，有专门测试的代码属于"意图信号"，默认保留。
- **处置**：撤销 D-H1，这两项不是死代码。

### S6　§5.10 测试清单有遗漏，也有不该删的

- **遗漏**：`tests/agent-runner-provider-runtime.test.ts` 覆盖的正是 C1 要删的 `provider-runtime.ts:50-55` official 回退，应列入。
- **会被连带打红**：`tests/no-duplicate-helpers-contract.test.ts:380` 断言"`OAuthUsageBucket` 全仓恰好声明一次"。A3 删除这个类型后计数变成 0，用例必失败，需要同步改。
- **不该删**：`tests/agent-runner-utils-redact.test.ts` 测的是通用 OAuth Bearer token 脱敏，`tests/githooks-contract.test.ts:191` 是密钥检测钩子的样例字符串，两者都与官方供应商无关，不属于本专题。

### S7　§8 D-E5 默认选项下，存量的其他账号仍能登录

- **方案原文**：D-E5 ①"原样留在库里，唯一账号看不到它们"。
- **实际情况**：登录只检查 `user.status !== 'active'`（`src/routes/auth.ts:284`），不检查是不是"唯一账号"。选 ① 时，这些账号自己仍然可以用原密码登录，登录后看到的是它们自己名下的工作区。用户管理界面在 E1 下线之后，就再也没有界面能禁用它们。
- **影响**：
  1. "单账号"在存量数据上并不成立。D-E5 的说明要写清楚：要阻止这些账号登录，只能选 ②，或者在 E1 之前用旧版界面把它们设为禁用。
  2. E2a 去掉权限中间件时，挂载点不能简单换成"只要已登录"，否则存量的普通成员账号会拿到系统配置权限。新增决策 D-E7（THESIS-11），建议换成 `adminRoleMiddleware`。

## 三、数字与措辞的小漂移（已更正）

| #   | 位置            | 方案原文                                                     | 实际                                                                                                                                                                                                                                                  |
| --- | --------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m1  | §8.6 D-E4       | `logAuthEvent` 调用点 `auth.ts` 11 处、`config.ts` 3 处      | 原数字含 import 行。实际调用 `auth.ts` 10 处、`config.ts` 2 处，`admin.ts` 另有 16 处随文件删除。`config.ts` 的 2 处记录的是 `system_settings_updated` 和 `host_integration_updated`                                                                  |
| m2  | §10.4           | `start-desktop.command`（66）；启动脚本合计 88               | 58 行（66 是 `restart-dev.command` 的行数），合计 80                                                                                                                                                                                                  |
| m3  | §10.4           | `allowScripts` 里的两条 electron 条目                        | 相关条目有四条：`electron@39.8.10`、`electron-winstaller@5.4.0`、`esbuild@0.25.12`、`esbuild@0.28.2`。`esbuild@0.28.2` 是否被其他依赖间接需要，归入 V-G1                                                                                              |
| m4  | §10.4           | `web/vite.config.ts:6` 的注释（暗示含 electron）             | 注释写的是"两仓桌面端可同时运行"，不含 electron 字样，只需改措辞                                                                                                                                                                                      |
| m5  | §7.4            | 注册配置读写 `src/runtime-config.ts:2194-2260`               | 2194-2252。2253 行之后是 `buildContainerEnvLines`                                                                                                                                                                                                     |
| m6  | §5.2、§5.6      | 不删"V2/V3 到 V4"的迁移；不动清单列三个函数                  | 迁移链是 V2/V3→V4→V5，V4→V5 的入口 `readStoredStateV4`（:1223）也要列入不动清单                                                                                                                                                                       |
| m7  | §8.4            | `requirePermission` 及"由它派生的五个中间件"                 | 4 个派生 + 1 个 `adminRoleMiddleware`（见 S4）                                                                                                                                                                                                        |
| m8  | §6、§8 文档同步 | 只列了 `docs/API.md`、`docs/ACL-MATRIX.md`、产品定位三份文档 | 漏了 `CLAUDE.md` §3.2：路由表的 `/usage`、`/users` 行，`/monitor` 行的权限说明，以及兼容重定向列表里的 `usage`→`/usage`（对应 `SettingsPage.tsx:68` 的 `LEGACY_TAB_ROUTES`）；§6、§11 也漏了前端 `web/src/stores/chat.ts` 实时拼 `token_usage` 的两处 |

## 四、可以提前结案的核实项

| 核实项     | 结论                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-1        | **结案。** 两个调用点都只在有 OAuth 凭据时触发：:1126 判断 `validation.data.claudeOAuthCredentials && updated.enabled`，:1546 是 OAuth 回调里的 `if (oauthCredentials)`。`closeAllActiveForCredentialRefresh` 全仓只有这两个调用方                                  |
| V-5        | **部分结案。** `ContainerEnvPanel` 不提供官方凭据的输入框，保存时把 `anthropicApiKey`、`claudeCodeOauthToken` 固定发空串，但后端 PUT 路由仍然接受这两个字段。`mergeClaudeEnvConfig` 的规则是"工作区值非空才覆盖"，所以全局是第三方时，工作区无法切回官方路径        |
| V-7        | **结案。** 见 S6                                                                                                                                                                                                                                                    |
| V-C1       | **结案，结论与方案相反。** 见 S1                                                                                                                                                                                                                                    |
| V-C5       | **部分结案。** Pi runner 在 `publishResult` 里每个 turn 只发一次 `usage`（有 `completionPublished` 保护），并带 `eventId`。一条可见回复会不会跨多个 turn，仍需核实                                                                                                  |
| V-C6、V-F1 | **结案。** 引用 `usage_records` 的预处理语句是 `stmts().insertUsageInsert`（`src/db.ts:176`），唯一调用方是 `recordUsageEventBatch`（:1489），停记账后没有调用                                                                                                      |
| V-D3、V-E3 | **结案。** 以 `/api/admin` 为夹具的测试只有 `tests/routes-system-settings-security.test.ts` 的三处。没有任何测试调用 `/api/auth/register`。路由测试的身份由 `tests/helpers/route-test-user.ts` 通过环境变量注入，不经过注册。`src/routes/admin.ts` 也没有专门的测试 |
| V-C4       | **结案。** `tests/task-continuation-scheduler.test.ts:221` 的"model pricing table"只是描述 schema 版本历史的注释，不是代码路径                                                                                                                                      |
| V-E8       | **结案。** 见 m1。停写之后，系统设置和宿主机集成的变更也不再留痕                                                                                                                                                                                                    |
| V-F5       | **确认。** `CLAUDE.md` §7 仍列着已在 v77 删除的 `usage_daily_summary`                                                                                                                                                                                               |
| V-G2       | **结案。** `CLAUDE.md` 和 `docs/API.md` 没有桌面端描述；README 有 26 行、`AGENTS.md` 有 3 行（:48-50）提到                                                                                                                                                          |

## 五、可行性评估

| 专题            | 可行性               | 说明                                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5 供应商裁官方 | 可行，需修正分类     | 按 S2、S3 修正后，凭据链的风险明显下降。真正的阻塞点是 D-2（没有 Base URL 时怎么办），它决定了运行时收口怎么写                                                                                                                                                                                                                                 |
| §6 用量与单价   | 可行，T2 比原估大    | 要删 5 个调用点（S1）。另外，气泡回写目前没有"按消息读回 `token_usage`"的单条查询，`updateLatestMessageTokenUsage` 只能整值覆盖。在"本任务不改 `src/db.ts`"的约束下，只能在 `src/index.ts` 里按消息 ID 在内存累加。前端 `web/src/stores/chat.ts` 会实时用流事件拼 `token_usage`（:2340、:2632），也要同步收口，这一点方案 §6 和 §11 都没有列出 |
| §7 管理后台     | 不单独执行           | 用户已裁决 §8"只做个人用户"，§7 被完全覆盖。只有 D-D2（两项登录限流设置挪到哪里）还需要决定，并入 §8 的第一个包                                                                                                                                                                                                                                |
| §8 个人用户     | E1 可行；E2 需拆分   | 见 S4。推荐 E2a。E1 的测试面很小：`/api/admin` 和注册接口几乎没有测试（V-E3）                                                                                                                                                                                                                                                                  |
| §9 删表         | 可行                 | v72、v75、v76、v77、v78 都有同类先例。§8 下线注册后，`registerUserWithoutInvite`（`src/db.ts:9958`）会变成孤儿函数，它不属于五张表，但应在同一次 `src/db.ts` 清理里删掉                                                                                                                                                                        |
| §10 桌面端      | 可行，独立，风险最低 | 网页客户端没有任何 `ckqclawDesktop` 调用，"Desktop:" 只是布局注释。建议最先做，顺带让 V-E7 失去意义                                                                                                                                                                                                                                            |
| §11 前端清扫    | 规则可行，检查靠人工 | "从 `main.tsx` 出发没有不可达文件"目前只能人工判断，建议把它做成一个可重复运行的契约测试（O7）                                                                                                                                                                                                                                                 |

## 六、优化建议（已写入 v0.8 和任务池）

- **O1　执行顺序。** 桌面端最先做，它零依赖，而且能顺带消除 V-E7。§6 和 §8 必须先于 §9。§5、§6、§8 共用一批热点文件：`src/routes/config.ts`、`src/routes/auth.ts`、`src/web.ts`、`web/src/App.tsx`、`SettingsPage.tsx`、`SettingsNav.tsx`、`nav-items.ts`、`stores/auth.ts`、`settings/types.ts`。并行会话会在这些文件上冲突，建议按波次串行，具体见任务池 README 第三节。
- **O2　文档随包同步。** 取消各专题单独的"文档同步"子任务（原 T5）。每个任务包同步自己涉及的 `docs/API.md` 和 `docs/ACL-MATRIX.md` 行，完成标准里包含 `npm run docs:check`。只有"多用户改为个人"的产品定位改写单独成一个包，因为它依赖 §8 的最终状态。
- **O3　§7 不单独立项。** D-D2 并入 §8 的 E1 包。
- **O4　E2 拆成 E2a 和 E2b。** 推荐只做 E2a（见 S4），D-E1 增加这个选项。
- **O5　重写 D-C3 的选项。** 改为：① 接受飞书费用一行随定价下线自然消失（零代码；第三方端点的上游费用本来就是 0）；② 飞书卡片同步改为只显示耗时与轮数。同时，气泡回写只需要累加 `durationMs` 和 `numTurns`，不必在宿主重建完整的 token 明细。
- **O6　修正 §5 的删除分类。** 见 S2、S3：剥离与清理代码列入不动清单；`bug-report` 的判断改写；`anthropicApiKey` 按共用字段处理。
- **O7　可选：前端可达性契约测试。** 把 §11.4 第 1 条做成 vitest 契约测试，从 `web/src/main.tsx` 沿 import 关系遍历，断言没有不可达的非测试模块。约百行，各个前端裁剪包可以直接复用，代替人工核对。这是新增的测试工具，按约束需要用户批准后才做。
- **O8　锚点写法。** issue 里统一写"符号名 + 基线行号"，执行时以符号名为准，与方案的行号规则一致。

## 七、仍需用户拍板的决策（汇总）

拆分后，每个决策都挂在对应的 issue 上，领取前拍板：

| 决策            | 所在 issue           | 本次审核的建议                                                                   |
| --------------- | -------------------- | -------------------------------------------------------------------------------- |
| D-1、D-4        | THESIS-02            | 维持方案默认：① 用户先在界面删除官方供应商；① 存储层不收窄                       |
| D-2             | THESIS-04            | ② 宿主要求必须有 Base URL，runner 遇到 official 直接报错                         |
| D-3             | THESIS-04            | ① 只从后端 Schema 和 `ContainerEnvConfig` 中摘掉 `claudeCodeOauthToken`          |
| D-C3（已重写）  | THESIS-09            | ①，零代码                                                                        |
| D-D2            | THESIS-10            | ① 挪到"执行与容量"页                                                             |
| D-E1（新增 ②a） | THESIS-11            | ②a 只去权限                                                                      |
| D-E7（新增）    | THESIS-11            | ① 原权限中间件挂载点换成 `adminRoleMiddleware`（见 S7）                          |
| D-E2、D-E3      | THESIS-10、THESIS-12 | ① 保留登录；① 去掉强制改密                                                       |
| D-E5、D-E6      | THESIS-10、THESIS-13 | 默认值                                                                           |
| D-F1 至 D-F3    | THESIS-14            | ① 一版迁移；① 只删表；D-F3 必须在 THESIS-06 之前问清楚，否则用量页下线后无法导出 |
| D-G1 至 D-G3    | THESIS-01            | 默认值                                                                           |
| O7 是否采纳     | THESIS-15            | 建议采纳，并排在前端裁剪包之前                                                   |
