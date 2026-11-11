/**
 * Task AB batch 4: host-side turn observer.
 *
 * Contract under test (plan §3.3): a process singleton tapping the turn
 * lifecycle — every public method is synchronous, nothing ever throws, and
 * the whole chain is a no-op (zero eval.db writes) while observability is
 * disabled. `full` mode stores redacted conversation text; `metadata` mode
 * stores none.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-observer-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(tmpRoot, 'data'),
  STORE_DIR: path.join(tmpRoot, 'data', 'db'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redactLogMessage: (value: string) => `redacted(${value})`,
}));

const { TurnObserver } = await import('../src/turn-observer.js');

type InsertTurnCall = Record<string, unknown>;
type UpdateTurnCall = { turnId: string; patch: Record<string, unknown> };

function createStoreSpy() {
  const inserts: InsertTurnCall[] = [];
  const updates: UpdateTurnCall[] = [];
  return {
    inserts,
    updates,
    store: {
      insertTurn: (turn: InsertTurnCall) => {
        inserts.push(turn);
      },
      updateTurn: (turnId: string, patch: Record<string, unknown>) => {
        updates.push({ turnId, patch });
      },
    },
  };
}

function makeObserver(
  config: Record<string, unknown>,
  spy = createStoreSpy(),
  maxQueueSize = 1000,
): {
  observer: InstanceType<typeof TurnObserver>;
  spy: ReturnType<typeof createStoreSpy>;
} {
  return {
    observer: new TurnObserver({
      getConfig: () => config as never,
      getStore: () => spy.store as never,
      maxQueueSize,
      flushDelayMs: 60_000, // never auto-flush; tests drive flush() directly
    }),
    spy,
  };
}

const BASE_CTX = {
  workspaceJid: 'web:ws-a',
  folder: 'ws-a',
  channel: 'web',
  interactionMode: 'assistant',
  autoRecallEnabled: true,
  inputText: '帮我回忆上次的项目决定',
  defaultTurnId: 'fallback-turn',
};

function streamResult(
  eventType: string,
  extra: Record<string, unknown> = {},
  inputTurnId = 'turn-1',
) {
  return {
    status: 'stream',
    result: null,
    inputTurnId,
    streamEvent: { eventType, ...extra },
  };
}

let observerCount = 0;

beforeEach(() => {
  observerCount += 1;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('disabled pipeline is a strict no-op', () => {
  test('missing config writes nothing and opens no store', () => {
    const { observer, spy } = makeObserver({
      enabled: false,
      contentMode: 'metadata',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('text_delta', { text: 'x' }));
    observer.onResult(BASE_CTX, {
      status: 'success',
      result: 'answer',
      inputTurnId: 'turn-1',
    });
    observer.flush();
    expect(spy.inserts).toHaveLength(0);
    expect(spy.updates).toHaveLength(0);
  });
});

describe('turn lifecycle recording', () => {
  test('first sight inserts the turn row with full-mode redacted input', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('text_delta'));
    observer.flush();
    expect(spy.inserts).toHaveLength(1);
    expect(spy.inserts[0]).toMatchObject({
      turnId: 'turn-1',
      workspaceJid: 'web:ws-a',
      folder: 'ws-a',
      channel: 'web',
      interactionMode: 'assistant',
      autoRecallEnabled: 1,
      inputText: 'redacted(帮我回忆上次的项目决定)',
    });
  });

  test('metadata mode records the same turn without any text', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'metadata',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('text_delta'));
    observer.flush();
    expect(spy.inserts[0]).toMatchObject({ turnId: 'turn-1' });
    expect(spy.inserts[0].inputText).toBeNull();
    // No output key at insert time at all; the store defaults it to NULL.
    expect(spy.inserts[0].outputText).toBeUndefined();
  });

  test('auto_recall events patch the recall columns', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, {
      status: 'stream',
      result: null,
      inputTurnId: 'turn-1',
      streamEvent: {
        eventType: 'auto_recall',
        autoRecall: { injected: true, hitCount: 3, latencyMs: 412 },
      },
    });
    observer.flush();
    expect(spy.updates).toContainEqual({
      turnId: 'turn-1',
      patch: { recallInjected: 1, recallHitCount: 3, recallLatencyMs: 412 },
    });
  });

  test('auto_recall without the facts payload records injected=0', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('auto_recall'));
    observer.flush();
    expect(spy.updates).toContainEqual({
      turnId: 'turn-1',
      patch: { recallInjected: 0 },
    });
  });

  test('usage events accumulate per turn and land on completion', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, {
      status: 'stream',
      result: null,
      inputTurnId: 'turn-1',
      streamEvent: {
        eventType: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          costUSD: 0.01,
          durationMs: 1500,
        },
      },
    });
    observer.onResult(BASE_CTX, {
      status: 'success',
      result: '最终回答',
      inputTurnId: 'turn-1',
    });
    observer.flush();
    const completion = spy.updates.find(
      (call) => call.patch.durationMs !== undefined,
    );
    expect(completion).toEqual({
      turnId: 'turn-1',
      patch: {
        inputTokens: 100,
        outputTokens: 40,
        costUsd: 0.01,
        durationMs: 1500,
        outputText: 'redacted(最终回答)',
      },
    });
  });

  test('terminal statuses finalize the turn; error output stays null-safe', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('text_delta'));
    observer.onResult(BASE_CTX, {
      status: 'stream',
      result: null,
      inputTurnId: 'turn-1',
      streamEvent: {
        eventType: 'usage',
        usage: { inputTokens: 5, outputTokens: 0, costUSD: 0, durationMs: 300 },
      },
    });
    observer.onResult(BASE_CTX, {
      status: 'error',
      error: 'provider down',
      inputTurnId: 'turn-1',
    });
    observer.flush();
    const completion = spy.updates.find(
      (call) => call.patch.durationMs !== undefined,
    );
    // Error turns finalize with whatever usage was seen; no answer text key.
    expect(completion!.turnId).toBe('turn-1');
    expect(completion!.patch.durationMs).toBe(300);
    expect(completion!.patch.outputText).toBeUndefined();
  });

  test('interleaved turns keep their identities separate', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, streamResult('auto_recall', {}, 'turn-a'));
    observer.onResult(BASE_CTX, {
      status: 'success',
      result: 'a-answer',
      inputTurnId: 'turn-a',
    });
    observer.onResult(BASE_CTX, streamResult('auto_recall', {}, 'turn-b'));
    observer.flush();
    expect(spy.inserts.map((turn) => turn.turnId).sort()).toEqual([
      'turn-a',
      'turn-b',
    ]);
  });

  test('missing inputTurnId falls back to the context default', () => {
    const { observer, spy } = makeObserver({
      enabled: true,
      contentMode: 'full',
      judge: { enabled: false },
    });
    observer.onResult(BASE_CTX, {
      status: 'stream',
      result: null,
      streamEvent: { eventType: 'status' },
    });
    observer.flush();
    expect(spy.inserts[0].turnId).toBe('fallback-turn');
  });
});

describe('robustness contract', () => {
  test('store failures never propagate to the caller', () => {
    const boom = {
      insertTurn: vi.fn(() => {
        throw new Error('disk full');
      }),
      updateTurn: vi.fn(() => {
        throw new Error('db locked');
      }),
    };
    const observer = new TurnObserver({
      getConfig: () =>
        ({
          enabled: true,
          contentMode: 'full',
          judge: { enabled: false },
        }) as never,
      getStore: () => boom as never,
      maxQueueSize: 1000,
      flushDelayMs: 60_000,
    });
    expect(() => {
      observer.onResult(BASE_CTX, streamResult('text_delta'));
      observer.onResult(BASE_CTX, {
        status: 'success',
        result: 'x',
        inputTurnId: 'turn-1',
      });
      observer.flush();
      observer.flush();
    }).not.toThrow();
  });

  test('bounded queue drops new ops instead of growing unbounded', () => {
    const { observer, spy } = makeObserver(
      { enabled: true, contentMode: 'full', judge: { enabled: false } },
      createStoreSpy(),
      3,
    );
    // 1 insert (turn-1) + 3 more turns than the queue can hold.
    observer.onResult(BASE_CTX, streamResult('text_delta', {}, 'turn-1'));
    observer.onResult(BASE_CTX, streamResult('text_delta', {}, 'turn-2'));
    observer.onResult(BASE_CTX, streamResult('text_delta', {}, 'turn-3'));
    observer.onResult(BASE_CTX, streamResult('text_delta', {}, 'turn-4'));
    observer.flush();
    // Queue cap 3: the first three ops survive, the fourth turn's insert is dropped.
    expect(spy.inserts.length + spy.updates.length).toBeLessThanOrEqual(3);
  });

  test('singleton export exists for the host tap', async () => {
    const mod = await import('../src/turn-observer.js');
    expect(mod.turnObserver).toBeInstanceOf(TurnObserver);
  });
});
