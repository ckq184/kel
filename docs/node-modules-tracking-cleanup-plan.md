# 任务立项：node_modules 误追踪清理

> 立项日期：2026-11-24｜base：`5ccf1b3`｜分支：`claude/node-modules-tracking-fix`
> 来源：用户报告 main 的 `17113e9` 误提交三处自引用 `node_modules` 符号链接，新 worktree 跑 `npm ci` 后 `check-scope` 报 3 个路径越界。

## 0. 需求采访结论

- **目标**：把三处误追踪的 `node_modules` 符号链接从版本库中移除，并让 `.gitignore` 同时覆盖目录、文件与符号链接三种形态，保证新 worktree 跑 `npm ci` 后 `check-scope` 不再把它们当作变更路径。
- **完成条件**：
  1. `git ls-files` 中不存在任何以 `node_modules` 为路径段的条目；
  2. 从修复后的 main 新建 worktree，三侧 `npm ci` 后 `node scripts/check-scope.mjs` 通过；
  3. `npm run verify` 六步全绿；
  4. 新增防回潮契约测试，锁住"不追踪 node_modules"与"忽略规则覆盖符号链接"两条。
- **约束**：不重写历史、不 force-push；不修改 `check-scope` 判定逻辑；不动其他 worktree 的工作树；不触碰 `data/` 与任何密钥。
- **非目标**：不修正 `17113e9` 本身（该提交仍是历史事实）；不自动清理其他 worktree；不改变 worktree 共用主仓依赖的本地用法（修复后该用法仍可用，只是不再进入索引）。

## 1. 关键事实（开工前核实）

- **引入点**：`17113e9` 是 `bfa96a1`（main）与 `aa0c18c`（THESIS-01 分支）的合并提交；两个父提交的树里都没有 `node_modules` 条目，合并结果却新增了三条 `120000` 符号链接。`git log --all -- node_modules web/node_modules container/agent-runner/node_modules` 只命中 `17113e9`，说明是合并工作树里的本地链接被 `git add -A` 带进了 evil merge。
- **链接形态**：三条都是指向主 worktree 绝对路径的自引用链接：
  - `node_modules -> /Users/xy/Desktop/workspace/text-repo/node_modules`
  - `web/node_modules -> /Users/xy/Desktop/workspace/text-repo/web/node_modules`
  - `container/agent-runner/node_modules -> /Users/xy/Desktop/workspace/text-repo/container/agent-runner/node_modules`
- **忽略规则缺口**：`.gitignore` 的 `node_modules/` 带尾斜杠，只匹配目录。实测：该规则下 `git add -A` 仍会收录名为 `node_modules` 的符号链接和普通文件；去掉尾斜杠后三种形态都被忽略。
- **新 worktree 症状**：worktree 基于含链接的提交时，`npm ci` 把链接替换成实体目录；索引里仍是符号链接，`git diff` 把三个路径列为删除/类型变化，`check-scope` 因 `base→工作树` 全量 diff 报越界。`git ls-files --others --exclude-standard` 不收录它们（索引中仍存在），所以问题不是"未跟踪目录泄漏"，而是"索引条目被替换"。
- **旧 worktree 合并阻塞**：已跑过 `npm ci` 的 worktree 里，索引记录的符号链接在工作树被目录取代，`git status` 显示 ` D`；直接 merge 删除提交会报 `Your local changes ... would be overwritten`。先执行 `git rm --cached -r --ignore-unmatch node_modules web/node_modules container/agent-runner/node_modules` 再合并可成功，实体目录保留且后续被忽略。
- **现状范围**：主 worktree（`claude/thesis-01-desktop-removal`）索引不含这些条目；`main-view`、`thesis-03` 至 `thesis-07` 六个 worktree 各含三条。修复只落在 main，已有 worktree 按本文件第 7 节自行清理。
- **历史重写评估**：`17113e9` 之后 main 还有 THESIS-03/04 等提交，远端已存在该提交，多个 worktree 以其为祖先；重写需要 force-push 并改写所有后继 SHA。前向删除提交在合并时能正确传播：分支侧未修改这些路径，main 侧的删除会被保留。

## 2. 方案

前向修复，不重写历史：

1. `.gitignore` 的 `node_modules/` 改为 `node_modules`，同时覆盖目录、普通文件与符号链接。
2. 用 `git rm --cached` 把三条索引条目移出跟踪，工作树里的本地符号链接保留（随后被新规则忽略），不删除主仓依赖。
3. 新增 `tests/node-modules-tracking-contract.test.ts`：
   - 断言当前仓库索引无任何 `node_modules` 路径段；
   - 在临时 git 仓库中复制本仓 `.gitignore`，分别放入名为 `node_modules` 的目录、普通文件（非 Windows 再补符号链接），`git add -A` 后断言均未被收录。
4. 从修复分支新建干净 worktree，三侧 `npm ci` 后跑 `check-scope` 与 `verify`，复现并验证用户场景。

## 3. 实现步骤（TDD）

1. **Red**：新增契约测试；在修复前的工作树上运行，索引断言因三条链接失败，忽略规则断言因 `node_modules/` 不匹配符号链接/文件失败。
2. **Green**：改 `.gitignore`；`git rm --cached -r` 三条索引条目；重跑契约测试通过。
3. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`。
4. **场景复现**：新建 worktree → `make install`（三侧 `npm ci`）→ `check-scope` 通过 → `npm run verify` 六步全绿。
5. **合入**：本地 main 以 `--no-ff` 合并修复分支，合并树再跑 verify/check-scope；不推送。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/node-modules-tracking-cleanup-plan.md`、`.gitignore`、`tests/node-modules-tracking-contract.test.ts`、`node_modules`、`web/node_modules`、`container/agent-runner/node_modules`。

## 5. 验收条件

1. `git ls-files | grep node_modules` 无输出。
2. 修复后从 main 新建 worktree，根、`web/`、`container/agent-runner/` 三侧 `npm ci` 均成功。
3. 上述新 worktree 中 `node scripts/check-scope.mjs` 通过，输出不再出现任何 `node_modules` 路径。
4. `npm run verify` 六步全绿。
5. 本地 main 已包含修复；远端推送由用户执行。

## 6. 非目标

- 不重写 `17113e9` 或任何历史提交，不 force-push。
- 不自动改动其他 worktree 的索引或工作树；只在本文件第 7 节给出清理命令。
- 不修改 `scripts/check-scope.mjs`，不把 `node_modules` 加进例外（那会掩盖索引污染）。
- 不删除任何已安装依赖，不修改 `node_modules/` 内容。
- 不新增运行时依赖。

## 7. 风险与回滚

- **本地符号链接用法**：修复后 `node_modules` 规则覆盖符号链接，worktree 继续用"链接到主仓依赖"不会进 `git status`；跑 `npm ci` 则替换成实体目录，同样被忽略。
- **旧 worktree**：先 `git rm --cached -r --ignore-unmatch node_modules web/node_modules container/agent-runner/node_modules`，再 merge/rebase 最新 main；实体依赖目录保留。
- **回滚**：`git revert <修复提交>` 会恢复三条索引条目；不建议，除非确认要回到旧行为并自行承担 `npm ci` 后的范围误报。
- **远端**：修复只在本地 main；推送前请确认所有活跃 worktree 已清理索引，避免它们把旧链接状态带进后续提交。

## 8. 交付记录

（实现与验证完成后补记）
