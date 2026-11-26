# 任务 thesis-trim：毕设裁减方案（活文档）

> **文件定位**：本仓库（本科毕设精简版）的裁减总方案与裁决台账。活文档——裁决有变、范围调整、核实出新事实，都直接改本文并在 §15 变更记录登记。执行某一项裁减时另按 `docs/workflow.md` 立项（任务 plan + `.gatescope.json`），本文只定范围、裁决与约束，不写实现。
> **当前状态**：草案 v0.9（2026-11-25，第三轮重裁见 §15）。已按代码审核修正漂移（[审核报告](review-thesis-trim-plan-v0.7.md)），各专题已拆成独立任务包（[任务池 README](README.md)）；尚未立项，未改任何代码。待执行的裁减有六项：§5 供应商配置裁掉官方、§6 用量分析与模型单价、§7 管理后台裁两项（已被 §8 覆盖，不单独立项）、§8 只做个人用户、§9 清理用不到的数据表（排在最后）、§10 桌面端。§11 是跨专题的前端裁减清单与清扫规则。
> **行号基准**：本文 `文件:行号` 均为 main `d6e04aa` 的原始树。后续提交后行号必然漂移，执行时以符号名（函数名、路由路径、import）为锚点 grep 重新定位，禁止盲信行号。
> **配套文档**：`docs/task-thesis-lite-plan.md`（第一轮方案，裁决在其 §2）、`docs/task-thesis-lite-delivery.md`（第一轮交付与偏差记录）、`docs/workflow.md`、`docs/constitution.md`。
> **新会话必读**：提出任何裁减建议之前先读 §2 裁决台账。已定项不重新讨论；要改结论，由用户拍板后在 §15 登记。

---

## 1. 背景与结论

- **代码量不是短板。** 业务源码 18.5 万行（§12）。国内对毕业设计代码量没有全国统一标准，行数门槛写在各学院细则里；检索到的公开例子从"不少于 500 行语句"到"代码不少于 3000 行"都有（原文未核对，见 §14）。按最严的例子算也是它的 60 倍。
- **真正的风险有三个。** ① 答辩可解释性：评委问到没读过的模块就答不上来。② 贡献边界：Agent 的核心循环依赖 Pi Agent SDK，仓库自己写的是工作台、渠道、调度这一层，论文要写清楚。③ 归属与声明：仓库若公开，学校代码查重会查到与自己的仓库重复，需保留提交记录；学院若要求声明 AI 工具使用，按规定填。
- **第一轮已经裁过一次。** 2026-11-17 的 thesis-lite 七批删掉了评测、auto-memory、billing、钉钉等模块，净删 43,973 行（交付档 §1）。本轮不追求把代码裁到所谓"本科体量"，只裁两类东西：整模块的外围功能，和保留模块内部用不上的分支。论文与演示以第一轮的"保留（答辩章节映射）"为基础，扣除本轮改裁的部分（§2）。
- **本轮结论。** Docker 模式保留（§4）；供应商配置裁掉官方、只保留第三方（§5）；用量分析与模型单价裁掉，聊天气泡只保留耗时（§6）；管理后台裁掉注册策略与用户与访问，只保留运行状态（§7）；只做个人用户，裁减多用户认证与权限矩阵（§8）；用不到的数据表一并删除（§9）；桌面端裁掉（§10）；被裁功能的前端代码一并裁净（§11）；其余模块沿用第一轮裁决（§2）。其中用量、管理后台的两项、多用户体系、桌面端取代了第一轮的保留结论，"数据库不动"的安全线也被 §9 取代，取代关系记在 §2。

## 2. 裁决台账

| #   | 裁决项                                   | 第一轮（2026-11-17）                                   | 本轮评估与裁决（2026-11-24）                                                    | 现行结论                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Docker 容器执行模式                      | 保留清单："容器隔离 Agent 运行时（核心亮点）"          | 评估为"可裁"；用户裁决不删除                                                    | **保留**（§4）                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | 供应商配置的官方 Claude                  | 未涉及                                                 | 用户裁决：裁掉官方，只保留第三方                                                | **已裁**（§5，THESIS-02 `302514e`、03 `decc279`、04 `8886aa3`、05 `2ebade8`）                                                                                                                                                                                                                                                                                                             |
| 3   | 渠道范围                                 | 裁决 1：保留 Web + 飞书 + QQ + 微信，砍钉钉（已执行）  | 评估建议裁 QQ、微信                                                             | 保留三渠道                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | 用量分析与模型单价                       | 裁决 2：砍 billing，保留用量统计与自定义定价（已执行） | 评估建议"可裁"；**用户改裁**：先裁用量分析，再裁模型单价；聊天气泡只保留耗时    | **已裁**（§6，THESIS-06 `cfc0343`、07 `217c12c`、08 `7ede632`、09 `f94d719`；合入 main `8866a8f`）；整体取代第一轮裁决 2                                                                                                                                                                                                                                                                  |
| 5   | 运行状态 MonitorPage                     | 裁决 3：保留                                           | 评估建议"可裁"；**用户裁决**：管理后台只保留运行状态                            | **保留**（§7）                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | 浏览器操控                               | 裁决 4：保留                                           | 未评估                                                                          | 保留                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | Electron 桌面端                          | 裁决 5：保留                                           | 评估建议"可裁"；**用户改裁**，条件是删掉后仍能访问本地文件（已核实成立，§10.1） | **已裁**（§10，THESIS-01，提交 `e78869d`）；取代第一轮裁决 5                                                                                                                                                                                                                                                                                                                              |
| 8   | 能力扩展（Skills / MCP / Plugins）       | 裁决 6：保留（核心深耦合，且是好章节）                 | 评估建议"看选题"                                                                | 保留                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | browse / bug-report                      | 前端清扫轮裁决：保留不删                               | 未评估                                                                          | 保留；**Bug 报告于第三轮改裁为裁掉**（[personal-slim](../issues4/task-personal-slim-plan.md) P4，THESIS-24），browse 保留                                                                                                                                                                                                                                                                 |
| 10  | 用户与访问（用户列表、邀请码、审计）     | 保留清单                                               | 评估建议"可裁"；**用户改裁**；随后裁决只做个人用户                              | **并入 §8**（THESIS-10）                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | 注册策略                                 | 保留清单（随多用户）                                   | **用户改裁**；随后裁决只做个人用户                                              | **并入 §8**（THESIS-10）                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | 多用户认证与权限体系（账号、角色、权限） | 保留清单："多用户认证与权限矩阵"，列为答辩章节         | **用户改裁：只做个人用户**                                                      | **已裁**（§8，THESIS-10 `cd4d7a7`、11 `bdddede`、12 `54ad6b4`、13 `bb79c95`）；IM 侧访问控制保留；**第三轮改裁去掉角色**（[personal-slim](../issues4/task-personal-slim-plan.md) P1，THESIS-19 至 21），数据归属仍保留；**v1.1 再改裁：只保留管理员一个角色，数据归属与按用户作用域一并裁减**（[personal-slim](../issues4/task-personal-slim-plan.md) P1、P2，THESIS-19 至 21、34 至 37） |
| 13  | 定时任务调度、工作区记忆库、Agent 人设   | 保留清单（未单列裁决）                                 | 评估建议"可裁 / 看选题"                                                         | 保留；要重议须用户另行裁决；**第三轮改裁裁掉 Agent 档案生成与润色**（[personal-slim](../issues4/task-personal-slim-plan.md) P5，THESIS-25），对话式 Builder 与其余保留                                                                                                                                                                                                                    |
| 14  | IM 消息管道与可靠性存储                  | 保留清单（三渠道基建）                                 | 评估即不建议动                                                                  | 不动                                                                                                                                                                                                                                                                                                                                                                                      |
| 15  | 旧格式迁移与兼容代码                     | 第一轮安全线：`src/db.ts` 与迁移链不动                 | 评估不建议动                                                                    | 不动；迁移链不重写，§5 的存储格式同理；**第三轮收窄**：迁移链仍不动，旧配置迁移、兼容别名、退役设置键与占位路由可删（[personal-slim](../issues4/task-personal-slim-plan.md) P3，THESIS-22、23）                                                                                                                                                                                           |
| 16  | 用不到的数据表                           | 第一轮安全线：`src/db.ts` 与迁移链不动                 | **用户裁决**：自定义单价表一并删除，所有用不到的表一并裁减                      | **已完成**（§9，THESIS-14：实现 `b62bbd3`、审查处置 `721cbfe`；v79 一版迁移删除五表）                                                                                                                                                                                                                                                                                                     |
| 17  | 被裁功能的前端代码                       | 第一轮裁后有前端清扫轮                                 | **用户裁决**：需要裁减的功能，涉及的前端代码也一并裁减                          | 随各专题执行，清单见 §11                                                                                                                                                                                                                                                                                                                                                                  |

第一轮的六项裁决在原文中标注"已定，不再讨论"。本轮评估起初没有读到第一轮文档，提了几条与之冲突的建议。其中用量分析、用户与访问、注册策略、多用户体系、桌面端五项，用户随后改裁，以本轮裁决为准，并取代第一轮的对应结论；其余冲突项仍以第一轮裁决为准，清单见 §13。

## 3. 裁剪原则（硬约束）

1. **一模块一任务。** 立项 → TDD 实现 → `npm run verify` 六步全绿 → `node scripts/check-scope.mjs` 通过 → 一任务一提交；出问题整任务 revert。
2. **表结构只在 §9 里动。** 各裁剪专题本身不改表结构、不删表；全部裁完后，由 §9 用一版前向迁移统一删除用不到的表。这是 2026-11-24 的用户裁决，取代第一轮"`src/db.ts` 一字不动"的安全线。迁移链本身不重写。
3. **删前交叉核实。** `git grep -w` 查调用方，范围含 `tests/` 与 `docs/`；"掉线逻辑"与"意图信号"先请用户决定，口径见 `docs/issues/README.md`。
4. **不猜测。** 不确定的事实标 TODO、执行时核实；发现与方案预期不符即停下报告，不擅自扩范围。
5. **`data/` 是敏感区。** 代理不读写；存量数据怎么处置由用户操作或明确批准。
6. **分支与提交。** 在独立任务分支上做，合入 main 与否由用户决定；代理不推送。
7. **不绕门禁。** 禁止 `git commit --no-verify`，禁止跳过 verify 变通。
8. **前端一并裁净。** 每裁一个功能，它的前端代码同步裁掉，不留孤儿文件、死导出和无人使用的依赖。清单与检查项见 §11。

## 4. 专题 A：Docker 模式

**裁决：保留，不删除（2026-11-24，用户）。** 第一轮把"容器隔离 Agent 运行时"列为核心亮点，本轮维持。

### 4.1 评估结论（备查，不必重复评估）

- **Docker 是两种执行模式之一。** 容器模式 `runContainerAgent`（`src/container-runner.ts:1524`，426 行）用 `docker run` 启动 Agent；主机模式 `runHostAgent`（同文件 :2053，747 行）把 Agent 作为本机 Node 进程跑在工作区目录。两者在 `src/index.ts:8276-8350` 按 `executionMode` 分派。
- **技术上可裁。** 主机模式是完整的平行实现。若日后重议，删除范围约为：`container/` 下镜像文件 8 个共 1,612 行、`src/container-runner.ts` 容器分支约 940 行、其余文件的 Docker 分支约 500 行、`src/container-image-failure.ts` 81 行、镜像发布工作流与冒烟脚本 304 行、6 个测试文件 1,559 行，合计约 5,000 行。
- **裁掉的代价。** ① 没有沙箱：主机模式下 Agent 以启动服务的账号权限运行，shell 不受工作区目录限制。② 网页终端没了：终端靠 `docker exec` 实现。③ 主机执行仅管理员可用（`canExecuteOnHost`，`src/host-execution-policy.ts`），普通成员没有可用的执行方式。④ 少一个设计亮点。

### 4.2 保留后的注意事项（环境事项，不涉及代码改动）

- **演示机需要 Docker。** `make dev` 与 `make start` 都先调用 `_ensure-docker-image`：只要机器上有 `docker` 命令就执行 `docker pull ckq184/ckqclaw-agent:latest`，拉取失败会中断启动。第一轮冒烟时已遇到过（交付档 §5）。
- **没有 Docker 时的应急开关。** 设置页"管理员纯宿主机模式"（系统设置 `adminHostOnlyMode`，环境变量 `ADMIN_HOST_ONLY_MODE` 给初始值）：管理员的工作区和定时任务迁到主机；所有工作区都是主机模式时，启动检查 `ensureDockerRunning`（`src/index.ts:11825`）直接跳过。局限：普通成员仍走 Docker，主机工作区没有网页终端，Makefile 的拉镜像步骤不受该开关影响。
- **未裁决。** 要不要为演示机预先拉好镜像或调整 Makefile，属新决策，列入 §14。

## 5. 专题 B：供应商配置——裁掉官方，只保留第三方

**裁决：裁（2026-11-24，用户）。状态：待立项。** 本节可直接作为立项 plan 的底稿。

### 5.1 目标

把供应商配置里的"官方 Claude"整条路径裁掉，只保留第三方端点。裁剪后：

- 界面上不再有"官方"选项；
- 接口不再接受官方型供应商，OAuth 路由下线；
- 运行时只有一条路径：把第三方端点注册为独立 provider；
- 现有第三方供应商无需迁移即可继续使用。

### 5.2 非目标

- 不改 `claude-provider.json` 的存储格式（保持 version 5），不删 V2/V3→V4→V5 的旧格式迁移代码。
- 不支持新的协议。"第三方"在本仓库仅指 Anthropic Messages 协议兼容端点（runner 注册时 `api` 写死为 `anthropic-messages`），不包括 OpenAI 兼容接口。论文里应写成"Anthropic 协议兼容的多端点接入"，不要写成"多供应商"。
- 不改第三方表单与 runner 的第三方注册逻辑。
- 不动 Docker 模式、数据库、IM 渠道。

### 5.3 关键事实（d6e04aa）

- **数据模型。** `UnifiedProvider.type` 取 `'official'` 或 `'third_party'`（`src/runtime-config.ts:418`）。官方专用字段：`claudeCodeOauthToken`、`claudeOAuthCredentials`；第三方字段：`anthropicBaseUrl`、`anthropicAuthToken`、`anthropicModel`、`contextWindow`、`customEnv`。`anthropicApiKey` 是共用字段（v0.8 更正）：第三方表单不暴露它，但 runner 第三方分支以 `apiKey || authToken` 作为注册密钥（`pi-provider.ts:180`），环境变量回退和存量数据也会用到，不能按官方字段删除。
- **运行时契约。** 宿主与 runner 之间用 `endpointKind: 'official' | 'custom'`，由"有无 Base URL"推导（`src/runtime-config.ts:2264`）。`resolvePiProvider`（`container/agent-runner/src/runtime/pi/pi-provider.ts:131`）的官方分支用 Pi 内置的 anthropic 模型目录；第三方分支注册独立的 `ckqclaw-anthropic` provider，并把子代理固定在父模型上。
- **默认值。** 设置页供应商编辑器默认 `third_party`（`web/src/components/settings/ProviderEditor.tsx:94`）；首次启动引导页默认 `official`（`web/src/pages/SetupProvidersPage.tsx:46`）。
- **无供应商时的回退。** `defaultsFromEnv`（`src/runtime-config.ts:1681`）读环境变量 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_MODEL`。
- **路由。** 配置路由挂载在 `/api/config`（`src/web.ts:222`），供应商与 OAuth 路由族在 `src/routes/config.ts:747-1640`。
- **按 `type` 取值分支的代码**只出现在 `src/routes/config.ts`、`src/schemas.ts`、`src/runtime-config.ts` 和前端表单里；上下文窗口声明、自定义请求头、自定义环境变量、供应商池回退、Agent 绑定模型都不依赖官方分支。

### 5.4 删除范围（估算，执行时以核实为准）

| #    | 部分                                   | 锚点（d6e04aa）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 行数（估） |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| A1   | 供应商编辑器的官方模式                 | `web/src/components/settings/ProviderEditor.tsx`：类型切换（:545-600）、官方模式块（:606-804，含 oauth / setup_token / api_key 三个认证页）、官方模型选择（:970-992）、OAuth 流程（:265-311）、保存时的官方凭据分支（:380 起、:465 起）                                                                                                                                                                                                                                                                                              | 约 400     |
| A2   | 引导页的"官方渠道"分支                 | `web/src/pages/SetupProvidersPage.tsx`：状态（:46-58）、官方创建（:206-258）、渠道切换（:372-390）、官方表单（:394 起，三个认证页 :433、:501、:543）                                                                                                                                                                                                                                                                                                                                                                                 | 约 300     |
| A3   | 订阅用量条                             | `web/src/components/settings/UsageBars.tsx`（整文件 122 行）、`ProviderList.tsx:343` 的挂载、`web/src/components/settings/types.ts` 中的 `CachedOAuthUsage`、`OAuthUsageBucket`、`OAuthUsageResponse`                                                                                                                                                                                                                                                                                                                                | 约 170     |
| B1   | 后端 OAuth 路由、用量查询和校验        | `src/routes/config.ts`：`oauthFlows`（:657）、`fetchOAuthUsage`（:683）、`/claude/providers/:id/usage`（:1328）、`/claude/oauth/start`（:1398）、`/claude/oauth/callback`（:1439）；`src/schemas.ts:781` 的 `ClaudeOAuthCredentialsSchema`                                                                                                                                                                                                                                                                                           | 约 350     |
| B2   | 凭据写入和会话凭据刷新                 | `src/runtime-config.ts`：`writeCredentialsFile`（:2312）、`updateAllSessionCredentials`（:2367），以及 `createProvider`、`updateProviderSecrets`、`toPublicProvider`、`buildClaudeEnvLines`、`mergeClaudeEnvConfig` 里的 OAuth 分支；`src/group-queue.ts:1934` 的 `closeAllActiveForCredentialRefresh`                                                                                                                                                                                                                               | 约 300     |
| C1   | Runner 官方分支                        | `pi-provider.ts` 的官方分支（:152-168、:213-223）与 `getModel` 兼容导入（:2）；`container/agent-runner/src/provider-runtime.ts` 的 official 回退（:50-55）                                                                                                                                                                                                                                                                                                                                                                           | 约 60      |
| C2   | `.credentials.json` 写入与"已配置"判断 | `src/container-runner.ts` 的两段 `.credentials.json` 写入（:1281-1292、:2401-2411，条件都是 `claudeOAuthCredentials`）；三处判断：`src/routes/auth.ts:107-114` 去掉官方凭据，但不能误伤"Base URL + API Key"的第三方配置；`src/routes/bug-report.ts:77-81` **改写**为第三方判定（它现在只认官方凭据，只删不改会恒为 false）；`src/agent-profile-generator.ts:34-35` 去掉两个官方字段。`oauthAccount` 剥离和残留凭据清理属于第三方分支，不删（§5.6）；`src/routes/groups.ts:2565-2566` 是工作区容器环境变量的写入，归 D-3（v0.8 更正） | 约 60      |
| 合计 |                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 约 1,670   |

### 5.5 必须同步修改（不删也要改）

1. **引导页默认值。** `SetupProvidersPage.tsx:46` 改为 `third_party`。
2. **接口校验。** `UnifiedProviderCreateSchema` 的 `type` 枚举（`src/schemas.ts:903`）只接受 `third_party`；patch 与 secrets 两个 handler 的合并态校验（`src/routes/config.ts:907-925`、:1071-1094）改为对所有供应商无条件生效。
3. **类型声明。** `src/runtime-config.ts:385`、:418、:437、:1375，`web/src/types.ts:83`，`web/src/components/settings/types.ts:10`。
4. **列表标签。** `ProviderList.tsx:200-205` 的"官方 / 第三方"标签。
5. **文档。** `docs/API.md` 有 3 行提到相关路由或字段；`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/ACL-MATRIX.md` 执行时 grep 定位。

### 5.6 不动清单

- **存储格式与旧格式迁移。** `readStoredState`（:961）、`normalizeStoredState`（:860）、`migrateV3toV4`（:1107）、`readStoredStateV4`（:1223，V4→V5 的入口，v0.8 补充），均在 `src/runtime-config.ts`，前三者合计约 290 行；`OFFICIAL_CLAUDE_PROFILE_ID`（:14）被旧格式读取与迁移代码依赖，一并保留。官方专用字段在存储层留作闲置字段。
- **第三方路径。** `ProviderEditor.tsx` 的第三方模式块（:806-968）与环境变量、请求头编辑（:993 起）；`ClaudeProviderSection.tsx:182` 的"复制第三方提供商"；`/claude/providers` 增删改查与健康检查、`/claude/balancing`、`/claude/apply`。
- **Runner 第三方逻辑。** 注册（`pi-provider.ts:173-212`）、子代理继承父模型（`container/agent-runner/src/runtime/pi/pi-subagents.ts:18-30`）、自定义请求头（`parseCustomHeaders`）。
- **第三方分支里的凭据防护（v0.8 更正，原列入 C2）。** `src/container-runner.ts` 剥离 `oauthAccount` 的代码（容器模式 `getContainerClaudeJsonPath` :150-180，主机模式 :2355-2384）和删除残留 `.credentials.json` 的代码（:1294-1303、:2388-2398）都在第三方分支里，作用是防止宿主机的 OAuth 登录态劫持第三方请求，保留。
- **`host_claude` 上下文。** `src/claude-context-resolver.ts`，与供应商类型无关。
- **数据库。** 本专题不涉及任何表。

### 5.7 需用户决策

| #   | 问题                                                        | 选项                                                                                                                           | 说明                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | 存量数据里的官方型供应商怎么处理                            | ① 用户在界面删除后再用裁剪版；② 加载时忽略并告警；③ 加载时拒绝启动                                                             | ① 零代码；②③ 要改读取逻辑。默认 ①。存量内容代理不读（敏感区），见 V-3                                                                                                                                                                                |
| D-2 | 没有 Base URL 时的回退怎么处理                              | ① 保持现状；② 宿主要求必须有 `ANTHROPIC_BASE_URL`，runner 遇到 official 直接报错；③ 在②的基础上去掉环境变量回退，只认 Web 配置 | 宿主 `defaultsFromEnv` 读环境变量，runner 在缺标记且无 Base URL 时默认 official。现状下"只有 API Key、没有 Base URL"等于直连官方端点，与本专题目标不一致                                                                                             |
| D-3 | 聊天页"容器环境变量"面板里的 `CLAUDE_CODE_OAUTH_TOKEN` 字段 | ① 本任务只摘该字段；② 该面板整体另行评估                                                                                       | `web/src/components/chat/ContainerEnvPanel.tsx` 经 `ChatView.tsx:928` 挂载。它不提供官方凭据输入框，保存时把该字段固定发空串，但后端 `src/routes/groups.ts:2565-2566` 仍然接受（V-5）。选 ① 就是从后端 Schema 和 `ContainerEnvConfig` 中摘掉这个字段 |
| D-4 | 类型声明怎么收窄                                            | ① 存储层保留 `official` 取值，只收窄接口与界面；② 存储层一并收窄并升版迁移                                                     | 默认 ①，存量文件零风险；② 要动凭据迁移链，不建议                                                                                                                                                                                                     |

### 5.8 执行时核实项（先核实再动刀）

| #   | 核实内容                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V-1 | `updateAllSessionCredentials` 与 `closeAllActiveForCredentialRefresh` 的全部调用方（`src/routes/config.ts:1127-1128`、:1547-1548），确认它们只在官方 OAuth 凭据存在时生效后再删。**已结案（v0.8）**：两处分别以 `claudeOAuthCredentials && updated.enabled`（:1126）和 OAuth 回调里的 `if (oauthCredentials)`（:1546）为条件，全仓没有其他调用方 |
| V-2 | `resolveProfileToConfig`（`src/runtime-config.ts:1946`）把 `officialSecrets` 的凭据并入每个供应商配置，核实第三方供应商是否依赖其中的任何字段                                                                                                                                                                                                    |
| V-3 | 现有 `data/config/claude-provider.json` 是否含官方型供应商或 `__official__` 档案、默认供应商是哪一类（敏感区，由用户确认）                                                                                                                                                                                                                       |
| V-4 | `src/provider-failure.ts:13` 起的官方鉴权失败文案是否被第三方路径复用                                                                                                                                                                                                                                                                            |
| V-5 | `ContainerEnvPanel` 与供应商编辑器的环境变量是否功能重复（对应 D-3）。**部分结案（v0.8）**：面板只编辑 Base URL 和 Auth Token，官方两个字段固定发空串；`mergeClaudeEnvConfig` 按"工作区值非空才覆盖"合并，全局是第三方时，工作区无法切回官方路径                                                                                                 |
| V-6 | 健康检查与"重置健康状态"路由（`/claude/providers/health`、`/claude/providers/:id/reset-health`）对官方型供应商的处理                                                                                                                                                                                                                             |
| V-7 | §5.10 测试文件里官方与 OAuth 用例的具体范围。**已结案（v0.8）**：见 §5.10                                                                                                                                                                                                                                                                        |

### 5.9 任务拆分

每个任务的回滚点为其开工前的 HEAD，立项时写入 `.gatescope.json` 的 `base`。

**T0 立项（不删码）**

- 确认 §5.7 的 D-1 至 D-4 已拍板。
- 重置 `.gatescope.json`：`task` 填本任务名，`base` 填开工前 HEAD，`allow` 列出 §5.4、§5.5、§5.10 涉及的路径（先读 `scripts/check-scope.mjs` 确认语义）。
- 若按任务池流程走：在 `docs/issues/` 新建 issue（编号顺延）并更新其 README 索引行。
- 完成标准：plan 与 `.gatescope.json` 落档，`node scripts/check-scope.mjs` 通过。

**T1 接口封口（后端，先行）**

- 目标：接口层不再接受、不再提供官方能力。
- Red：新增用例——`type: 'official'` 的创建请求被拒；`/api/config/claude/oauth/start`、`/api/config/claude/oauth/callback`、`/api/config/claude/providers/:id/usage` 返回 404；第三方供应商的创建、修改、密钥更新、健康检查回归用例保持通过。
- Green：`src/schemas.ts` 的 `type` 枚举收窄；删除 `src/routes/config.ts` 的 OAuth 路由与用量查询；合并态校验改为无条件；按 §5.4 C2 处理三处"已配置"判断（`bug-report` 改写为第三方判定）。
- 完成标准：新增用例全绿，`make typecheck` 通过。

**T2 界面收口（前端）**

- 目标：界面只剩第三方表单。
- Red：源码契约用例——引导页与编辑器源码不再出现 `official` 分支与 OAuth 流程，默认模式为 `third_party`。
- Green：§5.4 的 A1 至 A3，以及 §5.5 的第 1、3、4 项。
- 完成标准：契约用例全绿，`make build` 通过；设置页与引导页由用户人工验收。

**T3 运行时收口（Runner 与宿主）**

- 目标：运行时只有第三方一条路径。
- Red：runner 用例——`endpointKind` 为 `official` 时按 D-2 的裁决处理；第三方注册、子代理继承父模型、自定义请求头的既有用例保持通过。
- Green：§5.4 的 C1；`defaultsFromEnv` 按 D-2 处理。
- 完成标准：runner 单测全绿；若动了共享类型，`make sync-types` 后无差异。

**T4 凭据链清理（宿主，最后做）**

- 前置：V-1、V-2 核实通过。
- Green：§5.4 的 B2 与 C2 中的 `.credentials.json` 部分。
- 完成标准：全量 vitest 通过；`claude-provider.json` 仍为 version 5。

**T5 文档同步与终验**

- 同步 §5.5 第 5 项列出的文档。
- `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- 人工冒烟（用户验收）：用第三方供应商登录 → 对话流式回复 → 设置页供应商列表无"官方"标签 → 引导页无"官方渠道"。

**整体验收条件**

1. 界面：供应商编辑器与引导页 `/setup/providers` 只有第三方表单。
2. 接口：携带 `type: 'official'` 的创建请求返回 400；三个 OAuth 与用量路由返回 404。
3. 运行时：用第三方供应商跑通一次流式对话，过程中不生成 `.credentials.json`。
4. 兼容：`claude-provider.json` 仍为 version 5，存量第三方供应商无需迁移。
5. 门禁：`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
6. 非目标未被实现：存储格式、迁移代码、数据库、Docker 模式均无改动。

### 5.10 测试影响

v0.8 按调用方重新核对，测试分三类：

- **要改写其中的官方或 OAuth 用例**：`tests/routes-provider-runtime-apply.test.ts`、`tests/runtime-config-env.test.ts`、`tests/pi-runtime-settings-and-credentials.test.ts`、`tests/unified-provider-third-party-baseurl.test.ts`、`tests/pi-subagent-custom-provider.test.ts`、`tests/routes-agent-profiles.test.ts`、`tests/runtime-config-default-provider.test.ts`、`tests/pi-custom-provider-headers.test.ts`，以及原清单漏掉的 `tests/agent-runner-provider-runtime.test.ts`（覆盖 C1 要删的 official 回退）。
- **会被连带打红**：`tests/no-duplicate-helpers-contract.test.ts:380` 断言 `OAuthUsageBucket` 全仓恰好声明一次，A3 删掉这个类型后要同步修改。
- **与本专题无关，不动**：`tests/agent-runner-utils-redact.test.ts`（通用 OAuth Bearer token 脱敏）、`tests/githooks-contract.test.ts:191`（密钥检测钩子的样例字符串）。

### 5.11 风险与回滚

- **凭据存储是全仓最敏感的代码之一。** 只删官方专用的函数与分支，不改 V5 结构；T4 放在最后、单独提交。
- **`data/` 是敏感区。** 代理不读写；存量官方供应商由用户处理（D-1）。
- **演示依赖第三方端点。** 裁剪后无法直连 Anthropic 官方，须确保手上有可用的第三方端点（§14）。
- **行号漂移。** 以符号名为锚点定位。
- **回滚。** 每个任务独立提交，`git revert <提交号>`；整体可回退到立项前的 HEAD。
- **发现与方案不符。** 停下报告，不擅自扩范围（宪法第二节第 10 条、第四节失败分层）。

## 6. 专题 C：用量分析与模型单价——裁掉

**裁决：裁（2026-11-24，用户三次裁决：裁用量分析，裁模型单价，聊天气泡只保留耗时）。状态：已完成（THESIS-06/07/08/09；合入 main `8866a8f`）。** 本项整体取代第一轮裁决 2。三层一起裁，按 L3 执行。

### 6.1 目标

把用量分析页与模型单价整条路径裁掉，聊天气泡只显示耗时。裁剪后：

- 主导航与聊天页不再有用量入口；
- `/usage` 路由与 `/api/usage` 下线；
- 设置页不再有"模型单价"，`/api/pricing` 下线；
- 聊天气泡只显示耗时，不再显示 token 数和明细提示；
- 对话、定时任务、运行状态页不受影响。

### 6.2 非目标

- 不动 `usage` 流事件和 `messages.token_usage` 的写入，气泡只是不再显示 token 部分。
- 本专题不删表。用量表与自定义单价表的删除放在 §9。
- 不动运行状态页（`src/routes/monitor.ts` 不引用用量数据，已核实）。

### 6.3 关键事实（d6e04aa）

用量在代码里分三层，上层依赖下层：

- **页面层。** `web/src/pages/UsagePage.tsx`（1,292 行）、`web/src/stores/usage.ts`（660）、`web/src/components/usage/`（168）、`web/src/utils/usage-format.ts`（13）。入口有三处：主导航 `/usage`（`web/src/components/layout/nav-items.ts:25`）、聊天页"用量统计"菜单（`web/src/pages/ChatPage.tsx:298-301`）、登录状态变化时对用量 store 的重置（`web/src/stores/auth.ts:97`、:116、:134）。后端是 `/api/usage` 的六个只读接口（`src/routes/usage.ts`：`/stats`、`/models`、`/filters`、`/records`、`/export.csv`、`/users`，共 225 行）。
- **记账层。** `src/usage-service.ts`（214）、`src/task-usage.ts`（42）。调用点共五处（v0.8 更正，原写两处）：`src/index.ts` 里包装函数 `writeUsageRecords`（:1792）的四处调用，以及 `src/task-scheduler.ts:1208` 的 `recordIsolatedTaskUsage`。四处调用里，:6410 和 :10190 写账本并回写气泡；:6090 和 :10041 在推送前用 Kaboo 计价结果覆盖流事件的 `usage.costUSD`，Web 和飞书看到的费用都来自这一步。
- **定价层。** 设置页"模型单价"的三个前端文件（`ModelPricingSection.tsx` 242、`ModelPricingDialog.tsx` 318、`stores/model-pricing.ts` 129）与导航项（`web/src/components/settings/SettingsNav.tsx:74-78`）；`/api/pricing` 的五个接口（`src/routes/pricing.ts` 166：规则增删改查加预览，都要求 `manage_system_config`）；`src/kaboo-pricing.ts`（396，内置价格表与计价函数）、`src/custom-pricing-store.ts`（53，自定义规则的缓存，规则存在数据库表 `custom_model_pricing`）。定价只被记账层和它自己的接口引用；记账层引用了其中五个函数来算费用（`src/usage-service.ts:4-14`）。
- **气泡数据的写入路径经过账本。** 每条用量事件到达时，`src/index.ts:6421` 先记账，再调用 `rebuildMessageTokenUsageFromLedger`（`src/db.ts:1231`）从账本按消息汇总，回写 `messages.token_usage`。之所以要经账本，是因为一条回复可能收到多次增量用量事件。所以用量表有两个读方：`/api/usage`，以及这条回写路径。
- **气泡的显示。** `web/src/components/chat/MessageBubble.tsx:108-183` 的 `TokenUsageDisplay` 显示"N tokens · X 秒"，悬停还有明细提示（主模型、输入输出、缓存读写、推理）。辅助函数在 `web/src/lib/token-usage-presentation.ts`（100）。另外，前端 `web/src/stores/chat.ts` 会用实时流事件拼出同样格式的 `token_usage`（:2340、:2632），刷新页面之前的气泡靠它显示（v0.8 补充）。

因为上层依赖下层，只能从上往下依次裁。反过来，下层一旦裁掉，上层也没有存在的理由：记账层的全部产出就是按单价算出的费用。

### 6.4 三个累计的裁剪层级

| 层级               | 删除内容                                                                      | 行数（估） |
| ------------------ | ----------------------------------------------------------------------------- | ---------- |
| L1 页面            | 页面层的全部文件、`/api/usage`、三处入口                                      | 约 2,360   |
| L2 = L1 + 停记账   | `usage-service.ts`、`task-usage.ts`、五处调用点；把气泡回写改成不经账本的累加 | 约 330     |
| L3 = L2 + 模型单价 | 定价层的全部文件、`/api/pricing`、设置页的"模型单价"导航项                    | 约 1,300   |

- **模型单价与停记账只能一起裁。** 定价只被记账层引用，而记账层的全部产出就是按单价算出的费用。只裁模型单价、保留记账，就得改写 `usage-service.ts` 去掉费用计算，剩下的记录只有 token 数，而用量分析页已经裁掉，没有任何地方读取它们。所以三层一起裁，合计约 4,000 行。

### 6.5 需用户决策

| #    | 问题                          | 选项                                                                                 | 说明                                                                                                                                                                                                                             |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-C1 | 裁到哪一层                    | ① L1 只裁页面；② L2 页面加停记账；③ L3 再加模型单价                                  | **已定 ③**（2026-11-24）。用户先裁用量分析、再裁模型单价；停记账随模型单价一并执行，理由见 §6.4                                                                                                                                  |
| D-C2 | 聊天气泡里的 token 数与耗时   | ① 都保留；② 都去掉；③ 只保留耗时                                                     | **已定 ③**（2026-11-24）。明细提示与三个 token 辅助函数一并删除                                                                                                                                                                  |
| D-C3 | 飞书卡片摘要里的 token 与费用 | ① token 保持现状，费用一行随定价下线自然消失（默认，零代码）；② 同样只保留耗时与轮数 | **已定 ②**（2026-11-25）。飞书摘要只留耗时与轮数；token 摘要与费用一并删除，改 `src/feishu-usage-display.ts`、`src/feishu-cards/sections.ts`、`src/feishu-cards/types.ts`、`src/feishu-streaming-card.ts`（THESIS-09 `f94d719`） |

### 6.6 测试影响（执行时核实具体范围）

- **随 L1 删除或改写**：`tests/frontend-usage-experience.test.ts`（344 行）、`tests/routes-usage.test.ts`（293）；`tests/frontend-settings-information-architecture.test.ts`（断言 `/usage` 导航）、`tests/frontend-product-terminology.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts` 各有一处引用，需改。
- **随 L2 删除或改写**：`tests/usage-accounting.test.ts`（630）、`tests/task-usage-routing.test.ts`（200）。
- **随 L3 删除**：`tests/pricing-routes.test.ts`（721）、`tests/custom-pricing.test.ts`（214）、`tests/custom-pricing-frontend.test.ts`（182）、`tests/kaboo-pricing.test.ts`（213）。另有 `tests/no-duplicate-helpers-contract.test.ts`（7 处引用定价辅助函数）、`tests/frontend-settings-information-architecture.test.ts`（设置导航断言）需改。
- **随气泡改动改写**：`tests/usage-display-formatting.test.ts`（174，断言的是 token 明细的三个辅助函数）改为只测耗时解析。
- **随 §9 删除**：`tests/schema-v51-usage.test.ts`（断言用量表结构）。
- **不动**：`tests/pi-usage-stream.test.ts`（`usage` 流事件）。

### 6.7 执行时核实项（先核实再动刀）

| #    | 核实内容                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-C1 | 飞书卡片摘要里的费用一行（`src/feishu-usage-display.ts:67`）是否只取自 `usage` 流事件，与定价层无关。**已结案（v0.8），结论相反**：它取自被定价层覆盖后的 `costUSD`，见 §6.3                                                    |
| V-C2 | `tests/no-duplicate-helpers-contract.test.ts` 等测试对定价辅助函数的引用范围                                                                                                                                                    |
| V-C3 | 自定义单价表 `custom_model_pricing` 除定价层外是否还有读写方                                                                                                                                                                    |
| V-C4 | `tests/task-continuation-scheduler.test.ts` 里的一处定价引用属于什么路径                                                                                                                                                        |
| V-C5 | `usage` 流事件里的用量是增量还是累计。这决定停记账之后气泡的耗时怎么累加，是 T2 的前置。**部分结案（v0.8）**：Pi runner 每个 turn 只在 `publishResult` 里发一次 `usage`，并带 `eventId`；一条可见回复会不会跨多个 turn 仍待核实 |
| V-C6 | `src/db.ts` 的 `stmts()` 里引用 `usage_records` 的预处理语句是哪一条，停记账后是否还有调用。**已结案（v0.8）**：是 `insertUsageInsert`（:176），唯一调用方是 `recordUsageEventBatch`（:1489），停记账后没有调用                 |

### 6.8 任务拆分

**T0 立项（不删码）**：确认 D-C3 已拍板；重置 `.gatescope.json`。

**T1 页面层**

- Red：源码契约用例——主导航与聊天页源码不再出现 `/usage`；路由用例——六个 `/api/usage` 接口返回 404。
- Green：L1 的全部内容。
- 完成标准：新增用例全绿，`make typecheck` 与 `make build` 通过。

**T2 停记账与回写**

- Red：用例——对话与定时任务跑完后，用量表不新增记录；一条回复连续收到三次用量事件后，消息上的耗时是三次之和。
- Green：删五处调用点（§6.3）和两个模块；把 `src/index.ts:6421`、:10202 两处对 `rebuildMessageTokenUsageFromLedger` 的调用换成不经账本的累加回写。`updateLatestMessageTokenUsage` 已经支持按消息 ID 写入，但只能整值覆盖，所以累加要在 `src/index.ts` 里按消息 ID 进行。按 D-C2，只需要累加耗时和轮数。
- 完成标准：新增用例全绿。本任务不改 `src/db.ts`，`rebuildMessageTokenUsageFromLedger` 的函数本体留到 §9 随表一起删除。

**T3 模型单价**

- Red：路由用例——五个 `/api/pricing` 接口返回 404；源码契约用例——设置导航不再出现"模型单价"。
- Green：删除 `src/routes/pricing.ts` 及其挂载（`src/web.ts:234`）、`src/kaboo-pricing.ts`、`src/custom-pricing-store.ts`，以及前端三个文件、设置页的导航项（`SettingsNav.tsx:74-78`）与标签类型（`web/src/components/settings/types.ts:117`）。
- 完成标准：新增用例全绿。

**T4 气泡收口**

- Red：组件用例——气泡只渲染耗时，不出现"tokens"字样与明细提示；源码契约用例——`MessageBubble.tsx` 不再引用三个 token 辅助函数。
- Green：`TokenUsageDisplay` 只保留耗时分支（耗时为 0 时不显示）；`web/src/lib/token-usage-presentation.ts` 只留 `parseTokenUsage`；`web/src/stores/chat.ts` 实时拼 `token_usage` 的两处（:2340、:2632）一并收口；按 D-C3 处理飞书卡片摘要。
- 完成标准：新增用例全绿，`make build` 通过；气泡由用户人工验收。

**T5 文档同步与终验**

- 同步 `docs/API.md`（用量 7 行、定价 10 行）与 `docs/ACL-MATRIX.md`（各 1 行），以及 `CLAUDE.md` §3.2 路由表的 `/usage` 行和兼容重定向列表里的 `usage`→`/usage`（v0.8 补充；`SettingsPage.tsx:68` 的 `LEGACY_TAB_ROUTES` 同步删除该条）。
- `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- 人工冒烟（用户验收）：登录 → 对话流式回复，气泡显示耗时 → 主导航与聊天页菜单无用量入口 → 设置页无"模型单价" → 运行状态页正常。

**整体验收条件**

1. 主导航与聊天页菜单没有用量入口；访问 `/usage` 落到工作台。
2. `/api/usage` 六个接口与 `/api/pricing` 五个接口返回 404。
3. 对话流式回复正常；聊天气泡只显示耗时，没有 token 数和明细提示。
4. 对话与定时任务运行后，用量表不再新增记录。
5. 门禁：`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
6. 非目标未被实现：本专题不改 `src/db.ts` 与表结构，`usage` 流事件、运行状态页均无改动。

### 6.9 风险与回滚

- **气泡回写路径要改。** 耗时现在经账本回写。停记账之后如果不改这条路径，账本是空的，气泡里的耗时会变成 0。T2 必须先于一切删表动作完成并验证。
- **停记账后用量数据不再增长。** 历史数据留在表里，直到 §9 删表。
- **飞书卡片摘要按 D-C3 ② 收口。** 费用一行随定价层下线消失；THESIS-09 同时删除 token 摘要，legacy note 与 v2 meta row 只保留耗时与轮数，验收时不再有 token/费用。
- **引用点分散。** 登录状态变化时的 store 重置、导航契约测试等引用点靠类型检查和全量测试兜底。
- **回滚。** 每个任务独立提交，`git revert <提交号>`。

## 7. 专题 D：管理后台——裁注册策略与用户与访问，保留运行状态

**裁决：裁（2026-11-24，用户）。状态：待立项。** 本项取代第一轮保留清单中"多用户认证与权限矩阵（UsersPage / 邀请码 / 审计日志）"的界面部分。

**v0.8：本节不单独立项。** 用户已裁决只做个人用户（§8），本节被完全覆盖，D-D2 并入任务包 THESIS-10，下文保留作背景与决策记录。

**与 §8 的关系。** §8 是范围更大的版本。若执行 §8，本节的"注册策略""用户与访问"两部分并入 §8 执行，D-D1、D-D3、D-D4 由 §8 给出确定答案；本节只有"运行状态保留"和 D-D2 仍然单独有效。若不执行 §8，按本节执行。

### 7.1 目标

设置页"管理后台"分组只保留"运行状态"。裁剪后：

- 设置页不再有"注册策略"与"用户与访问"两个标签；
- `/users` 路由下线；
- 运行状态页功能不变。

### 7.2 非目标

- 不动登录、登出、改密、会话管理、角色与权限守卫、ACL 矩阵。
- 不动审计日志的写入（`logAuthEvent`），只是没有查看界面。
- 不动运行状态页。
- 本专题不改表结构；不关闭、不修改任何已有账号。

### 7.3 关键事实（d6e04aa）

- **"管理后台"是设置页的一个分组，正好三项**（`web/src/components/settings/SettingsNav.tsx:81-89`）：注册策略、用户与访问、运行状态。"用户与访问"同时是独立路由 `/users`（`web/src/App.tsx`，权限守卫为 `manage_users`、`manage_invites`、`view_audit_log` 之一）。
- **注册策略页是两个部分的组合**（`web/src/pages/SettingsPage.tsx:247-254`）：`RegistrationSection`（两个开关：允许注册、需要邀请码）和 `SystemSettingsSection scope="security"`（认证尝试次数上限、登录与注册限流时间两项登录限流设置）。裁掉页面后，这两项设置需要去处（D-D2）。
- **注册与邀请码是一体的。** 默认配置是"允许注册、必须邀请码"（`src/runtime-config.ts:2205-2210`）；邀请码只能在"用户与访问 → 邀请码"里生成；登录页按 `GET /api/auth/register/status` 决定是否显示注册入口（`web/src/pages/LoginPage.tsx:57`）。两页一起裁掉后，没有任何界面能生成邀请码或调整注册策略。
- **后端管理接口独立于界面。** `/api/admin` 共 12 个接口（`src/routes/admin.ts`，1,192 行）：用户增删改查、权限模板、邀请码、审计日志查询与导出。界面之外没有其他前端消费方，权限模板只被 `web/src/stores/users.ts:147` 使用。
- **三个管理权限名**（`manage_users`、`manage_invites`、`view_audit_log`）在后端 `src/permissions.ts`、`src/types.ts`、`src/middleware/auth.ts`、`src/routes/admin.ts` 与前端 `web/src/stores/auth.ts:9-11` 中声明。
- **有测试把管理接口当夹具。** `tests/routes-system-settings-security.test.ts:556`、:582、:619 通过 `/api/admin/users/:id` 改变用户角色，作为系统设置安全用例的前置步骤。

### 7.4 删除范围（估算，执行时以核实为准）

| 部分               | 锚点（d6e04aa）                                                                                                                                                                   | 行数（估） |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 注册策略界面       | `web/src/components/settings/RegistrationSection.tsx`（122）；`SettingsPage.tsx:247-254`；`SettingsNav.tsx:82-86`                                                                 | 约 150     |
| 注册策略接口与配置 | `src/routes/config.ts:1591-1638`（`GET`、`PUT /registration`）；`src/runtime-config.ts:2194-2252`（`registration.json` 读写）                                                     | 约 110     |
| 用户与访问界面     | `web/src/pages/UsersPage.tsx`（107）、`web/src/components/users/`（993）、`web/src/stores/users.ts`（259）；`App.tsx` 的 `/users` 路由；`SettingsPage.tsx:23`、:82-86、:109、:197 | 约 1,360   |
| 管理接口（可选）   | `src/routes/admin.ts`（1,192）与 `src/web.ts:225` 的挂载                                                                                                                          | 约 1,190   |

### 7.5 需用户决策

| #    | 问题                             | 选项                                                                                                                                                                   | 说明                                                                                                                 |
| ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D-D1 | 裁掉注册策略后，注册行为怎么定   | ① 关闭注册：后端固定视为不允许注册，`POST /api/auth/register` 恒返回 403，登录页不再出现注册入口；② 保持现状：继续读 `data/config/registration.json`，只是没有界面可改 | ② 之下新用户实际无法注册（没有生成邀请码的入口），但行为取决于存量配置文件。建议 ①：行为确定，演示机不会对外开放注册 |
| D-D2 | 两项登录限流设置去哪             | ① 挪到"执行与容量"页，分组改名为"执行、容量与安全"；② 删掉界面，后端设置与环境变量保留；③ 挪到"运行状态"页                                                             | ① 改动最小，设置仍然可达；② 之后只能靠环境变量调整                                                                   |
| D-D3 | 后端管理接口是否一并删除         | ① 只删界面，接口保留（默认）；② 接口一并删除                                                                                                                           | ② 多删约 1,190 行，但要改以它为夹具的测试，之后用户管理只能直接改数据库                                              |
| D-D4 | 三个管理权限名是否从权限体系下架 | ① 保留（默认）；② 按第一轮下架 `manage_billing` 的先例，从权限、类型与前端联合类型中移除                                                                               | ① 零风险；② 更干净，但要动后端权限定义                                                                               |

### 7.6 执行时核实项（先核实再动刀）

| #    | 核实内容                                                                                   |
| ---- | ------------------------------------------------------------------------------------------ |
| V-D1 | 登录限流设置按 D-D2 挪走后，`SystemSettingsSection` 的 `scope` 联合类型与保存逻辑如何收敛  |
| V-D2 | 前端联合类型里的三个权限名去掉后，是否还有其他消费者                                       |
| V-D3 | 除 `routes-system-settings-security.test.ts` 外，是否还有测试以 `/api/admin` 为夹具        |
| V-D4 | `tests/frontend-load-error-visibility.test.ts:31`（UsersPage）与设置导航结构断言的具体范围 |
| V-D5 | D-D1 选 ① 时，访问 `/login?tab=register` 是否正确落回登录页                                |

### 7.7 任务拆分

**T0 立项（不删码）**：确认 D-D1 至 D-D4 已拍板；重置 `.gatescope.json`。

**T1 界面收口**

- Red：源码契约用例——设置导航"管理后台"只有运行状态；`App.tsx` 不再有 `/users` 路由。
- Green：删除范围表的前三行；按 D-D2 处理两项登录限流设置。
- 完成标准：契约用例全绿，`make build` 通过。

**T2 注册行为**

- Red：路由用例——`GET`、`PUT /api/config/registration` 返回 404；按 D-D1 选 ① 时，`POST /api/auth/register` 返回 403，`GET /api/auth/register/status` 返回不允许注册。
- Green：删除注册策略接口与配置读写；按 D-D1 改注册判断。
- 完成标准：新增用例全绿，登录、登出、改密回归用例保持通过。

**T3 管理接口（D-D3 选 ② 时）**

- Red：路由用例——`/api/admin` 的 12 个接口返回 404；系统设置安全用例改用直接写库作为前置。
- Green：删除 `src/routes/admin.ts` 与挂载；按 D-D4 处理权限名。
- 完成标准：新增用例全绿，`make typecheck` 通过。

**T4 文档同步与终验**

- 同步 `docs/API.md`（管理接口 10 行、注册 1 行、用户页 5 行）、`docs/ACL-MATRIX.md`（注册 2 行）、`CLAUDE.md`（1 行）。
- `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- 人工冒烟（用户验收）：登录 → 设置页"管理后台"只有"运行状态" → 运行状态页正常 → 访问 `/users` 落到工作台 → 登录页没有注册入口（D-D1 选 ① 时）。

**整体验收条件**

1. 设置页"管理后台"只有"运行状态"一项；访问 `/users` 落到工作台。
2. 运行状态页功能不变。
3. 登录、登出、改密、会话管理正常；已有账号不受影响。
4. 注册行为与 D-D1 的裁决一致。
5. 两项登录限流设置按 D-D2 仍可配置。
6. 门禁：`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
7. 非目标未被实现：认证链路、权限守卫、审计写入均无改动，本专题不改表结构。

### 7.8 风险与回滚

- **论文章节的演示面缩小。** 第一轮把"多用户认证与权限矩阵"列为答辩章节。只按本节裁剪时，登录、角色、权限守卫、ACL 矩阵仍在，但无法在界面上演示新建用户、生成邀请码、查看审计日志；需要多用户演示时，要提前准备好已有账号（§14）。若执行 §8，这一章整体改写（§8.10）。
- **关闭注册是行为变更。** `POST /api/auth/register` 从可用变为恒拒绝，属于对外接口的破坏性变更，按宪法第二节第 2 条须在立项时明确确认。
- **回滚。** 每个任务独立提交，`git revert <提交号>`。

## 8. 专题 E：只做个人用户——裁减多用户认证与权限矩阵

**裁决：裁（2026-11-24，用户）。状态：已完成（THESIS-10 `cd4d7a7`、11 `bdddede`、12 `54ad6b4`、13 `bb79c95`）。** 本项取代第一轮保留清单中的"多用户认证与权限矩阵"，该章节原列为答辩章节。做到哪一层见 D-E1。

### 8.1 目标

系统只有一个账号：首次启动时创建，此后不能注册、不能新增。裁剪后：

- 没有注册、邀请码、用户管理、角色、权限模板、权限矩阵；
- 这一个账号拥有全部能力，界面上不再有按权限显隐的入口；
- 仍然需要登录。

### 8.2 范围澄清

- **在范围内：CKQClaw 账号体系。** 账号的注册与管理、角色与权限、权限中间件、权限矩阵文档。
- **不在范围内：IM 侧访问控制。** 机器人主人（`owner_im_id`）、发送者白名单、响应对象（`everyone` / `owner_only`）、激活方式、IM 命令的主人约束、主人档案（CKQClaw Owner Profile）。它们回答的是"群里谁可以指挥这台机器人"，个人用户同样需要，默认全部保留。

### 8.3 非目标

- 不去掉登录（除非 D-E2 改裁）。
- 不动数据归属：`created_by` 字段、工作区访问判断（`canAccessGroup`、`canModifyGroup`、`canDeleteGroup`）、按账号划分的目录（如 `data/skills/{userId}/`）都保留（除非 D-E1 选 ③）。
- 不动 IM 侧访问控制、渠道多账号（同一个账号可以有多个机器人）、会话置顶偏好。
- 本专题不改表结构，只删除对 `invite_codes` 与 `auth_audit_log` 的读写；这两张表的删除放在 §9。

### 8.4 关键事实（d6e04aa）

- **权限是分十一层的。** `docs/ACL-MATRIX.md`（333 行）定义了公开、登录、工作区访问、修改、删除、主机执行、系统配置、用户管理、邀请、审计、IM 主人。角色只有管理员和普通成员两种，权限五项，另有四个权限模板（`src/permissions.ts`）。
- **权限中间件的挂载点集中。** `src/middleware/auth.ts:151-170` 定义了 `requirePermission`、由它派生的 4 个中间件，以及按角色判断的 `adminRoleMiddleware`（在 `src/routes/config.ts` 挂载 5 处），全仓约 55 行引用（含定义与 import），其中 `systemConfigMiddleware` 30 行；另有一处直接判断权限名 `manage_group_env`（`src/routes/groups.ts:522`、:2466-2518）。
- **角色判断远比权限判断多（v0.8 补充）。** 后端有 86 处 `role === 'admin'` 或 `role !== 'admin'`，集中在 `src/index.ts`（21）、`src/routes/groups.ts`（20）、`src/routes/tasks.ts`（18）、`src/ipc/task-ops.ts`（15）、`src/ipc/task-dispatch.ts`（12）、`src/container-runner.ts`（12）、`src/routes/monitor.ts`（9）等文件；"管理员主工作区"相关标识（`isAdminHome` 等）有 69 处引用。主机执行、脚本任务、管理员纯宿主机模式都按角色判定。
- **前端权限门分散但很浅。** 25 个文件、约 90 处：`AuthGuard` 的 `requiredPermission`、设置页与导航的 `canManage*`、若干页面的 `role === 'admin'` 判断。
- **数据归属的引用面很广。** 后端 53 个文件、500 行引用 `created_by` 或 `owner_user_id`；工作区访问判断定义在 `src/web-context.ts:298-390`，后端 16 个文件、180 行调用；80 个测试文件涉及归属字段。单账号下这些判断恒为真。
- **强制改密在单账号下没有触发点。** 首次启动创建账号和命令行重置密码都把 `must_change_password` 设为 `false`（`src/routes/auth.ts:169`、`src/reset-admin.ts:32`、:48）；唯一会置为真的路径是管理员在用户管理里给别人重置密码，而这条路径本就要裁掉。相关代码后端 36 行、前端 22 行、测试 43 行。
- **首启与登录链路独立于多用户。** `POST /api/auth/setup`（仅用户表为空时可用）、登录、登出、个人资料、改密、会话管理、头像、登录限流都是"仅本人"的接口，单账号下原样可用。
- **产品定位写在三份文档里。** `README.md:261`、`CLAUDE.md:21`、`AGENTS.md:47` 都写的是"多用户 Agent 工作台"。

### 8.5 三个累计的裁剪层级

| 层级                  | 内容                                                                                                                                                                                | 行数（估）     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| E1 单账号             | 注册、邀请码、注册策略、用户管理、权限模板、`/api/admin` 整体下线                                                                                                                   | 约 3,150       |
| E2a = E1 + 去权限     | 权限名、权限模板、`requirePermission` 及其 4 个派生中间件与挂载、`manage_group_env` 判断、前端 `canManage*` 与 `requiredPermission`；`role` 列与 admin 语义保留，唯一账号恒为 admin | 约 450         |
| E2b = E2a + 去角色    | `adminRoleMiddleware`、后端 86 处角色判断、"管理员主工作区"概念、主机执行与脚本任务的角色门槛（v0.8 新增）                                                                          | 未估算；不建议 |
| E3 = E2b + 去数据归属 | 删掉"这条数据属于哪个账号"的比对：工作区访问判断、主人状态闸门、IM 聊天的归属判定与回填，技能和 MCP 目录不再按账号分层                                                              | 未估算；不建议 |

E1 的行数与 §7 重叠约 2,810 行，两项不要重复计入。

- **E2 拆分（v0.8）。** 原 E2 只统计了权限，没有统计角色（§8.4），约 450 行只对应 E2a。拆分后推荐只做 E2a：对唯一账号来说，角色判断恒为真，理由与不做 E3 相同。
- **只做 E1 的问题。** 角色与权限的代码还在，但唯一账号永远是管理员，权限判断恒为真：一段不会出错的死逻辑，答辩时仍要解释"为什么有权限矩阵却只有一个用户"。
- **E3 具体指什么。** 现在每条数据都记着"属于哪个账号"：工作区和 IM 聊天有 `created_by`，渠道账号和 Agent 档案有 `owner_user_id`，技能与 MCP 配置按账号分目录存放（如 `data/skills/{userId}/`）。每次访问都要比对"当前账号是不是主人"，不是就返回 404（`canAccessGroup`，`src/web-context.ts:309`）。E3 就是删掉这套比对：路由直接操作请求的数据，列表不再按主人过滤，IM 消息到达时不再判断该归哪个账号，技能和 MCP 目录不再按账号分层。数据库里的归属列不动。
- **E2 与 E3 的差别。** 对唯一账号来说两者用起来完全一样。唯一的可见差别是：库里若还有别的账号名下的工作区，E2 下看不到，E3 下会全部出现（与 D-E5 相关）。
- **不建议 E3 的原因。** 牵动 53 个后端文件和 80 个测试文件，并与 IM 聊天的归属、回填逻辑纠缠；而单账号下这些判断恒为真，留着没有功能代价。
- **可选加项。** 去掉强制改密机制，约 150 行（D-E3）。

### 8.6 需用户决策

| #    | 问题                                            | 选项                                                                                       | 说明                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-E1 | 做到哪一层                                      | ① E1 单账号；②a E2a 再去掉权限体系；②b E2b 再去掉角色；③ E3 再去掉数据归属                 | 建议 ②a（v0.8，原为\"建议 ②\"）                                                                                                                                                                                                                                                                                          |
| D-E2 | 是否保留登录                                    | ① 保留单账号登录（默认）；② 完全去掉登录                                                   | 去掉后，任何能访问端口的人都能指挥一台可以执行命令的 Agent；只有服务只绑定本机回环地址时才可接受                                                                                                                                                                                                                         |
| D-E3 | 强制改密机制 `must_change_password`             | ① 去掉（默认）；② 保留                                                                     | 单账号下没有任何路径会触发它；去掉还能消除第一轮排查过的"桌面端登录循环"困惑（交付档 §9）                                                                                                                                                                                                                                |
| D-E4 | 审计日志 `auth_audit_log` 的写入                | ① 继续写，只是没有查看界面；② 停止写入                                                     | **已定 ②**（2026-11-24，随"用不到的表一并删除"的裁决）。裁掉用户管理后它只剩写入、没有读取；调用点在 `src/routes/auth.ts`（10 处）和 `src/routes/config.ts`（2 处，记录系统设置与宿主机集成的变更，停写后这两类变更也不再留痕），`src/routes/admin.ts` 的 16 处随文件删除（v0.8 更正，原数字含 import 行）；表在 §9 删除 |
| D-E5 | 存量数据里的其他账号及其工作区                  | ① 原样留在库里，唯一账号看不到它们（默认）；② 裁剪前在界面上删除这些账号；③ 迁移给唯一账号 | ② 会连带处理其数据，删除语义需核实（V-E6）；③ 需要额外的迁移工具，不建议。存量情况代理不读（敏感区），由用户确认。v0.8 补充：选 ① 时这些账号自己仍能用原密码登录（登录只检查 `status === 'active'`，`src/routes/auth.ts:284`），用户管理界面下线后就无法再禁用它们                                                       |
| D-E6 | `docs/ACL-MATRIX.md` 怎么处理                   | ① 改写为"个人版访问边界"（默认）；② 删除                                                   | **已定 ①**（2026-11-25，用户）。文档检查不强制它存在，但 `AGENTS.md` 的文档索引引用了它；改写后继续作为论文"个人版认证与访问边界"的提纲                                                                                                                                                                                  |
| D-E7 | 去掉权限中间件后，原挂载点换成什么（v0.8 新增） | ① 换成 `adminRoleMiddleware`，仍要求 admin 角色；② 只留 `authMiddleware`                   | 建议 ①：D-E5 选 ① 时存量的其他账号仍能登录，选 ② 会让存量的普通成员账号拿到系统配置权限                                                                                                                                                                                                                                  |

### 8.7 执行时核实项（先核实再动刀）

| #    | 核实内容                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V-E1 | 各路由上权限中间件挂载点的全集，以及去掉后"普通成员得到 403"一类测试如何处置                                                                                                                                                                           |
| V-E2 | 前端 25 个文件的权限门里，哪些应改为始终可见，哪些随页面一并删除                                                                                                                                                                                       |
| V-E3 | 以注册接口或 `/api/admin` 创建第二个用户的测试夹具范围（如 `tests/routes-system-settings-security.test.ts:556`、:582、:619）。**已结案（v0.8）**：只有这三处；没有测试调用注册接口，路由测试的身份由 `tests/helpers/route-test-user.ts` 经环境变量注入 |
| V-E4 | 去掉强制改密后，`authMiddleware` 的改密闸门（`src/middleware/auth.ts:122-134`）、`AuthGuard` 与设置页的改密跳转如何收敛                                                                                                                                |
| V-E5 | "管理员纯宿主机模式"在单账号下仍然有效（会把工作区迁到主机），但文案里的"普通成员仍固定使用 Docker"不再成立，需要改写                                                                                                                                  |
| V-E6 | 管理员删除账号的连带语义：是否会删除该账号的工作区、渠道账号与数据                                                                                                                                                                                     |
| V-E7 | Electron 桌面壳对登录流程的依赖（交付档 §9 记录过登录问题）。§10 先执行则此项失效                                                                                                                                                                      |
| V-E8 | `logAuthEvent` 的全部调用点，以及 `src/routes/config.ts` 里那 3 处记录的是什么事件。**已结案（v0.8）**：见 D-E4                                                                                                                                        |

### 8.8 任务拆分

**T0 立项（不删码）**：确认 D-E1、D-E2、D-E3、D-E5、D-E6 已拍板；重置 `.gatescope.json`。

**T1 账号收口**

- Red：路由用例——`/api/auth/register` 与 `/api/auth/register/status` 返回 404，`/api/admin` 的 12 个接口返回 404；源码契约用例——登录页不再有注册入口；用例——登录、登出、改密之后 `auth_audit_log` 不新增记录。
- Green：删除注册与邀请码的接口和界面、注册策略、`/api/admin`、`logAuthEvent` 的全部调用点；以它们为夹具的测试改用直接写库。
- 完成标准：新增用例全绿；登录、登出、改密、个人资料、会话管理回归用例保持通过。本任务不改 `src/db.ts` 与表结构。

**T2 去权限（D-E1 选 ②a 或 ②b 时；②b 的去角色另行拆分）**

- Red：源码契约用例——后端不再出现权限中间件与 `hasPermission`，前端不再出现 `requiredPermission` 与 `canManage*`。
- Green：删除权限定义、中间件及挂载、`manage_group_env` 判断、前端权限门；所有入口对已登录的唯一账号可见。
- 完成标准：契约用例全绿，`make typecheck` 与 `make build` 通过。

**T3 强制改密（D-E3 选 ① 时）**

- Red：用例——登录响应里不再出现强制改密状态，改密专用的跳转与拦截不再存在。
- Green：删除后端闸门与前端改密跳转。

**T4 文档同步与终验**

- 改写 `README.md`、`CLAUDE.md`、`AGENTS.md` 的产品定位（"多用户"改为"个人"），以及 `CLAUDE.md` §3.2 路由表的 `/users` 行、`/monitor` 行的权限说明和 §8 的权限中间件描述（v0.8 补充）；按 D-E6 处理 `docs/ACL-MATRIX.md`；同步 `docs/API.md`。
- `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- 人工冒烟（用户验收）：首启创建账号 → 登出后重新登录 → 设置页所有入口可见 → 改密后用新密码登录 → 渠道账号页正常。

**整体验收条件**

1. 首次启动只有"创建账号"一步；之后登录页没有注册入口。
2. `/api/auth/register*` 与 `/api/admin/*` 返回 404。
3. 唯一账号登录后能看到全部页面，包括系统配置与运行状态（E2 时）。
4. 对话、工作区、渠道账号、技能、定时任务正常；已有数据无需迁移。
5. IM 侧访问控制（主人、白名单、响应对象）行为不变。
6. 门禁：`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
7. 非目标未被实现：登录链路、数据归属判断均无改动，本专题不改表结构。

### 8.9 测试影响

- **E1**：删除或改写以注册接口、管理接口创建第二个用户的夹具；用户管理、邀请码相关用例删除。
- **E1 与 E2 下，以"两个用户互相隔离"为目标的用例仍然成立。** 它们靠测试夹具准备两个用户（`tests/helpers/route-test-user.ts`，执行时核实），而 `src/db.ts` 不动，所以会继续通过；但它们验证的场景在单账号产品里不会再出现，是否保留由用户在立项时决定。
- **到 E3 才会删除**的隔离类用例：`tests/routes-agents-acl.test.ts`（1,343）、`tests/routes-groups-owner-acl.test.ts`（1,331）、`tests/routes-messages-acl.test.ts`（397）、`tests/routes-mcp-server-isolation.test.ts`（333）、`tests/routes-workspace-config-acl.test.ts`（250）、`tests/routes-stop-interrupt-acl.test.ts`（145），以及 v0.8 补充的 `tests/task-acl.test.ts`、`tests/user-home-isolation.test.ts`、`tests/group-broadcast-acl.test.ts`、`tests/group-queue-user-concurrency.test.ts` 等。
- **不属于本专题，不要误删**：`tests/container-session-permissions.test.ts`（容器文件权限）、`tests/provider-auth-error.test.ts`（供应商鉴权），以及名字带 owner 的 IM 主人相关用例。

### 8.10 风险与回滚

- **产品定位变了。** 三份文档和论文都要从"多用户"改成"个人"。论文里"多用户认证与权限矩阵"一章删除，可改写为"个人版的认证与访问边界"：登录会话、WebSocket 来源校验、登录限流、IM 侧访问控制。
- **安全边界收缩为两层。** 登录会话和 IM 侧访问控制。密码成为唯一账号的唯一屏障，登录限流必须保留。
- **审计写入停掉后，登录、改密这些操作不再留痕。** 单账号产品里只有本人操作；如果日后再对外开放，需要恢复审计（D-E4）。
- **涉及文件多。** E2 大约涉及 30 个源文件和数十个测试文件，必须按任务拆分逐步提交。
- **与 Docker 专题有交叉。** 主机执行要求管理员角色（`canExecuteOnHost`），单账号下恒为真；"管理员纯宿主机模式"的文案要改（V-E5）。
- **回滚。** 每个任务独立提交，`git revert <提交号>`。

## 9. 专题 F：清理用不到的数据表

**裁决：裁（2026-11-24，用户：自定义单价表一并删除，所有用不到的表一并裁减）。状态：待立项，排在其余专题之后。** 本项取代第一轮"`src/db.ts` 一字不动"的安全线，属于破坏性变更，按宪法第二节第 2 条须在立项时明确确认。

### 9.1 现状

全库 44 张表：41 张正式表，3 张迁移用的临时表。按表级分析，目前全部在运行时被读写，没有已经死掉的表。"用不到"只会因为裁剪而产生。

### 9.2 逐表结论

裁剪全部落地后没有读写方的表有 5 张：

| 表                     | 现在谁在读写                                 | 裁完之后                 | `src/db.ts` 里相关的函数                   |
| ---------------------- | -------------------------------------------- | ------------------------ | ------------------------------------------ |
| `usage_records`        | `/api/usage`、记账层、气泡回写               | 无（§6）                 | 与 `usage_events` 合计 9 个函数、约 580 行 |
| `usage_events`         | 记账层、气泡回写                             | 无（§6）                 | 同上                                       |
| `custom_model_pricing` | `/api/pricing`、记账层                       | 无（§6）                 | 5 个函数、140 行                           |
| `invite_codes`         | 注册接口、`/api/admin`                       | 无（§8）                 | 5 个函数、182 行                           |
| `auth_audit_log`       | 登录、登出、改密时写入；只有 `/api/admin` 读 | 没有读方，写入随 §8 停掉 | 2 个函数、101 行                           |

合计 21 个函数、1,004 行。另有 `registerUserWithoutInvite`（`src/db.ts:9958`）只写 `users` 表，不属于这五张表，但 §8 下线注册后它没有调用方，与这 21 个函数在同一次 `src/db.ts` 清理里删除（v0.8 补充）。其余 36 张正式表都在用：消息与会话 5 张、工作区 4 张、渠道绑定与可靠性 9 张、定时任务 3 张、Agent 档案 4 张、工作区记忆 8 张、账号与登录 3 张。

### 9.3 怎么删

仓库已有六次同类先例，都在 `src/db-schema/migrations-channel-trims.ts`（旧记忆表、待审批表、三个退役渠道的数据、billing 表族、用量日汇总表、定时任务的旧租约列）。照同一套做法：

1. **先停写。** 在各自的专题里删除对这些表的全部读写调用。先例的要求是写路径与删表在同一变更里移除。
2. **去掉建表语句。** `usage_records` 与 `usage_events` 在 `src/db-schema/usage-tables.ts:21-82`，`custom_model_pricing` 在 `src/db-schema/agent-profile-tables.ts:139`，`invite_codes` 与 `auth_audit_log` 在 `src/db-schema/auth-tables.ts:44`、:68。新库从此不再创建它们。
3. **加一版前向迁移。** 版本号从当时的当前版本（现为 78）升一版，对旧库执行 `DROP TABLE IF EXISTS`。写法与 v76 到 v77 那一段相同：带版本判断、包在事务里、删除后写日志。
4. **删除 `src/db.ts` 里对应的 21 个函数**，连同 `stmts()` 里引用用量表的预处理语句和相关类型。
5. **同步测试。** `tests/db-upgrade-safety.test.ts:578` 把版本号钉在 78，要改成新版本号，并按先例补三个用例：旧库升级后表不存在、新库首次启动表不存在、迁移前备份存在。`tests/schema-v51-usage.test.ts` 删除。
6. **同步文档。** `CLAUDE.md` §7 的核心表族清单等。

### 9.4 数据与回滚

- **这五张表里的历史数据会丢失**：用量记录、自定义单价规则、邀请码、登录审计记录。其他表的数据不受影响。
- **回滚路径是迁移前备份。** 升级时 `enforcePreMigrationBackup`（`src/db.ts:454`）会先在 `data/db/migration-backups/` 下生成一份完整备份，文件名形如 `messages-v78-to-v79-…db`；备份失败则拒绝迁移。
- **代码回滚不等于数据回滚。** 数据库一旦升级，把代码退回删表之前会被"拒绝降级"的检查挡住，必须同时用备份恢复数据库。所以本专题排在最后，默认只做一次。

### 9.5 列的清理（未裁决）

表之外还有列会随裁剪失去用途，先例里表和列是一起删的。候选如下，均需逐列核实：

| 列                                             | 何时失去用途             |
| ---------------------------------------------- | ------------------------ |
| `users.permissions`                            | §8 做到 E2 之后          |
| `users.must_change_password`                   | 去掉强制改密之后（D-E3） |
| `users.disable_reason`、`users.notes`          | 用户管理裁掉之后         |
| `users` 表中与邀请码相关的列（是否存在待核实） | 注册下线之后             |

是否纳入由 D-F2 决定；做的话与删表放在同一版迁移里。

### 9.6 需用户决策

| #    | 问题                       | 选项                                                                               | 说明                                                                               |
| ---- | -------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D-F1 | 什么时候删                 | ① 其余专题全部落地后，用一版迁移一次删完（默认）；② 每个专题内各自删表、各自升版本 | ① 只有一次备份和一个恢复点；② 每个专题可独立回滚，但要升多次版本、多次改版本号钉   |
| D-F2 | 是否连带清理用不到的列     | ① 只删表（默认）；② 表和列一起删，放在同一版迁移                                   | ② 更彻底，但列的候选要逐个核实，且多数取决于 §8 做到哪一层                         |
| D-F3 | 这五张表的历史数据能否丢弃 | ① 可以丢弃；② 需要先导出留存                                                       | 用量表可能很大。用量页裁掉之后只能直接从数据库导出，所以要留存的话得在 §6 之前导出 |

**2026-11-25 用户拍板**：D-F1 ①、D-F2 ①、D-F3 ①（均与方案默认一致）；执行结果见 [THESIS-14 交付记录](THESIS-14-drop-dead-tables.md#交付记录)。

### 9.7 执行时核实项（先核实再动刀）

| #    | 核实内容                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-F1 | `stmts()` 中引用 `usage_records` 的预处理语句，以及 `src/db.ts` 中与五张表相关的类型定义。**预处理语句已结案（v0.8）**：`insertUsageInsert`，见 V-C6             |
| V-F2 | 以这五张表为前置的测试：`tests/task-usage-routing.test.ts`、`tests/usage-accounting.test.ts` 随 §6 删除；`tests/backup-restore-safety.test.ts`（859 行）是否涉及 |
| V-F3 | 被删表上的索引与外键（`invite_codes.created_by` 指向 `users`），确认删除顺序不被外键检查挡住                                                                     |
| V-F4 | 列的候选清单逐列核实（对应 D-F2）                                                                                                                                |
| V-F5 | `CLAUDE.md` §7 的表族清单里仍列着 `usage_daily_summary`，而这张表已在 v77 删除；同步文档时一并更正（v0.8 已确认）                                                |
| V-F6 | 立项时按当时的最终裁剪状态重新核对一遍"用不到"的名单                                                                                                             |

### 9.8 任务拆分

**T0 立项（不删码）**：确认 D-F1 至 D-F3；前置条件是 §6 与 §8 对这五张表的读写调用已全部删除；重置 `.gatescope.json`。

**T1 迁移**

- Red：按先例在 `tests/db-upgrade-safety.test.ts` 先写失败用例——旧库升级后五张表不存在，新库首次启动五张表不存在，迁移前备份存在。
- Green：去掉建表语句，加删表迁移，`CURRENT_SCHEMA_VERSION` 升一版。
- 完成标准：新增用例全绿，版本号钉已更新。

**T2 清理数据库代码**

- Red：源码契约用例——`src/db.ts` 不再出现这五张表的名字。
- Green：删除 21 个函数、相关预处理语句与类型；按 D-F2 处理列。
- 完成标准：契约用例全绿，`make typecheck` 通过。

**T3 文档同步与终验**

- 同步 `CLAUDE.md` §7 的核心表族清单、`docs/API.md`、`AGENTS.md` 中关于表结构的描述。
- `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
- 人工冒烟（用户验收）：用升级前的数据库副本启动 → 自动生成迁移备份 → 登录、对话、定时任务、渠道、记忆全部正常 → `data/db/migration-backups/` 下有备份文件。

**整体验收条件**

1. 旧库升级后与新库首次启动后，五张表都不存在。
2. 迁移前自动生成完整备份，备份可被 SQLite 打开。
3. 其余 36 张正式表的数据与对应功能不受影响。
4. `src/db.ts` 中不再有这五张表的函数与建表语句。
5. 门禁：`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
6. 迁移链未被重写：升级前的各版迁移步骤原样保留。

### 9.9 风险与回滚

- **不可只靠代码回滚。** 见 §9.4。
- **裁剪范围再变，名单也会变。** 例如 §8 若只做到 E1，五张表的结论不变，但列的候选会不同。立项时按最终状态重新核对（V-F6）。
- **气泡回写与账本耦合。** 见 §6.3。那部分改动属于 §6 的 T2，必须在删表之前完成并验证。
- **回滚。** 代码 `git revert <提交号>`，同时用迁移前备份恢复数据库。

## 10. 专题 G：桌面端——裁掉

**裁决：裁（2026-11-24，用户）。条件是删掉之后仍能访问本地电脑的文件；经核实条件成立。状态：待立项。** 本项取代第一轮裁决 5"Electron 桌面端保留"。可以在任何时间执行，与其他专题没有依赖。

### 10.1 条件核实：本地文件访问不依赖桌面端

- **桌面端只是一个窗口。** `electron/src/main/index.ts`（334 行）只做三件事：开窗口加载网页界面（默认地址 `http://127.0.0.1:3001`）、记住窗口的位置和大小、提供应用菜单。窗口里的页面运行在沙箱中，关闭了 Node 集成（:222-228），没有任何文件系统能力。
- **它暴露给页面的接口都与文件无关。** `electron/src/preload/index.ts`（27 行）只暴露五个：取配置、打开外部链接、重试、刷新、关于对话框。
- **后端和网页客户端都不依赖它。** 后端、runner、脚本里没有一处提到 electron；网页客户端里也没有调用桌面接口的代码（`web/src/components/layout/AppLayout.tsx:17` 的 `isDesktop` 只是"宽屏"的媒体查询，与桌面端无关）。
- **本地文件访问全在后端。** 上传下载（`src/routes/files.ts`）、工作区文件面板（`web/src/components/chat/FilePanel.tsx`）、宿主机目录浏览（`src/routes/browse.ts`、`DirectoryBrowser.tsx`）、宿主机目录挂载（`HostDirectoryMountEditor.tsx`、`src/mount-security.ts`），以及 Agent 读写文件（主机模式直接读写，容器模式经挂载）。这几部分合计约 4,500 行，全部是后端和网页客户端的实现。
- **打包版也不自带后端。** 桌面端启动时只去连已经在运行的后端，连不上就显示"Backend 未连接"的错误页（`electron/src/main/index.ts:187-207`）。所以它从来不是一个独立的应用。

### 10.2 目标

删掉桌面端，改用浏览器访问：生产模式 `http://127.0.0.1:3001`，开发模式 `http://127.0.0.1:5174`。裁剪后，文件上传下载、工作区文件、宿主机目录挂载、Agent 读写文件全部照常。

### 10.3 会失去什么

- 独立窗口和应用菜单、窗口位置记忆、单实例锁、关于对话框。
- 可安装的安装包（dmg、zip、nsis、AppImage）。
- 独立的登录状态。见 §10.8 的浏览器注意事项。

### 10.4 删除范围（估算）

| 部分              | 锚点（d6e04aa）                                                                                                                                                                                                                  | 行数（估）               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 桌面端源码与配置  | `electron/` 目录 8 个文件：`src/main/index.ts`（334）、`src/main/menu-template.ts`（56）、`src/preload/index.ts`（27）、`electron-builder.yml`（37）、`package.json`（10）、`tsconfig.json`（15），另有两个图标文件（约 2.3 MB） | 约 480                   |
| 启动脚本          | `start-desktop.command`（58）、`start-desktop.bat`（22）                                                                                                                                                                         | 80                       |
| 测试              | `tests/electron-menu-contract.test.ts`（126）、`tests/electron-shell-contract.test.ts`（38）                                                                                                                                     | 164                      |
| 根 `package.json` | 七条 `desktop:*` 脚本（:25-31）；开发依赖 `electron`、`electron-builder`（:58-59）；关键字（:90-91）；`allowScripts` 里的 `electron@39.8.10`、`electron-winstaller@5.4.0` 两条（:97-98），`esbuild` 的两条（:99-100）按 D-G3     | 约 15                    |
| 零散引用          | `.gitignore:6` 的 `/electron/release/`；`restart-dev.command` 里的桌面端部分（按 D-G2）；`web/vite.config.ts:6-7` 注释里"两仓桌面端可同时运行"的措辞                                                                             | 零散                     |
| 合计              |                                                                                                                                                                                                                                  | 约 750（不含测试约 590） |

删除开发依赖后要跑一次 `npm install` 更新 `package-lock.json`，与第一轮删 `dingtalk-stream` 时的做法相同。

### 10.5 需用户决策

| #    | 问题                  | 选项                                                                                                                          | 说明                                                                                                               |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D-G1 | 两份桌面端历史文档    | ① `docs/desktop-identity-split-plan.md` 删除，`docs/dual-desktop-port-isolation-plan.md` 保留（默认）；② 两份都删；③ 两份都留 | 前者只讲桌面应用的身份与锁，随桌面端失效；后者讲本仓为什么用 3001 和 5174 端口，两个仓库并排运行网页服务时仍然适用 |
| D-G2 | `restart-dev.command` | ① 去掉其中启动桌面端的部分，保留重启前后端的功能（默认）；② 整个删除                                                          | 脚本一共 66 行，桌面端相关约 15 行                                                                                 |
| D-G3 | 开发依赖 `esbuild`    | ① 连同删除（默认）；② 保留                                                                                                    | 根目录声明它只用于两条 `desktop:build:*` 脚本，前端由 Vite 自带。执行时核实（V-G1）                                |

### 10.6 执行时核实项（先核实再动刀）

| #    | 核实内容                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-G1 | 除了两条 `desktop:build:*` 脚本，全仓是否还有地方直接调用 `esbuild`；`package.json` 的 `allowScripts` 里它的两条是否还需要                                                        |
| V-G2 | README 和 `AGENTS.md` 之外（如 `CLAUDE.md`、`docs/API.md`）是否还有桌面端描述。**已结案（v0.8）**：`CLAUDE.md`、`docs/API.md` 都没有；README 约 26 行、`AGENTS.md` 3 行（:48-50） |
| V-G3 | 删掉开发依赖并更新 lockfile 后，`make install` 能否通过                                                                                                                           |

### 10.7 任务拆分

**T0 立项（不删码）**：确认 D-G1 至 D-G3；重置 `.gatescope.json`。

**T1 依赖与脚本**

- Red：源码契约用例——`package.json` 不再有 `desktop:*` 脚本，也不再有 `electron` 与 `electron-builder`（`esbuild` 按 D-G3）。
- Green：改 `package.json`，跑 `npm install` 更新 lockfile；按 D-G2 处理 `restart-dev.command`；删除两个启动脚本。
- 完成标准：契约用例全绿；`make install` 在新 lockfile 下通过。

**T2 源码与测试**

- Green：删除 `electron/` 目录与两个测试文件；清理 `.gitignore` 与 `web/vite.config.ts` 的注释。
- 完成标准：`npm run verify` 六步全绿。

**T3 文档同步与终验**

- 同步 `README.md`（约 26 行：入口列表、界面截图说明、Electron Desktop 小节、启动说明、命令表）与 `AGENTS.md`（3 行：技术栈、目录结构、构建产物）。
- 人工冒烟（用户验收）：启动服务 → 浏览器打开 → 登录 → 上传一个文件 → 在工作区文件面板里打开它 → 让 Agent 读取工作区里的一个文件。

**整体验收条件**

1. 仓库里没有 `electron/` 目录，`package.json` 没有 `desktop:*` 脚本和 electron 相关依赖。
2. `make install` 通过，`npm run verify` 六步全绿，`node scripts/check-scope.mjs` 通过。
3. 浏览器里文件上传、下载、工作区文件面板、宿主机目录挂载照常。
4. Agent 能读写工作区文件（主机模式与容器模式各验一次）。
5. 非目标未被实现：文件相关的后端与网页客户端代码没有功能性改动。

### 10.8 风险与回滚

- **登录状态改由浏览器管理。** Cookie 不区分端口。本仓和主仓用同一个 cookie 名、不同的签名密钥（交付档 §9），在同一个浏览器里同时登录两个仓库会互相顶掉。演示时用不同的主机名（`localhost` 和 `127.0.0.1`），或者用不同的浏览器配置文件。
- **端口沿用 3001 和 5174。** 这是为两个仓库并排运行定下的，桌面端删除后仍然有效，不改。
- **第一轮交付档 §9 的桌面端登录问题随之消失。** 该记录保留作历史。
- **回滚。** 一到两个提交，`git revert <提交号>`，lockfile 一并回滚。

## 11. 前端裁减清单与清扫规则（跨专题）

**裁决：裁一个功能时，它的前端代码一并裁净（2026-11-24，用户）。** 本节按 import 依赖关系逐个专题核对过，基线为 `d6e04aa`。`web/src` 共 232 个非测试模块。

### 11.1 规则

- 一个功能裁掉之后，前端不留任何只为它服务的代码：页面、组件、store、工具函数、类型、路由与旧地址重定向、导航项、权限判断、事件监听、第三方依赖。
- 清扫挂在各专题的最后一个任务上（§5 的 T5、§6 的 T5、§8 的 T4），检查项见 §11.4。这些检查项同时算作各专题验收条件的一部分。
- 判定用依赖关系，不靠人工记忆：从 `web/src/main.tsx` 按 import 关系可达的文件之外，不应再有不可达的非测试文件。类型声明文件和 `make sync-types` 同步出来的副本不算。

### 11.2 整文件删除

| 专题                 | 整文件删除                                                                                                                                                                           | 行数     | 删除后仍要修改的保留文件                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §6 用量与模型单价    | 8 个：`pages/UsagePage.tsx`、`stores/usage.ts`、`components/usage/` 下 2 个、`utils/usage-format.ts`、`ModelPricingSection.tsx`、`ModelPricingDialog.tsx`、`stores/model-pricing.ts` | 约 2,830 | `App.tsx`（懒加载、`/usage` 路由、加载占位组件）、`SettingsPage.tsx`（标签类型、旧地址重定向、标题、渲染）、`SettingsNav.tsx`（"模型单价"导航项与图标导入）、`nav-items.ts`（"用量"导航项）、`ChatPage.tsx`（"用量统计"菜单）、`stores/auth.ts`（用量 store 的重置）、`MessageBubble.tsx`、`lib/token-usage-presentation.ts` 与 `stores/chat.ts`（按 D-C2；`stores/chat.ts` 为 v0.8 补充） |
| §5 供应商官方        | 1 个：`settings/UsageBars.tsx`                                                                                                                                                       | 约 120   | `ProviderEditor.tsx`、`SetupProvidersPage.tsx`、`ProviderList.tsx`、`settings/types.ts`（官方与 OAuth 的类型字段）                                                                                                                                                                                                                                                                         |
| §8 个人用户（含 §7） | 7 个：`pages/UsersPage.tsx`、`components/users/` 下 4 个、`stores/users.ts`、`settings/RegistrationSection.tsx`                                                                      | 约 1,490 | `App.tsx`（`/users` 路由与权限守卫）、`SettingsPage.tsx`、`SettingsNav.tsx`、`stores/auth.ts`（注册与权限类型）、`AuthGuard.tsx`、`LoginPage.tsx`（注册页签）、`nav-items.ts`、`UnifiedSidebar.tsx`、`BottomTabBar.tsx`、`MonitorPage.tsx`、`AppearanceSection.tsx`、`utils/routeRestore.ts`                                                                                               |
| §10 桌面端           | 无。网页客户端里没有桌面端专属代码                                                                                                                                                   | 0        | 无                                                                                                                                                                                                                                                                                                                                                                                         |
| §9 数据表            | 无。表结构不涉及前端                                                                                                                                                                 | 0        | 无                                                                                                                                                                                                                                                                                                                                                                                         |
| 合计                 | 16 个文件                                                                                                                                                                            | 约 4,440 |                                                                                                                                                                                                                                                                                                                                                                                            |

按 import 关系核对的结果：这些文件没有被它们独占的下游模块，删掉之后不会留下新的孤儿文件。

### 11.3 第三方依赖

- **`recharts` 随 §6 删除。** 这个图表库在 `web/package.json` 里，全仓只有一个文件引用它，就是用量页的趋势图 `web/src/components/usage/UsageTrendChart.tsx`。删除后跑一次 `npm install` 更新 `web/package-lock.json`。
- 其余依赖在裁剪之后都还有保留文件在用，已逐个核对。

### 11.4 清扫检查项

1. **可达性。** 从 `web/src/main.tsx` 按 import 关系走一遍，没有不可达的非测试文件。
2. **死导出。** 共享的类型文件和工具文件里，没有只为被裁功能服务的导出。
3. **入口。** 路由、旧地址重定向、主导航、设置导航、聊天页菜单里没有被裁功能的入口。
4. **权限与事件。** 没有指向被裁功能的权限判断、WebSocket 事件监听和 store 字段。
5. **依赖。** `web/package.json` 里没有只被被裁功能使用的包。
6. **文案与测试。** 界面文案、术语测试、路由测试的样例里没有被裁功能的名称。已知两处：`web/src/utils/chat-route-preload.test.ts:15` 拿 `/register` 当样例路径，`web/tests/e2e/mobile-chat-harness.tsx:21` 的用户夹具带 `permissions` 字段。
7. **图标与样式。** 没有只为被裁功能导入的图标。样式表里没有被裁功能的专属样式，这一条现在就成立（`web/src/styles/globals.css` 已查）。

第一轮在前端清扫轮里做过同样的事（交付档 §8）。

### 11.5 需用户决策

| #    | 问题                     | 选项                                         | 说明                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-H1 | 既有的死导出是否顺手删除 | ① 否，另立任务（默认）；② 是，清扫时顺手删除 | **v0.8 撤销本项，前提不成立**：`BalancingConfig` 经同文件的 `ProvidersListResponse.balancing` 被 `ClaudeProviderSection.tsx` 使用，只是 `export` 多余；`withAgentContextSource` 有专门测试（`tests/frontend-agent-product-contract.test.ts`），属于意图信号，默认保留。`OAuthUsageResponse` 属于被裁功能的类型，随 §5 删除，不算扩大范围 |

## 12. 现状基线：代码量（main `d6e04aa`，2026-11-24 测量）

口径：`git ls-files` 跟踪的文件，不含 `node_modules` 与构建产物；"有效行"是去掉空行和整行注释后的估算。

| 类别                                       | 文件数  | 行数                          |
| ------------------------------------------ | ------- | ----------------------------- |
| 后端 `src/`                                | 236     | 118,559                       |
| 前端 `web/src/`                            | 232     | 57,859                        |
| Agent Runner `container/agent-runner/src/` | 28      | 7,539                         |
| 共享类型、桌面壳                           | 9       | 1,054                         |
| **业务源码合计**                           | **505** | **185,011**（有效行 158,643） |
| 测试                                       | 364     | 85,925                        |
| 文档与 Prompt                              | 96      | 9,362                         |
| 容器脚本、工程脚本                         | 33      | 5,085                         |
| 锁文件、配置、静态资源                     | 56      | 22,933                        |
| 合计                                       | 1,054   | 308,316                       |

业务源码按功能模块归类：

| 模块                                                    | 源码（万行） | 测试（万行） |
| ------------------------------------------------------- | ------------ | ------------ |
| IM 渠道及消息管道                                       | 4.70         | 2.10         |
| 核心骨架（启动、WebSocket、数据库、认证、工作区与会话） | 3.94         | 2.66         |
| Agent 运行时（Runner 封装、容器与主机执行、流式解析）   | 1.66         | 0.75         |
| 定时任务                                                | 1.43         | 0.74         |
| Web 对话界面                                            | 1.30         | 0.01         |
| Agent 档案与 Agent Builder                              | 1.17         | 0.91         |
| 技能与 MCP 管理                                         | 1.14         | 0.36         |
| 供应商与系统配置                                        | 1.02         | 0.40         |
| 记忆                                                    | 0.57         | 0.24         |
| 管理监控（用户、邀请、审计、监控页、反馈）              | 0.55         | 0.03         |
| 用量与定价                                              | 0.52         | 0.33         |
| 文件与终端                                              | 0.49         | 0.04         |
| 合计                                                    | 18.50        | 8.59         |

口径说明：

- 模块归类按文件名与函数名关键字估算。`src/index.ts`（15,135 行）与 `src/db.ts`（10,704 行）按顶层函数名拆入各模块，单个模块的误差在百行量级。
- IM 渠道 4.70 万行中，飞书适配器约 1.22 万、QQ 约 0.34 万、微信约 0.33 万、后端通用渠道设施约 1.86 万、前端渠道界面约 0.56 万。
- 桌面壳（0.04 万行）计入核心骨架。
- `container/agent-runner` 目录名带 container，但 Host 与 Container 两种模式共用，不属于 Docker 专属。
- 与第一轮交付档的数字不可直接相减：交付档统计的是 git 增删行数，本文统计的是文件行数。

## 13. 已评估、未采纳的建议（备查）

| 建议（2026-11-24 评估）                           | 结论                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| 裁监控页                                          | 与第一轮裁决 3 冲突；本轮用户确认保留（管理后台只留运行状态，§7）                |
| 裁用户、邀请、审计管理                            | 2026-11-24 用户改裁，已转为 §7 的执行项；用户随后裁决只做个人用户，并入 §8       |
| 裁用量分析                                        | 2026-11-24 用户改裁，已转为 §6 的执行项                                          |
| 裁 Electron 桌面端                                | 2026-11-24 用户改裁（条件"删后仍能访问本地文件"已核实成立），已转为 §10 的执行项 |
| 裁 QQ 与微信，飞书视选题保留                      | 与第一轮裁决 1 冲突，未采纳                                                      |
| 技能与 MCP 视选题保留                             | 与第一轮裁决 6 冲突（核心深耦合），未采纳                                        |
| 定时任务、记忆库、Agent 档案列为"可裁 / 看选题"   | 在第一轮保留清单内，未获裁决，不重提                                             |
| 裁终端、留文件上传                                | 终端依赖 `docker exec`；Docker 保留则不受影响                                    |
| 裁 Docker 模式                                    | 用户裁决保留（§4）                                                               |
| 动 IM 消息管道、兼容与迁移代码                    | 评估即不建议；兼容与重复实现的收敛已由 ISSUE-10、ISSUE-11 完成                   |
| 去数据归属（E3）                                  | 评估不建议：引用面广而单账号下判断恒为真；是否执行见 D-E1                        |
| "必留四模块约 7.9 万行为毕设主线、下限约 11 万行" | 基于上述建议的推算，已失效；论文主线以第一轮保留清单扣除本轮改裁项为准           |

## 14. 待确认事项（TODO）

| #   | 事项                                                                                                                                       | 影响                            | 由谁确认                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | 本院《毕业设计（论文）管理细则》与任务书的实际要求：代码量、查重、AIGC 检测、AI 工具使用声明、是否收源码或逐段走查                         | 决定论文与演示的范围            | 用户                                                                                                                |
| 2   | 毕设题目与论文主线                                                                                                                         | 决定演示范围                    | 用户                                                                                                                |
| 3   | §1 引用的院校细则与教育部抽检办法的原文（[北京理工大学管理细则](https://me.bit.edu.cn/docs/2019-05/6e87cd0652084a2d9959551b9f0b2e31.pdf)） | 核对后可去掉"原文未核对"标注    | 评估会话                                                                                                            |
| 4   | §5.7 的 D-1 至 D-4                                                                                                                         | 供应商专题立项的前置            | 用户                                                                                                                |
| 5   | 可用的第三方端点                                                                                                                           | 供应商专题裁剪后的演示依赖      | 用户                                                                                                                |
| 6   | §6.5 的 D-C3（D-C1、D-C2 已定）                                                                                                            | 用量专题立项的前置              | **已拍板 ②**（2026-11-25）                                                                                          |
| 7   | §7.5 的 D-D2（§7 不单独执行，见 §7）                                                                                                       | 管理后台专题立项的前置          | 用户                                                                                                                |
| 8   | §8.6 的 D-E1、D-E2、D-E3、D-E5、D-E6、D-E7（D-E4 已定）                                                                                    | 个人用户专题立项的前置          | 用户                                                                                                                |
| 9   | 存量数据里是否有第二个账号，以及它名下的工作区和渠道账号                                                                                   | 对应 D-E5；敏感区，代理不读     | 用户；**2026-11-25 已结案**：本机只有 1 个账号（[核实记录](../issues4/README.md#四部署前置与用户操作代理不能代办)） |
| 10  | §9.6 的 D-F1 至 D-F3，尤其是五张表的历史数据能否丢弃                                                                                       | 数据表专题立项的前置            | 用户                                                                                                                |
| 11  | §10.5 的 D-G1 至 D-G3                                                                                                                      | 桌面端专题立项的前置            | 用户                                                                                                                |
| 12  | §11.5 的 D-H1（v0.8 撤销，见 §11.5）                                                                                                       | 前端清扫时是否扩大一点范围      | 用户                                                                                                                |
| 13  | 演示机的 Docker：是否预先拉好镜像，或调整 Makefile 的拉取步骤                                                                              | 影响演示当天能否启动            | 用户                                                                                                                |
| 14  | `AGENTS.md` 记录的远程地址是 `ckq184/Personnal-agent.git`，实际是 `ckq184/text.git`                                                        | 文档漂移                        | 用户                                                                                                                |
| 15  | 是否把本文登记进 `AGENTS.md` 的文档索引或任务池 README                                                                                     | 便于新会话先读裁决台账          | 用户                                                                                                                |
| 16  | 是否把代码量统计脚本入库                                                                                                                   | 决定 §12 的数字以后能否一键重测 | 用户                                                                                                                |
| 17  | 六项专题的任务编号与分支名（v0.8：编号已在任务池分配为 THESIS-01 至 THESIS-15，分支名立项时定）                                            | 立项时需要                      | 用户                                                                                                                |
| 18  | 前端可达性契约测试是否入库（审核建议 O7，任务包 THESIS-15）                                                                                | 决定 §11.4 第 1 条能否自动核对  | **已采纳**（2026-11-25）                                                                                            |

## 15. 变更记录与维护规则

| 日期       | 版本   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 决策人                                                                                   |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 2026-11-24 | v0.1   | 创建：裁决台账、Docker 保留、供应商裁官方方案、代码量基线、未采纳建议备查、待确认事项                                                                                                                                                                                                                                                                                                                                                                                                    | 用户裁决（Docker 保留、供应商裁官方）；其余由评估会话整理                                |
| 2026-11-24 | v0.2   | 新增专题 C 用量分析、专题 D 管理后台；台账登记两项改裁；原 §6 至 §9 顺延为 §8 至 §11                                                                                                                                                                                                                                                                                                                                                                                                     | 用户裁决（裁用量分析；管理后台裁注册策略与用户与访问，只留运行状态）；其余由评估会话整理 |
| 2026-11-24 | v0.3   | 新增专题 E 只做个人用户；台账登记多用户体系改裁，用户与访问、注册策略并入 §8；原 §8 至 §11 顺延为 §9 至 §12；补充 E3 的具体含义                                                                                                                                                                                                                                                                                                                                                          | 用户裁决（只做个人用户）；其余由评估会话整理                                             |
| 2026-11-24 | v0.4   | 模型单价裁决裁掉；§6 改为三层一起裁（L3），补充定价层锚点与核实项；D-C1 结案                                                                                                                                                                                                                                                                                                                                                                                                             | 用户裁决（裁模型单价）；"停记账随之执行"是评估会话依依赖关系的推定，立项时请用户确认     |
| 2026-11-24 | v0.5   | 聊天气泡裁决只保留耗时（D-C2 结案）；新增专题 F 清理用不到的数据表，取代"数据库不动"的安全线；D-E4 结案；更正"用量表只有 `/api/usage` 在读"的错误；原 §9 至 §12 顺延为 §10 至 §13                                                                                                                                                                                                                                                                                                        | 用户裁决（气泡只留耗时；用不到的表一并删除）；其余由评估会话整理                         |
| 2026-11-24 | v0.6   | 桌面端改裁，条件"删后仍能访问本地文件"已核实成立；新增专题 G；原 §10 至 §13 顺延为 §11 至 §14                                                                                                                                                                                                                                                                                                                                                                                            | 用户裁决（裁桌面端，附条件）；条件核实由评估会话完成                                     |
| 2026-11-24 | v0.7   | 新增 §11 前端裁减清单与清扫规则：按 import 依赖关系核对各专题的前端整文件、保留文件里的死片段与第三方依赖（`recharts` 随用量页删除）；原则增加"前端一并裁净"；原 §11 至 §14 顺延为 §12 至 §15                                                                                                                                                                                                                                                                                            | 用户裁决（被裁功能的前端代码一并裁减）；清单核对由评估会话完成                           |
| 2026-11-24 | v0.8   | 按代码审核（基线 `d6e04aa`）修正漂移：§6 写账本调用点由两处改为五处、飞书费用一行改判为来自定价层（V-C1 结论反转，D-C3 选项重写）；§5 的 `oauthAccount` 剥离与残留凭据清理改列不动清单，`bug-report` 判断改为改写，`anthropicApiKey` 改为共用字段；§8 补充角色判断规模，E2 拆为 E2a/E2b，补充"D-E5 ① 下存量账号仍能登录"并新增 D-E7；撤销 D-H1；更正 `logAuthEvent` 调用数、桌面端脚本行数等数字；10 个核实项结案；§7 不单独立项；各专题拆成 THESIS-01 至 THESIS-15 任务包。详见审核报告 | 审核会话整理；E2 拆分、D-C3 选项、THESIS-15 待用户拍板                                   |
| 2026-11-25 | v0.9   | 第三轮重裁（用户拍板，详见 [personal-slim](../issues4/task-personal-slim-plan.md) §2）：台账 #12 去掉角色（推翻 D-E1 ②a，数据归属 E3 仍不做）、#15 收窄为只保运行时兼容（迁移链不动）、#9 裁掉 Bug 报告、#13 裁掉 Agent 档案生成与润色；执行包为 docs/issues4 的 THESIS-19 至 33                                                                                                                                                                                                         | 用户拍板                                                                                 |
| 2026-11-25 | v0.9.1 | §14 待确认第 9 项（存量第二个账号，对应 D-E5）结案：经用户授权只读核实本机开发实例只有 1 个账号；THESIS-10、11 交付记录与 issues3 README 第四节同步补注                                                                                                                                                                                                                                                                                                                                  | 用户授权核实                                                                             |
| 2026-11-26 | v0.9.2 | 第三轮方案升 v1.1（用户 2026-11-25 拍板，详见 [personal-slim](../issues4/task-personal-slim-plan.md) §2、§11）：台账 #12 由"去掉角色、保留归属"改为"只保留管理员一个角色，数据归属与按用户作用域一并裁减"，推翻本文 §13 对去数据归属（E3）的否定；按用户旧数据不搬迁；MCP 合并为一个作用域；归属列保留不读；执行包增加 THESIS-34 至 37                                                                                                                                                   | 用户拍板                                                                                 |

维护规则：

1. **裁决变化**：改 §2，并在本节登记日期、内容、决策人。
2. **核实出新事实**：改对应专题，并在本节登记。
3. **某专题立项后**：执行细节以该任务的 plan 为准；本文只在 §2 更新状态（待立项、进行中、已交付及提交号）。
4. **新的裁减建议**：先对照 §2 与 §13；已裁决或已否决的不重提，确需重议的列为 §14 待确认项。
