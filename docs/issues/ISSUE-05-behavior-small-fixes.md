# ISSUE-05 行为级小修：孤儿结果文件、溢出标记、/pair 正则、safeRoot

| 字段          | 值                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 待领取                                                                                                                                                                                                                                                 |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                      |
| 优先级        | P1                                                                                                                                                                                                                                                     |
| 类型          | 缺陷修复（每项改动范围都很小）                                                                                                                                                                                                                         |
| 依赖          | 无                                                                                                                                                                                                                                                     |
| 阻塞          | ISSUE-12                                                                                                                                                                                                                                               |
| 预计改动路径  | `src/index.ts`（仅 10840-10875 行的清理名单）、`src/group-queue.ts`、`src/qq.ts`、`src/wechat.ts`、`src/channel-admission.ts`、`container/agent-runner/src/mcp-tools.ts`，以及相应的 `tests/**`；第 2 项如果接上调用方，还会涉及识别溢出错误的那个文件 |
| 需用户决策    | 部分：第 2 项和第 3 项                                                                                                                                                                                                                                 |
| 来源          | 审查报告 §8、§14.2                                                                                                                                                                                                                                     |

## 要做的事

### 1. 孤儿结果文件逃过清理（行为隐患，已复核）

- **现状**：
  - `src/index.ts:10847-10870` 的 `RESULT_FILE_PREFIXES` 共 22 项，其中没有 `feishu_capability_result_`；
  - 但 `writeTaskResult(tasksDir, 'feishu_capability', …)`（`:12946`、`:12963`）确实会生成 `feishu_capability_result_<requestId>.json`（文件名由 `:11152-11155` 拼出）。
- **后果**：runner 超时或崩溃后，留下的结果文件不会被“超过 10 分钟就删除”的清理逻辑删掉，而是落进 `!isResultFile` 分支，被当作任务请求处理，引发伪任务告警。
- **要做**：
  - 补上这个前缀；
  - 建议顺带让名单从所有 `writeTaskResult` 的 type 自动派生，或者加一个测试，断言每个写入 type 都在名单里，避免以后再漏。

### 2. `markContextOverflow` 从未被调用（掉线逻辑，需用户决定）

- **现状**：
  - `src/group-queue.ts:785` 的 `markContextOverflow` 自建仓基线以来没有任何调用方；
  - 读取 `contextOverflowGroups` 的逻辑（`:612`、`:2672`、`:2809`）还在。
- **后果**：上下文溢出时，仍然走指数退避重试。“溢出时跳过退避”这条设计从未生效。
- **方案**（请用户二选一）：
  - (a) 在识别上下文溢出错误的地方（先查 `src/agent-output-parser.ts`、`src/provider-failure.ts`）接上调用；
  - (b) 连同读取端一起下线。

### 3. 统一 `/pair` 配对码解析（行为已经分叉）

- **现状**：
  - 共享函数 `src/channel-admission.ts:106` 的 `parseChannelPairingCode` 使用 `/^\/pair\s+(\S+)\s*$/i`；
  - QQ（`src/qq.ts:1560`、`:1776`）和微信（`src/wechat.ts:826`）各自内联了 `/^\/pair\s+(\S+)/i`，没有尾部锚点。
- **后果**：`/pair abc extra` 在 QQ 和微信上能通过，在共享函数里会被拒绝。
- **要做**：
  - 请用户确认期望行为；
  - QQ 和微信改为调用共享函数，或者调用 `evaluateChannelAdmission`（`:118`，目前只有测试在调用）；
  - 为 QQ、微信、飞书三个渠道补上同样的用例。

### 4. 收敛 `mcp-tools` 里的路径包含检查（安全相关）

- **现状**：`container/agent-runner/src/mcp-tools.ts` 的 `:844`、`:975`、`:999` 三处，各自内联了 `safeRoot` 加 `startsWith` 的检查。
- **要做**：抽成一个函数，并补充测试，至少覆盖：
  - `..` 穿越；
  - 名字前缀相同的目录（例如 `/work` 和 `/work2`）；
  - 结尾带分隔符和不带分隔符两种写法；
  - 符号链接（如果当前语义不处理符号链接，就在测试里明确写出当前行为）。

## 非目标

- 不重构 `src/index.ts` 的其他部分。

## 验收标准

- 每一项都有对应的测试；`npm run verify` 和 check-scope 都通过。

## 交付记录

（领取后填写）
