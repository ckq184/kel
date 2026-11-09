# 任务 V 立项：自定义模型单价（规则 + 兜底价）——交接文档

> **状态**：2026-11-09 用户批准立项（两决策见 §1）；**同日实现完成**（按 §4 顺序 TDD 六步，测试 `tests/custom-pricing.test.ts` 11 用例、`tests/pricing-routes.test.ts` 19 用例、`tests/custom-pricing-frontend.test.ts` 8 用例全绿）。
> **范围扩宽说明（超出 §5 清单的仅两个测试文件）**：`tests/db-upgrade-safety.test.ts` 与 `tests/task-continuation-scheduler.test.ts` —— 两者均以字面量 pin 住 `CURRENT_SCHEMA_VERSION`（前者注释自带「每次迁移必须同 commit 更新 pin」的维护义务），版本 72→73 的机械联动更新，无行为变更。
> **用途**：新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §4 顺序 TDD 执行，无需重新排查。所有事实均带文件行号（2026-11-09 本机 macOS arm64 取证；行号若漂移以符号名为准）。
> **回滚点**：立项提交本身（`.gatescope.json` 的 base=立项提交的父 HEAD `ca787e4`；实现 diff 基线=立项提交）。

---

## 0. 一句话结论

用量费用由宿主在 `src/kaboo-pricing.ts` 本地计价，非 Claude 模型（如 `glm-5.3-flash`）未命中内置表时一律按 **Sonnet 兜底价 $3/$15/MTok** 计费。本任务新增 admin 可管理的**自定义单价规则表**（模式串匹配 + 五类 token 单价）与**一条可选自定义兜底价**，解析优先级：自定义规则 → 内置表 → 自定义兜底 → 内置 Sonnet 兜底；只影响新事件，历史行已固化不变。

## 1. 目标与用户决策（2026-11-09）

1. 管理界面挂**「设置」新 tab「模型单价」**，权限 `manage_system_config`（不挂账单页：计费未开启时单价仍影响 /usage 估算费用，设置页始终可达）。
2. **支持自定义兜底价**：一条可选规则取代内置 Sonnet 兜底（全仓至多一条，DB 层强制）。
3. 非目标（防蔓延，勿顺手做）：历史行 repricing、按用户/工作区差异化单价、runner 侧改动、成员端价格展示页、汇率/币种转换、按 token 数阶梯价。

## 2. 已取证事实（新会话无需重做）

### 2.1 计价链路（谁在算钱）

| #   | 事实                                                                                                                                                                | 证据                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 计价真相源=内置表+子串最长匹配+Sonnet 兜底，**纯函数模块**                                                                                                          | `src/kaboo-pricing.ts:56-65`（兜底）、`:92-200`（表）、`:233-247`（匹配：大小写不敏感子串、最长胜出、尾部 % 忽略）、`:250-263`（五类单价求和） |
| 2   | **全仓唯一计价消费方** = `recordUsageEvent`：`priceKabooUsageByModel`（事件定价）+ `estimateKabooModelCostCents` ×2（UTC 半小时桶增量，`Math.max(0,…)` 钳制增量≥0） | `src/usage-service.ts:135-144`、`:163-181`                                                                                                     |
| 3   | 展示侧（/api/usage、billing、usage 页）**只读存量列**，不算价；改价新事件即刻生效、历史行不变                                                                       | `src/routes/usage.ts:113,217`；`src/db.ts:3997`（getUsageAnalytics 聚合存量）                                                                  |
| 4   | 五类 token 互斥口径（reasoning 从 output 拆出、cacheWrite1h 是 cacheWrite 子集）与分（cent）取整边界                                                                | `src/kaboo-pricing.ts:266-280`；`src/usage-service.ts:163-181`                                                                                 |
| 5   | `recordUsageEvent` 是**同步**热路径（better-sqlite3 同步 API），自定义价读取必须同步可用（缓存，不能 async）                                                        | `src/usage-service.ts:121-242`                                                                                                                 |

### 2.2 可复用模式（照抄即可）

| 模式                                     | 位置                                                                                                                                                                                                                                                                                   | 要点                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB→内存缓存（TTL+显式失效）              | `src/billing.ts:137-177`                                                                                                                                                                                                                                                               | 30s TTL + `invalidateAllBillingCaches()`，路由写后调用（`src/routes/billing.ts:113,345`）——新 store 照此                                                                 |
| admin CRUD 路由（zod+409+审计+缓存失效） | `src/routes/billing.ts:264-385`                                                                                                                                                                                                                                                        | 400 `{error:'Invalid request body', details}`、409 重复、PATCH 动态字段、`logBillingAudit('<action>', actor.id, …)`                                                      |
| 权限中间件                               | `src/middleware/auth.ts:176`                                                                                                                                                                                                                                                           | `systemConfigMiddleware = requirePermission('manage_system_config')`；用法 `route.post(path, authMiddleware, systemConfigMiddleware, handler)`                           |
| 路由挂载                                 | `src/web.ts:49-67`（import）、`:267-286`（app.route）                                                                                                                                                                                                                                  | 新路由文件**必须**同时进 `docs/API.md:19-38` 模块索引表（`scripts/check-docs.mjs:131-141` 机审强制）与 `docs/ACL-MATRIX.md` §6（`:198-211`）                             |
| 新表迁移                                 | `src/db.ts:106`（CURRENT_SCHEMA_VERSION=**72**）、`:2499-2513`（v71→v72 版本块样例）、基础 schema 大 exec 块 `:535-1228`                                                                                                                                                               | 建表放基础块（CREATE TABLE IF NOT EXISTS 天然幂等）+ 版本号 72→73 + 版本注释块；无数据回填不需事务；备份/拒降级由 `enforcePreMigrationBackup`（`db.ts:440-466`）自动覆盖 |
| 表 CRUD 函数惯例                         | `src/db.ts:13280-13482`（billing_plans）                                                                                                                                                                                                                                               | `getXxx/listXxx/createXxx/updateXxx/deleteXxx` + 私有 `mapXxxRow`（布尔/JSON 转换在 map 层）                                                                             |
| 前端表单 Dialog                          | `web/src/components/billing/PlanFormDialog.tsx:157-223`                                                                                                                                                                                                                                | FormState 单对象 + 泛型 `set`、数字输入 `type="number" step="0.001"`、Switch 开关、`toast.error` 校验、Dialog 提交                                                       |
| 前端列表卡片                             | `web/src/components/settings/ProviderList.tsx:158-357`                                                                                                                                                                                                                                 | header 计数 + 空态 + divide-y 行 + Switch/编辑/删除 + 底部添加按钮                                                                                                       |
| 删除确认                                 | `web/src/components/common/ConfirmDialog.tsx`                                                                                                                                                                                                                                          | `confirmVariant="danger"`                                                                                                                                                |
| 前端小 store                             | `web/src/stores/mcp-servers.ts:69-159`                                                                                                                                                                                                                                                 | state+CRUD actions、mutate-then-reload、行级失败不覆盖列表 error                                                                                                         |
| 设置页 tab 注册 5 处                     | `web/src/components/settings/types.ts:130-152`（SettingsTab 联合）、`web/src/pages/SettingsPage.tsx:28-59`（VALID_TABS/SYSTEM_TABS）、`:106-116`（无权限回退）、`:138-161`（sectionTitle）、`:252-274`（渲染分支）、`web/src/components/settings/SettingsNav.tsx:33-89`（systemItems） | SYSTEM_TABS 受 `canManageSystemConfig` gating（`SettingsPage.tsx:81-87`）                                                                                                |
| API 客户端                               | `web/src/api/client.ts:84-103`                                                                                                                                                                                                                                                         | `api.get/post/patch/delete`；401 自动跳登录；错误经 `getErrorMessage`（`web/src/components/settings/types.ts:154-161`）→ toast                                           |
| 测试模式                                 | ①临时 DB：`tests/task-usage-routing.test.ts:1-40`（mock config/runtime-config/logger + 动态 import db）②纯函数：`tests/kaboo-pricing.test.ts` ③前端源检查：`tests/frontend-settings-information-architecture.test.ts:7-28` ④store 单测：`tests/mcp-servers-frontend.test.ts:1-37`      | 新测试分四类照抄                                                                                                                                                         |

## 3. 方案设计

### 3.1 数据模型（新表 `custom_model_pricing`）

```sql
CREATE TABLE IF NOT EXISTS custom_model_pricing (
  id TEXT PRIMARY KEY,                       -- 仿 billing_plans 的 id 生成惯例
  kind TEXT NOT NULL DEFAULT 'pattern' CHECK (kind IN ('pattern','fallback')),
  pattern TEXT NOT NULL DEFAULT '',           -- kind='pattern' 时必填（应用层校验 2-100 字符）；fallback 恒 ''
  display_name TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL DEFAULT 'custom',
  input_price_per_mtok REAL NOT NULL DEFAULT 0,
  output_price_per_mtok REAL NOT NULL DEFAULT 0,
  cache_read_price_per_mtok REAL NOT NULL DEFAULT 0,
  cache_creation_price_per_mtok REAL NOT NULL DEFAULT 0,
  reasoning_price_per_mtok REAL NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_pricing_fallback
  ON custom_model_pricing (kind) WHERE kind = 'fallback';   -- 兜底至多一条（DB 层强制）
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_pricing_pattern
  ON custom_model_pricing (pattern) WHERE kind = 'pattern'; -- 同模式串唯一（409 依据）
```

`CURRENT_SCHEMA_VERSION` 72→73（版本注释块说明：仅新增幂等表+索引，无数据迁移）。

### 3.2 计价解析（保持 kaboo-pricing.ts 纯函数）

`src/kaboo-pricing.ts` 增加可选参数（**默认行为不变**，现有 `tests/kaboo-pricing.test.ts` 必须原样全绿）：

```ts
export interface CustomPricingRules {
  patterns: readonly KabooModelPricing[];  // 已启用的 pattern 规则
  fallback?: KabooModelPricing;            // 已启用的自定义兜底（至多一条）
}
matchKabooModelPricing(modelName, custom?)      // 自定义 patterns（子串最长）→ 内置表（子串最长）→ undefined
estimateKabooModelCostUSD(model, usage, custom?)  // match ?? custom?.fallback ?? KABOO_SONNET_FALLBACK
estimateKabooModelCostCents(model, usage, custom?)
priceKabooUsageByModel(root, modelUsage, custom?)
```

**优先级（测试锁定）**：自定义 pattern（tier 内最长匹配）→ 内置表 → 自定义兜底 → 内置 Sonnet 兜底。自定义 pattern 命中即胜出（管理员显式创建，即使内置表有更长匹配）。

**桶内换价语义（写入测试）**：半小时桶增量 = `round(新价×桶总量) − round(新价×桶前量)`，被 `Math.max(0,…)` 钳制（`src/usage-service.ts:179-181`）→ 换价当桶可能轻微**少计、绝不多计**。这是既定取舍，不做桶切分。

### 3.3 缓存 store（新文件 `src/custom-pricing-store.ts`）

- `getEffectiveCustomPricing(): CustomPricingRules`：同步读缓存；缓存 = DB 查询投影为 `KabooModelPricing` 形状（跳过 disabled），TTL 30s（仿 `src/billing.ts:137-177`）。
- `invalidateCustomPricingCache()`：CRUD 路由每次变更后调用。
- `src/usage-service.ts` `recordUsageEvent` 开头取一次 `const custom = getEffectiveCustomPricing()`，传入 `:135`、`:163`、`:167` 三处计价调用。

### 3.4 API（新文件 `src/routes/pricing.ts`，挂 `/api/pricing`）

| 方法/路径                       | 说明                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/pricing/rules`        | 列出全部规则（含 disabled）+ 兜底（管理视角）                                                                           |
| `POST /api/pricing/rules`       | 创建；body 带 `kind`；fallback 已存在或 pattern 重复 → 409                                                              |
| `PATCH /api/pricing/rules/:id`  | 部分更新（404 不存在）；改 pattern 撞唯一 → 409                                                                         |
| `DELETE /api/pricing/rules/:id` | 删除（404）                                                                                                             |
| `POST /api/pricing/preview`     | `{ model }` → `{ source: 'custom'\|'builtin'\|'fallback-custom'\|'fallback-sonnet', rule?, pricing }`，给管理员验证匹配 |

- 全部 `authMiddleware, systemConfigMiddleware`。
- zod schema 加在 `src/schemas.ts`：pattern 2-100 字符（fallback 不需要）、五价 ≥0 有限数、上限 1e4、displayName ≤100。
- 审计：复用 `logBillingAudit('custom_pricing_created/updated/deleted', actor.id, …)`（若签名不匹配则不加，最小范围）。
- **文档同步（verify 的 docs:check 会拦）**：`docs/API.md:19-38` 模块索引加行 + 端点小节；`docs/ACL-MATRIX.md` §6 加 `/api/pricing/*` → `manage_system_config` 行。

### 3.5 前端

- 新 tab `key='pricing'`、label「模型单价」（lucide 图标如 `Coins`），注册 §2.2 所列 5 处，进 `SYSTEM_TABS`（`canManageSystemConfig` gating）。
- `web/src/components/settings/ModelPricingSection.tsx`：上方「兜底价」卡片（无则显示"未设置（内置 Sonnet 兜底 $3/$15 生效）"+ 添加按钮；有则展示/编辑/删除/启停）+ 规则列表（模式串、显示名、五价摘要、启停 Switch、编辑/删除、底部添加）。
- 表单 Dialog `web/src/components/settings/ModelPricingDialog.tsx`：照抄 `PlanFormDialog.tsx` FormState+set 模式；五价输入 `type="number" step="0.001" min="0"`；带「预览匹配」输入框调 `POST /api/pricing/preview` 内联显示命中来源。
- store `web/src/stores/model-pricing.ts`：仿 `mcp-servers.ts`（loadRules/createRule/updateRule/deleteRule + loading/error）。

## 4. 执行顺序（TDD，每步先写测试见红再实现）

1. **迁移+CRUD**：tests 断言 v73 建表/幂等/fallback 唯一索引/pattern 唯一索引 → db.ts 实现（表+版本块+CRUD 函数）。
2. **纯函数解析**：tests（新建 `tests/custom-pricing.test.ts`）断言优先级矩阵/自定义兜底/默认行为不变 → kaboo-pricing.ts 可选参数。
3. **store+usage-service 注入**：tests（临时 DB）断言「建规则 → recordUsageEvent 按新价落库；禁用规则 → 回落；删缓存失效后立即生效」 → custom-pricing-store.ts + usage-service.ts 三处传参。**含桶内换价 clamp 用例**。
4. **API**：tests（新建 `tests/pricing-routes.test.ts`，临时 DB）断言 CRUD/401/403/409/404/preview/缓存失效 → routes/pricing.ts + schemas.ts + web.ts 挂载 + API.md/ACL-MATRIX 同步。
5. **前端**：tests（新建 `tests/custom-pricing-frontend.test.ts` 源检查 + store 单测）断言 5 处注册点/组件字段/store actions → 实现 §3.5。
6. **收尾**：`npm run verify` 六步 → `node scripts/check-scope.mjs` → 单提交 `feat: 计价 - 自定义模型单价规则与兜底价`（push 由用户显式发起）。

## 5. 文件清单（= .gatescope.json allow）

新增：`src/custom-pricing-store.ts`、`src/routes/pricing.ts`、`web/src/components/settings/ModelPricingSection.tsx`、`web/src/components/settings/ModelPricingDialog.tsx`、`web/src/stores/model-pricing.ts`、`tests/custom-pricing.test.ts`、`tests/pricing-routes.test.ts`、`tests/custom-pricing-frontend.test.ts`
修改：`src/db.ts`、`src/kaboo-pricing.ts`、`src/usage-service.ts`、`src/schemas.ts`、`src/web.ts`、`web/src/components/settings/types.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/pages/SettingsPage.tsx`、`tests/kaboo-pricing.test.ts`（如需扩断言）、`tests/frontend-settings-information-architecture.test.ts`（tab 断言同步）、`docs/API.md`、`docs/ACL-MATRIX.md`、`docs/task-v-custom-model-pricing-plan.md`

## 6. 风险与边界

1. **钱（核心）**：优先级矩阵与 cent 取整必须测试锁定；桶内换价钳制语义（少计不多计）备查。
2. **历史不可变**：只影响新事件；存量 `provider_estimated_cost_usd`/`billed_cost_usd` 不回算。
3. **纯函数污染**：`kaboo-pricing.ts` 禁止 import db；DB 只进 custom-pricing-store.ts。
4. **缓存一致性**：CRUD 后显式 invalidate + TTL 30s；单进程 SQLite 无跨进程失效问题。
5. **模式误伤**：pattern 最短 2 字符（防单字符子串大面积命中）；兜底用显式 `kind` 列 + 部分唯一索引。
6. **文档门禁**：新路由文件不进 API.md 索引 → verify 的 docs:check 直接红。
7. **敏感区纪律**：本任务不触碰 `data/`、不新增运行时依赖（宪法第 4 条）；zod/现有依赖内完成。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`（diff 全在 §5 清单内）。
- 真机验收（用户执行，实现/审查分离）：设置 → 模型单价 → 建 `glm-5.3-flash` 规则（如 in $0.6 / out $2.2 / cacheRead $0.1 / cacheCreation $0.7 / reasoning $2.2）→ preview 输入 `glm-5.3-flash` 显示命中 custom → 发一轮 glm 对话 → `/usage` 当日新记录费用按自定义价（对照手算：如 in 55,679 → 55,679×0.6/1M=$0.0334…）→ 删规则后新事件回落内置/兜底价；历史行金额不变。
- `.gatescope.json` 已随立项提交落档（task=任务V，base=父 HEAD `ca787e4`，allow=§5）；实现会话**不得扩宽**，确需扩宽在提交信息说明理由并由用户复核。
