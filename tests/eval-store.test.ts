import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-store-'));

// Top-level await imports (auto-memory-routes.test.ts precedent): the mock
// factories close over tmpRoot, so the module graph must resolve after the
// test module body has initialized it.
const { EvalStore, SCORE_DEFINITIONS } = await import('../src/eval-store.js');
const { getObservabilityConfig, resetObservabilityConfigCache } =
  await import('../src/observability-config.js');

// The store resolves its default path from STORE_DIR at import time; point
// that at the temp dir so `EvalStore.open()` never touches the real data/.
vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(tmpRoot, 'data'),
  STORE_DIR: path.join(tmpRoot, 'data', 'db'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function freshStorePath(name: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
  return path.join(dir, 'eval.db');
}

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── SCORE_DEFINITIONS registry ──────────────────────────────────────────────

describe('SCORE_DEFINITIONS', () => {
  test('registers every score name with type and numeric range', () => {
    expect(Object.keys(SCORE_DEFINITIONS).sort()).toEqual(
      [
        'hit',
        'mrr',
        'precision',
        'recall',
        'recall_injected',
        'recall_utilized',
        'turn_latency_ms',
        'turn_tokens',
      ].sort(),
    );
    for (const def of Object.values(SCORE_DEFINITIONS)) {
      expect(['NUMERIC', 'BOOLEAN']).toContain(def.dataType);
      if (def.dataType === 'NUMERIC') {
        expect(def.minValue).toBeGreaterThanOrEqual(0);
        expect(def.maxValue).toBeGreaterThan(def.minValue!);
      }
    }
    // Boolean scores stay in the 0/1 domain.
    expect(SCORE_DEFINITIONS.recall_utilized.dataType).toBe('BOOLEAN');
    expect(SCORE_DEFINITIONS.recall_utilized.maxValue).toBe(1);
  });
});

// ── eval.db schema + self-versioning ────────────────────────────────────────

describe('EvalStore schema', () => {
  test('creates the three tables and stamps user_version=1', () => {
    const dbPath = freshStorePath('schema');
    const store = EvalStore.open(dbPath);
    try {
      const raw = new Database(dbPath, { readonly: true });
      try {
        const version = raw.prepare('PRAGMA user_version').get() as {
          user_version: number;
        };
        expect(version.user_version).toBe(1);
        const tables = (
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toEqual(
          expect.arrayContaining(['eval_runs', 'eval_run_items', 'obs_turns']),
        );
      } finally {
        raw.close();
      }
    } finally {
      store.close();
    }
  });

  test('reopening an existing v1 store is idempotent', () => {
    const dbPath = freshStorePath('reopen');
    const first = EvalStore.open(dbPath);
    first.upsertRun({ id: 'run-1', name: 'r1', k: 5 }, [
      {
        queryId: 'q1',
        category: 'verbatim',
        expected: ['m1'],
        retrieved: ['m1'],
        recall: 1,
        hit: 1,
        mrr: 1,
        precision: 1,
        latencyMs: 120,
      },
    ]);
    first.close();

    const second = EvalStore.open(dbPath);
    try {
      expect(second.getRun('run-1')?.run.name).toBe('r1');
      expect(second.getRun('run-1')?.items).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  test('refuses to open a database stamped with a newer user_version', () => {
    const dbPath = freshStorePath('newer');
    const raw = new Database(dbPath);
    raw.exec('PRAGMA user_version = 2');
    raw.close();
    expect(() => EvalStore.open(dbPath)).toThrow(/newer than supported/i);
  });
});

// ── eval_runs + eval_run_items ──────────────────────────────────────────────

describe('EvalStore runs', () => {
  let store: EvalStore;
  beforeEach(() => {
    store = EvalStore.open(freshStorePath('runs'));
  });
  afterEach(() => {
    store.close();
  });

  test('upsertRun writes run + items and replaces items on re-upsert', () => {
    store.upsertRun(
      {
        id: 'run-a',
        name: 'baseline',
        kind: 'recall',
        k: 5,
        summary: {
          overall: {
            n: 2,
            recall: 0.75,
            hitRate: 1,
            mrr: 0.75,
            precision: 0.5,
          },
          perCategory: {},
        },
      },
      [
        {
          queryId: 'q1',
          category: 'verbatim',
          expected: ['m1'],
          retrieved: ['m1', 'm2'],
          recall: 1,
          hit: 1,
          mrr: 1,
          precision: 0.5,
          latencyMs: 100,
          note: 'first',
        },
        {
          queryId: 'q2',
          category: 'paraphrase',
          expected: ['m2'],
          retrieved: [],
          recall: 0,
          hit: 0,
          mrr: 0,
          precision: 0,
          latencyMs: 200,
        },
      ],
    );

    const loaded = store.getRun('run-a');
    expect(loaded?.run.name).toBe('baseline');
    expect(loaded?.run.k).toBe(5);
    expect(loaded?.run.summary.overall.recall).toBe(0.75);
    expect(loaded?.items).toHaveLength(2);
    expect(loaded?.items[0]).toMatchObject({
      queryId: 'q1',
      category: 'verbatim',
      expected: ['m1'],
      retrieved: ['m1', 'm2'],
      recall: 1,
      hit: 1,
      mrr: 1,
      precision: 0.5,
      latencyMs: 100,
      note: 'first',
    });

    // Same id upsert again with different items: full replacement, no residue.
    store.upsertRun({ id: 'run-a', name: 'baseline-v2', k: 10 }, [
      {
        queryId: 'q1',
        category: 'verbatim',
        expected: ['m1'],
        retrieved: ['m1'],
        recall: 1,
        hit: 1,
        mrr: 1,
        precision: 1,
        latencyMs: 90,
      },
    ]);
    const reloaded = store.getRun('run-a');
    expect(reloaded?.run.name).toBe('baseline-v2');
    expect(reloaded?.run.k).toBe(10);
    expect(reloaded?.items).toHaveLength(1);
  });

  test('getRun returns null for unknown ids', () => {
    expect(store.getRun('missing')).toBeNull();
  });

  test('listRuns returns newest first', () => {
    const item = {
      queryId: 'q',
      category: 'verbatim' as const,
      expected: ['m'],
      retrieved: ['m'],
      recall: 1,
      hit: 1,
      mrr: 1,
      precision: 1,
      latencyMs: 1,
    };
    store.upsertRun(
      { id: 'old', name: 'old', k: 5, createdAt: '2026-11-10T00:00:00Z' },
      [item],
    );
    store.upsertRun(
      { id: 'new', name: 'new', k: 5, createdAt: '2026-11-11T00:00:00Z' },
      [item],
    );
    expect(store.listRuns().map((run) => run.id)).toEqual(['new', 'old']);
  });

  test('compareRuns recomputes overall metrics from items per run', () => {
    store.upsertRun({ id: 'r1', name: 'r1', k: 5 }, [
      {
        queryId: 'q1',
        category: 'verbatim',
        expected: ['m1'],
        retrieved: ['m1'],
        recall: 1,
        hit: 1,
        mrr: 1,
        precision: 1,
        latencyMs: 50,
      },
      {
        queryId: 'q2',
        category: 'paraphrase',
        expected: ['m2'],
        retrieved: [],
        recall: 0,
        hit: 0,
        mrr: 0,
        precision: 0,
        latencyMs: 150,
      },
    ]);
    store.upsertRun({ id: 'r2', name: 'r2', k: 5 }, [
      {
        queryId: 'q1',
        category: 'verbatim',
        expected: ['m1'],
        retrieved: ['m1'],
        recall: 1,
        hit: 1,
        mrr: 0.5,
        precision: 0.5,
        latencyMs: 60,
      },
    ]);
    const comparison = store.compareRuns(['r1', 'r2', 'missing']);
    expect(comparison).toHaveLength(3);
    expect(comparison[0]).toMatchObject({
      id: 'r1',
      itemCount: 2,
      recall: 0.5,
      hitRate: 0.5,
      mrr: 0.5,
      precision: 0.5,
    });
    expect(comparison[1]).toMatchObject({
      id: 'r2',
      itemCount: 1,
      recall: 1,
      mrr: 0.5,
    });
    expect(comparison[2]).toBeNull();
  });
});

// ── obs_turns ───────────────────────────────────────────────────────────────

describe('EvalStore turns', () => {
  let store: EvalStore;
  beforeEach(() => {
    store = EvalStore.open(freshStorePath('turns'));
  });
  afterEach(() => {
    store.close();
  });

  test('insertTurn + updateTurn accumulate fields across the turn lifecycle', () => {
    store.insertTurn({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      workspaceJid: 'web:folder-a',
      folder: 'folder-a',
      channel: 'web',
      interactionMode: 'assistant',
      autoRecallEnabled: 1,
    });
    // Recall outcome arrives via the auto_recall stream event.
    expect(
      store.updateTurn('turn-1', {
        recallInjected: 1,
        recallHitCount: 3,
        recallLatencyMs: 421,
      }),
    ).toBe(true);
    // Completion fills usage + answer.
    expect(
      store.updateTurn('turn-1', {
        inputText: '帮我回忆上次的项目决定',
        outputText: '根据记录……',
        inputTokens: 1200,
        outputTokens: 340,
        costUsd: 0.0123,
        durationMs: 5600,
      }),
    ).toBe(true);

    const { items, total } = store.listTurns({});
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'sess-1',
      workspaceJid: 'web:folder-a',
      channel: 'web',
      recallInjected: 1,
      recallHitCount: 3,
      recallLatencyMs: 421,
      inputText: '帮我回忆上次的项目决定',
      outputText: '根据记录……',
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0123,
      durationMs: 5600,
      judgeUsed: null,
    });

    expect(store.updateTurn('missing', { durationMs: 1 })).toBe(false);
  });

  test('insertTurn with an existing turnId is ignored (idempotent)', () => {
    store.insertTurn({ turnId: 't', channel: 'web' });
    store.insertTurn({ turnId: 't', channel: 'feishu' });
    const { items } = store.listTurns({});
    expect(items).toHaveLength(1);
    expect(items[0].channel).toBe('web');
  });

  test('listTurns filters by workspace, channel, recall, judge and paginates', () => {
    const base = {
      sessionId: 's',
      folder: 'f',
      interactionMode: 'assistant' as const,
    };
    store.insertTurn({
      turnId: 't1',
      ...base,
      workspaceJid: 'web:a',
      channel: 'web',
      autoRecallEnabled: 1,
    });
    store.insertTurn({
      turnId: 't2',
      ...base,
      workspaceJid: 'feishu:b',
      channel: 'feishu',
      autoRecallEnabled: 1,
    });
    store.insertTurn({
      turnId: 't3',
      ...base,
      workspaceJid: 'web:a',
      channel: 'web',
      autoRecallEnabled: 0,
    });
    store.updateTurn('t1', { recallInjected: 1, durationMs: 100 });
    store.updateTurn('t2', { recallInjected: 0, durationMs: 100 });
    store.updateTurn('t3', { durationMs: 100 });
    store.updateTurn('t1', { judgeUsed: 1, judgeReasoning: 'answer cites it' });

    expect(store.listTurns({ channel: 'web' }).total).toBe(2);
    expect(store.listTurns({ workspaceJid: 'feishu:b' }).total).toBe(1);
    expect(store.listTurns({ recallInjected: true }).total).toBe(1);
    expect(store.listTurns({ judge: 'judged' }).total).toBe(1);
    expect(store.listTurns({ judge: 'pending' }).total).toBe(2);
    expect(store.listTurns({}).total).toBe(3);
    // Pagination: newest first by default, limit/offset window.
    const page = store.listTurns({ limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  test('listPendingJudgeTurns returns only finished recall-injected turns without a verdict', () => {
    store.insertTurn({ turnId: 'done', channel: 'web' });
    store.updateTurn('done', { recallInjected: 1, durationMs: 10 });
    store.insertTurn({ turnId: 'running', channel: 'web' });
    store.updateTurn('running', { recallInjected: 1 });
    store.insertTurn({ turnId: 'no-recall', channel: 'web' });
    store.updateTurn('no-recall', { recallInjected: 0, durationMs: 10 });
    store.insertTurn({ turnId: 'judged', channel: 'web' });
    store.updateTurn('judged', { recallInjected: 1, durationMs: 10 });
    store.updateTurn('judged', { judgeUsed: 0 });

    const pending = store.listPendingJudgeTurns(10);
    expect(pending.map((turn) => turn.turnId)).toEqual(['done']);
  });

  test('turn rows store no content columns when metadata mode leaves them unset', () => {
    store.insertTurn({ turnId: 'meta', channel: 'web' });
    store.updateTurn('meta', {
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 2,
    });
    const { items } = store.listTurns({});
    expect(items[0].inputText).toBeNull();
    expect(items[0].outputText).toBeNull();
  });
});

// ── two-process safety (server writes obs_turns, script writes runs) ────────

describe('EvalStore concurrent connections', () => {
  test('two independent connections interleave writes without SQLITE_BUSY', () => {
    const dbPath = freshStorePath('concurrent');
    const serverSide = EvalStore.open(dbPath);
    const scriptSide = EvalStore.open(dbPath);
    try {
      for (let index = 0; index < 25; index += 1) {
        scriptSide.upsertRun({ id: `run-${index}`, name: `r${index}`, k: 5 }, [
          {
            queryId: 'q',
            category: 'verbatim',
            expected: ['m'],
            retrieved: ['m'],
            recall: 1,
            hit: 1,
            mrr: 1,
            precision: 1,
            latencyMs: index,
          },
        ]);
        serverSide.insertTurn({
          turnId: `turn-${index}`,
          channel: 'web',
          workspaceJid: 'web:f',
        });
        serverSide.updateTurn(`turn-${index}`, {
          durationMs: index,
          costUsd: 0.001,
        });
      }
      expect(scriptSide.listRuns()).toHaveLength(25);
      expect(serverSide.listTurns({}).total).toBe(25);
      // Each connection observes the other's committed rows.
      expect(scriptSide.listTurns({}).total).toBe(25);
      expect(serverSide.listRuns()).toHaveLength(25);
    } finally {
      serverSide.close();
      scriptSide.close();
    }
  });
});

// ── observability config ────────────────────────────────────────────────────

describe('observability config', () => {
  const configPath = path.join(tmpRoot, 'data', 'config', 'observability.json');

  function writeConfig(raw: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, raw);
  }

  beforeEach(() => {
    resetObservabilityConfigCache();
    fs.rmSync(configPath, { force: true });
    delete process.env.CKQCLAW_OBSERVABILITY_ENABLED;
    delete process.env.CKQCLAW_OBSERVABILITY_CONTENT_MODE;
    delete process.env.CKQCLAW_OBSERVABILITY_JUDGE_ENABLED;
  });

  afterEach(() => {
    resetObservabilityConfigCache();
    fs.rmSync(configPath, { force: true });
    delete process.env.CKQCLAW_OBSERVABILITY_ENABLED;
    delete process.env.CKQCLAW_OBSERVABILITY_CONTENT_MODE;
    delete process.env.CKQCLAW_OBSERVABILITY_JUDGE_ENABLED;
  });

  test('missing file means the whole pipeline is off', () => {
    const config = getObservabilityConfig();
    expect(config.enabled).toBe(false);
    expect(config.judge.enabled).toBe(false);
  });

  test('file enables full mode with judge switch', () => {
    writeConfig(
      JSON.stringify({
        enabled: true,
        contentMode: 'full',
        judge: { enabled: true },
      }),
    );
    const config = getObservabilityConfig();
    expect(config.enabled).toBe(true);
    expect(config.contentMode).toBe('full');
    expect(config.judge.enabled).toBe(true);
  });

  test('metadata mode is selectable and judge defaults to off', () => {
    writeConfig(JSON.stringify({ enabled: true, contentMode: 'metadata' }));
    const config = getObservabilityConfig();
    expect(config.contentMode).toBe('metadata');
    expect(config.judge.enabled).toBe(false);
  });

  test('invalid values fall back to safe defaults without throwing', () => {
    writeConfig(
      JSON.stringify({ enabled: 'yes', contentMode: 'everything', judge: 1 }),
    );
    const config = getObservabilityConfig();
    expect(config.enabled).toBe(false);
    expect(config.contentMode).toBe('metadata');
    expect(config.judge.enabled).toBe(false);
  });

  test('env overrides win over the file channel', () => {
    writeConfig(JSON.stringify({ enabled: false }));
    process.env.CKQCLAW_OBSERVABILITY_ENABLED = 'true';
    process.env.CKQCLAW_OBSERVABILITY_CONTENT_MODE = 'full';
    process.env.CKQCLAW_OBSERVABILITY_JUDGE_ENABLED = 'true';
    const config = getObservabilityConfig();
    expect(config.enabled).toBe(true);
    expect(config.contentMode).toBe('full');
    expect(config.judge.enabled).toBe(true);
  });
});
