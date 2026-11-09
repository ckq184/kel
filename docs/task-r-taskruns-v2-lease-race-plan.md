# 任务 R 立项：task-runs-v2 通知重试用例时序竞态修复（测试侧）

> **状态**：2026-11-09 用户裁决立项（「先另立任务 R 修该遗留用例，绿后再提交任务 Q」）。
> **回滚点**：`ffb5b9a`（写入 `.gatescope.json`）。
> **关联**：任务 K 档案 `docs/task-k-windows-test-baseline-triage-plan.md` §8 已标记「task-runs-v2（租约/通知状态机时序断言，非预算问题，未修——候选后续）」；任务 Q 交付时再次暴露并三重定性（stash 基线同红）。

---

## 0. 一句话结论

`tests/task-runs-v2.test.ts` 「a late payload gets a fresh retry budget after the prior batch is exhausted」用例的**第 5 次 claim 是循环外裸调用**，与第 4 次 claim（2ms 租约）间隔仅微秒级：快机器上租约未过期，`claimTaskRunNotificationById` 的 `lease_expires_at <= now` 条件不满足而返回 undefined → `exhausted.attempt` 抛 TypeError。循环内各轮有 `vi.waitFor`（interval 5ms > 2ms 租约）保护，唯独此句没有。修复 = 第 5 次 claim 同样以 `vi.waitFor` 轮询包裹（与该文件任务 M 既定改法「轮询替代 sleep」同构）。

## 1. 证据链

- 失败点：`tests/task-runs-v2.test.ts:951-957`，`claimTaskRunNotificationById(..., 60_000)` 返回 undefined；
- 生产查询（`src/db.ts` claimTaskRunNotification）可重入条件：`notification_lease_expires_at <= now`（或无租约且 `available_at <= now`）——租约未到期时返回 undefined 是**正确行为**；
- 前 4 轮 claim 用 2ms 租约 + `vi.waitFor`（interval 5ms）轮询，天然跨过 2ms 租约窗；第 5 次紧随第 4 轮断言执行（µs 级）；
- 平台差异解释：任务 K 档案（Windows）「单跑均绿」＝断言/循环开销 > 2ms；本机 macOS 稳定 < 2ms 稳定红——属快慢机器竞态，非生产回归。

## 2. 改动（单文件，生产代码零改动）

`tests/task-runs-v2.test.ts:951-957`：

```ts
// 前：裸调用，竞态窗口
const exhausted = db.claimTaskRunNotificationById(...)!;
expect(exhausted.attempt).toBe(5);

// 后：与同用例前 4 轮同构的 waitFor 轮询（租约过期由轮询间隔覆盖）
const exhausted = await vi.waitFor(
  () => {
    const claim = db.claimTaskRunNotificationById(
      created.run.id, 'final-budget-worker', 60_000);
    expect(claim).toBeTruthy();
    return claim!;
  },
  { timeout: 10_000, interval: 5 },
);
expect(exhausted.attempt).toBe(5);
```

## 3. 验收条件

1. `npx vitest run tests/task-runs-v2.test.ts` 全绿（连跑 3 轮验证稳定）；
2. `npm run verify` 六步全绿（含全量 vitest）；
3. `node scripts/check-scope.mjs` 通过。

## 4. 非目标

- 不改 `src/db.ts` 任何生产逻辑（claim 返回 undefined 对未过期租约是正确语义）；
- 不调整 2ms/60s 租约参数与用例其他断言。
