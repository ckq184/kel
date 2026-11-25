# THESIS-13 个人用户（四）：产品定位与访问边界文档改写

| 字段          | 值                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                        |
| 领取人 / 分支 | claude/thesis-13-personal-docs-and-acl                                                                                                                                                                                        |
| 优先级        | P2                                                                                                                                                                                                                            |
| 类型          | 文档                                                                                                                                                                                                                          |
| 依赖          | THESIS-10；THESIS-11、12 若执行，则在其之后（文档要反映个人用户专题的最终状态）                                                                                                                                               |
| 阻塞          | 无                                                                                                                                                                                                                            |
| 可并行        | ✅ 03、04、05、07、09、15。⚠️ 01（`AGENTS.md`、`README.md`）；02、06、08（`docs/ACL-MATRIX.md` 整体改写、`CLAUDE.md` §3.2）。❌ 10、11、12（本包依赖它们）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/ACL-MATRIX.md`、`docs/API.md`、`web/src/**`（仅 V-E5 文案）                                                                                                                      |
| 需用户决策    | **是**：D-E6（`docs/ACL-MATRIX.md` 怎么处理）                                                                                                                                                                                 |
| 来源          | 方案 §8（T4）、§8.10                                                                                                                                                                                                          |

## 目标

把仓库文档里的产品定位从"多用户 Agent 工作台"改成"个人 Agent 工作台"，把权限矩阵改写为个人版的访问边界。

## 范围（锚点为 `d6e04aa`）

| 文件                 | 内容                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`          | :261"多用户认证、ACL、owner 生命周期……"等产品定位描述                                                                                                                                             |
| `CLAUDE.md`          | :21 产品定位；§3.2 路由表里 `/monitor` 的权限说明（若 THESIS-11 未改）；§8 认证与权限一节（"系统配置、用户、邀请和审计使用独立 Permission Middleware"等）。§7 表族清单由 THESIS-14 负责，本包不改 |
| `AGENTS.md`          | :47 产品定位                                                                                                                                                                                      |
| `docs/ACL-MATRIX.md` | 按 D-E6 改写或删除（333 行，原定义十一层权限）                                                                                                                                                    |
| 文案（V-E5）         | 设置页"管理员纯宿主机模式"里"普通成员仍固定使用 Docker"的说法，若 THESIS-10 未处理则在本包改写                                                                                                    |

改写后的访问边界只有两层：登录会话（含 WebSocket 来源校验与登录限流）和 IM 侧访问控制（机器人主人、发送者白名单、响应对象、激活方式、IM 命令的主人约束）。这也是方案 §8.10 建议的论文章节"个人版的认证与访问边界"的提纲。

## 非目标

- 不改代码行为。
- 不改 `AGENTS.md` 里远程地址的漂移（方案 §14 第 14 项，由用户另行决定）。

## 需用户决策（领取前拍板）

| #    | 问题                          | 选项                             | 方案默认 |
| ---- | ----------------------------- | -------------------------------- | -------- |
| D-E6 | `docs/ACL-MATRIX.md` 怎么处理 | ① 改写为"个人版访问边界"；② 删除 | ①        |

`AGENTS.md` 的文档索引和 `CLAUDE.md` §1 都引用了 `docs/ACL-MATRIX.md`，选 ② 要同步删除这些引用。

## 验收条件

1. `README.md`、`CLAUDE.md`、`AGENTS.md` 不再把产品描述为"多用户"。
2. `docs/ACL-MATRIX.md` 与代码一致：不再出现已删除的权限名、用户管理、邀请与审计层。
3. `npm run docs:check` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。

## 交付记录

- **提交**：`ac799d5`（立项）、`424aa1b`（Red）、`83efc82`（文档改写）、`034f06c`（审查处置）、`bb79c95`（复核处置）；本提交为交付（三处状态与记录）。
- **分支 / base**：`claude/thesis-13-personal-docs-and-acl`，base `da4920b`。
- **改动**：
  - `README.md`、`CLAUDE.md`、`AGENTS.md`：产品定位改为个人版；README 顺带校正"用量、账单""管理员初始化"等与 THESIS-06/08/10 后界面不符的表述；`CLAUDE.md` §6.1 的"每个用户/跨用户"改为"同一账号/跨账号"。
  - `docs/ACL-MATRIX.md`：按 D-E6 ① 整体改写为"个人版访问边界"，只保留登录会话与 IM 侧访问控制两层；补回仍有效的纵深防御（账号资源、工作区归属、删除/环境变量、Workspace Memory v2、Owner Profile、定时任务/`task-acl`/MCP、`adminHostOnlyMode`、legacy memory 410）；WebSocket 的"Docker Build 流"更正为"Docker pull 进度"。
  - `docs/API.md`：ACL 链接与访问措辞同步；`delete-impact` 影响面按实际响应收窄。
  - `tests/thesis-13-personal-docs.test.ts`：新增 6 个契约用例，锁定定位口径、ACL 两层结构、已删除标识符/路由与保留的边界符号。
- **验证**：`npm run verify` 6/6 全绿（366 文件，3015 通过 / 23 跳过 / 0 失败）；`node scripts/check-scope.mjs` 通过（12 个路径，含本记录与方案台账）；`npm run docs:check` 通过（127 个 Markdown）。
- **审查**：独立规格审查初轮 2 个阻塞（Docker Build 事实错误、方案台账未进范围声明），处置后复核通过；代码质量审查 M2 过度删减已补回，Minor 逐项处置。详见 `docs/审查记录.md`。
- **偏差 / 计划外修正**：新增 `tests/thesis-13-personal-docs.test.ts` 与 `docs/issues2/task-thesis-trim-plan.md` 超出 issue 的预计改动路径，已分别写入 plan §3 与 `.gatescope.json` allow；README 的"界面与体验""首次进入""渠道与自动化"三处校正不在 issue 逐条列出的锚点内，属同一产品定位与陈旧界面描述的顺带修正。
- **未做**：未实机验收（文档包，无运行界面变化）；未改代码行为、schema、表结构与 `data/`；`CLAUDE.md` §7 表族清单（`invite_codes`、`auth_audit_log`）留给 THESIS-14。
- **后续建议**：无新增 issue。
