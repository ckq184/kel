# 任务 thesis-lite 交付说明

> **执行会话**：本仓库裁剪执行会话（2026-11-17）。
> **方案**：`docs/task-thesis-lite-plan.md`（七批执行档）；**交接**：`docs/task-thesis-lite-handoff.md`。
> **基线**：`bf0eba1`（主仓完整副本）→ 现行 HEAD。全程未 push。

---

## 1. 总体结果

- **净删 43,973 行**（`git diff --stat bf0eba1..HEAD`：236 文件变更，+457 / −44,430；净变化 = −43,973，其中含立项与交付说明等新增文档 +457 行）
- 方案预估「净删 5~7 万行」的下沿未完全达到，**原因：批次 5 的 browse/bug-report 经执行时核实有前端真实消费，按方案前置裁决跳过删除**（详见 §4）
- 每批独立 commit、verify 六步全绿后提交，可单独 revert

## 2. 批次 commit 清单

| 批次          | commit    | 内容                                                                                                                                                                                                                                                         | 行数变化      |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 0 立项        | `082955a` | 方案+交接档落档，`.gatescope.json` 重置（task=thesis-lite、base=bf0eba1、allow=\*\*）                                                                                                                                                                        | +251 / −16    |
| 1 评测/RSI    | `218501a` | eval/harness 全家 33 文件：11 宿主模块+4 脚本+EvalPage+13 测试+runner adapter 注入链                                                                                                                                                                         | +4 / −16,438  |
| 2 auto-memory | `9eeb38b` | mem0 侧车全家 54 文件：宿主三件+routes、runner context+python 侧车、三 MCP 工具、`auto_recall` 流事件（`memory_recall`/`usage` 保留）、Dockerfile mem0 段、install/smoke 脚本段                                                                              | +36 / −10,083 |
| 3 billing     | `20febca` | billing.ts+routes+前端 17 组件+BillingPage+store；全部闸门（web/IM/agent 会话/定时任务×2/群组/渠道/存储/MCP 限额）、订阅过期/月度对账定时器、并发限额 checker；**usage 统计+自定义模型定价全保留**（`usage-service` 改为倍率恒 1、不扣余额；db.ts 一字未动） | +68 / −7,237  |
| 4 钉钉        | `26b9c8c` | dingtalk 三件+prompt+`dingtalk-stream` 依赖；im-channel/im-manager/runtime-config/routes×2/index.ts 全链路分支、union 类型收窄、前端 meta/capabilities/manager；**飞书/QQ/微信与全部共享 channel-\* 基建不动**                                               | +66 / −5,023  |
| 5 收尾        | `d7191eb` | verify.mjs failHint 已删文档引用清理；**browse/bug-report 跳删**（见 §4）                                                                                                                                                                                    | +1 / −1       |
| 6 文档        | `dc59971` | 删 46 份过程文档（task-_/TASK-_/REMAINING-WORK/审查记录等），改写 README/AGENTS/CLAUDE/API/ACL-MATRIX 被裁模块描述                                                                                                                                           | +27 / −5,628  |
| 6 收尾        | `07db3bb` | 冒烟发现的 5 处钉钉残留文案清理                                                                                                                                                                                                                              | +5 / −5       |

## 3. 「执行时核实」项结论（方案 §5）

| 核实项                                              | 结论                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/usage.ts` 对 billing 的依赖                 | 仅 `isBillingEnabled()` 一个符号（响应 `billing` 元信息字段）→ 摘除字段与 import；前端 `stores/usage.ts` 同步删归一化链                      |
| `channel-account-migration.ts` 是否含 dingtalk 分支 | **不含**（全仓 grep 证实），无需改动                                                                                                         |
| db 相关测试对 `auto_memory_recall` 列（v74）的断言  | db.ts 未动，三个 db 测试随全量套件持续绿 ✓                                                                                                   |
| `observability-config.ts` 引用复查                  | 仅被 recall-judge/turn-observer/eval-store 测试引用，全在删除清单内 ✓                                                                        |
| `builtin-mcp-catalog.mjs` 引用复查                  | **有真实调用方**：`install-host-tools.sh`（catalog_query/verify）+ Dockerfile/smoke 注释 → 连带删除 mem0 段与 TMP_MCP_DIR 机制，注释同步改写 |
| browse/bug-report 前端消费（批次 5 前置）           | **有真实消费**（见 §4）→ 按方案跳过删除                                                                                                      |

## 4. 与方案的偏差（需用户知悉）

1. **browse/bug-report 未删**（方案批次 5 第一项的前置确认命中）：`web/src/components/shared/DirectoryBrowser.tsx` 消费 `/api/browse/directories`（挂载于创建容器对话框与宿主目录挂载编辑器），`web/src/components/common/BugReportDialog.tsx` 消费全部三个 `/api/bug-report/*` 端点（挂载于设置-关于页与侧栏）。方案明确「若发现有消费，本项跳过并在交付说明中报告」。若希望连前端消费面一起砍（DirectoryBrowser/BugReportDialog 及其挂载点），需用户裁决后补一批。
2. **usage-service 语义微调**（方案「保留勿动」清单成员，但有真实 billing 依赖）：`shouldCharge` 判定链删除后，`billedCostUSD` 列改为恒等于 `providerEstimatedCostUSD`（倍率恒 1）、`chargeBalance` 恒 false、不写余额。`usage_records` 的 billed 列语义从「账单扣费」退化为「无倍率镜像」。用量页对应文案已改为「按内置价格表估算，非账单扣费」。
3. **types/schemas 的 Billing 类型族保留**：`src/db.ts`（禁改文件）import 了 `BillingPlan` 等类型，故 `src/types.ts`/`src/schemas.ts`/`permissions.ts` 中 billing 声明性代码保留（纯类型/zod schema/权限字符串，无运行时行为）。
4. **`docs/screenshots/` 保留**：方案未点名，非过程文档，未动。

## 5. 终验结果

- `npm run verify` 六步全绿 ✓（format / docs:check / 三侧 typecheck+sync / vitest 全量 / build / git diff --check）
- `node scripts/check-scope.mjs` 通过（base=bf0eba1，allow=\*\*，审计轨迹型声明）✓
- `make build` ✓；web e2e `npm --prefix web run test:e2e` **9/9 通过** ✓
- 浏览器冒烟（独立端口 3100/5273——3000/5173 被主仓开发服务占用，未触碰）：首启初始化向导（仅飞书+Claude，无钉钉）→ 创建管理员 → 工作台（导航无评测/无账单）→ 设置导航（无自动记忆/无计费管理，含模型单价/运行状态保留项）→ 渠道账号可选渠道 = **飞书/QQ/微信** → 用量页正常 → 运行状态监控页正常 ✓
- 冒烟中发现并修复 5 处钉钉残留文案（`07db3bb`）；全仓 `钉钉|dingtalk|DingTalk` 代码面 grep 清零 ✓

### 受环境限制未覆盖的冒烟项（代码面已验证编译/测试通过，待用户环境验收）

| 项                   | 原因                                                        |
| -------------------- | ----------------------------------------------------------- |
| 聊天流式回复         | 需 LLM Provider key（交接档明示由用户配置）                 |
| 浏览器操控工具       | 需 Docker daemon（本机未运行；`make dev` 在拉镜像一步中止） |
| 桌面端启动           | 保留模块、核心链路未改；electron 启动属 GUI 操作，留给用户  |
| 飞书/QQ/微信真实收发 | 需各渠道真实凭据                                            |

## 6. 保留能力核对（答辩章节映射，方案 §3）

多用户认证与权限矩阵 ✓、Web 流式聊天 ✓、工作区与文件管理 ✓、容器隔离 Agent 运行时 ✓（代码面完整，Docker 环境待用户验收）、浏览器操控 ✓（同上）、Agent 人设 ✓、飞书/QQ/微信三渠道 ✓、定时任务调度与渠道推送 ✓、能力扩展（Skills/MCP/Plugins）✓、工作区记忆库（MemoryPage + `memory_recall`）✓、Token 用量统计 + 自定义模型定价 ✓、运行监控 ✓、Electron 桌面端 ✓、verify/CI/Docker 发布工程基建 ✓。

## 7. 用户验收清单（建议）

1. 配置 LLM Provider 后 `make dev`（先启动 Docker）验证：登录 → 聊天流式 → 浏览器操控 → 用量页 → 监控页 → 渠道页（无钉钉）→ 桌面端
2. ~~决断 §4.1：browse/bug-report 是否连前端消费面一起删~~ → **已裁决（2026-11-17 前端清扫轮）：保留不删**
3. 确认 §4.2 的 billed 列语义变化可接受

## 8. 前端清扫轮（2026-11-17，七批之后增量）

三路只读侦察确认页面/路由已全干净（无孤儿页面、无已删事件监听、导航无无用入口），本轮清掉四处非页面级残留；**browse/bug-report 经用户裁决保留不删**（DirectoryBrowser 被宿主目录挂载依赖、BugReportDialog 是演示亮点）。

| 步骤 | commit    | 内容                                                                                                                                                  | 行数   |
| ---- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | `7a48c95` | 删孤儿文件 `useEscapeKey.ts`/`BalancingSettings.tsx`（全仓零引用）                                                                                    | −141   |
| 2    | `453c56a` | 下架 `manage_billing` 权限项（permissions/types/web auth/web users-utils 四文件；存量 DB 值由 `normalizePermissions` 静默剥离，权限模板 UI 自动收敛） | −7/+6  |
| 3    | `4d58932` | 删 `billing_update` 死 WS 事件类型与 `BillingBlockType`/`BillingAccessResult` 死类型族 + 两处过时 billing 注释（`make sync-types` 同步）              | −32/+5 |
| 4    | `368efcd` | 删 UsagePage 冗余「账单扣费」展示线（表格列/CSV 列/AttributionRow 死管道/三处文案；`stores/usage.ts` 解析字段保留）                                   | −30/+6 |

明确不动：host 侧 billing 声明性代码（runtime-config 5 个设置字段、schemas Billing Schema、types BillingPlan 族——与 db.ts 禁改线纠缠，无前端渲染）、`db.ts` 一字不动。验证：每步 verify 六步全绿独立 commit；web e2e 9/9；check-scope 通过。CSV 导出列结构变化（少「账单扣费 USD」一列）已在本节备案。

## 9. 桌面端登录循环暂态问题（2026-11-17 排查，2026-11-18 归档；零代码修复）

**现象**：桌面端（Electron）输入账号密码后不进入应用，静默回到登录页要求重新输入，admin 与 member（ckq）两账号均复现；Web 端（浏览器）从未复现；次日自行消失。

**根因（环境暂态，非代码 bug）**：Electron 的 cookie jar 在 host `127.0.0.1` 上短暂处于脏状态——主仓与副本使用**相同的会话 cookie 名、不同的签名密钥**，当天桌面端曾静默连到主仓页面（启动脚本占用探测的缺口，已在 `68861e1` 修复为仓库感知），切换本仓后 jar 里新旧 cookie 多轮交替；叠加两账号均处于 `must_change_password` 强制改密期（登录成功 → 跳改密页 → 改密后 `sessions_revoked` 撤销会话并清 cookie → 回登录页重新输入），观感即「登录不上，一直要求重新输入」。多轮写删后 jar 收敛为单一有效 cookie（查证 `~/Library/Application Support/CKQClaw/Cookies` 仅剩一条 `ckqclaw_session`），**自愈**。

**排查证据链**（全部只读）：`auth_audit_log` 五次 `login_success`（后端侧登录从未失败、会话行全部落库）；`user_sessions` 会话 30 天有效、密钥文件稳定、3000 单进程；WS 握手实验矩阵 4/4（直连/经 vite 代理 × Origin 变体，伪造 cookie 全部正确 401）证明后端与代理链路正常；弹回由 [web/src/api/client.ts](../web/src/api/client.ts) 的 401 拦截（静默 `replaceInApp('/login')`）与 [web/src/api/ws.ts](../web/src/api/ws.ts) 的 1008 处理两条通路触发，WS 握手失败不写审计——解释「审计全成功但人被弹回」。

**手动处置（再遇到时，任选其一）**：

1. 退出桌面端，删除 `~/Library/Application Support/CKQClaw/Cookies` 后重开，重新登录；
2. 确认处于强制改密流程（`must_change_password=true` 的账号首次登录会跳「安全与设备」改密页，改完需用新密码重新登录）——完成改密即恢复；
3. 主仓/副本切换运行时，先停掉对方的 3000/5173 服务再登录（避免 cookie 跨仓残留）。

**明确不改代码**：登录/会话/WS 后端链路、代理、审计经全量验证无缺陷；强制改密流程为既定安全设计。可选的观感改进（401 弹回前的一次性 toast 提示）留待用户后续裁决。
