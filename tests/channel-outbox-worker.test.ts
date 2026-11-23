/**
 * ISSUE-14：Channel Outbox 后台 worker（runChannelOutboxRetryPass）。
 *
 * 用户拍板（2026-11-23）：
 * - 只重投 text：按行内 payload 重建发送，走 deliverChannelOutboxItem 状态机；
 *   image/file/card/mutation 无法安全重建，转 failed 并告警；
 * - 只认领终态 turn 的行，活跃 turn 的行（含运行期限流重试）继续交给 turn；
 * - payload 校验失败转 failed；渠道暂不可用保留 retry_wait；created_at 超过
 *   1 小时的行转 failed，不再发送；
 * - uncertain 行零动作，同 turn 有 uncertain 行时整个 turn 跳过（围栏）。
 *
 * 每个用例结束时自己的行都已离开可认领集合，避免影响后续用例。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-outbox-worker-'));
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
const runtimeScope = await import('../src/channel-outbox-runtime-scope.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function routeFor(chat: string) {
  return {
    provider: 'feishu',
    accountId: 'bot-worker',
    sourceJid: `feishu:bot-worker:${chat}`,
    chatId: chat,
    rootId: null,
    threadId: null,
  };
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/**
 * Persist one outbox row that a crashed process left in `claimed`, then run
 * the startup reconcile so it becomes `retry_wait` — the real restart path.
 */
async function strandRow(input: {
  name: string;
  chat: string;
  kind: 'text' | 'image' | 'file' | 'card' | 'mutation';
  payload: unknown;
  at: string;
  turnRunId?: string;
  ordinal?: number;
}) {
  const route = routeFor(input.chat);
  const turnRunId =
    input.turnRunId ??
    store.createChannelTurnRun({
      ...route,
      idempotencyKey: `outbox-worker:${input.name}`,
      now: input.at,
    }).run.id;
  await expect(
    delivery.deliverChannelOutboxItem({
      ...route,
      turnRunId,
      ordinal: input.ordinal ?? 0,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: `${turnRunId}:${input.name}`,
      owner: `crashed-${input.name}`,
      leaseMs: 1_000,
      now: () => input.at,
      delivery: {
        mode: 'single',
        send: async () => {
          throw new Error('must not run before the crash');
        },
      },
      afterPersist: (phase) => {
        if (phase === 'claimed') {
          throw new delivery.ChannelDeliveryProcessCrash();
        }
      },
    }),
  ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);
  store.reconcileExpiredChannelOutbox(addMs(input.at, 1_001));
  const row = store
    .scanChannelReliabilityNonterminal()
    .outbox.find(
      (item) =>
        item.turnRunId === turnRunId &&
        item.idempotencyKey === `${turnRunId}:${input.name}`,
    )!;
  expect(row.status).toBe('retry_wait');
  return { row, turnRunId, route };
}

function makeDeps(now: string, overrides: Record<string, unknown> = {}) {
  const sendText = vi.fn(
    async (
      _jid: string,
      _text: string,
      _options: { presentation?: 'native' },
    ) => {},
  );
  const isChannelAvailable = vi.fn((_jid: string) => true);
  return {
    sendText,
    isChannelAvailable,
    deps: {
      owner: 'ckqclaw-outbox-worker:test',
      sendText,
      isChannelAvailable,
      now: () => now,
      ...overrides,
    },
  };
}

describe('channel outbox retry worker', () => {
  test('re-delivers a text row of a terminal turn through the outbox state machine', async () => {
    const at = '2026-11-23T01:00:00.000Z';
    const { row, turnRunId, route } = await strandRow({
      name: 'text-terminal',
      chat: 'chat-text',
      kind: 'text',
      payload: {
        text: '重启后补发',
        presentation: 'native',
        deliveryRole: 'final',
      },
      at,
    });
    store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);

    const now = addMs(at, 5_000);
    const { deps, sendText } = makeDeps(now);
    const result = await delivery.runChannelOutboxRetryPass(deps);

    expect(result).toEqual({
      delivered: 1,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(route.sourceJid, '重启后补发', {
      presentation: 'native',
    });
    expect(store.getChannelOutboxItem(row.id)).toMatchObject({
      status: 'delivered',
      attempt: 2,
      leaseOwner: null,
      providerMessageId: runtimeScope.syntheticChannelProviderAck({
        turnRunId,
        ordinal: row.ordinal,
        payloadHash: row.payloadHash,
      }),
    });

    // A second pass is a no-op: delivered rows are never re-sent.
    const again = await delivery.runChannelOutboxRetryPass(deps);
    expect(again).toEqual({
      delivered: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  test('default presentation is omitted when the payload has none', async () => {
    const at = '2026-11-23T01:10:00.000Z';
    const { row, turnRunId, route } = await strandRow({
      name: 'text-default-presentation',
      chat: 'chat-default',
      kind: 'text',
      payload: { text: '普通文本' },
      at,
    });
    store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
    const { deps, sendText } = makeDeps(addMs(at, 5_000));
    await delivery.runChannelOutboxRetryPass(deps);
    expect(sendText).toHaveBeenCalledWith(route.sourceJid, '普通文本', {});
    expect(store.getChannelOutboxItem(row.id)?.status).toBe('delivered');
  });

  test('leaves rows of a live turn to the turn itself', async () => {
    const at = '2026-11-23T02:00:00.000Z';
    const { row, turnRunId } = await strandRow({
      name: 'text-live-turn',
      chat: 'chat-live',
      kind: 'text',
      payload: { text: '活跃 turn' },
      at,
    });
    // turn stays queued (not terminal)
    const { deps, sendText } = makeDeps(addMs(at, 5_000));
    const result = await delivery.runChannelOutboxRetryPass(deps);
    expect(result.delivered + result.failed + result.skipped).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    expect(store.getChannelOutboxItem(row.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
      leaseOwner: null,
    });
    // Clean up for later cases: once the turn finishes the worker takes over.
    store.interruptChannelTurnRunById(turnRunId, 'done', addMs(at, 6_000));
    await delivery.runChannelOutboxRetryPass(makeDeps(addMs(at, 7_000)).deps);
    expect(store.getChannelOutboxItem(row.id)?.status).toBe('delivered');
  });

  test('does not claim a row before its available_at', async () => {
    const at = '2026-11-23T03:00:00.000Z';
    const route = routeFor('chat-future');
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'outbox-worker:future',
      now: at,
    }).run;
    const { item } = store.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: '限流后再发' },
      now: at,
    });
    const claim = store.claimChannelOutboxById(item.id, 'live', 60_000, at)!;
    expect(
      store.failChannelOutbox(claim, {
        error: 'rate limited',
        retryAt: addMs(at, 60_000),
        now: at,
      }),
    ).toBe(true);
    store.interruptChannelTurnRunById(run.id, 'done', at);

    const early = makeDeps(addMs(at, 30_000));
    await delivery.runChannelOutboxRetryPass(early.deps);
    expect(early.sendText).not.toHaveBeenCalled();
    expect(store.getChannelOutboxItem(item.id)?.status).toBe('retry_wait');

    const due = makeDeps(addMs(at, 61_000));
    await delivery.runChannelOutboxRetryPass(due.deps);
    expect(due.sendText).toHaveBeenCalledTimes(1);
    expect(store.getChannelOutboxItem(item.id)?.status).toBe('delivered');
  });

  test('never touches uncertain rows and skips every row of a fenced turn', async () => {
    const at = '2026-11-23T04:00:00.000Z';
    const route = routeFor('chat-fenced');
    const run = store.createChannelTurnRun({
      ...route,
      idempotencyKey: 'outbox-worker:fenced',
      now: at,
    }).run;
    // ordinal 0: a send that crashed after `sending` -> uncertain.
    await expect(
      delivery.deliverChannelOutboxItem({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        payload: { text: '可能已发出' },
        idempotencyKey: `${run.id}:uncertain`,
        owner: 'crashed-sending',
        leaseMs: 1_000,
        now: () => at,
        delivery: {
          mode: 'single',
          send: async () => ({ providerMessageId: 'never' }),
        },
        afterPersist: (phase) => {
          if (phase === 'sending') {
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);
    // ordinal 1: a pre-send sibling in the same turn.
    const sibling = await strandRow({
      name: 'fenced-sibling',
      chat: 'chat-fenced',
      kind: 'text',
      payload: { text: '同 turn 兄弟行' },
      at,
      turnRunId: run.id,
      ordinal: 1,
    });
    // strandRow's reconcile also fenced ordinal 0 as uncertain.
    const uncertain = store.getUncertainChannelOutboxForTurn(run.id)!;
    expect(uncertain).toBeDefined();
    store.interruptChannelTurnRunById(run.id, 'process restarted', at);

    const { deps, sendText } = makeDeps(addMs(at, 5_000));
    const result = await delivery.runChannelOutboxRetryPass(deps);
    expect(result).toEqual({
      delivered: 0,
      failed: 0,
      uncertain: 0,
      skipped: 0,
    });
    expect(sendText).not.toHaveBeenCalled();
    expect(store.getChannelOutboxItem(uncertain.id)).toMatchObject({
      status: 'uncertain',
      revision: uncertain.revision,
    });
    expect(store.getChannelOutboxItem(sibling.row.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
    });
  });

  test.each([
    ['image', { fileName: 'a.png', contentHash: 'abc' }],
    ['file', { fileName: 'report.pdf', contentHash: 'def' }],
    ['card', { card: { title: 'x' } }],
    ['mutation', { operation: 'add_reaction', params: {} }],
  ] as const)(
    'marks a %s row failed because it cannot be rebuilt',
    async (kind, payload) => {
      const at = '2026-11-23T05:00:00.000Z';
      const { row, turnRunId } = await strandRow({
        name: `non-text-${kind}`,
        chat: `chat-${kind}`,
        kind,
        payload,
        at,
      });
      store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
      const { deps, sendText } = makeDeps(addMs(at, 5_000));
      const result = await delivery.runChannelOutboxRetryPass(deps);
      expect(result).toEqual({
        delivered: 0,
        failed: 1,
        uncertain: 0,
        skipped: 0,
      });
      expect(sendText).not.toHaveBeenCalled();
      const after = store.getChannelOutboxItem(row.id)!;
      expect(after.status).toBe('failed');
      expect(after.leaseOwner).toBeNull();
      expect(after.error).toContain(kind);
    },
  );

  test.each([
    ['missing text', { presentation: 'native' }],
    ['empty text', { text: '   ' }],
    ['non-string text', { text: 42 }],
    ['unknown presentation', { text: 'x', presentation: 'card' }],
    ['non-object payload', 'just a string'],
  ] as const)(
    'marks a text row failed when its payload is invalid (%s)',
    async (label, payload) => {
      const at = '2026-11-23T06:00:00.000Z';
      const { row, turnRunId } = await strandRow({
        name: `invalid-${label}`,
        chat: `chat-invalid-${label.replace(/\s+/g, '-')}`,
        kind: 'text',
        payload,
        at,
      });
      store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
      const { deps, sendText } = makeDeps(addMs(at, 5_000));
      const result = await delivery.runChannelOutboxRetryPass(deps);
      expect(result.failed).toBe(1);
      expect(sendText).not.toHaveBeenCalled();
      const after = store.getChannelOutboxItem(row.id)!;
      expect(after.status).toBe('failed');
      expect(after.error).toMatch(/payload/i);
    },
  );

  test('marks rows older than the age limit failed instead of sending late', async () => {
    const at = '2026-11-23T07:00:00.000Z';
    const { row, turnRunId } = await strandRow({
      name: 'stale-text',
      chat: 'chat-stale',
      kind: 'text',
      payload: { text: '迟到一小时的旧消息' },
      at,
    });
    store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
    const { deps, sendText } = makeDeps(addMs(at, 60 * 60 * 1_000 + 1));
    const result = await delivery.runChannelOutboxRetryPass(deps);
    expect(result.failed).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
    const after = store.getChannelOutboxItem(row.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/older than/i);
  });

  test('keeps the row in retry_wait while its channel is unavailable', async () => {
    const at = '2026-11-23T08:00:00.000Z';
    const { row, turnRunId, route } = await strandRow({
      name: 'channel-down',
      chat: 'chat-down',
      kind: 'text',
      payload: { text: '等渠道恢复' },
      at,
    });
    store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
    const down = makeDeps(addMs(at, 5_000));
    down.isChannelAvailable.mockReturnValue(false);
    const result = await delivery.runChannelOutboxRetryPass(down.deps);
    expect(result).toEqual({
      delivered: 0,
      failed: 0,
      uncertain: 0,
      skipped: 1,
    });
    expect(down.isChannelAvailable).toHaveBeenCalledWith(route.sourceJid);
    expect(down.sendText).not.toHaveBeenCalled();
    expect(store.getChannelOutboxItem(row.id)).toMatchObject({
      status: 'retry_wait',
      attempt: 1,
      leaseOwner: null,
    });

    const up = makeDeps(addMs(at, 20_000));
    await delivery.runChannelOutboxRetryPass(up.deps);
    expect(up.sendText).toHaveBeenCalledTimes(1);
    expect(store.getChannelOutboxItem(row.id)?.status).toBe('delivered');
  });

  test('an ambiguous send failure fences the row as uncertain', async () => {
    const at = '2026-11-23T09:00:00.000Z';
    const { row, turnRunId } = await strandRow({
      name: 'send-throws',
      chat: 'chat-throws',
      kind: 'text',
      payload: { text: '发送超时' },
      at,
    });
    store.interruptChannelTurnRunById(turnRunId, 'process restarted', at);
    const { deps, sendText } = makeDeps(addMs(at, 5_000));
    sendText.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await delivery.runChannelOutboxRetryPass(deps);
    expect(result).toEqual({
      delivered: 0,
      failed: 0,
      uncertain: 1,
      skipped: 0,
    });
    expect(store.getChannelOutboxItem(row.id)?.status).toBe('uncertain');

    // Uncertain is never retried automatically.
    const again = makeDeps(addMs(at, 30_000));
    await delivery.runChannelOutboxRetryPass(again.deps);
    expect(again.sendText).not.toHaveBeenCalled();
  });
});
