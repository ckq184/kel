# 任务 N：仓库行尾轻量策略（.gitattributes 可执行文本 eol=lf）

> **文档定位**：任务 K §5-3 预留裁决位的落地任务（轻量）。自包含可交接。
> **建议注入语**：「阅读 docs/task-n-gitattributes-lightweight-plan.md，开工。」
> **基线（回滚点）**：`2cd187c`（任务 M 收官提交）。
> **批准状态**：用户 2026-10-24 在任务 M 收官后的裁决问询中选定
> **轻量方案**（彻底方案与维持现状被否）；同场裁决 CI/remote 暂不配置
> （宪法门禁表行 1/行 2 继续待建设）。

## 0. 一句话立项理由

`core.autocrlf=true` 且无 `.gitattributes` 是贯穿任务 K/L 的 CRLF 摩擦
土壤（H 类测试修复、hooks 检出归一、prettier endOfLine 特判、verify
第 6 步 warning 噪音）。用户裁决轻量方案：只锁定**可执行文本**在一切
检出形态下为 LF，消除「CRLF 破坏 sh shebang/命令行」这一类问题；其余
文件维持现状，warning 噪音与既有特判继续容忍（彻底归一未采纳，冻结期
成本不值）。

## 1. 范围与非目标

**范围（单批）**：

1. 仓库根新增 `.gitattributes`：`.githooks/* eol=lf` + `*.sh eol=lf`
   （含裁决注释）。
2. 工作区行尾刷新：加规则后 git 对工作区 CRLF 的 `scripts/install-host-tools.sh`
   判为 dirty，`git checkout --` 刷新归一（内容零变化，仅行尾）。
3. 引用点同步（4 处）：`scripts/verify.mjs` 文件头注 + 第 6 步 note
   （「仓库无 .gitattributes」表述过时）；`scripts/install-githooks.mjs`
   头注（归一逻辑从「唯一防线」降为「兜底」）；`tests/reproducible-build-contract.test.ts`
   的 endOfLine:'auto' 特判注释（特判**保留**——轻量方案不覆盖源码
   prettier 行尾，理由更新为已裁决现状）。
4. 契约锁定：`tests/githooks-contract.test.ts` 新增断言——`.gitattributes`
   须含 `.githooks/*` 与 `*.sh` 的 `eol=lf` 规则（手滑删规则即红）。
5. 裁决落档：任务 K 计划 §5-3 补裁决结果、REMAINING-WORK 状态快照、
   AGENTS.md 目录结构段补 `.gitattributes` 一句。

**非目标**：全仓行尾归一（`* text=auto`，彻底方案，未采纳）；prettier
endOfLine 特判回收（随彻底方案才可回收）；CI/remote（另行裁决，现暂缓）；
verify 第 6 步 warning 噪音消除（autocrlf 对其余文件仍在，以退出码为准
的现行语义不变）。

## 2. 验收

- `.gitattributes` 两规则落库；`git status` 干净（.sh 与 .githooks/\* 无
  行尾残留 dirty）。
- `scripts/*.sh` 与 hooks 实测仍绿（verify 第 3 步等价链包含两个 .sh
  检查 + sync 脚本；install-githooks.mjs 幂等重装不破坏）。
- 新契约断言绿；冷却态全量 `npm run verify` 0 失败文件；check-scope 过。

## 3. 执行记录

### 单批收官（2026-10-24，立项 `a2e1643` + 本 `chore:` 提交）

1. `.gitattributes` 两规则落库（裁决注释内嵌）；探针确认加规则后
   git status 不产生行尾 dirty（eol=lf 只约束后续检出）。
2. 工作区归一：`scripts/install-host-tools.sh`（唯一 CRLF 工作副本）
   删除重检出 → `file` 确认 LF；`check-stream-event-sync.sh` 实测绿。
3. 引用点同步 4 处：verify.mjs 头注与第 6 步 note、install-githooks.mjs
   （归一从唯一防线降为兜底）、reproducible-build-contract 特判注释
   （特判保留——轻量方案不覆盖源码 prettier 行尾）。
4. 契约锁定：githooks-contract 新增「.gitattributes 锁定可执行文本
   eol=lf」断言（删规则即红，与「三 shim LF」断言互为表里——前者防
   检出形态回退，后者防工作副本污染）。
5. 裁决落档：任务 K 计划 §5-3、AGENTS 目录结构段、REMAINING-WORK。
