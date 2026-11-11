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
  test('creates the base tables and stamps the current user_version', () => {
    const dbPath = freshStorePath('schema');
    const store = EvalStore.open(dbPath);
    try {
      const raw = new Database(dbPath, { readonly: true });
      try {
        const version = raw.prepare('PRAGMA user_version').get() as {
          user_version: number;
        };
        expect(version.user_version).toBe(3);
        const tables = (
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toEqual(
          expect.arrayContaining([
            'eval_runs',
            'eval_run_items',
            'obs_turns',
            'eval_datasets',
            'harness_proposals',
            'harness_versions',
            'harness_lessons',
          ]),
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
    raw.exec('PRAGMA user_version = 4');
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

// ── eval_datasets (task AD: managed golden sets, v2) ────────────────────────

describe('EvalStore datasets', () => {
  test('migration seeds the builtin auto-recall set from the shipped JSON', () => {
    const store = EvalStore.open(freshStorePath('ds-seed'));
    try {
      const list = store.listDatasets();
      const builtin = list.find((item) => item.name === 'auto-recall');
      expect(builtin).toMatchObject({ source: 'builtin' });
      expect(builtin!.seedCount).toBeGreaterThan(0);
      expect(builtin!.queryCount).toBeGreaterThan(0);
      // List projection never carries the data payload.
      expect(
        (builtin as unknown as Record<string, unknown>).data,
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('re-seeding on reopen is idempotent (one builtin row)', () => {
    const dbPath = freshStorePath('ds-idempotent');
    const first = EvalStore.open(dbPath);
    first.close();
    const second = EvalStore.open(dbPath);
    try {
      expect(
        second.listDatasets().filter((item) => item.name === 'auto-recall'),
      ).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  test('upsert + get round-trip a manual set', () => {
    const store = EvalStore.open(freshStorePath('ds-crud'));
    try {
      const data = {
        seed: [
          {
            marker: 'M1',
            content: '记忆一，含独特关键词 alpha。',
            keys: ['alpha'],
          },
        ],
        queries: [
          {
            id: 'q1',
            category: 'verbatim' as const,
            text: 'alpha 是什么',
            expected: ['M1'],
          },
          {
            id: 'q2',
            category: 'paraphrase' as const,
            text: '换个说法问 alpha',
            expected: ['M1'],
          },
          {
            id: 'q3',
            category: 'multi' as const,
            text: 'multi query',
            expected: ['M1'],
          },
          {
            id: 'q4',
            category: 'truncation' as const,
            text: `${'长'.repeat(600)}alpha`,
            expected: ['M1'],
          },
        ],
      };
      store.upsertDataset({
        name: 'my-set',
        description: '手写集',
        data,
        source: 'manual',
      });
      const loaded = store.getDataset('my-set');
      expect(loaded).toMatchObject({
        name: 'my-set',
        description: '手写集',
        source: 'manual',
      });
      expect(loaded!.data).toEqual(data);
      expect(loaded!.data.queries).toHaveLength(4);
      // Upsert with same name replaces the payload and bumps updated_at.
      const revised = {
        ...data,
        description: undefined,
        queries: data.queries.slice(0, 1),
      };
      store.upsertDataset({
        name: 'my-set',
        data: { seed: data.seed, queries: revised.queries },
        source: 'manual',
      });
      expect(store.getDataset('my-set')!.data.queries).toHaveLength(1);
      expect(store.getDataset('missing')).toBeNull();
    } finally {
      store.close();
    }
  });

  test('deleteDataset distinguishes builtin / not_found / deleted', () => {
    const store = EvalStore.open(freshStorePath('ds-del'));
    try {
      expect(store.deleteDataset('auto-recall')).toBe('builtin');
      expect(store.deleteDataset('missing')).toBe('not_found');
      store.upsertDataset({
        name: 'temp',
        data: {
          seed: [{ marker: 'M1', content: 'c alpha', keys: ['alpha'] }],
          queries: [
            { id: 'q1', category: 'verbatim', text: 'q', expected: ['M1'] },
            { id: 'q2', category: 'paraphrase', text: 'q', expected: ['M1'] },
            { id: 'q3', category: 'multi', text: 'q', expected: ['M1'] },
            {
              id: 'q4',
              category: 'truncation',
              text: 'x'.repeat(501),
              expected: ['M1'],
            },
          ],
        },
        source: 'manual',
      });
      expect(store.deleteDataset('temp')).toBe('deleted');
      expect(store.getDataset('temp')).toBeNull();
    } finally {
      store.close();
    }
  });
});

// ── Harness adapter tables (v3, task AE) ────────────────────────────────────

describe('EvalStore harness (v3)', () => {
  function sampleProposal(
    overrides: Partial<{
      id: string;
      workspaceJid: string;
      adapterMd: string;
      keepBase: boolean;
    }> = {},
  ) {
    return {
      id: overrides.id ?? 'hp_test1',
      workspaceJid: overrides.workspaceJid ?? 'ws-a@g.us',
      adapterMd:
        overrides.adapterMd ?? '# Adapter\n\n回答财务类问题前先确认币种。',
      keepBase: overrides.keepBase ?? false,
      diff: '@@ -1 +1 @@\n-base\n+new',
      rationale: '三个财务 turn 都漏了币种确认，属于重复出现的一致失败。',
      evidence: [
        {
          turnId: 't1',
          inputExcerpt: '帮我算一下报销总额',
          outputExcerpt: '总额 1200 元',
          why: '未确认币种，两 turn 分歧',
        },
      ],
      baselineVersion: 0,
      model: 'glm-flash',
      promptHash: 'abc123',
    };
  }

  test('fresh open lands on user_version 3 with all three harness tables', () => {
    const store = EvalStore.open(freshStorePath('hv-fresh'));
    try {
      const version = (
        (store as unknown as { db: Database.Database }).db
          .prepare('PRAGMA user_version')
          .get() as { user_version: number }
      ).user_version;
      expect(version).toBe(3);
      const tables = (
        (store as unknown as { db: Database.Database }).db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'harness_%'",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables.sort()).toEqual([
        'harness_lessons',
        'harness_proposals',
        'harness_versions',
      ]);
    } finally {
      store.close();
    }
  });

  test('refuses a future v4 database (forward-only contract)', () => {
    const dbPath = freshStorePath('hv-v4');
    const raw = new Database(dbPath);
    raw.exec('PRAGMA user_version = 4');
    raw.close();
    expect(() => EvalStore.open(dbPath)).toThrow(/refusing downgrade/i);
  });

  test('insert + list + get round-trips a proposal; list omits the body', () => {
    const store = EvalStore.open(freshStorePath('hv-crud'));
    try {
      store.insertHarnessProposal(sampleProposal());
      const list = store.listHarnessProposals('ws-a@g.us');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'hp_test1',
        status: 'pending',
        keepBase: false,
        evidenceCount: 1,
      });
      expect(
        (list[0] as unknown as Record<string, unknown>).adapterMd,
      ).toBeUndefined();
      const detail = store.getHarnessProposal('hp_test1');
      expect(detail).toMatchObject({ id: 'hp_test1', status: 'pending' });
      expect(detail!.adapterMd).toContain('币种');
      expect(detail!.evidence[0].turnId).toBe('t1');
    } finally {
      store.close();
    }
  });

  test('list filters by workspace and orders newest first', () => {
    const store = EvalStore.open(freshStorePath('hv-list'));
    try {
      store.insertHarnessProposal(
        sampleProposal({
          id: 'hp_a1',
          workspaceJid: 'ws-a@g.us',
        }),
      );
      store.insertHarnessProposal(
        sampleProposal({
          id: 'hp_b1',
          workspaceJid: 'ws-b@g.us',
        }),
      );
      store.insertHarnessProposal(
        sampleProposal({
          id: 'hp_a2',
          workspaceJid: 'ws-a@g.us',
        }),
      );
      const listA = store.listHarnessProposals('ws-a@g.us');
      expect(listA.map((item) => item.id)).toEqual(['hp_a2', 'hp_a1']);
      expect(store.listHarnessProposals('ws-c@g.us')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test('proposal state machine: only pending can be decided, once', () => {
    const store = EvalStore.open(freshStorePath('hv-state'));
    try {
      store.insertHarnessProposal(sampleProposal({ id: 'hp_s1' }));
      store.insertHarnessProposal(sampleProposal({ id: 'hp_s2' }));
      store.insertHarnessProposal(
        sampleProposal({ id: 'hp_s3', keepBase: true, adapterMd: '' }),
      );
      expect(
        store.decideHarnessProposal('hp_missing', {
          status: 'adopted',
          decidedBy: 'admin',
        }),
      ).toBe('not_found');
      expect(
        store.decideHarnessProposal('hp_s1', {
          status: 'adopted',
          decidedBy: 'admin',
        }),
      ).toBe('ok');
      const adopted = store.getHarnessProposal('hp_s1');
      expect(adopted).toMatchObject({
        status: 'adopted',
        decidedBy: 'admin',
      });
      expect(adopted!.decidedAt).toBeTruthy();
      // Second decision on the same proposal is rejected.
      expect(
        store.decideHarnessProposal('hp_s1', {
          status: 'rejected',
          decidedBy: 'admin',
        }),
      ).toBe('invalid_transition');
      // invalid proposals are terminal.
      store.insertHarnessProposal(sampleProposal({ id: 'hp_s9' }));
      (store as unknown as { db: Database.Database }).db
        .prepare(
          "UPDATE harness_proposals SET status='invalid' WHERE id='hp_s9'",
        )
        .run();
      expect(
        store.decideHarnessProposal('hp_s9', {
          status: 'adopted',
          decidedBy: 'admin',
        }),
      ).toBe('invalid_transition');
    } finally {
      store.close();
    }
  });

  test('versions increment per workspace, unique, active = max', () => {
    const store = EvalStore.open(freshStorePath('hv-versions'));
    try {
      const v1 = store.insertHarnessVersion({
        workspaceJid: 'ws-a@g.us',
        proposalId: 'hp_v1',
        adapterMd: '# v1',
        adoptedBy: 'admin',
      });
      expect(v1.version).toBe(1);
      const v2Other = store.insertHarnessVersion({
        workspaceJid: 'ws-b@g.us',
        proposalId: null,
        adapterMd: '# other ws',
        adoptedBy: 'admin',
      });
      expect(v2Other.version).toBe(1);
      const v2 = store.insertHarnessVersion({
        workspaceJid: 'ws-a@g.us',
        proposalId: 'hp_v2',
        adapterMd: '# v2',
        adoptedBy: 'admin',
      });
      expect(v2.version).toBe(2);
      const active = store.getActiveHarnessVersion('ws-a@g.us');
      expect(active).toMatchObject({ version: 2, adapterMd: '# v2' });
      expect(store.getActiveHarnessVersion('ws-none@g.us')).toBeNull();
      const list = store.listHarnessVersions('ws-a@g.us');
      expect(list.map((item) => item.version)).toEqual([2, 1]);
    } finally {
      store.close();
    }
  });

  test('lessons round-trip and filter by workspace', () => {
    const store = EvalStore.open(freshStorePath('hv-lessons'));
    try {
      store.insertHarnessLesson({
        id: 'hl_1',
        workspaceJid: 'ws-a@g.us',
        cue: '财务类问题且涉及金额',
        lesson: '在 system 指令中要求先确认币种（ADAPTER.md）',
        evidence: 'hp_x: 3 个 turn 漏币种确认',
        confidence: 'medium',
        proposalId: 'hp_x',
      });
      store.insertHarnessLesson({
        id: 'hl_2',
        workspaceJid: 'ws-b@g.us',
        cue: 'cue b',
        lesson: 'lesson b',
        evidence: 'ev b',
        confidence: null,
        proposalId: null,
      });
      const list = store.listHarnessLessons('ws-a@g.us');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'hl_1',
        cue: '财务类问题且涉及金额',
      });
    } finally {
      store.close();
    }
  });
});
