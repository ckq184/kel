# 行为级小修立项（ISSUE-05）：孤儿结果文件、溢出标记下线、/pair 正则统一、safeRoot 收敛

> 任务来源：`docs/issues/ISSUE-05-behavior-small-fixes.md`（死代码与臃肿审查 R2 §8、§14.2）。
> 回滚点：`b08a3b8`（开工前 HEAD，见 `.gatescope.json` 的 `base`）。
> 需求采访结论（2026-11-20，用户拍板）：
>
> - 第 2 项：`markContextOverflow` **连同读取端一起下线**。依据：`src/index.ts:8797` 的
>   `context_overflow:` handler 分支已直接 `commitCursor()` 并 `return true`，队列视为
>   成功、`retryCount=0`，"溢出跳过退避"的实际效果已由该分支达成；`markContextOverflow`
>   属于从未接线的平行机制，接上调用也不会有任何效果（成功路径不进 `scheduleRetry`）。
> - 第 3 项：`/pair` 统一为**严格语义**（拒绝多余参数），QQ 两处、微信一处内联正则
>   改为调用共享函数 `parseChannelPairingCode`。

## 目标（What & Why）

四项互相独立的行为级小修，每项均有测试锁定：

1. **孤儿结果文件逃过清理**：`src/index.ts` 的 `RESULT_FILE_PREFIXES`（22 项）缺
   `feishu_capability_result_`，而 `writeTaskResult(tasksDir, 'feishu_capability', …)`
   会生成该前缀文件。runner 超时/崩溃后残留的结果文件不会被"超过 10 分钟删除"的
   清理逻辑删掉，落进 `!isResultFile` 分支被当作任务请求处理，引发伪任务告警。
2. **`markContextOverflow` 从未被调用**（掉线逻辑，用户已决定下线）：删除
   `src/group-queue.ts` 的 `markContextOverflow` 方法、`contextOverflowGroups` 字段
   及三处读取（`willRetryAfterFailure`、`scheduleRetry`、虚拟 JID GC）。
3. **`/pair` 配对码解析分叉**：QQ（`src/qq.ts` 两处）与微信（`src/wechat.ts` 一处）
   内联宽松正则 `/^\/pair\s+(\S+)/i`（无尾部锚点）与共享函数
   `parseChannelPairingCode` 的严格正则 `/^\/pair\s+(\S+)\s*$/i` 行为分叉——
   `/pair abc extra` 在 QQ/微信被接受（取 abc），在共享语义被拒绝。统一为严格语义。
4. **`mcp-tools` 路径包含检查收敛**：`container/agent-runner/src/mcp-tools.ts` 三处
   （`:844`、`:975`、`:999`）各自内联相同的 `safeRoot + startsWith` 检查，抽成一个
   纯函数并补测试。

## 非目标

- 不重构 `src/index.ts` 其他部分；不把 `RESULT_FILE_PREFIXES` 改为运行时注册表
  派生（以源码一致性测试锁定，代价最小）。
- 第 3 项不把 QQ/微信接入 `evaluateChannelAdmission` 的完整准入流程（那涉及授权
  回调重构，超出小修范围），只统一 `/pair` 解析。
- 第 4 项不改变路径检查语义（仍为字符串前缀比较，不引入 realpath/符号链接解析）；
  符号链接的当前行为在测试中显式记录。
- 不动 `src/index.ts:8797` 的 `context_overflow:` handler 分支（它已正确生效）。

## 修改文件范围

| 文件                                                         | 改动                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/index.ts`                                               | 第 1 项：`RESULT_FILE_PREFIXES` 补 `feishu_capability_result_`（就地补齐，见偏差记录 ①） |
| `src/group-queue.ts`                                         | 第 2 项：删 `markContextOverflow`、`contextOverflowGroups` 及三处读取                    |
| `src/qq.ts`                                                  | 第 3 项：两处内联正则改为 `parseChannelPairingCode`                                      |
| `src/wechat.ts`                                              | 第 3 项：一处内联正则改为 `parseChannelPairingCode`                                      |
| `src/channel-admission.ts`                                   | 不改（共享函数已正确；最终未补 JSDoc）                                                   |
| `container/agent-runner/src/mcp-tools.ts`                    | 第 4 项：三处内联检查改为调用收敛函数                                                    |
| `container/agent-runner/src/utils.ts`                        | 第 4 项：新增 `isPathWithinWorkspaceRoot` 纯函数（范围扩宽，见偏差记录 ②）               |
| `tests/result-file-prefixes-consistency.test.ts`（新增）     | 第 1 项测试                                                                              |
| `tests/group-queue-context-overflow-removal.test.ts`（新增） | 第 2 项测试                                                                              |
| `tests/channel-pairing-uniform.test.ts`（新增）              | 第 3 项测试                                                                              |
| `tests/mcp-tools-path-containment.test.ts`（新增）           | 第 4 项测试                                                                              |

### 实现偏差记录（相对本 plan 初稿，供立项批准者复核）

1. **第 1 项未把 `RESULT_FILE_PREFIXES` 抽为模块级导出常量**：`src/index.ts` 是主服务
   入口（import 即启动监听），导出常量没有可导入的消费方，测试改走源码文本提取
   （`tests/result-file-prefixes-consistency.test.ts`），搬动常量位置属无关重构，
   按最小范围原则就地补齐。
2. **第 4 项收敛函数落在 `container/agent-runner/src/utils.ts`**（初稿只写了
   mcp-tools.ts）：utils.ts 是既有纯函数模块（文件头注释即"Pure utility
   functions"）、已被 mcp-tools.ts 引用，且测试可直接导入；mcp-tools.ts 重依赖
   zod/pi SDK，新函数放那里无法被测试导入。此为 `.gatescope.json` 相对立项提交
   的范围扩宽，随实现提交说明。

## 方案与测试设计

### 第 1 项：结果文件前缀

- `RESULT_FILE_PREFIXES` 就地补 `feishu_capability_result_`（偏差记录 ①）。
- 测试（源码一致性，项目已有先例 `tests/provider-auth-error.test.ts` 的源码断言模式）：
  - 读取 `src/index.ts` 源码，正则提取所有字面量调用
    `writeTaskResult(tasksDir, '<type>', …`，断言 `'<type>_result_'` 均在名单内；
  - 提取 `case '<type>':` 分支内出现 `writeTaskResult(tasksDir, data.type` 的 case 标签，
    断言 `'<type>_result_'` 均在名单内；
  - 断言 `parsedData.type.endsWith('_task')` 兜底路径依赖的 `_task` 后缀族
    （`schedule_task`、`cancel_task` 等名单现有 `_task` 项）被名单覆盖。

### 第 2 项：下线 markContextOverflow

- 删除：`contextOverflowGroups` 字段（`:235`）、`markContextOverflow`（`:785-791`）、
  `willRetryAfterFailure` 中的读取行（`:612`）、`scheduleRetry` 中的溢出跳过分支
  （`:2671-2681`）、GC 中的 delete（`:2809`）。
- `willRetryAfterFailure` 方法保留（`src/index.ts:8921` 仍在调用），仅删溢出特判行。
- 测试：源码断言 `src/group-queue.ts` 不再包含 `markContextOverflow` 与
  `contextOverflowGroups`；`willRetryAfterFailure` 仍存在且被 `src/index.ts` 引用
  （防止误删在用方法）。

### 第 3 项：/pair 统一严格语义

- `src/qq.ts` 两处、`src/wechat.ts` 一处：`content.match(/^\/pair\s+(\S+)/i)` 改为
  `parseChannelPairingCode(content)`，后续流程不变（null 时 fallthrough 到原有
  未授权/普通消息路径，与共享函数在飞书侧共享语义一致）。
- 严格语义下 `/pair abc extra` 解析为 null：该消息不再触发配对，走渠道各自的
  准入判定（未授权聊天被拒/提示由现有授权路径决定），不新增"格式错误"提示分支
  ——与 `evaluateChannelAdmission` 消费共享函数时的行为完全一致。
- 测试：
  - 共享函数行为（已有 `tests/channel-admission.test.ts` 锁定，含
    `/pair one extra` → null）；
  - 新增源码一致性断言：`src/qq.ts`、`src/wechat.ts` 不含无尾部锚点的内联正则
    `/^\/pair\s+(\S+)/i`，且均 import 并调用 `parseChannelPairingCode`；
  - 飞书渠道无 `/pair` 文本命令路径（DM 即绑定信号，`src/feishu.ts` 仅注释提及），
    无需用例——此为与 issue 描述的偏差，登记入交付记录。

### 第 4 项：safeRoot 收敛

- 抽纯函数 `isPathWithinWorkspaceRoot(resolved: string, root: string): boolean`，
  落在 `container/agent-runner/src/utils.ts`（偏差记录 ②）——语义与现有三处完全
  一致：`resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)`。
- 三处调用点替换，错误文案不变。
- 测试覆盖（issue 要求四类）：
  - `..` 穿越被拒（`/ws/g/../../etc/passwd` resolve 后不在 root 下）；
  - 前缀相同目录被拒（root `/ws/group1`，路径 `/ws/group10/x`）；
  - root 尾带分隔符与不带两种写法行为一致；`resolved === root` 本身被允许；
  - 符号链接：当前实现为纯字符串比较、不做 realpath 解析——测试用例显式断言
    "字符串在 root 内的符号链接路径被放行（即使链接目标在外）"，记录当前行为。

## 风险与应对

- 第 2 项删除 `scheduleRetry` 溢出分支后，`scheduleRetry` 行为对溢出 group 与普通
  group 一致（指数退避）——但如上分析，溢出路径根本不会走到 `scheduleRetry`
  （handler return true），无行为变化。
- 第 3 项行为变化：QQ/微信上 `/pair abc extra` 从"取 abc 配对"变为"不识别为配对
  命令"——用户已拍板接受。
- 第 4 项为等值重构 + 测试，无行为变化。

## 验收标准

- 每项均有测试；`npm run verify`（六步门禁）与 `node scripts/check-scope.mjs` 通过。
