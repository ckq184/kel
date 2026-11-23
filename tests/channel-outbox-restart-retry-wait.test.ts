/**
 * 重启后 retry_wait 行的两条重投路径（ISSUE-07 项3 复现测试，ISSUE-14 改写）。
 *
 * 进程重启后，启动路径调用 reconcileChannelOutboxDeliveries()：pre-send 阶段
 * （claimed/uploading/uploaded）且租约过期的 channel_outbox 行翻转为
 * retry_wait（仅翻转、不投递）。之后由谁重投取决于所属 turn 的状态：
 *
 * 1. turn 已终态（重启后由恢复循环置 interrupted 等）——再没有人能重驱，
 *    由后台 worker runChannelOutboxRetryPass（挂在 15s 恢复循环的 afterPass
 *    阶段）认领：text 按 payload 重建重投；image/file/card/mutation 无法安全
 *    重建，转 failed。turn 仍活跃时 worker 零动作。
 * 2. turn 仍活跃——由同一 idempotencyKey 的 turn 重新进入
 *    deliverChannelOutboxItem（新入站消息重驱 / 游标重放）按 ID 认领重投；
 *    这条路径保留为 worker 之外的对照。
 *
 * uncertain 行仍须人工 resolve，两条路径都不碰（worker 侧见
 * tests/channel-outbox-worker.test.ts）。
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

describe('channel outbox restart: retry_wait rows after reconcile', () => {
  test('reconcile flips expired pre-send leases to retry_wait and the worker takes them once the turn is terminal', async () => {
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

    // (a) 再次 reconcile 幂等：不重复翻转、不投递。
    now = '2026-11-20T08:00:05.000Z';
    expect(store.reconcileExpiredChannelOutbox(now)).toEqual({
      retryable: 0,
      uncertain: 0,
    });

    // (b) turn 仍活跃：worker 零动作，行留给 turn 自己重驱。
    const sendText = vi.fn(async () => {});
    const workerDeps = {
      owner: 'ckqclaw-outbox-worker:restart-test',
      sendText,
      isChannelAvailable: () => true,
      now: () => now,
    };
    expect(await delivery.runChannelOutboxRetryPass(workerDeps)).toEqual({
      delivered: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    });
    expect(store.getChannelOutboxItem(rowA.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
      leaseOwner: null,
    });

    // (c) 恢复循环把 turn 置为终态后，一轮 worker 即收口两行：text 重投，
    //     file 的 payload 无法重建物理发送，转 failed。旧的投递闭包从未运行。
    store.interruptChannelTurnRunById(runA.id, 'process restarted', now);
    store.interruptChannelTurnRunById(runB.id, 'process restarted', now);
    expect(await delivery.runChannelOutboxRetryPass(workerDeps)).toEqual({
      delivered: 1,
      failed: 1,
      uncertain: 0,
      skipped: 0,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      route.sourceJid,
      'claimed 后进程死亡',
      {},
    );
    expect(store.getChannelOutboxItem(rowA.id)).toMatchObject({
      status: 'delivered',
      attempt: 2,
      leaseOwner: null,
    });
    const failedB = store.getChannelOutboxItem(rowB.id)!;
    expect(failedB.status).toBe('failed');
    expect(failedB.error).toContain('file rows cannot be rebuilt');
    expect(sends).toBe(0);
    expect(uploads).toBe(0);
  });

  test('while the turn is live, the row is re-delivered when the same idempotencyKey re-enters deliverChannelOutboxItem', async () => {
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

    // turn 仍活跃时 worker 不碰这一行（card 即使到了 worker 手里也只会转
    // failed，这里证明它根本没被认领）。
    now = '2026-11-20T08:10:30.000Z';
    const sendText = vi.fn(async () => {});
    await delivery.runChannelOutboxRetryPass({
      owner: 'ckqclaw-outbox-worker:restart-test',
      sendText,
      isChannelAvailable: () => true,
      now: () => now,
    });
    expect(store.getChannelOutboxItem(flipped.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
    });

    // 对照路径：同一 idempotencyKey 的 turn 再次进入
    // deliverChannelOutboxItem（模拟新入站消息重驱 / 游标重放），行被按
    // ID 认领并完成物理重投。
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
