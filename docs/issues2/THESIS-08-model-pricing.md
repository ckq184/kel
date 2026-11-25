# THESIS-08 用量（三）：模型单价下线

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 领取人 / 分支 | THESIS-08 会话 / `claude/thesis-08-model-pricing`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 类型          | 裁剪（定价层，方案 L3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 依赖          | THESIS-07（`usage-service.ts` 是定价层的另一个调用方，07 删除它之后才能删定价）                                                                                                                                                                                                                                                                                                                                                                                                         |
| 阻塞          | THESIS-14                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 可并行        | ✅ 01、02、04、05、09、15。⚠️ 03（`settings/types.ts`、测试）；12（`SettingsPage.tsx` 不同区域）；13（`docs/ACL-MATRIX.md`）。❌ 06、07（本包依赖它们）；10、11（同改 `SettingsPage.tsx`、`SettingsNav.tsx`、`src/web.ts`、`src/routes/pricing.ts`）；14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                                                                                                 |
| 预计改动路径  | `src/routes/pricing.ts`、`src/web.ts`、`src/kaboo-pricing.ts`、`src/custom-pricing-store.ts`、`web/src/components/settings/ModelPricingSection.tsx`、`web/src/components/settings/ModelPricingDialog.tsx`、`web/src/stores/model-pricing.ts`、`web/src/components/settings/SettingsNav.tsx`、`web/src/components/settings/types.ts`、`web/src/pages/SettingsPage.tsx`、`container/agent-runner/src/runtime/pi/pi-session.ts`（仅注释）、`docs/API.md`、`docs/ACL-MATRIX.md`、`tests/**` |
| 需用户决策    | 否（D-C1 已定 ③）                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 来源          | 方案 §6（L3、T3）、§11.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 目标

设置页不再有"模型单价"，`/api/pricing` 下线，内置价格表和自定义规则缓存删除。

## 范围（锚点为 `d6e04aa`）

| 部分 | 内容                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端 | 删除 `src/routes/pricing.ts`（166，五个接口：规则增删改查与预览）及挂载 `src/web.ts:81`、:234；删除 `src/kaboo-pricing.ts`（396）、`src/custom-pricing-store.ts`（53）                                                                                                             |
| 前端 | 删除 `ModelPricingSection.tsx`（242）、`ModelPricingDialog.tsx`（318）、`stores/model-pricing.ts`（129）；`SettingsNav.tsx:74-78` 的导航项与 `Coins` 图标导入；`settings/types.ts:117` 的 `'pricing'`；`SettingsPage.tsx` 的 :22 导入、:34 与 :57 的标签、:137 的标题、:256 的渲染 |
| 注释 | `container/agent-runner/src/runtime/pi/pi-session.ts:8`、:53 提到"宿主账本（usage-service / kaboo-pricing）"，改为不指向已删模块的描述                                                                                                                                             |
| 文档 | `docs/API.md` 定价 10 行；`docs/ACL-MATRIX.md` 1 行                                                                                                                                                                                                                                |

已核实：定价层之外，只有 `src/db.ts` 的 `custom_model_pricing` 读写函数引用它（V-C3），这些函数随表在 THESIS-14 删除。`tests/task-continuation-scheduler.test.ts:221` 的"model pricing table"只是描述 schema 历史的注释，不是代码路径（V-C4 结案）。

## 非目标

- 不删 `custom_model_pricing` 表和 `src/db.ts` 里的五个读写函数（THESIS-14）。本包之后它们暂时成为孤儿导出。
- 不改聊天气泡（THESIS-09）。

## 执行前核实

- **V-C2**：`tests/no-duplicate-helpers-contract.test.ts` 有 7 处引用定价辅助函数，逐条确认是删掉断言还是改写。
- 对 `kaboo`、`KabooModelPricing`、`getEffectiveCustomPricing`、`ModelPricing`、`/api/pricing` 做一次 `git grep`，范围包含 `tests/`、`web/`、`docs/`、`container/`。

## 实现步骤（TDD）

1. **Red**：路由用例：五个 `/api/pricing` 接口返回 404；源码契约用例：设置导航不再出现"模型单价"与 `pricing` 标签。
2. **Green**：按范围表修改。
3. **测试同步**：删除 `tests/pricing-routes.test.ts`（721）、`tests/custom-pricing.test.ts`（214）、`tests/custom-pricing-frontend.test.ts`（182）、`tests/kaboo-pricing.test.ts`（213）；改写 `tests/no-duplicate-helpers-contract.test.ts`、`tests/frontend-settings-information-architecture.test.ts`。
4. **前端清扫**：方案 §11.4。

## 验收条件

1. 设置页没有"模型单价"；`/api/pricing` 五个接口返回 404。
2. `make typecheck`、`make build` 通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 方案 §11.4 清扫检查项通过。

## 风险与回滚

- **回滚**：`git revert <提交号>`。

## 交付记录

- 提交：立项 `b765cea`、实现 `7ede632`、契约补强 `63988a8`、审查处置 `99f6d49`、交付（本提交）。
- 验证：`npm run verify` 6/6 全绿（361 文件，2977 通过 / 23 跳过 / 0 失败，51.0s）；`make clean && make build` 通过，清掉 tsc 遗留的 `dist/routes/pricing.js`、`dist/kaboo-pricing.js`、`dist/custom-pricing-store.js`；`node scripts/check-scope.mjs` 27 路径全在声明范围内。独立代理规格审查（0 阻塞 / 6 非阻塞）与代码质量审查（Critical 0 / Major 0 / Minor 7）通过，处置与登记见 `docs/审查记录.md`。
- 与 issue 描述的偏差：
  1. **范围扩宽 `src/schemas.ts`（用户 2026-11-25 批准）**：删除只被 `/api/pricing` 使用的 `CustomPricingCreateSchema`、`CustomPricingPatchSchema`、`CustomPricingPreviewSchema`、`customPricingFields`、`pricePerMTok`。issue 范围表未列该文件，plan §0/§3 与 `.gatescope.json` 已登记理由。
  2. **测试同步比 issue 多两处**：`tests/frontend-settings-information-architecture.test.ts` 与 `tests/thesis-07-usage-ledger-stop.test.ts` 中涉及 pricing 的断言删除，由新增 `tests/thesis-08-model-pricing-removal.test.ts`（18 例）独占删除契约；`tests/no-duplicate-helpers-contract.test.ts` 只保留 `normalizePricingPattern` 单一导出断言。
  3. **覆盖空档**：删除 `tests/pricing-routes.test.ts` 同时带走 `custom_model_pricing` CRUD、v73 迁移形状与 store 投影的直接覆盖；`tests/db-upgrade-safety.test.ts` 的 v73 版本钉仍在，函数/表本体留给 THESIS-14，届时随删。
  4. **留待 THESIS-14 的悬空注释/孤儿导出**：`src/db.ts:10493`（指向已删 `kaboo-pricing.ts`）、`:10514`（"validated at the API layer"）、`:10549`（"pricing routes' 409 uniqueness prechecks"）与 `src/db-schema/agent-profile-tables.ts:135-137`（"pure pricing module"）；`normalizePricingPattern` 仍被 `db.ts` 内部 create/update 调用，本包按非目标未改 `src/db.ts`。
  5. `dist/` 构建产物不在版本控制，交付前用 clean build 复核；推送由用户执行。
- 人工冒烟待用户执行：登录 → 设置页系统配置分组无"模型单价" → 对话一轮正常；访问 `/api/pricing/rules` 返回 404。
