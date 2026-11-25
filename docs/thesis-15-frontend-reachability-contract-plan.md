# 任务立项：THESIS-15 可选：前端可达性契约测试

> 立项日期：2026-11-25｜base：`da4920b`｜分支：`claude/thesis-15-frontend-reachability-contract`
> 来源：[docs/issues2/THESIS-15-frontend-reachability-contract.md](issues2/THESIS-15-frontend-reachability-contract.md)（方案 §11.1、§11.4 第 1 条；审核建议 O7）

## 0. 需求采访结论（2026-11-25，用户拍板）

- **采纳 O7**：新增 vitest 契约测试，把方案 §11.4 第 1 条"从 `web/src/main.tsx` 按 import 关系可达之外没有不可达的非测试文件"做成可重复执行的测试。
- **只新增测试文件，不改产品代码**：预计 `tests/frontend-reachability-contract.test.ts`；不引入新依赖，不改 CI、git hooks、Makefile 或 vitest 配置。
- **当前状态无需清理**：在 main `da4920b` 实测 212 个非测试目标模块全部可达，0 个孤儿文件；测试应直接通过。
- **解析口径**：只认静态 `import`、`export … from`、字面量动态 `import()` 与 `@/` 别名；非 TS 资源（CSS 等）和裸模块说明符不参与遍历。

## 1. 关键事实（开工前核实，main `da4920b`）

- `web/src` 共 218 个 `.ts`/`.tsx` 文件：4 个测试文件、1 个 `.d.ts`、1 个 `make sync-types` 同步副本、212 个目标模块。
- 入口 `web/src/main.tsx` 静态导入 `./App`、`./styles/globals.css`、`./utils/url`、`./utils/legacyPwaCleanup`。
- 页面入口集中在 `web/src/App.tsx` 的 `React.lazy(() => import('./pages/...'))`；其余动态导入（`ChatView`、`MessageBubble`、`AppLayout`、`MermaidDiagram`）均为字面量说明符。
- 全树无 `.js`/`.jsx`/`.mjs`，无带查询串的 import，无 `import.meta.glob`，无 `require()`；CSS 副作用导入出现在 `main.tsx` 与 `components/chat/TerminalPanel.tsx`、`MarkdownRenderer.tsx` 等包内组件，JSON 无导入。非 TS 资源不参与遍历，按 `.ts`/`.tsx` 即可覆盖全部模块边。
- 路径别名 `@/*` → `web/src/*` 定义在 `web/tsconfig.json`，测试需同步解析。
- 同步副本为 `web/src/stream-event.types.ts`，由 `scripts/sync-stream-event.sh` 从 `shared/stream-event.ts` 拷贝，按方案 §11.1 排除。
- 根 `vitest.config.ts` 默认发现 `**/*.test.ts`，`make test` 即 `npx vitest run`；新测试放在 `tests/` 下可被自动执行。
- 现有源码扫描型测试（如 `tests/frontend-pwa-retirement.test.ts`）使用 `process.cwd()` + `node:fs`/`node:path`，本测试沿用同一风格。

## 2. 实现步骤（TDD）

1. **新增测试**：`tests/frontend-reachability-contract.test.ts`
   - 按保守启发式剥离行注释与块注释，再用正则收集说明符：静态 `import … from`、副作用 `import`、`export … from`、字面量动态 `import()`。
   - 从 `web/src/main.tsx` 做 BFS；相对路径按 `.ts`、`.tsx`、`/index.ts`、`/index.tsx` 解析，`@/` 映射到 `web/src`。
   - 目标集合排除 `*.test.ts`/`*.test.tsx`、`*.d.ts` 与 `web/src/stream-event.types.ts`。
   - 断言语义：`unreachable` 数组为空，失败时输出相对路径；同时断言目标集合非空，避免入口或目录写错时假通过。
2. **先跑用例**：`npx vitest run tests/frontend-reachability-contract.test.ts`，当前代码预期通过（当前无不可达文件）。
3. **反向验证（验收条件 2）**：临时注释 `web/src/App.tsx` 中 `MemoryPage` 的懒加载 `import('./pages/MemoryPage')`，重跑该用例，确认失败并指出 `web/src/pages/MemoryPage.tsx`；随后 `git checkout -- web/src/App.tsx` 还原，确认工作树无残留。该临时改动不提交。
4. **格式与门禁**：`npm run format:changed`；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
5. **审查与交付**：独立规格审查与代码质量审查落 `docs/审查记录.md`；issue、README 索引改"已完成"并写交付记录；方案 §14 第 18 项登记"已采纳"。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-15-frontend-reachability-contract.md`、`docs/issues2/README.md`、`docs/issues2/task-thesis-trim-plan.md`（仅 §14 第 18 项状态）、`docs/thesis-15-frontend-reachability-contract-plan.md`、`docs/审查记录.md`、`tests/frontend-reachability-contract.test.ts`。

其中 `docs/issues2/task-thesis-trim-plan.md` 超出 issue 的"预计改动路径"：仅把 §14 第 18 项"是否采纳"改为已采纳，不改编排与范围；按"扩宽范围只能改声明"登记。

## 4. 验收条件

1. 新增测试在当前 main 代码上通过，且能被 `make test` 执行。
2. 人为移除一个 import 时，测试失败并指出不可达的文件（按 §2 第 3 步留证）。
3. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
4. 不修改 `web/src`、后端、依赖与门禁配置；仅为测试与簿记文件改动。

## 5. 非目标

- 不删除、不修改任何现有前端文件，包括当前已确认可达的所有模块。
- 不做死导出、入口、权限、依赖、文案的检查（§11.4 第 2–7 条；本包只做第 1 条）。
- 不引入 TypeScript 编译器、AST 解析器或新依赖；不接入 CI 或 git hooks。
- 不改 `vitest.config.ts`、`Makefile` 或 `package.json`。
- 不读写 `data/`。

## 6. 风险与回滚

- **反向验证已通过**：临时把 `web/src/App.tsx` 的 `MemoryPage` 懒加载 import 注释掉后，用例失败并列出 `web/src/pages/MemoryPage.tsx` 与 `web/src/features/workspace-memory/model.ts`；随后已还原，临时改动未提交。
- **正则解析的边界**：注释剥离用启发式（行首/空白/`{` 后的 `/*` 与行首/空白后的 `//`），避免把 `image/*`、`${protocol}//` 误判为注释；字符串内容不做词法解析。注释或字符串中恰好出现 import 文本时仍可能产生假边或假红；独立审查用 TypeScript AST 对比当前树边集合为 0 差异。若未来出现模板字符串动态导入，需同步扩展解析口径。
- **测试文件口径**：当前 `web/src` 只有 `*.test.ts`/`*.test.tsx` 四份测试文件；若未来引入 `*.spec.ts` 或 `__tests__/` 辅助文件，需同步扩展排除规则。
- **同步副本排除**：`web/src/stream-event.types.ts` 当前经 `stores/chat.ts` 可达，排除规则本身未被失败场景单独覆盖；保留是为符合 §11.1 口径，并防止该文件未来失去消费者时被误报。
- **路径写死风险**：入口与同步副本路径是方案约定的固定值；目标文件数不写死，新增/删除模块自动适配。
- **假通过风险**：目标集合非空断言兜底入口或目录拼错。
- **回滚**：单个提交，`git revert <提交号>`；不涉及数据与 schema。
