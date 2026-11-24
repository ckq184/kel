# 开工提示词模板

> **用途**：在新的 agent 会话里领取、调研、复核、合入 [任务池](README.md) 里的 THESIS issue。复制对应模板，替换 `<…>` 占位符即可。
> **前提**：`docs/issues2/` 已经合入 main。新开的 worktree 会话从 main 切出，看不到未提交的文件。
> **原则**：一个 issue 开一个新会话（worktree 模式）；能提前拍板的决策直接写进提示词，省掉一轮来回；并行开工只开 README 第三节并行矩阵里两两 ✅ 的组合。

---

## 一、占位符

| 占位符         | 填什么                                          | 从哪里查                    |
| -------------- | ----------------------------------------------- | --------------------------- |
| `<编号>`       | 两位数编号，如 `01`                             | README 第二节索引           |
| `<issue 文件>` | issue 文件名，如 `THESIS-01-desktop-removal.md` | 第五节速查表                |
| `<方案章节>`   | 该 issue 对应的方案章节，如 `§10`               | 第五节速查表                |
| `<决策清单>`   | 每行一条：`- D-xx：选 ①（一句话说明）`          | 该 issue 的"需用户决策"一节 |
| `<并行清单>`   | 同时在进行的 issue 编号；没有就写"无"           | README 第三节并行矩阵       |
| `<分支名>`     | issue 会话交付时所在的分支                      | 该 issue 的交付记录         |
| `<补充说明>`   | 本次特有的注意事项，没有就删掉这一行            | 第五节速查表的"注意"列      |

---

## 二、模板

### 模板 A：标准开工（决策都已拍板）

```text
领取 docs/issues2/<issue 文件>。

先读：docs/issues2/README.md 第一节与第三节、这个 issue 全文、
方案 docs/issues2/task-thesis-trim-plan.md 的 <方案章节>。

已拍板的决策：
<决策清单>

同时在进行的 issue：<并行清单>。不要改它们的预计改动路径。
<补充说明>

按 README 第一节的流程执行：领取改状态 → 立项 plan 与 .gatescope.json → TDD
→ npm run verify 与 node scripts/check-scope.mjs → 交付。
交付时三处状态都改为"已完成"：issue 元信息、README 索引行、方案 §2（专题全部完成时）。

遇到下面任何一种情况就停下来报告，不要自己扩大范围：
锚点与代码对不上、需要改预计改动路径以外的文件、验收条件做不到。
不读写 data/，不推送，合入 main 由我决定。
```

### 模板 B：只做需求采访（决策还没想好）

```text
领取 docs/issues2/<issue 文件>，但这次只做需求采访：
读完这个 issue 和方案 <方案章节> 之后，把"需用户决策"里每一项的选项、影响和你的建议列给我，
并结合当前代码核实一遍 issue 里"执行前核实"的条目，等我拍板。
在我回复之前不要改任何文件，也不要改 issue 状态。
```

拍板后在同一个会话里接着说：

```text
拍板：
<决策清单>
按模板 A 的要求开工。
```

### 模板 C：交付复核（新会话，只读）

```text
复核 THESIS-<编号> 的交付（分支 <分支名>）：
1. 对照 docs/issues2/<issue 文件> 的验收条件逐条核对；
2. 检查 diff 是否超出预计改动路径，node scripts/check-scope.mjs 是否通过；
3. 检查三处状态是否都改成了"已完成"，交付记录里的提交号、验证结果、偏差是否齐全；
4. 前端相关的 issue 再按方案 §11.4 检查有没有孤儿文件、死导出、无人使用的依赖。
只报告问题，不要改代码。
```

### 模板 D：合入 main

```text
把分支 <分支名>（THESIS-<编号>）合入 main：
先确认该分支 npm run verify 全绿、check-scope 通过、三处状态已改为"已完成"；
按仓库惯例用 --no-ff 合入，提交信息写成 "chore: THESIS-<编号>合入main - <一句话摘要>"。
如果与其他已合入的 issue 冲突：.gatescope.json 取本分支的版本，README 索引行两边的状态都保留，
其他冲突先停下来告诉我。不要推送。
```

### 模板 E：中断后续做

```text
继续 THESIS-<编号>（分支 <分支名>）。
先读这个 issue、docs/<任务名>-plan.md 和 git log <base>..HEAD，告诉我已完成到哪一步、还剩什么，
确认后再接着做。规则同模板 A。
```

---

## 三、并行开工时

同一波里开几个会话，每个会话都用模板 A，只是 `<并行清单>` 写其余几个编号。例如第一波开 01、02、03、04、06 时，THESIS-02 的会话写：

```text
同时在进行的 issue：THESIS-01、03、04、06。不要改它们的预计改动路径。
```

合入 main 的顺序不限，但每合入一个，后面的分支都要先 rebase 最新 main 再合入（模板 D）。

---

## 四、填好的例子

**THESIS-01（模板 A，决策取默认）**

```text
领取 docs/issues2/THESIS-01-desktop-removal.md。

先读：docs/issues2/README.md 第一节与第三节、这个 issue 全文、
方案 docs/issues2/task-thesis-trim-plan.md 的 §10。

已拍板的决策：
- D-G1：选 ①（删 desktop-identity-split-plan.md，保留 dual-desktop-port-isolation-plan.md）
- D-G2：选 ①（restart-dev.command 只去掉桌面端部分）
- D-G3：选 ①（连同 esbuild 删除，但先完成 V-G1 核实）

同时在进行的 issue：THESIS-02、03、04、06。不要改它们的预计改动路径。

（以下与模板 A 相同）
```

**THESIS-11（模板 B）**

```text
领取 docs/issues2/THESIS-11-drop-permissions.md，但这次只做需求采访：
读完这个 issue 和方案 §8 之后，把"需用户决策"里每一项的选项、影响和你的建议列给我，
并结合当前代码核实一遍 issue 里"执行前核实"的条目，等我拍板。
在我回复之前不要改任何文件，也不要改 issue 状态。
```

---

## 五、速查表

| 编号 | issue 文件                                    | 方案章节 | 要拍板的决策                     | 注意（可填进 `<补充说明>`）                                                                   |
| ---- | --------------------------------------------- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| 01   | `THESIS-01-desktop-removal.md`                | §10      | D-G1、D-G2、D-G3                 | 人工冒烟要在主机模式和容器模式各做一次                                                        |
| 02   | `THESIS-02-provider-api-seal.md`              | §5       | D-1、D-4                         | D-1 选 ① 时，先在旧版界面删掉官方型供应商；按审核更正 S3，`bug-report` 的判断要改写，不能只删 |
| 03   | `THESIS-03-provider-ui.md`                    | §5       | 无                               | 同步修改 `tests/no-duplicate-helpers-contract.test.ts:380`                                    |
| 04   | `THESIS-04-provider-runtime.md`               | §5       | D-2                              | 真实 Provider 冒烟会产生费用，不要把凭据、Endpoint、模型名写进日志                            |
| 05   | `THESIS-05-provider-credential-chain.md`      | §5       | D-3                              | `oauthAccount` 剥离与残留凭据清理属于第三方分支，不删（审核更正 S2）                          |
| 06   | `THESIS-06-usage-page.md`                     | §6       | D-F3                             | D-F3 选"先导出"时，等我导出完再开工                                                           |
| 07   | `THESIS-07-usage-ledger-stop.md`              | §6       | 无（立项时确认停记账随单价执行） | 写账本的调用点有五处（审核更正 S1）；与 R2 任务池 ISSUE-26 同改 `src/task-scheduler.ts`       |
| 08   | `THESIS-08-model-pricing.md`                  | §6       | 无                               | —                                                                                             |
| 09   | `THESIS-09-bubble-duration-only.md`           | §6       | D-C3                             | D-C3 的选项已按审核结论重写                                                                   |
| 10   | `THESIS-10-single-account.md`                 | §8、§7   | D-D2、D-E2、D-E5                 | 要处理存量的其他账号，必须在开工前用旧版界面处理；关闭注册是破坏性变更，立项时须明确确认      |
| 11   | `THESIS-11-drop-permissions.md`               | §8       | D-E1、D-E7                       | 只做 E2a，保留角色判断                                                                        |
| 12   | `THESIS-12-drop-forced-password-change.md`    | §8       | D-E3                             | D-E3 选 ② 则本 issue 取消                                                                     |
| 13   | `THESIS-13-personal-docs-and-acl.md`          | §8       | D-E6                             | `CLAUDE.md` §7 表族由 THESIS-14 负责，本包不改                                                |
| 14   | `THESIS-14-drop-dead-tables.md`               | §9       | D-F1、D-F2、D-F3                 | 其余 issue 全部完成后再开；人工冒烟由我用数据库副本来做                                       |
| 15   | `THESIS-15-frontend-reachability-contract.md` | §11      | 是否采纳                         | 采纳的话放在第一波最先做                                                                      |
