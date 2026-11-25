# 任务立项：THESIS-08 用量（三）：模型单价下线

> 立项日期：2026-11-25｜base：`479e2fd`（开工前 main HEAD，回滚点）｜分支：`claude/thesis-08-model-pricing`
> 来源：[docs/issues2/THESIS-08-model-pricing.md](issues2/THESIS-08-model-pricing.md)（方案 §6 L3/T3、§11.2）
> **状态：立项（仅领取与范围声明）。实现、验证与交付记录在实现提交与交付提交里补齐。**

## 0. 需求采访结论（2026-11-25）

- **目标**：设置页不再有"模型单价"，`/api/pricing` 五个接口下线，内置 Kaboo 价格表与自定义规则缓存删除；定价层的前端文件、导航项、类型与文档同步裁净。
- **完成条件**：五个 `/api/pricing` 接口（含未认证请求）全部 404；设置导航与设置页不再出现 `pricing` / "模型单价"；定价层 6 个源码文件与 4 个测试文件删除；`make typecheck`、`make build`、`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；方案 §11.4 七项清扫检查通过。
- **约束**：不改 `src/db.ts`、不改表结构（`custom_model_pricing` 留给 THESIS-14）；不改聊天气泡（THESIS-09）；不读写 `data/`；不新增/删除第三方依赖。
- **依赖状态**：THESIS-07 已合入 main（`e5fad5c`），`usage-service.ts` 已删除，定价层只剩 `/api/pricing` 与设置页两个调用方，满足开工条件。
- **待用户决策**：issue 原列"否"（D-C1 已定 ③）。执行中发现一项范围外但直接由本包产生的孤儿：`src/schemas.ts` 的三个定价 schema 只被 `src/routes/pricing.ts` 使用。**用户 2026-11-25 拍板：一并删除**，已扩宽 `.gatescope.json` 的 allow。

## 1. 关键事实（开工前核实，锚点为 `479e2fd`）

- **后端定价层**：`src/routes/pricing.ts`（166 行，五个接口：`GET /rules`、`POST /rules`、`PATCH /rules/:id`、`DELETE /rules/:id`、`POST /preview`，全部挂 `authMiddleware` + `systemConfigMiddleware`）；`src/kaboo-pricing.ts`（396 行，内置价格表与计价函数）；`src/custom-pricing-store.ts`（53 行，自定义规则缓存）。
- **挂载点**：`src/web.ts:79` 导入、`:230` `app.route('/api/pricing', pricingRoutes)`。
- **调用方核实**：`git grep -E "kaboo|KabooModelPricing|getEffectiveCustomPricing|ModelPricing|/api/pricing"` 覆盖 `src/ tests/ web/ docs/ container/`。THESIS-07 之后，`kaboo-pricing.ts`、`custom-pricing-store.ts` 的生产调用方只有 `src/routes/pricing.ts`；`src/db.ts` 的 `custom_model_pricing` 读写函数已无外部调用方（`normalizePricingPattern` 仍被 `db.ts` 内部 create/update 使用），**留给 THESIS-14**（issue 非目标）。
- **schema 孤儿（用户已拍板删除）**：`src/schemas.ts:977-1027` 的 `CustomPricingCreateSchema`、`CustomPricingPatchSchema`、`CustomPricingPreviewSchema`、`customPricingFields`、`pricePerMTok` 仅被 `src/routes/pricing.ts` 导入，全仓无其他引用。
- **前端定价层**：`ModelPricingSection.tsx`（242）、`ModelPricingDialog.tsx`（318）、`stores/model-pricing.ts`（129）；入口为 `SettingsNav.tsx:73-75`（`key/label/icon`，`Coins` 仅此处使用）、`settings/types.ts:90`（`'pricing'`）、`SettingsPage.tsx:21`（导入）、`:31`/`:51`（`VALID_TABS`/`SYSTEM_TABS`）、`:122`（标签）、`:227`（渲染）。无其他前端文件引用这些模块（`auth.ts` 不重置定价 store）。
- **注释**：`container/agent-runner/src/runtime/pi/pi-session.ts:8`、`:53` 提到已删除或即将删除的 `usage-service`/`kaboo-pricing`，改为不指向具体已删模块的描述。
- **文档**：`docs/API.md:32` 路由表 1 行、`:494-507` "## 模型单价" 整节（10 行正文）；`docs/ACL-MATRIX.md:198` 一行。
- **测试面**：
  - 随本包删除：`tests/pricing-routes.test.ts`（554）、`tests/custom-pricing.test.ts`（214）、`tests/custom-pricing-frontend.test.ts`（182）、`tests/kaboo-pricing.test.ts`（213）。
  - 需改写：`tests/no-duplicate-helpers-contract.test.ts:393-400`（`normalizePricingPattern` 的"定价路由无内联副本"断言随路由消失）；`tests/frontend-settings-information-architecture.test.ts:23-24`（`key: 'pricing'` 断言反转）；`tests/thesis-07-usage-ledger-stop.test.ts:99-100`（读取即将删除的 `tests/pricing-routes.test.ts`，改为断言文件已删除）。
  - 新增：`tests/thesis-08-model-pricing-removal.test.ts`（五接口 404 + 源码/文档契约）。
- **依赖**：前端定价组件只用 `lucide-react` 图标与仓库内 UI 组件，均被其他页面继续使用；`web/package.json` 无需改动。
- **数据库**：本包不改 `src/db.ts`、`src/db-schema/**`，不升版本号；`tests/db-upgrade-safety.test.ts` 的 v73 钉不动。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/thesis-08-model-pricing-removal.test.ts`：
   - 五个 `/api/pricing` 路径按各自方法发无认证请求，期望 404（路由还在时会先被 `authMiddleware` 拦成 401，能区分"未挂载"与"存在但拒绝"）；
   - `src/routes/pricing.ts`、`src/kaboo-pricing.ts`、`src/custom-pricing-store.ts` 与前三个前端文件不存在；`src/web.ts` 无导入与挂载；
   - `SettingsNav.tsx` 无 `pricing`/`模型单价`/`Coins`，`settings/types.ts` 无 `'pricing'`，`SettingsPage.tsx` 无定价导入、标签、渲染；
   - `src/schemas.ts` 无 `CustomPricing` 定价 schema；
   - `pi-session.ts` 注释不再出现 `kaboo-pricing`、`usage-service`；
   - `docs/API.md`、`docs/ACL-MATRIX.md` 不再出现 `/api/pricing` 或"模型单价"。
   - 先在未修改的源码上跑该文件，确认因接口存在/文件存在而红。
2. **Green**：删除后端 3 文件与 `src/web.ts` 两处引用；删除 `src/schemas.ts` 定价 schema 段；删除前端 3 文件并清掉 `SettingsNav`/`types`/`SettingsPage` 的入口；改写 `pi-session.ts` 两处注释；删除 `docs/API.md` 路由行与整节、`docs/ACL-MATRIX.md` 一行。
3. **测试同步**：删除 4 个定价测试文件；改写 `no-duplicate-helpers-contract`；`frontend-settings-information-architecture` 与 `thesis-07` 中涉及定价的断言删除，由 `thesis-08` 契约独占；保留 `tests/db-upgrade-safety.test.ts` 的 v73 钉。
4. **前端清扫（方案 §11.4）**：可达性（删除后生产源码无 `ModelPricing`/`model-pricing`/`/api/pricing` 引用；历史任务文档与契约测试除外）、死导出、入口、权限/事件、依赖、文案与测试、图标（`Coins` 仅删除处使用）逐项核对。
5. **验证**：`make typecheck`、`make build`、`npm run verify` 六步、`node scripts/check-scope.mjs`。
6. **独立审查**：规格符合性与代码质量两轮由独立代理执行，结论落 `docs/审查记录.md`。
7. **交付**：issue 与 README 索引改"已完成"，写交付记录；专题 §6 的 06/07/08 已完成但 09 未完成，**方案 §2 裁决台账不改**，留待 09 交付时统一更新。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-08-model-pricing.md`、`docs/issues2/README.md`、`docs/thesis-08-model-pricing-plan.md`、`docs/审查记录.md`、`src/routes/pricing.ts`、`src/web.ts`、`src/kaboo-pricing.ts`、`src/custom-pricing-store.ts`、`src/schemas.ts`（用户批准的范围外扩宽）、`web/src/components/settings/ModelPricingSection.tsx`、`web/src/components/settings/ModelPricingDialog.tsx`、`web/src/stores/model-pricing.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/types.ts`、`web/src/pages/SettingsPage.tsx`、`container/agent-runner/src/runtime/pi/pi-session.ts`（仅注释）、`docs/API.md`、`docs/ACL-MATRIX.md`、`tests/**`。

不含 `src/db.ts`、`src/db-schema/**`、`web/package.json`、`data/`、其他前端文件。

## 4. 验收条件

1. 设置页没有"模型单价"；`/api/pricing` 五个接口返回 404。
2. 定价层 6 个源码文件与 4 个测试文件删除；`src/schemas.ts` 不再有定价 schema。
3. `make typecheck`、`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 方案 §11.4 七项清扫检查通过。
5. 非目标未被实现：`src/db.ts`、表结构、聊天气泡、`usage` 流事件、依赖文件均无改动。
6. **人工冒烟（用户）**：登录 → 设置页系统配置无"模型单价" → 对话一轮正常。

## 5. 非目标

- 不删 `custom_model_pricing` 表和 `src/db.ts` 里的读写函数（THESIS-14）；本包之后它们暂时成为孤儿导出。
- 不改聊天气泡与飞书摘要（THESIS-09）。
- 不改 `web/package.json` 依赖（无只服务定价层的第三方包）。
- 不读写 `data/`。

## 6. 风险与回滚

- **孤儿导出**：`src/db.ts` 的 `normalizePricingPattern`、五个 `*CustomModelPricing*` 函数与 `CustomModelPricing` 类型在本包后无调用方，已在本 plan 与交付记录登记，随 THESIS-14 删除。
- **测试覆盖空档**：`tests/pricing-routes.test.ts` 还覆盖 `custom_model_pricing` 的 CRUD 与 v73 迁移形状；删除后这些覆盖要到 THESIS-14 随函数/表消失才最终收口；`tests/db-upgrade-safety.test.ts` 的 v73 版本钉仍保留迁移链事实。
- **路径 404 的证明力**：`PATCH/DELETE` 在路由存在时对不存在的 id 也返回 404，因此新用例同时断言"无认证请求返回 404"（存在时会返回 401）与"路由模块/挂载不存在"。
- **回滚**：`git revert <提交号>`；无数据迁移，回滚零额外操作。
