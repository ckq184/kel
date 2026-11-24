# THESIS-08 用量（三）：模型单价下线

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
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

（交付时填写）
