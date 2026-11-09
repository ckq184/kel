# 任务 Q 立项：模型服务认证错误（401/403）即时透出与快速失败

> **状态**：2026-11-09 用户批准执行（「开始修」）。根因经运行时数据 + 代码双重取证，见 §2。
> **回滚点**：`ffb5b9a`（开工前 HEAD，同步写入 `.gatescope.json`）。
> **创建**：2026-11-09。排查会话：ZCode（本地 macOS arm64）。

---

## 0. 一句话结论

Pi Runner 把 provider 401 以 `status:'error'` 上报宿主后，宿主错误分类区没有「认证/永久性错误」通道，落入默认的**静默退避重试**（`MAX_RETRIES=5`，`src/group-queue.ts:115`）；期间用户零反馈，重试注定失败（Key 无效是确定性错误）。修复 = 在既有确定性错误通道旁（`agent_profile_unavailable:` 同构位置）新增一个 `isPermanentProviderAuthError` 通道：命中即发 `agent_error:` 系统消息、提交游标、清指示器、跳过重试。

## 1. 现象与背景（2026-11-09 实测案例）

- Web 聊天发送「你好」，无任何回复、无任何错误提示；runner 进程存活数分钟。
- 取证：会话 JSONL（`data/sessions/main/.claude/sessions/2026-11-09T03-01-34-*.jsonl`）记录 assistant `stopReason:"error"` + `errorMessage:"401 {\"error\":{\"message\":\"令牌已过期或验证不正确\"}}"`（provider=ckqclaw-anthropic，智谱 Anthropic 兼容端点）。
- 直接 curl 上游同 Key 双端点均 401，证实 Key 无效（后经用户更换 Coding Plan 专用 Key 解决通信本身）。
- **本任务修的是暴露出来的产品缺陷**：这类错误不该让用户干等 5 轮退避且零提示。

## 2. 根因链（代码取证，新会话无需重做）

|  #  | 环节                                                                                                                                                                                                                                                                                 | 证据                                                                                                 |
| :-: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
|  1  | Pi SDK 调 LLM 得 401，pi-session 产出 `RuntimeResult{finalizationReason:'error', error:"401 …", text:null}`                                                                                                                                                                          | `container/agent-runner/src/runtime/pi/pi-session.ts:122-150`（agent_end 取 assistant.errorMessage） |
|  2  | pi-runner `publishResult` 发 `{status:'error', result:null, error:"401 …", inputTurnCompleted:false}`                                                                                                                                                                                | `container/agent-runner/src/runtime/pi/pi-runner.ts:246-269`                                         |
|  3  | runner **不退出**，主循环 `waitForNextInput()` 挂起（runner 进程长寿的原因）                                                                                                                                                                                                         | `container/agent-runner/src/pi-index.ts:516-548`                                                     |
|  4  | 宿主 `processGroupMessages` 错误分类区：401 无专属通道 → 落入默认 `willRetryAfterFailure` **静默重试**                                                                                                                                                                               | `src/index.ts:9517-9530`（注释明言「还会重试的中间轮次不向用户广播 agent_error」）                   |
|  5  | 重试次数 `MAX_RETRIES=5` + 递增退避；耗尽后才发泛化的 `agent_max_retries`（「已达最大重试次数」，不提 Key）                                                                                                                                                                          | `src/group-queue.ts:115,611-613`；`src/index.ts:20990`                                               |
|  6  | 遗留 Claude runner 的 `providerFailure` 控制面（宿主消费端 `src/index.ts:7915` 起，含 `PROVIDER_FAILURE_USER_NOTICE`）在 Pi 路径上是**死分支**：Pi runner 不发布该信号，且遗留 runner 源码 `container/agent-runner/src/index.ts` 不参与构建（tsconfig include 仅 `src/pi-index.ts`） | `container/agent-runner/tsconfig.json` include 列表；dist 产物 grep 零命中                           |

既有确定性错误快速失败通道（本任务的同构参照）：`context_budget_exceeded:` / `prompt_plan_invalid:` / `context_overflow:` / `agent_profile_unavailable:`（`src/index.ts:9385-9446`）。

## 3. 方案

### 3.1 改动一：`src/provider-failure.ts` 新增纯分类函数与文案

```ts
export const PROVIDER_AUTH_USER_NOTICE =
  '⚠️ 模型服务认证失败：API Key 无效或已过期，本次处理已停止（已跳过自动重试）。请到「设置 → 模型服务」检查并更新 API Key 后重试。';

export function isPermanentProviderAuthError(error: string): boolean;
```

匹配模式（收窄，防误伤瞬时错误）：

- `^401` / `^403` 行首锚定（Pi errorMessage 形态：`401 {"error":…}`）；
- 关键词子串：`authentication_failed`、`invalid x-api-key`、`invalid_api_key`（Anthropic 官方文案）、`令牌已过期或验证不正确`（智谱文案，兜底包装形态）。

反例必须不命中：`500`、`429`、`529 overloaded`、`ECONNREFUSED`、`timeout`、含 "401" 的无关计数文本。

### 3.2 改动二：`src/index.ts` processGroupMessages 错误分类区新增通道

位置：`agent_profile_unavailable:` 通道之后、OOM 检测之前。逻辑与该通道同构：

```ts
if (isPermanentProviderAuthError(errorDetail)) {
  const notice = `${PROVIDER_AUTH_USER_NOTICE}（${errorDetail.slice(0, 120)}）`;
  sendSystemMessage(chatJid, 'agent_error', notice);
  await projectCurrentScheduledGroupTerminal('failed', notice);
  logger.warn(
    { group: group.name, error: errorDetail },
    'Provider auth error; skipping retry',
  );
  commitCursor();
  await clearProcessingIndicatorForInput(ipcReplyTurnTracker.inputTurnId);
  return true;
}
```

前端零改动：`web/src/lib/system-message-registry.ts` 已将 `agent_error:` 前缀渲染为 error 样式。

### 3.3 测试（TDD，先写测试）

新文件 `tests/provider-auth-error.test.ts`：

1. `isPermanentProviderAuthError` 单测：正例（§1 实测串、Anthropic 文案、403 开头、被包装的 authentication_failed）+ 反例（§3.1 列表）；
2. 源码结构断言（照 `tests/turn-outcome.test.ts:102-119` 风格）：index.ts 新分支切片须包含 `isPermanentProviderAuthError` 调用、`sendSystemMessage`、`commitCursor`、`return true`。

## 4. 范围声明（.gatescope.json allow）

- `src/provider-failure.ts`
- `src/index.ts`
- `tests/provider-auth-error.test.ts`
- `docs/task-q-provider-auth-error-fastfail-plan.md`

## 5. 非目标（防蔓延）

- **task-scheduler.ts 定时任务同类路径**：该处有独立错误投影（`src/task-scheduler.ts:1426-1453`），是否同样需要快速失败另行评估立项；
- 遗留 Claude runner 死代码清理（`container/agent-runner/src/index.ts` 及陈旧 dist）；
- `providerFailure` 控制面 / provider 池自动切换向 Pi 路径的移植（架构级，另行立项）；
- 前端任何改动。

## 6. 验收条件

1. `npm run verify` 六步全过；`node scripts/check-scope.mjs` 通过；
2. 新测试全绿且覆盖 §3.3 正反例；
3. 人工验收（用户）：配置一个无效 Key 的 provider → Web 聊天发消息 → **数十秒内**（单次 runner 生命周期，非 5 轮退避后）聊天出现「模型服务认证失败」错误提示；后端日志出现 `Provider auth error; skipping retry`。

## 7. 风险

| 风险                                 | 缓解                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| 误把可恢复错误判成永久，丢失重试机会 | 模式收窄（§3.1）；此类错误即便重试 5 轮也不会成功；文案引导用户主动重发 |
| 上游短暂 401 误报                    | 概率极低；用户重发即触发新一轮（游标已提交，无消息丢失）                |
