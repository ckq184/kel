# ISSUE-15 Windows 测试兼容性：CRLF 源码锚点与路径分隔符归一

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 进行中                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 领取人 / 分支 | issue-15-windows-test-compat                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 优先级        | P1（阻塞后续所有任务的 verify 全绿交付）                                                                                                                                                                                                                                                                                                                                                                                                          |
| 类型          | 测试侧兼容性修复（生产行为零改动）                                                                                                                                                                                                                                                                                                                                                                                                                |
| 依赖          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 预计改动路径  | `tests/channel-connector-failure-safety.test.ts`、`tests/graceful-shutdown-order.test.ts`、`tests/issue11-compat-and-duplicate-convergence.test.ts`、`tests/makefile-runtime-contract.test.ts`、`tests/mcp-tools-path-containment.test.ts`、`tests/no-duplicate-helpers-contract.test.ts`、`tests/turn-outcome.test.ts`、`tests/warm-channel-outbox-scope-correlation.test.ts`、`tests/workflow-card-contract.test.ts`、`scripts/check-scope.mjs` |
| 需用户决策    | 否（测试侧归一不改任何被测行为；`isPathWithinWorkspaceRoot` 生产行为不动，夹具按 `path.sep` 构造保持各平台原生语义）                                                                                                                                                                                                                                                                                                                              |
| 来源          | ISSUE-09 合入 main（212df80）时发现：本机（Windows + 系统级 `core.autocrlf=true`）`npm run verify` 第 4 步必红                                                                                                                                                                                                                                                                                                                                    |

## 缺口：Windows 下 verify 第 4 步 21 例必红

取证（2026-11-21，HEAD `212df80`）：本机 Git 系统配置 `core.autocrlf=true`（`D:/Git/etc/gitconfig`），全仓工作树文件为 100% CRLF（`src/index.ts` 19922/19922 行尾为 CRLF，抽样 `src/web.ts`、`Makefile`、`web/src/stores/chat.ts` 同）。失败 21 例与纯 main `7b957b0` 逐条一致（对照 worktree `comm` 比对为空），分两类：

**A. 路径分隔符（3 文件 11 例）**——测试辅助/夹具在 Windows 产出 `\` 或 POSIX 字面量与 `path.sep` 生产实现互斥：

| 文件                                                     | 根因                                                                                                                                  | 例数 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `tests/no-duplicate-helpers-contract.test.ts`            | `listSourceFiles` 用 `path.join(dir, entry.name)` 产出 `src\...`，断言写死 `src/...`                                                  | 6    |
| `tests/issue11-compat-and-duplicate-convergence.test.ts` | `listWebSources` 同上                                                                                                                 | 2    |
| `tests/mcp-tools-path-containment.test.ts`               | 夹具为 POSIX 字面量 `/ws/group1/...`，生产 `isPathWithinWorkspaceRoot` 按 `path.sep` 前缀比较（Windows 下 `/ws/group1` + `\` 不匹配） | 3    |

**B. CRLF 源码锚点（6 文件 10 例）**——断言内嵌 `\n`，磁盘内容为 `\r\n`：

| 文件                                                  | 例数 |
| ----------------------------------------------------- | ---- |
| `tests/turn-outcome.test.ts`                          | 3    |
| `tests/warm-channel-outbox-scope-correlation.test.ts` | 3    |
| `tests/channel-connector-failure-safety.test.ts`      | 1    |
| `tests/graceful-shutdown-order.test.ts`               | 1    |
| `tests/makefile-runtime-contract.test.ts`             | 1    |
| `tests/workflow-card-contract.test.ts`                | 1    |

另登记：`scripts/check-scope.mjs` 的 `git diff --name-only` 未关 `core.quotepath`，Windows 默认配置下中文路径（`docs/审查记录.md`）被八进制转义导致 allow 命中误判为越界（本次合入 ISSUE-09 时已实测撞到，临时用本仓库 `core.quotepath=false` 规避）。

## 实现要点

- **B 类**：读源处统一 `.replace(/\r\n/g, '\n')` 归一（每文件一处辅助函数或读点内联）。LF 环境零变化；CRLF 环境下内嵌 `\n` 的锚点恢复匹配。
- **A 类前两文件**：文件清单构造改 `path.posix.join`（`readdirSync` 的绝对路径打开仍用原生 `path.join`，仅清单字符串归一）。
- **A 类 mcp-tools**：夹具改 `parts.join(path.sep)` 逐平台原生构造，`isPathWithinWorkspaceRoot` 生产实现不动（ISSUE-05 §4“纯字符串前缀比较”语义逐平台原样受测）。
- **check-scope**：`git` 调用前置 `-c core.quotepath=false`（脚本级，免去每个 Windows 克隆手工配 git config）。
- **S2 竞态顺带修**：`requireDatabase` 用例原写法连续调用两次 `nowIso()`，毫秒跨界即红（本日满载轮两翻）；改取值一次再验 round-trip 恒等。该用例位于本任务已声明文件内，不修则"verify 全绿"验收标准随机不成立，详见 plan §2.4。
- **非目标**：不改任何 `src/`、`web/src/`、`container/agent-runner/src/` 生产代码；不动 `.gitattributes` 行尾策略（全仓 eol 归一曾被用户裁决否决，不重开）；不做 CI 化。

## 验收标准

- 本机 `npm run verify` 六步全绿（此前 step 4 必红 21 例）。
- `node scripts/check-scope.mjs` 通过（且撤销本仓库 `core.quotepath=false` 局部配置后仍通过——脚本级修复自证）。
- 每处修复只做归一，不放宽任何断言语义（锚点文本、断言方向、例数均不变）。

## 交付记录

（领取后填写）
