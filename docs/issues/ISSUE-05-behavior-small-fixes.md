# ISSUE-05 行为级小修：孤儿结果文件、溢出标记、/pair 正则、safeRoot

| 字段          | 值                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态          | 已完成                                                                                                                                                                                                                                                 |
| 领取人 / 分支 | zcode-issue05 会话（main 分支）                                                                                                                                                                                                                        |
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

- **立项提交**：`2493eab`（plan `docs/behavior-small-fixes-plan.md` + `.gatescope.json`，base=`b08a3b8`）
- **实现提交**：`83d59f2`（四项修复 + 4 个新测试文件 16 用例）
- **验证**：`npm run verify` 六步全绿（2 次复跑，最终 6/6 通过、总耗时 34.3s）；`node scripts/check-scope.mjs` 通过（14 路径全在声明范围内）；相关既有测试回归 63/63。
- **需求采访（2026-11-20，用户拍板）**：
  - 第 2 项选**连同读取端一起下线**。调查发现"溢出跳过退避"的实际效果由 `src/index.ts` 的 `context_overflow:` handler 分支达成（`commitCursor()` + `return true` → 队列视为成功不进 `scheduleRetry`），`markContextOverflow` 是从未接线的平行机制，接上调用也无实际作用。
  - 第 3 项选**严格语义**（拒绝 `/pair abc extra` 这类多余参数），QQ 两处、微信一处改调共享函数 `parseChannelPairingCode`。
- **与 issue 描述的偏差**：
  1. 第 1 项采用"加测试断言每个写入 type 都在名单里"路线（源码一致性测试，先例 `tests/provider-auth-error.test.ts`），未做运行时自动派生名单——`src/index.ts` 为主服务入口，导出常量无可导入消费方。
  2. 第 2 项补充调查结论：issue 中"上下文溢出时仍然走指数退避重试、设计从未生效"的表述不精确——**溢出跳过退避实际已生效**（由 handler 分支达成），从未生效的只是 `markContextOverflow` 这条平行机制；下线它无行为变化。
  3. 第 3 项"为飞书补用例"不适用：飞书无 `/pair` 文本命令路径（DM 即绑定信号，`src/feishu.ts` 仅注释提及），共享语义由 `tests/channel-admission.test.ts` + 新增 `tests/channel-pairing-uniform.test.ts` 锁定。
  4. 第 4 项收敛函数落在 `container/agent-runner/src/utils.ts`（超出 issue 预计改动路径）：utils.ts 是既有纯函数模块且测试可直接导入，mcp-tools.ts 重依赖不可导入。此为 `.gatescope.json` 相对立项提交的范围扩宽，已随实现提交说明并由立项批准者复核。
- **范围外新发现**（未处理，仅登记）：`RESULT_FILE_PREFIXES` 中 `install_skill_result_`、`uninstall_skill_result_`、`list_tasks_result_`、`ckqclaw_owner_profile_result_` 四项目前在 `src/index.ts` 已无对应的 `writeTaskResult` 写入点（疑似历史遗留的多余名单项，无害——清理更宽不是更窄）。若要裁剪可并入 ISSUE-08（孤儿死代码批 1）处理。
