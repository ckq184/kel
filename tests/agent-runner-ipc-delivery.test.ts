import { describe, expect, test } from 'vitest';

import {
  IpcTurnDeliveryTracker,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  orderIpcInputMessages,
  parseIpcReceipt,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';

function message(id: string): IpcInputMessage {
  return {
    text: id,
    receipt: {
      deliveryId: `delivery-${id}`,
      chatJid: 'web:main',
      cursor: { timestamp: `2026-07-10T00:00:0${id}.000Z`, id },
    },
  };
}

describe('agent-runner IPC delivery turn tracker', () => {
  test('orders requeued older messages before newly written messages by durable cursor', () => {
    const olderRequeued = message('1');
    const newerArrival = message('2');

    expect(orderIpcInputMessages([newerArrival, olderRequeued])).toEqual([
      olderRequeued,
      newerArrival,
    ]);
  });

  test('preserves filesystem order when a mixed batch has no complete durable ordering', () => {
    const newerArrival = message('2');
    const legacyMessage: IpcInputMessage = { text: 'legacy' };
    const olderRequeued = message('1');
    const drained = [newerArrival, legacyMessage, olderRequeued];

    expect(orderIpcInputMessages(drained)).toEqual(drained);
  });

  test('selects the greatest receipt cursor regardless of filesystem order', () => {
    const older = message('1');
    const newerSameTimestamp: IpcInputMessage = {
      text: 'newer',
      receipt: {
        deliveryId: 'delivery-newer',
        chatJid: 'web:main',
        cursor: {
          timestamp: older.receipt!.cursor.timestamp,
          id: 'z-newer',
        },
      },
    };

    expect(latestIpcDeliveryId([newerSameTimestamp, older])).toBe(
      'delivery-newer',
    );
    expect(latestIpcDeliveryId([older, newerSameTimestamp])).toBe(
      'delivery-newer',
    );
    expect(latestIpcInputMessage([newerSameTimestamp, older])).toBe(
      newerSameTimestamp,
    );
  });

  test('startup and idle-drained batches acknowledge only their exact completed turn', () => {
    const startup = [message('1'), message('2')];
    const tracker = new IpcTurnDeliveryTracker(startup);
    const idle = [message('3'), message('4')];
    tracker.acceptTurn(idle);

    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '1',
      '2',
    ]);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual([
      '3',
      '4',
    ]);
    expect(tracker.unacknowledgedMessages).toEqual([]);
  });

  test('mid-query turns are FIFO and later receipts cannot attach to an earlier result', () => {
    const tracker = new IpcTurnDeliveryTracker([]);
    tracker.acceptTurn([message('1')]);
    tracker.acceptTurn([message('2')]);

    expect(tracker.pendingTurnCount).toBe(3);
    expect(tracker.hasPendingTurns).toBe(true);
    expect(tracker.completeNextTurn()).toEqual([]); // initial non-IPC prompt
    // The first result completed, but two accepted steer turns are still
    // waiting in the same SDK stream. The runner must not arm its 5s close
    // timeout or tell the host to release a durable queued message yet.
    expect(tracker.pendingTurnCount).toBe(2);
    expect(tracker.hasPendingTurns).toBe(true);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['1']);
    expect(tracker.unacknowledgedMessages.map((m) => m.text)).toEqual(['2']);
    expect(tracker.completeNextTurn().map((r) => r.cursor.id)).toEqual(['2']);
    expect(tracker.pendingTurnCount).toBe(0);
    expect(tracker.hasPendingTurns).toBe(false);
  });

  test('intentional interrupt cancels the current warm-runner turn but preserves later turns', () => {
    const current = message('superseded');
    const laterOne = message('later-1');
    const laterTwo = message('later-2');
    const tracker = new IpcTurnDeliveryTracker([current]);
    tracker.acceptTurn([laterOne]);
    tracker.acceptTurn([laterTwo]);

    expect(tracker.cancelCurrentTurn()).toEqual([current]);
    expect(tracker.unacknowledgedMessages).toEqual([laterOne, laterTwo]);
    expect(tracker.pendingTurnCount).toBe(2);

    expect(tracker.completeNextTurn()).toEqual([laterOne.receipt]);
    expect(tracker.unacknowledgedMessages).toEqual([laterTwo]);
  });

  test('parses and preserves the exact covered cursor set for a batch', () => {
    const parsed = parseIpcReceipt({
      deliveryId: 'delivery-batch',
      chatJid: 'web:main',
      coveredCursors: [
        {
          timestamp: '2026-07-10T00:00:01.000Z',
          id: 'm1',
          sourceJid: 'feishu:oc_chat#account:account-a',
        },
        {
          timestamp: '2026-07-10T00:00:02.000Z',
          id: 'm2',
          sourceJid: 'telegram:-100123#account:account-b',
        },
      ],
      cursor: {
        timestamp: '2026-07-10T00:00:02.000Z',
        id: 'm2',
        sourceJid: 'telegram:-100123#account:account-b',
      },
    });

    expect(parsed?.coveredCursors?.map((cursor) => cursor.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(parsed?.coveredCursors?.map((cursor) => cursor.sourceJid)).toEqual([
      'feishu:oc_chat#account:account-a',
      'telegram:-100123#account:account-b',
    ]);
    expect(parsed?.cursor.sourceJid).toBe('telegram:-100123#account:account-b');
  });

  test('malformed or stale receipt payloads are rejected at the runner boundary', () => {
    expect(parseIpcReceipt(null)).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        cursor: { timestamp: 123, id: 'm' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [
          { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
          { timestamp: 123, id: 'm2' },
        ],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [],
        cursor: { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' },
      }),
    ).toBeUndefined();
    expect(
      parseIpcReceipt({
        deliveryId: 'd',
        chatJid: 'web:main',
        coveredCursors: [{ timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' }],
        cursor: { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' },
      }),
    ).toBeUndefined();
  });
});
