/**
 * Task AB batch 5: recall judge (recall_utilized scoring).
 *
 * The judge batch-scores finished, recall-injected turns with a structured
 * glm-flash verdict (versioned prompt hash + model land on every row), breaks
 * after 5 consecutive failures (warn-once circuit, reset by restart or a
 * config change), and records per-turn failures in judge_error.
 *
 * No self-referential loop is possible: the judge calls the LLM endpoint
 * directly and never travels through a conversation channel, so its own
 * calls can never become observed turns (pinned by a source assertion).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-judge-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(tmpRoot, 'data'),
  STORE_DIR: path.join(tmpRoot, 'data', 'db'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  RecallJudge,
  parseJudgeResponse,
  sampleByTurnId,
  JUDGE_PROMPT_VERSION,
} = await import('../src/recall-judge.js');

interface TurnRow {
  turnId: string;
  inputText: string | null;
  outputText: string | null;
  recallInjected: number | null;
  durationMs: number | null;
  judgeUsed: number | null;
}

function createStoreSpy(turns: TurnRow[]) {
  const updates: Array<{ turnId: string; patch: Record<string, unknown> }> = [];
  return {
    updates,
    store: {
      listPendingJudgeTurns: () =>
        turns
          .filter(
            (turn) =>
              turn.judgeUsed === null &&
              turn.recallInjected === 1 &&
              turn.durationMs !== null,
          )
          .map((turn) => ({
            turnId: turn.turnId,
            workspaceJid: 'web:ws',
            channel: 'web',
            recallInjected: turn.recallInjected,
            recallHitCount: 3,
            recallLatencyMs: 400,
            inputText: turn.inputText,
            outputText: turn.outputText,
            inputTokens: 10,
            outputTokens: 5,
            costUsd: 0.001,
            durationMs: turn.durationMs,
            judgeUsed: null,
            judgeReasoning: null,
            judgeError: null,
            judgePromptHash: null,
            judgeModel: null,
            createdAt: '2026-11-11T09:00:00.000Z',
          })),
      updateTurn: (turnId: string, patch: Record<string, unknown>) => {
        updates.push({ turnId, patch });
        if (patch.judgeUsed !== undefined) {
          const row = turns.find((turn) => turn.turnId === turnId);
          if (row) row.judgeUsed = patch.judgeUsed as number;
        }
      },
    },
  };
}

function makeJudge(
  turns: TurnRow[],
  complete: (prompt: string) => Promise<string>,
  config: {
    enabled?: boolean;
    judgeEnabled?: boolean;
    failureThreshold?: number;
  } = {},
) {
  const spy = createStoreSpy(turns);
  const judge = new RecallJudge({
    getStore: () => spy.store as never,
    getConfig: () =>
      ({
        enabled: config.enabled ?? true,
        contentMode: 'full',
        judge: { enabled: config.judgeEnabled ?? true },
      }) as never,
    getClient: () => ({ model: 'glm-4-flash', complete }),
    failureThreshold: config.failureThreshold,
  });
  return { judge, spy };
}

beforeEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

describe('parseJudgeResponse', () => {
  test('parses plain JSON verdicts', () => {
    expect(
      parseJudgeResponse('{"used": true, "reasoning": "answer cites it"}'),
    ).toEqual({ used: true, reasoning: 'answer cites it' });
  });

  test('strips markdown fences and surrounding prose', () => {
    expect(
      parseJudgeResponse(
        'Here you go:\n```json\n{"used": false, "reasoning": "no recall cited"}\n```',
      ),
    ).toEqual({ used: false, reasoning: 'no recall cited' });
  });

  test('garbage and non-boolean used values yield null', () => {
    expect(parseJudgeResponse('model had a hiccup')).toBeNull();
    expect(parseJudgeResponse('{"used": "yes"}')).toBeNull();
    expect(parseJudgeResponse('')).toBeNull();
  });
});

describe('sampleByTurnId (deterministic hash hook)', () => {
  test('rate 1 keeps everything, rate 0 drops everything', () => {
    expect(['a', 'b', 'c'].every((id) => sampleByTurnId(id, 1))).toBe(true);
    expect(['a', 'b', 'c'].some((id) => sampleByTurnId(id, 0))).toBe(false);
  });

  test('same turn id always maps to the same decision', () => {
    const first = sampleByTurnId('turn-42', 0.5);
    for (let index = 0; index < 10; index += 1) {
      expect(sampleByTurnId('turn-42', 0.5)).toBe(first);
    }
  });
});

describe('RecallJudge.runOnce', () => {
  test('writes structured verdicts with prompt hash and model version', async () => {
    const { judge, spy } = makeJudge(
      [
        {
          turnId: 't1',
          inputText: '上次的决策是什么',
          outputText: '根据记录，上次的决策是……',
          recallInjected: 1,
          durationMs: 1000,
          judgeUsed: null,
        },
      ],
      async () => '{"used": true, "reasoning": "回答引用了召回内容"}',
    );
    const report = await judge.runOnce();
    expect(report).toMatchObject({ judged: 1, failed: 0, skipped: 0 });
    expect(spy.updates[0]).toMatchObject({
      turnId: 't1',
      patch: {
        judgeUsed: 1,
        judgeReasoning: '回答引用了召回内容',
        judgePromptHash: expect.any(String),
        judgeModel: expect.any(String),
      },
    });
  });

  test('skips turns without stored text (metadata mode cannot be judged)', async () => {
    const calls: string[] = [];
    const { judge, spy } = makeJudge(
      [
        {
          turnId: 'meta',
          inputText: null,
          outputText: null,
          recallInjected: 1,
          durationMs: 1000,
          judgeUsed: null,
        },
      ],
      async (prompt) => {
        calls.push(prompt);
        return '{"used": true, "reasoning": "x"}';
      },
    );
    const report = await judge.runOnce();
    expect(report).toMatchObject({ judged: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
    expect(spy.updates).toHaveLength(0);
  });

  test('unparseable verdicts record judge_error and count as failures', async () => {
    const { judge, spy } = makeJudge(
      [
        {
          turnId: 't-bad',
          inputText: 'q',
          outputText: 'a',
          recallInjected: 1,
          durationMs: 1000,
          judgeUsed: null,
        },
      ],
      async () => 'not json at all',
    );
    const report = await judge.runOnce();
    expect(report).toMatchObject({ judged: 0, failed: 1 });
    expect(spy.updates[0]).toMatchObject({
      turnId: 't-bad',
      patch: { judgeError: expect.stringContaining('parse') },
    });
  });

  test('client failures count toward the circuit without writing verdicts', async () => {
    const { judge, spy } = makeJudge(
      [
        {
          turnId: 't-err',
          inputText: 'q',
          outputText: 'a',
          recallInjected: 1,
          durationMs: 1000,
          judgeUsed: null,
        },
      ],
      async () => {
        throw new Error('endpoint down');
      },
    );
    const report = await judge.runOnce();
    expect(report).toMatchObject({ failed: 1 });
    expect(spy.updates[0].patch.judgeError).toContain('endpoint down');
  });

  test('five consecutive failures open the circuit; a config change resets it', async () => {
    const turns: TurnRow[] = [
      {
        turnId: 't1',
        inputText: 'q',
        outputText: 'a',
        recallInjected: 1,
        durationMs: 1,
        judgeUsed: null,
      },
    ];
    const configState = {
      enabled: true,
      contentMode: 'full' as const,
      judge: { enabled: true },
    };
    let calls = 0;
    const spy = createStoreSpy(turns);
    const judge = new RecallJudge({
      getStore: () => spy.store as never,
      getConfig: () => configState as never,
      getClient: () => ({
        model: 'glm-4-flash',
        complete: async () => {
          calls += 1;
          throw new Error('down');
        },
      }),
      failureThreshold: 5,
    });
    for (let round = 0; round < 4; round += 1) {
      const report = await judge.runOnce();
      expect(report.circuitOpen).toBe(false);
    }
    // The 5th consecutive failure trips the breaker within that same run.
    const fifth = await judge.runOnce();
    expect(fifth.circuitOpen).toBe(true);
    expect(calls).toBe(5);
    const sixth = await judge.runOnce();
    expect(sixth.circuitOpen).toBe(true);
    expect(calls).toBe(5); // no further LLM traffic

    // An operator flipping any observability field resets the circuit —
    // that is the documented recovery path short of a restart.
    configState.contentMode = 'metadata';
    turns[0].judgeUsed = null;
    const seventh = await judge.runOnce();
    expect(seventh.circuitOpen).toBe(false);
    expect(calls).toBe(6);
  });

  test('a success resets the consecutive-failure counter', async () => {
    const turns: TurnRow[] = [
      {
        turnId: 't1',
        inputText: 'q',
        outputText: 'a',
        recallInjected: 1,
        durationMs: 1,
        judgeUsed: null,
      },
    ];
    let fail = true;
    const { judge } = makeJudge(
      turns,
      async () => {
        if (fail) throw new Error('down');
        return '{"used": true, "reasoning": "ok"}';
      },
      { failureThreshold: 3 },
    );
    await judge.runOnce(); // fail 1
    await judge.runOnce(); // fail 2
    fail = false;
    // The turn was already marked with judge_error but stays pending
    // (judge_used still NULL) — success judges it and resets the counter.
    turns[0].judgeUsed = null;
    const ok = await judge.runOnce();
    expect(ok).toMatchObject({ judged: 1 });
    fail = true;
    turns[0].judgeUsed = null;
    await judge.runOnce(); // fail 1 again (counter was reset)
    const stillClosed = await judge.runOnce();
    expect(stillClosed.circuitOpen).toBe(false);
  });

  test('judge disabled in config is a no-op', async () => {
    const calls: string[] = [];
    const { judge, spy } = makeJudge(
      [
        {
          turnId: 't1',
          inputText: 'q',
          outputText: 'a',
          recallInjected: 1,
          durationMs: 1,
          judgeUsed: null,
        },
      ],
      async (prompt) => {
        calls.push(prompt);
        return '{"used": true, "reasoning": "x"}';
      },
      { judgeEnabled: false },
    );
    const report = await judge.runOnce();
    expect(report).toMatchObject({ judged: 0, skipped: 0, circuitOpen: false });
    expect(calls).toHaveLength(0);
    expect(spy.updates).toHaveLength(0);
  });

  test('prompts never leave through a conversation channel (no self-loop)', () => {
    const source = fs.readFileSync(path.resolve('src/recall-judge.ts'), 'utf8');
    expect(source).toMatch(/直调|direct/i);
    expect(source).not.toMatch(/sendMessage|runAgent|processGroupMessages/);
    expect(source).toContain(JUDGE_PROMPT_VERSION);
  });
});
