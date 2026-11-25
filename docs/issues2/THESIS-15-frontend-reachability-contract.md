# THESIS-15 可选：前端可达性契约测试

| 字段          | 值                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                             |
| 领取人 / 分支 | `claude/thesis-15-frontend-reachability-contract`                                                                  |
| 优先级        | P3                                                                                                                 |
| 类型          | 测试工具（审核优化 O7，不在方案原有范围内）                                                                        |
| 依赖          | 无                                                                                                                 |
| 阻塞          | 无。若采纳，建议排在 THESIS-03、06、08、09、10、11 之前，供它们直接复用                                            |
| 可并行        | ✅ 01、02、03、04、05、06、07、08、09、10、11、12、13、14。只新增一个测试文件（口径见 [README 第三节](README.md)） |
| 预计改动路径  | `tests/frontend-reachability-contract.test.ts`（新增）                                                             |
| 需用户决策    | **是**：是否采纳。新增测试工具按约束需要用户批准                                                                   |
| 来源          | 方案 §11.1、§11.4 第 1 条；审核报告 O7                                                                             |

## 背景

方案 §11 要求每裁一个功能，前端不留孤儿文件，判定标准是"从 `web/src/main.tsx` 按 import 关系可达的文件之外，不应再有不可达的非测试文件"。目前这条只能人工核对。前端裁剪包有 6 个，每个都要核对一次，人工做容易漏，也无法复现。

## 目标

新增一个 vitest 契约测试：从 `web/src/main.tsx` 出发，沿静态 `import`、`export … from` 和动态 `import()` 遍历 `web/src` 下的模块，断言所有非测试 `.ts`、`.tsx` 文件都可达。

## 约束

- 只用 Node 内置模块和正则解析 import，不引入新依赖。
- 按方案 §11.1 的口径排除：测试文件、`.d.ts` 类型声明、`make sync-types` 同步出来的副本。
- 在 `d6e04aa` 上应当通过。如果现在就有不可达文件，先列出来请用户决定，不要顺手删除（审查口径：掉线逻辑与意图信号先请用户决定）。
- 预计约百行。超过两百行说明设计过重，停下来重新评估。

## 验收条件

1. 新测试在当前代码上通过，并能被 `make test` 执行。
2. 人为删除一个 import（例如去掉 `App.tsx` 对某个页面的懒加载）时，测试失败并指出不可达的文件。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。

## 交付记录

- **提交**：立项 `4f9b1b8`、实现 `7983d31`、审查处置 `47ed6a7`、`f898425`、交付（本提交）。
- **验证**：`npm run verify` 6/6 全绿（366 文件，3010 通过 / 23 跳过 / 0 失败，36.5s）；`node scripts/check-scope.mjs` 6 路径全在 `.gatescope.json` 声明范围内；新增用例 1/1 通过。独立规格审查零阻塞；代码质量审查 Critical 0 / Major 0 / Minor 7，已处置 5 项、登记 2 项，详见 `docs/审查记录.md` 的 THESIS-15 节。
- **反向验证**：临时注释 `web/src/App.tsx` 的 `MemoryPage` 懒加载后，用例失败并列出 `web/src/pages/MemoryPage.tsx` 与 `web/src/features/workspace-memory/model.ts`；已还原，未提交。
- **与 issue 描述的偏差**：
  1. 实际改动除测试文件外还含立项计划与流程簿记（`.gatescope.json`、issue、README 索引、`docs/issues2/task-thesis-trim-plan.md` §14 第 18 项、`docs/审查记录.md`）；issue 的「预计改动路径」只列测试文件，这些均为 README 第一节要求的簿记，已在 `.gatescope.json` 声明。
  2. `docs/issues2/task-thesis-trim-plan.md` 仅把 §14 第 18 项「是否采纳」改为「已采纳（2026-11-25）」，不改编排与范围。
  3. 额外在基线 `d6e04aa` 上按同一口径复核：229 个目标模块、0 个不可达，满足 issue 的「在 d6e04aa 上应当通过」约束；正式测试在任务 base `da4920b` 上执行。
  4. 解析口径：类型位置 `typeof import('x')` 计为边（编译期可达，非运行时打包可达）；注释剥离用保守启发式；测试文件排除仅 `*.test.ts(x)`，当前树无 `*.spec.ts`/`__tests__/`。这些边界已写入 plan §6。
- **待用户验收**：本包只新增测试与簿记，无 UI/数据/接口变更，无需人工冒烟；可复核 `npx vitest run tests/frontend-reachability-contract.test.ts` 与 `make test`。
- **方案台账**：THESIS-15 是可选测试工具，不是方案 §2 的专题；采纳决策已随立项记入 §14 第 18 项。README 索引状态本提交同步为「已完成」。
