# 任务立项：THESIS-13 个人用户（四）：产品定位与访问边界文档改写

> 立项日期：2026-11-25｜base：`da4920b`｜分支：`claude/thesis-13-personal-docs-and-acl`
> 来源：[docs/issues2/THESIS-13-personal-docs-and-acl.md](issues2/THESIS-13-personal-docs-and-acl.md)（方案 §8 T4、§8.10）

## 0. 需求采访结论（2026-11-25，用户拍板）

- **D-E6 = ① 改写**：保留 `docs/ACL-MATRIX.md`，改写为"个人版访问边界"，不删除。
- **依赖已满足**：main `da4920b` 上 THESIS-10、11、12 均已合入并标记"已完成"；本包在 main 之上开工，不回改它们的实现。
- **定位口径**：产品从"多用户 Agent 工作台"改为"个人 Agent 工作台"。文档里的"多用户"只保留在代码模块的客观描述里（若有），产品定位不再使用。
- **访问边界口径**：改写后的边界只有两层——登录会话（含 WebSocket 来源校验与登录限流）与 IM 侧访问控制（机器人主人、发送者白名单、响应对象、激活方式、IM 命令的主人约束）。数据归属与 admin 角色检查作为纵深防御如实记录，不再写成多用户权限层。
- **V-E5 已由 THESIS-10 处理**：`SystemSettingsSection.tsx` 的"普通成员仍固定使用 Docker"文案已删除，本包不改前端文案。

## 1. 关键事实（开工前核实，main `da4920b`）

- **产品定位写在三处**：`README.md:23`（"面向个人与团队"）、`CLAUDE.md:21`（"多用户 Agent 工作台"）、`AGENTS.md:47`（同）。另有 `README.md:208` 的"多用户认证、ACL……"与 `CLAUDE.md:58` 的"多用户、多账号渠道连接池"两处残留。
- **`docs/ACL-MATRIX.md` 当前 322 行、11 节**：THESIS-11 已把权限层改为 admin 角色，但仍保留"访问层次"表、`created_by` 多账号隔离、member 表述与旧权限层次描述。
- **代码现状（改写依据）**：
  - 公开接口：`GET /api/auth/status`、`POST /api/auth/setup`（仅用户表为空）、`POST /api/auth/login`、`GET /api/auth/avatars/:filename`、`GET /api/config/appearance/public`、`GET /api/health`；`/ws` 要求 Cookie Session + Origin 校验。
  - 会话：`authMiddleware` 校验 HMAC 签名 Cookie，拒绝禁用/已删除账号；登录限流按 `username:ip` 与 `username` 两级计数（默认 5 次 / 15 分钟，全局窗口 1 小时）。
  - 管理面：`adminRoleMiddleware` 仍挂在 `src/routes/config.ts` 与 `src/routes/monitor.ts` 的管理路由上；唯一账号恒为 admin。
  - Host 执行：`hasHostExecutionPermission()`（admin 角色）与 `canExecuteOnHost()`（执行时复查 active admin）。
  - 数据归属：`canAccessGroup()` / `canModifyGroup()` / `canDeleteGroup()`（`src/web-context.ts`）按 `created_by` 隔离，admin 无全局旁路；E2a 未删除归属逻辑。
  - IM 侧：`src/im-command-utils.ts` 的主人命令闸门、`src/im-audience-policy.ts` 的响应对象/激活策略；`owner_im_id`、allowlist、owner claim/release 均保留。
- **V-E5**：`web/src/components/settings/SystemSettingsSection.tsx` 已不含该文案（THESIS-10 测试 `tests/thesis-10-single-account.test.ts:223` 与 `tests/frontend-settings-information-architecture.test.ts:137` 锁定），本包不动前端。
- **既有测试约束**：
  - `tests/thesis-06-usage-page-removal.test.ts:168` 断言 ACL 文档不含 `/api/usage`；`tests/thesis-08-model-pricing-removal.test.ts:161` 断言不含 `/api/pricing` 与"模型单价"；`tests/thesis-10-single-account.test.ts:279` 断言不含 `/api/auth/register`。
  - `tests/frontend-product-terminology.test.ts` 断言 README 含"自托管、Pi Agent 驱动的多渠道智能体工作台"，改写时保留该句。
  - `tests/desktop-removal-contract.test.ts` 断言 README/AGENTS 不含 Electron/桌面端措辞，改写时不要引入。
  - `docs:check` 会校验 Markdown 本地链接存在，删改引用时必须同步。
- **文档引用面**：`CLAUDE.md:9/269`、`README.md:15/199/229`、`docs/API.md:11` 引用 `docs/ACL-MATRIX.md`；选 ① 后这些引用继续有效，只需把"权限矩阵/权限模型"的措辞改成"访问边界"。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-13-personal-docs.test.ts`：
   - README 的"产品定位"段、CLAUDE.md 的 §2 产品模型段、AGENTS.md 的 `- **产品**` 行不再出现"多用户"，且含"个人"。
   - `docs/ACL-MATRIX.md` 标题为"个人版访问边界"，含"登录会话"与"IM 侧访问控制"两层；不含已删除的权限名（`manage_system_config`、`manage_users`、`manage_invites`、`view_audit_log`、`manage_group_env`、`requirePermission`、`systemConfigMiddleware`、`usersManageMiddleware`、`inviteManageMiddleware`、`auditViewMiddleware`）与已删除的路由（`/api/auth/register`、`/api/admin`、`/api/usage`、`/api/pricing`）；不含"模型单价"。
   - ACL 文档仍覆盖保留项：`authMiddleware`、`adminRoleMiddleware`、`owner_im_id`、`audience_mode`、`activation_mode`、`im-audience-policy`、`im-command-utils`、`canAccessGroup`、`hasHostExecutionPermission`。
   - README 文档索引行与 `docs/API.md` 的链接措辞改为"访问边界"。
   - 先跑该用例，确认因文档仍是旧口径而失败。
2. **Green 文档**：
   - `docs/ACL-MATRIX.md` 整体改写为个人版两层次结构（公开接口/登录会话/WebSocket/数据归属 + IM 主人/白名单/响应对象/激活/命令约束 + 验证要求）。
   - `README.md`：产品定位段、执行与安全边界、项目状态、文档索引与链接标签，以及顺带校正的界面导航、首次初始化与渠道措辞（原文仍写"用量、账单""管理员初始化"，与 THESIS-06/08/10 后的实际界面不符）。
   - `CLAUDE.md`：§2 产品定位、§8 认证与访问边界；`im-manager` 行去掉"多用户"。
   - `AGENTS.md`：`- **产品**` 行。
   - `docs/API.md`：ACL 链接措辞与两处"普通成员/普通用户"的访问说明。
3. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；独立规格审查与代码质量审查落 `docs/审查记录.md`。
4. **交付**：issue 与 README 索引改"已完成"并写交付记录；方案 §2 台账的个人用户专题状态随本包改"已完成"并写提交号。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-13-personal-docs-and-acl.md`、`docs/issues2/README.md`、`docs/issues2/task-thesis-trim-plan.md`、`docs/thesis-13-personal-docs-and-acl-plan.md`、`docs/审查记录.md`、`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/ACL-MATRIX.md`、`docs/API.md`、`tests/thesis-13-personal-docs.test.ts`。

`tests/thesis-13-personal-docs.test.ts` 超出 issue 的"预计改动路径"（原文未列 `tests/`）：新增该契约用例把验收条件 1、2 变成机审，避免文档口径再次漂移；按"扩宽范围只能改声明"登记。`docs/issues2/task-thesis-trim-plan.md` 是 README 第一节第 6 步要求交付时同步的方案台账，立项时漏列，交付时补入声明。

## 4. 验收条件

1. `README.md`、`CLAUDE.md`、`AGENTS.md` 不再把产品描述为"多用户"；产品定位改为"个人"。
2. `docs/ACL-MATRIX.md` 与代码一致：只保留登录会话与 IM 侧访问控制两层；不出现已删除的权限名、用户管理/邀请/审计层与已下线路由。
3. `docs/API.md`、`README.md` 对 ACL 文档的链接与措辞同步为"访问边界"。
4. `npm run docs:check` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. 非目标未被实现：不改代码行为、不改数据库与表结构、不动前端文案（V-E5 已处理）、不删 `docs/ACL-MATRIX.md`。

## 5. 非目标

- 不改任何代码行为、接口、数据库或表结构。
- 不动前端文案（V-E5 已由 THESIS-10 处理）。
- 不删除 `docs/ACL-MATRIX.md`（用户已拍板 D-E6 ①）。
- 不改 `AGENTS.md` 里远程地址等与本任务无关的漂移（方案 §14 第 14 项）。
- 不改 `CLAUDE.md` §7 的表族清单（THESIS-14 负责）。
- 不读写 `data/`。

## 6. 风险与回滚

- **文档与代码不一致的风险**：ACL 文档改写后若代码仍在权限/归属上有隐藏分支，会误导读者。缓解：改写只陈述已核实的事实，保留代码入口清单供交叉核对。
- **既有契约测试被打红**：THESIS-06/08/10 对 ACL 文档的字面断言必须继续满足；新增用例与既有用例一起跑。
- **链接失效**：`docs:check` 会校验本地链接；改写时保留所有引用文件的相对路径。
- **回滚**：`git revert <提交号>`；文档恢复原状，无数据变更。
