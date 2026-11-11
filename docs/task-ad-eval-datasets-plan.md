# 任务 AD 立项:评测集管理(可视化编辑 + 导入 + 多集切换)

> **状态**:2026-11-11 用户提出「评测集的内容要做可视化,可以在评测集里自己写评测集和导入评测集」,按宪法先立项再实现。基线 `99cb209`(任务 AC 收官提交)。
> **回滚点**:立项提交的父 HEAD `99cb209`(`.gatescope.json` 的 base;实现 diff 基线=立项提交)。
> **前置条件**:任务 AB(eval.db + 评测页)+ AC(Web 触发)已交付;`scripts/eval/auto-recall-golden.json`(20 记忆/17 查询)与 `validateGoldenSet` 校验链已存在且被 19 用例锁定。

---

## 0. 一句话结论

golden set 从单一硬编码 JSON 文件升级为 eval.db 里的**多套可管理评测集**:新增 `eval_datasets` 表(user_version 1→2 前向迁移,内置集由现有 JSON 文件首次播种),Web「评测」页新增 admin-only「评测集」tab(列表→可视化表格编辑器[seed+queries 增删行]→JSON 导入/导出),保存与导入都过 `validateGoldenSet` 校验;评测执行(命令行 `--dataset` 与 Web 触发弹窗下拉)可选集,run 落库记录所用集名。

## 1. 已拍板裁决(技术选型按先例,无需用户再确认)

1. **存储=eval.db 加表**(`user_version=2`,eval-store 自版本化迁移,拒绝降级沿用):`eval_datasets(name TEXT PK, description TEXT, data_json TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual'['builtin'|'manual'|'import'], created_at, updated_at)`。文件 `scripts/eval/auto-recall-golden.json` 降级为 builtin 播种源(内容不变),迁移时以 `source='builtin'`、name=`auto-recall` 幂等写入。
2. **管理权限=admin only**(`manage_system_config`,与「真实对话」tab 同级):自写评测集可能包含用户真实记忆内容,读写都收紧;评测**执行**仍沿 AC 裁决(触发=admin)。
3. **校验下沉**:GoldenSet 类型 + `validateGoldenSet` + `QUERY_MAX_CHARS` 从 `scripts/eval-auto-recall.ts` 移到新 `src/eval-dataset.ts`(tsconfig `rootDir=src`,宿主 build 不编译 scripts/,路由无法 import 脚本);脚本 re-export 保持既有符号与测试兼容。
4. **builtin 只读**:`source='builtin'` 的集不可删除、内容可改(改后仍标 builtin;校验保证完整性)。评测集名规则 `[\w-]{1,64}`。
5. **导入格式=现有 golden set JSON**(seed+queries);导入粘贴或文件上传解析后先校验后落库,非法给出逐条 issue 列表。
6. **多集切换**:评测脚本 `--dataset <name>`(缺省 `auto-recall`);加载顺序=DB 优先、DB 无该名时回退 builtin JSON 文件(兼容旧习惯);run 的 `config_json` 记 `dataset` 名;Web 触发弹窗加 dataset 下拉(默认 auto-recall)。

## 2. 方案设计

- `src/eval-dataset.ts`(新):GoldenSet/GoldenSeedItem/GoldenQuery/GoldenCategory 类型、QUERY_MAX_CHARS、validateGoldenSet(整体搬移,零逻辑改动)。
- `src/eval-store.ts`(改):v2 迁移(eval_datasets 表+builtin 播种[name='auto-recall' ON CONFLICT DO NOTHING]);`listDatasets()`、`getDataset(name)`、`upsertDataset({name, description?, data, source})`(upsert 前由调用方校验)、`deleteDataset(name)`(不存在 false);builtin 播种源=读 `scripts/eval/auto-recall-golden.json`(文件缺失则跳过播种,不阻塞迁移)。
- `src/routes/eval.ts`(改):
  - `GET /datasets`(admin)列表(name/description/source/seed 数/queries 数/updated_at,不含 data)
  - `GET /datasets/:name`(admin)含 data
  - `POST /datasets`(admin)创建 `{name, description?, data}` → validateGoldenSet 失败 400(issues 全量返回)
  - `PUT /datasets/:name`(admin)更新(同校验)
  - `DELETE /datasets/:name`(admin)删除(builtin 409)
  - `POST /runs/trigger` body 加 `dataset`(可选,缺省 auto-recall,名校验 `[\w-]{1,64}`)
- `src/eval-trigger.ts`(改):input 加 dataset 字段,拼 `--dataset <name>`。
- `scripts/eval-auto-recall.ts`(改):`--dataset` 参数;golden set 加载顺序 DB→文件;报告 config 记 dataset;类型/校验 re-export 自 src/eval-dataset.js。
- `web/src/pages/EvalPage.tsx`(改):tabs 加「评测集」(admin);列表卡片→选中进编辑器(seed 表格[marker/content/keys 每行可编辑+增删]、queries 表格[id/category 下拉四类/text/expected/note+增删])→保存(校验错误逐条展示)/删除/导出 JSON(下载)/新建(空白模板)/导入(粘贴 JSON 或文件选择→解析校验→预览→保存);trigger 弹窗加 dataset 下拉。

## 3. 执行顺序(TDD,每批次先写测试见红)

1. **批次 1 存储**:扩展 `tests/eval-store.test.ts`(v1→v2 迁移幂等+builtin 播种+CRUD+拒绝 v3)→ `src/eval-dataset.ts` + eval-store v2。
2. **批次 2 API+触发器**:扩展 `tests/eval-routes.test.ts`(401/403/400 校验 issues/409 builtin 删除/dataset 列表形状)+ `tests/eval-trigger.test.ts`(--dataset 拼装)→ routes + trigger。
3. **批次 3 脚本**:扩展 `tests/eval-auto-recall-metrics.test.ts`(加载顺序纯函数/re-export 兼容)→ 脚本改造。
4. **批次 4 前端**:扩展 `tests/eval-frontend.test.tsx`(tab 门控/列表/编辑器字段/导入入口/trigger 下拉)→ EvalPage。
5. **批次 5 文档+门禁**:API.md/AGENTS.md/CLAUDE.md → `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - 评测集管理：可视化编辑与导入（任务AD）`。

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-ad-eval-datasets-plan.md`、`src/eval-dataset.ts`
修改:`src/eval-store.ts`、`src/routes/eval.ts`、`src/eval-trigger.ts`、`scripts/eval-auto-recall.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-store.test.ts`、`tests/eval-routes.test.ts`、`tests/eval-trigger.test.ts`、`tests/eval-auto-recall-metrics.test.ts`、`tests/eval-frontend.test.tsx`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`
(不动:`scripts/eval/auto-recall-golden.json` 文件内容、langfuse 导出路径、turn-observer/recall-judge。)

## 5. 风险与边界

1. **eval.db v1→v2**:前向迁移仅加表+播种,不动既有三表;拒绝降级(>2 报错)沿用;播种幂等(name PK + ON CONFLICT DO NOTHING)。
2. **校验下沉搬迁**:纯搬移零逻辑改动,既有 19 用例(metrics/validateGoldenSet)+ re-export 兼容测试锁死;若搬迁引入行为差异测试即红。
3. **自写集质量**:validateGoldenSet 是唯一门槛(key 唯一性/四类齐全/truncation 长度等),保存/导入/播种三处同链;校验不过不落库。
4. **脚本回退**:DB 无该集名时回退 builtin 文件——旧环境(data/ 无 eval.db 或无该集)行为与今天完全一致。
5. **前端工程量**:编辑器是本任务最大块;表格行内编辑全受控组件,复用 Card/Button/Input 惯例;导入文件用 `<input type=file>` 读文本(纯前端,无上传端点)。
6. **内容隐私**:评测集可含真实记忆内容——管理面 admin only;列表不含 data 正文。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):评测页「评测集」tab(admin)→ 列表见 builtin `auto-recall`(20/17)→ 进编辑器改一条 query 保存 → 校验错误场景(如 expected 填未知 marker)被 400 拦截并逐条显示 → 导入粘贴一份合法 JSON 保存为新集 → 「运行评测」弹窗选新集跑通且 run 详情 config 显示 dataset 名 → member 无该 tab;命令行 `--dataset` 同步可跑。
