# 任务立项：ISSUE-15 Windows 测试兼容性 —— CRLF 源码锚点与路径分隔符归一

> 立项日期：2026-11-21｜base：`212df80`（main tip，ISSUE-09 合入后）｜分支：`issue-15-windows-test-compat`
> 来源：`docs/issues/ISSUE-15-windows-test-compat.md`（ISSUE-09 合入取证发现）
> 前序依赖：无。ISSUE-09 合入时已用纯 main `7b957b0` 对照 worktree 证明 21 例红灯与合并无关、均为本机 Windows 环境固有。

## 0. 需求采访结论（2026-11-21，用户指示"先修 Windows 测试兼容性"）

- **目标**：本机（Windows 10 + Git 系统级 `core.autocrlf=true`）`npm run verify` 六步全绿，使后续任务（ISSUE-10 等）拥有可交付的绿门禁基线。
- **完成条件**：verify 六步全绿 + check-scope 通过（含撤销局部 `core.quotepath` 配置自证）+ 断言语义零放宽。
- **约束**：测试侧归一优先，生产行为零改动；不重开 `.gitattributes` 全仓 eol 归一（历史裁决否决项）；非目标不做 CI 化。
- **无需用户拍板项**：无行为取舍——所有修复均为表示层归一，被测语义逐平台保持。

## 1. 根因与修复映射（21 例）

| #   | 文件                                             | 根因                                            | 修复                                                                                                | 例数 |
| --- | ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---- |
| A1  | `tests/no-duplicate-helpers-contract.test.ts`    | `listSourceFiles` 的 `path.join` 产出 `\`       | 清单构造改 `path.posix.join`（打开文件仍原生 `path.join`）                                            | 6    |
| A2  | `tests/issue11-compat-and-duplicate-convergence.test.ts` | `listWebSources` 同 A1                   | 同 A1                                                                                                | 2    |
| A3  | `tests/mcp-tools-path-containment.test.ts`       | POSIX 字面量夹具 vs `path.sep` 生产比较           | 夹具改 `parts.join(path.sep)` 逐平台原生构造；生产 `isPathWithinWorkspaceRoot` 不动                    | 3    |
| B1  | `tests/turn-outcome.test.ts`                     | 锚点内嵌 `\n`，磁盘 CRLF                        | 读源归一 `replace(/\r\n/g, '\n')`（收敛为一处模块级辅助）                                             | 3    |
| B2  | `tests/warm-channel-outbox-scope-correlation.test.ts` | `section()` 起止串/正则内嵌 `\n`            | `read()` 辅助归一                                                                                     | 3    |
| B3  | `tests/channel-connector-failure-safety.test.ts` | `'\n      }\n    },'` indexOf                | `source()` 辅助归一                                                                                   | 1    |
| B4  | `tests/graceful-shutdown-order.test.ts`          | `'queue\n        .shutdown(15_000)'` 等       | 读源归一                                                                                              | 1    |
| B5  | `tests/makefile-runtime-contract.test.ts`        | `/^dev-backend:.*\n\t\$\(RUNNER\)$/m`（`.` 不匹配 `\r`） | 顶层 `makefile` 读取归一                                                                  | 1    |
| B6  | `tests/workflow-card-contract.test.ts`           | `'if (!holdReason) {\n                clearStreamingSnapshot(chatJid)'` | 各 `readFileSync` 读点归一（收敛为一处辅助）                                          | 1    |
| S   | `scripts/check-scope.mjs`                        | `git diff --name-only` 受 `core.quotepath` 转义中文路径 | `git` 调用前置 `-c core.quotepath=false`；`tests/scope-check-contract.test.ts` 复跑确认不破坏            | —    |

## 2. 设计取舍

1. **为什么修测试而不是改行尾策略**：`.gitattributes` 只锁 `*.sh`/`.githooks/*` 为 LF 属用户显式裁决（"轻量方案"，全仓归一曾被否决）；测试作为机门禁应当对宿主 checkout 形态鲁棒——LF 环境行为不变、CRLF 环境恢复匹配，是唯一不重开历史裁决的修法。
2. **为什么 `isPathWithinWorkspaceRoot` 不动**：生产调用方传 `path.resolve` 产物，同平台内自洽；测试夹具改为按 `path.sep` 构造后，各平台都以其原生形态受测，ISSUE-05 §4 "纯字符串前缀比较、不做 realpath" 的既有语义原样保留。改生产为跨分隔符模糊匹配属安全语义变更，超出本任务（如需另行立项）。
3. **归一只做 `\r\n → \n`**：不 trim、不折叠空白，避免影响任何空白敏感断言。

## 3. 测试方案

- 修复后先单跑 9 文件：21 例红→0。
- 全量 `npm run verify` 六步全绿（含第 4 步全量 vitest）。
- `node scripts/check-scope.mjs` 通过；另以 `git config --unset core.quotepath` 后复跑自证脚本级修复。
- `tests/scope-check-contract.test.ts`（check-scope 的契约测试）单跑确认 `-c` 注入无破坏。

## 4. 非目标

- 不改 `src/`、`web/src/`、`container/agent-runner/src/` 任何生产代码。
- 不动 `.gitattributes`、不做全仓 eol 归一、不做 CI/hook 变更。
- 不处理 `tests/` 之外未失败的测试（预防性归一属范围蔓延）。

## 5. 回滚点

- base pin `212df80`（开工前 HEAD），写入 `.gatescope.json`；失败回 `git reset --hard 212df80`。
