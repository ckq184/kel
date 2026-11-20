/**
 * ISSUE-07 项3 复现测试：描述当前真实行为，不是缺陷修复的验收。
 *
 * 现状（2026-11 调查，ISSUE-07 批次F）：进程重启后，启动路径只调用
 * reconcileChannelOutboxDeliveries()（src/index.ts 启动序列，仅做状态翻
 * 转不做投递）。pre-send 阶段（claimed/uploading/uploaded）且租约过期的
 * channel_outbox 行被翻转为 retry_wait 后，没有任何后台 outbox worker 认
 * 领它们：claimNextChannelOutbox / claimNextChannelTurnRun 生产零调用，
 * 唯一的生产投递入口 deliverChannelOutboxItem 由入站消息驱动的 turn 调
 * 用（src/index.ts 与 src/feishu-capability-outbox.ts 两处 turn 驱动调用）。
 *
 * 因此本文件锁定两条现状断言：
 * 1. reconcileExpiredChannelOutbox 翻转后，再次 reconcile 幂等、行停留在
 *    retry_wait、物理发送闭包从未被调用——即重启后 retry_wait 滞留，不会
 *    自动重投；
 * 2. 正向对照：只有当同一 idempotencyKey 的 turn 重新进入
 *    deliverChannelOutboxItem（新入站消息重驱 / 游标重放模拟），行才能被
 *    按 ID 认领并重投——佐证"重投依赖 turn 重跑"的注释结论。
 *
 * retry_wait 的自动重投 worker 已另立
 * docs/issues/ISSUE-14-channel-outbox-worker.md；uncertain 行仍须人工
 * resolve，不归 worker。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'channel-outbox-restart-retry-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-primary',
  sourceJid: 'feishu:bot-primary:chat-1#root:root-1#thread:thread-1',
  chatId: 'chat-1',
  rootId: 'root-1',
  threadId: 'thread-1',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createRun(name: string, now: string) {
  return store.createChannelTurnRun({
    ...route,
    idempotencyKey: `restart-retry-wait:${name}`,
    now,
  }).run;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('channel outbox restart: retry_wait rows are stranded (current behavior)', () => {
  test('reconcile flips expired pre-send leases to retry_wait and nothing re-delivers them', async () => {
    let now = '2026-11-20T08:00:00.000Z';
    let sends = 0;
    let uploads = 0;

    // Row A: process death right after the claim persisted (status claimed).
    const runA = createRun('claimed-crash', now);
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: runA.id,
        ordinal: 0,
        kind: 'text' as const,
        payload: { text: 'claimed 后进程死亡' },
        idempotencyKey: `${runA.id}:text`,
        owner: 'sender-claimed-crash',
        leaseMs: 1_000,
        now: () => now,
        delivery: {
          mode: 'single' as const,
          send: async () => {
            sends++;
            return { providerMessageId: 'must-not-run-automatically-a' };
          },
        },
        afterPersist: (phase) => {
          if (phase === 'claimed') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // Row B: process death after `uploading` persisted, before upload ran
    // (status uploading, still pre-send).
    const runB = createRun('uploading-crash', now);
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: runB.id,
        ordinal: 0,
        kind: 'file' as const,
        payload: { path: 'deliverables/report.pdf' },
        idempotencyKey: `${runB.id}:file`,
        owner: 'sender-uploading-crash',
        leaseMs: 1_000,
        now: () => now,
        delivery: {
          mode: 'upload_then_send' as const,
          upload: async () => {
            uploads++;
            return { providerUploadKey: 'must-not-upload-automatically' };
          },
          sendUploaded: async () => {
            sends++;
            return { providerMessageId: 'must-not-run-automatically-b' };
          },
        },
        afterPersist: (phase) => {
          if (phase === 'uploading') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // ── 模拟重启：租约过期后启动 reconcile（src/index.ts 启动序列同款）──
    now = '2026-11-20T08:00:01.001Z';
    expect(store.reconcileExpiredChannelOutbox(now)).toEqual({
      retryable: 2,
      uncertain: 0,
    });
    const rowA = store
      .scanChannelReliabilityNonterminal()
      .outbox.find((item) => item.turnRunId === runA.id)!;
    const rowB = store
      .scanChannelReliabilityNonterminal()
      .outbox.find((item) => item.turnRunId === runB.id)!;
    expect(rowA).toMatchObject({
      status: 'retry_wait',
      leaseOwner: null,
      attempt: 1,
    });
    expect(rowB).toMatchObject({
      status: 'retry_wait',
      leaseOwner: null,
      attempt: 1,
    });

    // ── 现状断言：翻转后没有任何自动认领/投递路径 ──
    // (a) 再次 reconcile 幂等：不重复翻转、不投递。
    now = '2026-11-20T08:00:05.000Z';
    expect(store.reconcileExpiredChannelOutbox(now)).toEqual({
      retryable: 0,
      uncertain: 0,
    });
    expect(store.getChannelOutboxItem(rowA.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
      leaseOwner: null,
    });

    // (b) 真实时间流逝（相当于空转多个 worker 轮询周期）：行仍滞留
    //     retry_wait，租约无人持有，物理投递闭包从未被任何后台路径调用。
    //     生产代码里不存在这样的后台路径——claimNextChannelOutbox 生产
    //     零调用，deliverChannelOutboxItem 只被 turn 驱动调用。
    await sleep(50);
    const strandedA = store.getChannelOutboxItem(rowA.id)!;
    const strandedB = store.getChannelOutboxItem(rowB.id)!;
    expect(strandedA).toMatchObject({
      status: 'retry_wait',
      leaseOwner: null,
      attempt: 1,
    });
    expect(strandedB).toMatchObject({
      status: 'retry_wait',
      leaseOwner: null,
      attempt: 1,
    });
    expect(strandedA.availableAt).toBe(rowA.availableAt);
    expect(sends).toBe(0);
    expect(uploads).toBe(0);
  });

  test('a retry_wait row is re-delivered only when the same idempotencyKey re-enters deliverChannelOutboxItem', async () => {
    let now = '2026-11-20T08:10:00.000Z';
    let sends = 0;
    const run = createRun('turn-redrive', now);
    const input = {
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'card' as const,
      payload: { card: { title: '重启后重投' } },
      idempotencyKey: `${run.id}:card`,
      owner: 'sender-redrive',
      leaseMs: 1_000,
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => {
          sends++;
          return { providerMessageId: 'redelivered-after-turn-redrive' };
        },
      },
    } satisfies delivery.DeliverChannelOutboxInput;

    // 首次投递在 claimed 持久化后进程死亡。
    await expect(
      delivery.deliverChannelOutboxItem({
        ...input,
        afterPersist: (phase) => {
          if (phase === 'claimed') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);
    expect(sends).toBe(0);

    // 重启 reconcile 翻转为 retry_wait。
    now = '2026-11-20T08:10:01.001Z';
    expect(store.reconcileExpiredChannelOutbox(now)).toEqual({
      retryable: 1,
      uncertain: 0,
    });
    const flipped = store
      .scanChannelReliabilityNonterminal()
      .outbox.find((item) => item.turnRunId === run.id)!;
    expect(flipped.status).toBe('retry_wait');

    // 正向对照：同一 idempotencyKey 的 turn 再次进入
    // deliverChannelOutboxItem（模拟新入站消息重驱 / 游标重放），行被按
    // ID 认领并完成物理重投——这就是当前唯一的 retry_wait 重投路径。
    now = '2026-11-20T08:10:30.000Z';
    const redriven = await delivery.deliverChannelOutboxItem(input);
    expect(redriven).toMatchObject({
      itemId: flipped.id,
      status: 'delivered',
      reused: false,
      attempt: 2,
      receipt: { providerMessageId: 'redelivered-after-turn-redrive' },
    });
    expect(sends).toBe(1);
    expect(store.getChannelOutboxItem(flipped.id)?.status).toBe('delivered');
  });
});
