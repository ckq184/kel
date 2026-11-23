/**
 * ISSUE-14：outbox 重投 worker 并入 15s 恢复循环（用户拍板）。
 *
 * - afterPass 在同一轮 reconcile 之后执行：本轮刚被置为 interrupted 的 turn，
 *   其 retry_wait 行在同一轮就被 worker 重投（“一个轮询周期内”）；
 * - afterPass 抛错不影响 reconcile，也不让 trigger() 拒绝；
 * - 重叠 trigger 合并，afterPass 只执行一次；
 * - src/index.ts 启动序列把 worker 接到恢复循环上。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-outbox-stage-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({ logger }));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const delivery = await import('../src/channel-outbox-delivery.js');
const { startChannelReliabilityRecoveryLoop } =
  await import('../src/channel-reliability-recovery.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const reconciler = {
  reconcileStreamingCard: vi.fn(async () => ({
    version: 1,
    method: 'cardkit' as const,
  })),
};

describe('recovery loop outbox stage', () => {
  test('a turn interrupted by this pass has its retry_wait text re-delivered in the same pass', async () => {
    vi.useFakeTimers();
    const at = '2026-11-23T10:00:00.000Z';
    vi.setSystemTime(new Date(at));
    const route = {
      provider: 'feishu',
      accountId: 'bot-loop',
      sourceJid: 'feishu:bot-loop:chat-loop',
      chatId: 'chat-loop',
      rootId: null,
      threadId: null,
    };
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'recovery-outbox-stage:turn',
      now: at,
    }).run;
    expect(
      store.claimChannelTurnRunById(run.id, 'old-process', 1_000, at),
    ).toBeDefined();
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        payload: { text: '同一轮补发' },
        idempotencyKey: `${run.id}:text`,
        owner: 'old-process-outbox',
        leaseMs: 1_000,
        now: () => at,
        delivery: {
          mode: 'single',
          send: async () => ({ providerMessageId: 'never' }),
        },
        afterPersist: (phase) => {
          if (phase === 'claimed') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // Restart: startup reconcile flips the row, the turn lease is expired
    // but the turn itself is still `running` until a reconciliation pass.
    vi.setSystemTime(new Date('2026-11-23T10:00:05.000Z'));
    expect(delivery.reconcileChannelOutboxDeliveries()).toEqual({
      retryable: 1,
      uncertain: 0,
    });
    expect(store.getChannelTurnRun(run.id)?.status).toBe('running');

    const sendText = vi.fn(async () => {});
    const afterPass = vi.fn(() =>
      delivery.runChannelOutboxRetryPass({
        owner: 'ckqclaw-outbox-worker:test',
        sendText,
        isChannelAvailable: () => true,
      }),
    );
    const loop = startChannelReliabilityRecoveryLoop(reconciler, {
      intervalMs: 60_000,
      afterPass,
    });
    await loop.trigger();
    loop.stop();

    expect(store.getChannelTurnRun(run.id)?.status).toBe('interrupted');
    expect(afterPass).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(route.sourceJid, '同一轮补发', {});
    const row = store
      .scanChannelReliabilityNonterminal()
      .outbox.find((item) => item.turnRunId === run.id);
    expect(row).toBeUndefined(); // delivered rows are terminal
    vi.useRealTimers();
  });

  test('afterPass runs after the reconciliation pass and its failure is isolated', async () => {
    logger.info.mockClear();
    logger.debug.mockClear();
    logger.error.mockClear();
    const afterPass = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('worker exploded'))
      .mockResolvedValue(undefined);
    const loop = startChannelReliabilityRecoveryLoop(reconciler, {
      intervalMs: 60_000,
      afterPass,
    });
    await expect(loop.trigger()).resolves.toBeUndefined();
    const reconcileLog = [...logger.info.mock.calls, ...logger.debug.mock.calls]
      .map((call, index) => ({ call, index }))
      .find(
        ({ call }) =>
          call[1] === 'Channel reliability reconciliation completed',
      );
    expect(reconcileLog).toBeDefined();
    const reconcileOrder = Math.min(
      ...[
        ...logger.info.mock.invocationCallOrder.filter(
          (_, i) =>
            logger.info.mock.calls[i][1] ===
            'Channel reliability reconciliation completed',
        ),
        ...logger.debug.mock.invocationCallOrder.filter(
          (_, i) =>
            logger.debug.mock.calls[i][1] ===
            'Channel reliability reconciliation completed',
        ),
      ],
    );
    expect(afterPass.mock.invocationCallOrder[0]).toBeGreaterThan(
      reconcileOrder,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Channel outbox retry pass failed',
    );

    // The next tick still runs both stages.
    await loop.trigger();
    expect(afterPass).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  test('overlapping triggers coalesce into one afterPass run', async () => {
    let release!: () => void;
    const afterPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const loop = startChannelReliabilityRecoveryLoop(reconciler, {
      intervalMs: 60_000,
      afterPass,
    });
    const first = loop.trigger();
    const second = loop.trigger();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(afterPass).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(afterPass).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  test('index.ts wires the outbox retry worker into the recovery loop', () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const reconcileAt = source.indexOf(
      'const outboxRecovery = reconcileChannelOutboxDeliveries();',
    );
    const loopAt = source.search(
      /startChannelReliabilityRecoveryLoop\(\s*imManager,\s*\{/,
    );
    expect(reconcileAt).toBeGreaterThan(0);
    expect(loopAt).toBeGreaterThan(reconcileAt);
    const loopCall = source.slice(loopAt, source.indexOf('\n  );', loopAt));
    expect(loopCall).toMatch(/afterPass:/);
    expect(loopCall).toMatch(/runImmediately: true/);
    expect(source).toMatch(/runChannelOutboxRetryPass\(\{/);
    expect(source).toMatch(/ckqclaw-outbox-worker:\$\{process\.pid\}/);
  });
});
