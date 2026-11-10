# 任务 X 立项：自动记忆端点配置 UI 化（模型配置 tab + 凭据端点 + 促生效）——交接文档

> **状态**：2026-11-10 用户批准立项。开工前两项设计已拍板：**① 存储通道 = 继续写 `data/config/auto-memory.json`**（不迁 DB、不动 schema，沿用 `src/config.ts` session-secret 先例）；**② 表单落点 = 模型配置（claude）tab 加卡**（SYSTEM*TABS + `canManageSystemConfig`，与路由 `systemConfigMiddleware` 权限一致）。实现未开始，新窗口按 §4 顺序 TDD 执行。
> **用途**：新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行，无需重新排查。事实均带文件行号（2026-11-10 取证，任务 W 收官基线 `3502cbf`；行号若漂移以符号名为准）。
> **回滚点**：立项提交本身（`.gatescope.json` 的 base=立项提交的父 HEAD `3502cbf`——即任务 W 实现提交；实现 diff 基线=立项提交）。
> **参考仓**：`/Users/xy/Desktop/workspace/OpenDot*副本`（只读参考，任何文件不入本任务 diff；凭据端点纪律范本见 §2.4）。

---

## 0. 一句话结论

任务 W 补齐了自动记忆「只能存不能管」的管理面，但启用前置（llm/embedder 端点）仍要手工编辑 `data/config/auto-memory.json`。本任务把这条通路 UI 化：配置写通道（文件 0o600 + 缓存失效 + env 覆盖防护）→ 三个凭据管理端点（`manage_system_config`，key 掩码不回显，改完停侧车促生效）→ 模型配置 tab「自动记忆端点」卡；零新增依赖、不动 DB schema、不触碰批次 4/5（自动采集/召回注入仍为独立待批事项）。

## 1. 目标与用户决策（2026-11-10）

1. **已拍板（无需再问）**：
   - **① 存储通道 = 文件**：`data/config/auto-memory.json` 为唯一文件真相源；env `CKQCLAW_AUTO_MEMORY` 优先级语义不变，**env 设置时 UI 只读并拒绝写**（防双通道漂移）；不迁 DB、无 schema 变更。
   - **② 表单落点 = 模型配置（claude）tab**：该 tab 已受 SYSTEM_TABS + `canManageSystemConfig` gating，与路由 `systemConfigMiddleware` 权限一致；自动记忆端点本质是辅助推理端点，与 Provider 凭据同族。任务 W 的「自动记忆」tab 未配置态同步改造：有 `manage_system_config` 的用户显示「去配置」跳转（`/settings?tab=claude`），普通用户保留文件引导文案。
2. **非目标（防蔓延，勿顺手做）**：批次 4（自动采集）/批次 5（自动召回注入）任何实现（仍属任务 W 计划 §3.4/§3.5 待批范围）、per-workspace 启用开关、mem0ai 版本升级、侧车 llm/embedder 之外的配置项（超时/预算等）、凭据轮换提醒、DB 迁移。
3. **敏感区授权边界**：本任务的核心即是新增一条**写 `data/config/auto-memory.json`（AGENTS.md 敏感区①）的受控通路**——立项批准即本任务范围内的授权；落盘必须 0o600、成对合法才写、失败不半写、key 永不落日志/响应明文（延续任务 F/W 红线）。

## 2. 已取证事实（新会话无需重做）

### 2.1 配置读取链（现状，全部实测）

| #   | 事实                                                                                                                                              | 证据                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | 真相源优先级：env `CKQCLAW_AUTO_MEMORY` > `data/config/auto-memory.json` > 默认禁用；30s 缓存；`resetAutoMemoryConfigCache()` 为失效钩子          | `src/auto-memory-config.ts`（CONFIG_FILE/getAutoMemoryHostConfig/sanitizeConfig/resetAutoMemoryConfigCache）           |
| 2   | llm+embedder 必须成对合法（baseUrl 需 http(s)、apiKey/model 非空）才 enabled；`endpointFrom` 即校验器                                             | `src/auto-memory-config.ts`（sanitizeConfig/endpointFrom）                                                             |
| 3   | 敏感配置文件写先例：env 优先 + `mkdirSync(recursive)` + `writeFileSync(mode 0o600)`，无 tmp+rename 原子写（仓内一致做法）                         | `src/config.ts:70-95`（getOrCreateSessionSecret）                                                                      |
| 4   | key 掩码先例：`slice(0,4)+'***'+slice(-4)`，长度 ≤8 全 `***`；多处复用（clientSecret/botToken/token）                                             | `src/routes/config.ts:3134-3135,3562,3629,3793-3794`                                                                   |
| 5   | 侧车 config-on-spawn：运行中侧车持有 init 时配置直到 idle TTL/崩溃/stop；写新配置后须 `stopAll()` 促下次调用 respawn                              | `src/auto-memory-sidecar-manager.ts`（call/stopAll）、`src/auto-memory-ipc.ts`（getAutoMemorySidecarManager 单例）     |
| 6   | 任务 W 管理面现状：`/api/auto-memory` 五端点（authMiddleware + 资源 ACL）、status 三态（`{enabled,available,reason?}`）、未配置态引导卡被测试钉住 | `src/routes/auto-memory.ts`、`web/src/components/settings/AutoMemorySection.tsx`、`tests/auto-memory-frontend.test.ts` |
| 7   | 路由权限先例：`systemConfigMiddleware = requirePermission('manage_system_config')`（任务 V pricing 同款）                                         | `src/middleware/auth.ts:176`、`src/routes/pricing.ts`                                                                  |
| 8   | 前端：SYSTEM_TABS gating、claude tab 渲染分支（`<ClaudeProviderSection setNotice setError />`）、api client 已有 put/delete                       | `web/src/pages/SettingsPage.tsx`（SYSTEM_TABS/claude 分支）、`web/src/api/client.ts:88-95`                             |

### 2.2 OpenDot 凭据端点纪律（只读借鉴不搬代码）

`OpenDot_副本/src/routes/mem0-private.ts`：GET 只回 `credentialConfigured: boolean`（凭据零回显）；PUT 用 strict schema 且拒绝首尾空格/换行；DELETE 清除回布尔；全程 `Cache-Control: no-store` + bodyLimit 8KB。**移植方式**：纪律照搬（no-store、strict 校验、boolean 化的敏感状态）；回显粒度按本仓先例放宽到 baseUrl/model 明文 + apiKey 掩码（表单预填需要，掩码沿用 §2.1-4）。

## 3. 方案设计

### 3.1 批次 1：配置写通道（`src/auto-memory-config.ts` 扩展）

- `getAutoMemoryConfigSource(): 'env' | 'file' | 'none'`——env 覆盖检测（走既有 env 判定，不重复实现）。
- `writeAutoMemoryHostConfig(input: { llm: {baseUrl,apiKey,model}; embedder: {...} })`：复用 `endpointFrom` 语义校验（成对合法才写，非法返回 `{ok:false,error}` 不落盘）；`mkdirSync(recursive)` + `writeFileSync(0o600)`（§2.1-3 先例）；写成功后 `resetAutoMemoryConfigCache()`；**source==='env' 时拒绝（`env_override`）**。
- `clearAutoMemoryHostConfig()`：删除文件（env 态同样拒绝）+ resetCache。
- `tests/auto-memory-config.test.ts` 扩展：合法成对写入（内容/权限语义/缓存失效）、非法拒绝不落盘、env 态拒绝、清除。

### 3.2 批次 2：凭据管理端点（扩展 `src/routes/auto-memory.ts`）

| 方法/路径                        | 行为                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auto-memory/config`    | `{source, enabled, llm?: {baseUrl, model, apiKeyMasked}, embedder?: {...}}`——baseUrl/model 明文（预填），apiKey 掩码（§2.1-4 规则）；`no-store`                                                                                                       |
| `PUT /api/auto-memory/config`    | 入参 `{llm:{baseUrl,apiKey?,model}, embedder:{...}}`；**apiKey 缺省或掩码原样回传 = 保留旧值**；校验失败 400 `invalid_args`；成功=写文件 → `getAutoMemorySidecarManager().stopAll()` → `{ok:true, sidecarsRestarted:true}`；env 态 409 `env_override` |
| `DELETE /api/auto-memory/config` | 清除文件配置 → stopAll → `{ok:true}`；env 态 409                                                                                                                                                                                                      |

- 三端点挂 `systemConfigMiddleware`（无权限 403，未登录 401）；既有 workspace 管理端点保持 authMiddleware + 资源 ACL 不动——同文件按路径分段挂中间件。
- bodyLimit：config 端点单独 8KB（OpenDot 同值）；status 端点扩展回 `source` 字段（非敏感）。
- **文档同步（verify 会拦）**：`docs/API.md` 自动记忆小节加三端点；`docs/ACL-MATRIX.md` §4.6 补凭据端点行（`manage_system_config`）+ §6 表加一行。
- 测试（`tests/auto-memory-routes.test.ts` 扩展）：401/403、PUT 校验与保留旧值、掩码不回明文（断言响应无 apiKey 明文）、env 态 409、写后 stopAll 被调（mock 记录）、DELETE 后 status 回未配置态。

### 3.3 批次 3：模型配置 tab「自动记忆端点」卡 + 未配置态跳转

- 新 `web/src/components/settings/AutoMemoryEndpointCard.tsx`，挂 SettingsPage claude 分支（ClaudeProviderSection 下方）：
  - 状态行三态：未配置（表单空）/ 已配置·文件（掩码预填）/ **被环境变量覆盖（只读提示 CKQCLAW_AUTO_MEMORY，表单禁用）**。
  - llm+embedder 两组 baseUrl/model/apiKey 输入（apiKey 留空=保留）；保存 → PUT → 提示「已停止全部自动记忆侧车，下次使用时以新配置启动」；清除 → DELETE（`ConfirmDialog confirmVariant="danger"` 二次确认）。
- store `web/src/stores/auto-memory.ts` 扩展 `loadConfig/saveConfig/clearConfig`（沿用 mutate-then-reload、错误不互相覆盖的既有约定）。
- `AutoMemorySection.tsx` 未配置态改造：`canManageSystemConfig`（`useAuthStore`）→「去配置」跳转 `/settings?tab=claude` + 一句话说明；否则保留现有文件引导文案（**任务 W 测试钉了 `data/config/auto-memory.json` 文案与三态断言，须同步核对/更新 `tests/auto-memory-frontend.test.ts`**）。
- 测试：`tests/auto-memory-frontend.test.ts` 扩展（Card 状态三态/保留语义提示/danger 确认/store 三 action/Section 跳转门控）+ `tests/frontend-settings-information-architecture.test.ts` 补 claude 分支挂卡断言。

## 4. 执行顺序（TDD，每步先写测试见红再实现）

1. **批次 1**：`tests/auto-memory-config.test.ts` 新用例见红 → 写通道实现（source 检测/write/clear）。
2. **批次 2**：`tests/auto-memory-routes.test.ts` 新用例见红 → 三端点 + stopAll 接线 + API.md/ACL-MATRIX 同步。
3. **批次 3**：`tests/auto-memory-frontend.test.ts` + IA 契约新断言见红 → store 扩展 + Card + Section 未配置态改造 + claude 分支注册。
4. **收尾**：`npm run verify` 六步 → `node scripts/check-scope.mjs` → 单提交 `feat: 记忆 - 自动记忆端点配置UI化（任务X）`（push 由用户显式发起）。

## 5. 文件清单（= `.gatescope.json` allow）

新增：`web/src/components/settings/AutoMemoryEndpointCard.tsx`、`docs/task-x-auto-memory-endpoint-config-plan.md`（本文档）
修改：`src/auto-memory-config.ts`、`src/routes/auto-memory.ts`、`tests/auto-memory-config.test.ts`、`tests/auto-memory-routes.test.ts`、`web/src/pages/SettingsPage.tsx`、`web/src/components/settings/AutoMemorySection.tsx`、`web/src/stores/auto-memory.ts`、`tests/auto-memory-frontend.test.ts`、`tests/frontend-settings-information-architecture.test.ts`、`docs/API.md`、`docs/ACL-MATRIX.md`
（不动 `src/db.ts`、`src/web.ts`（路由已挂）、任何 schema/依赖；参考仓 OpenDot\_副本 任何文件不入 diff。）

## 6. 风险与边界

1. **敏感区写通路**——本任务立项授权范围；0o600、成对合法才落盘、失败不半写（先 sanitize 后写）、key 不落日志/响应明文。
2. **env 覆盖漂移**——env 态 GET 只读标注、PUT/DELETE 409、UI 表单禁用；双通道永不静默互相覆盖。
3. **生效语义**——运行中侧车持旧配置：写/清除成功即 `stopAll()`（下次调用以新配置 respawn）；设置页 status 探测会立即触发 respawn，属预期行为；UI 文案明示。
4. **apiKey 保留语义**——掩码回显 + 空值/掩码原样=保留旧值，防预填掩码被当明文写回；只有 DELETE 真清除。
5. **任务 W 测试契约**——未配置态文案/三态断言/「Section 不直连管理 API」断言都可能被本任务触碰，改 UI 必须同步测试（均在 allow 内）。
6. **权限双面并存**——同一路由文件两套中间件面（config=systemConfigMiddleware，workspace 管理=authMiddleware+资源 ACL），分段挂载不得互相波及；测试分别钉 401/403。
7. **30s 读缓存**——写路径必须 resetCache；status/管理端点在缓存失效后读新文件。
8. **零新增依赖**（宪法第 4 条）；不做批次 4/5；不碰 `data/` 既有实数据（测试全走临时目录 + env 注入）。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`（diff 全在 §5 清单内）。
- 真机验收（用户执行，实现/审查分离）：管理员在模型配置 tab 填端点保存 → 自动记忆 tab 变「已启用」→ 与 agent 对话产生记忆 → 列表可见 → 模型配置 tab 改 apiKey（留空保留）保存 → 列表/搜索仍工作（侧车已按新配置 respawn）→ 清除（danger 确认）→ 自动记忆 tab 回「未配置」→ 无 `manage_system_config` 成员访问三端点 403、设置页看不到配置卡 → 设 `CKQCLAW_AUTO_MEMORY` 后 UI 显示「被环境变量覆盖」且 PUT 409。
- `.gatescope.json` 随立项提交落档（task=任务X，base=`3502cbf`，allow=§5 清单）；实现会话**不得扩宽**，确需扩宽在提交信息说明理由并由用户复核。
