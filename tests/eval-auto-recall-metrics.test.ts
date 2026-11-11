/**
 * Pins the pure evaluation logic of the auto-recall harness
 * (scripts/eval-auto-recall.ts, task Z follow-up 3).
 *
 * The harness drives the REAL sidecar over the REAL embedder (manual, costs
 * money — npm run eval:auto-recall), so everything deterministic — the fixed
 * metric definitions, the 500-char query truncation contract mirrored from
 * the runner, marker keyword mapping, and golden-set integrity rules — is
 * unit-tested here against the shipped fixture.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  aggregateRows,
  basicAuthHeader,
  boundedQuery,
  createLangfuseClient,
  datasetItemPayload,
  evalStoreRunPayload,
  hitRateAtK,
  mapTextToMarkers,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  resolveLangfuseConfig,
  scorePayloads,
  validateGoldenSet,
  type GoldenSet,
  type QueryResultRow,
} from '../scripts/eval-auto-recall.js';

describe('metric definitions (fixed top-k contract)', () => {
  test('recall@k measures coverage of the expected markers', () => {
    expect(recallAtK(['M1', 'M2'], ['M1', 'M2', 'X'])).toBe(1);
    expect(recallAtK(['M1', 'M2'], ['M1'])).toBe(0.5);
    expect(recallAtK(['M1'], ['M2', 'M3'])).toBe(0);
    // Duplicate retrievals never inflate recall.
    expect(recallAtK(['M1'], ['M1', 'M1'])).toBe(1);
    expect(recallAtK([], ['M1'])).toBe(0);
  });

  test('hit-rate and reciprocal rank', () => {
    expect(hitRateAtK(['M1'], ['M2'])).toBe(0);
    expect(hitRateAtK(['M1'], ['M2', 'M1'])).toBe(1);
    expect(reciprocalRank(['M1'], ['M1'])).toBe(1);
    expect(reciprocalRank(['M2'], ['M1', 'M2'])).toBe(0.5);
    expect(reciprocalRank(['M1', 'M2'], ['X', 'M2', 'M1'])).toBe(0.5);
    expect(reciprocalRank(['M1'], ['X'])).toBe(0);
  });

  test('precision@k penalizes noise retrievals', () => {
    expect(precisionAtK(['M1'], ['M1'])).toBe(1);
    expect(precisionAtK(['M1'], ['M1', 'M2'])).toBe(0.5);
    expect(precisionAtK(['M1'], [])).toBe(0);
  });
});

describe('boundedQuery mirrors the runner turn contract', () => {
  test('trim first, then slice to the IPC limit', () => {
    expect(boundedQuery('  你好  ')).toBe('你好');
    expect(boundedQuery('a'.repeat(800), 500)).toHaveLength(500);
    // The runner trims BEFORE slicing — trailing whitespace never eats budget.
    expect(boundedQuery(`${'a'.repeat(499)}   `, 500)).toBe('a'.repeat(499));
  });
});

describe('marker keyword mapping', () => {
  const items = [
    {
      marker: 'M01',
      content: '用户主要用 Spring Boot 做 Java 后端开发',
      keys: ['Spring Boot'],
    },
    {
      marker: 'M04',
      content: '用户养了两只猫，叫糯米和芝麻',
      keys: ['糯米', '芝麻'],
    },
  ];

  test('any key hit maps the text to its marker', () => {
    expect(mapTextToMarkers('用户提到过 Spring Boot 技术栈', items)).toEqual([
      'M01',
    ]);
    expect(mapTextToMarkers('芝麻是一只黑猫', items)).toEqual(['M04']);
    expect(mapTextToMarkers('今天天气不错', items)).toEqual([]);
  });

  test('one marker is returned once even when several of its keys match', () => {
    expect(mapTextToMarkers('糯米和芝麻都是猫', items)).toEqual(['M04']);
  });
});

describe('golden set integrity (shipped fixture + rules)', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.resolve('scripts/eval/auto-recall-golden.json'),
      'utf8',
    ),
  ) as GoldenSet;

  test('the shipped fixture passes every integrity rule', () => {
    expect(validateGoldenSet(fixture)).toEqual([]);
  });

  test('fixture shape is substantial: categories covered, truncation > 500 chars', () => {
    const categories = new Set(fixture.queries.map((q) => q.category));
    for (const required of ['verbatim', 'paraphrase', 'multi', 'truncation']) {
      expect(categories, `missing category ${required}`).toContain(required);
    }
    const truncating = fixture.queries.filter(
      (q) => q.category === 'truncation',
    );
    expect(truncating.length).toBeGreaterThanOrEqual(2);
    for (const query of truncating) {
      expect(query.text.length).toBeGreaterThan(500);
    }
    // Enough memories to make top-5 discrimination meaningful.
    expect(fixture.seed.length).toBeGreaterThanOrEqual(15);
  });

  test('duplicate markers are rejected', () => {
    const issues = validateGoldenSet({
      seed: [
        { marker: 'M1', content: 'a', keys: ['k1'] },
        { marker: 'M1', content: 'b', keys: ['k2'] },
      ],
      queries: [
        { id: 'Q1', category: 'verbatim', text: 't', expected: ['M1'] },
      ],
    });
    expect(issues.join('\n')).toMatch(/duplicate marker/i);
  });

  test('a key that leaks into another item content is rejected', () => {
    const issues = validateGoldenSet({
      seed: [
        { marker: 'M1', content: '用户的项目叫 Atlas', keys: ['Atlas'] },
        { marker: 'M2', content: '用户在用 Atlas 重写索引', keys: ['重写'] },
      ],
      queries: [
        { id: 'Q1', category: 'verbatim', text: 't', expected: ['M1'] },
      ],
    });
    expect(issues.join('\n')).toMatch(/M2.*Atlas|Atlas.*M2/);
  });

  test('unknown expected marker and missing keys are rejected', () => {
    const issues = validateGoldenSet({
      seed: [{ marker: 'M1', content: 'a', keys: [] }],
      queries: [
        { id: 'Q1', category: 'verbatim', text: 't', expected: ['M9'] },
      ],
    });
    const joined = issues.join('\n');
    expect(joined).toMatch(/M1.*keys/);
    expect(joined).toMatch(/Q1.*M9|M9.*Q1/);
  });

  test('truncation queries must actually exceed the 500-char cut', () => {
    const issues = validateGoldenSet({
      seed: [{ marker: 'M1', content: 'a', keys: ['k'] }],
      queries: [
        { id: 'Q1', category: 'truncation', text: 'short', expected: ['M1'] },
      ],
    });
    expect(issues.join('\n')).toMatch(/Q1.*500|500.*Q1/);
  });
});

describe('aggregation', () => {
  test('per-category and overall averages', () => {
    const rows = [
      {
        id: 'Q1',
        category: 'verbatim',
        expected: ['M1'],
        retrieved: ['M1'],
        recall: 1,
        hit: 1,
        rr: 1,
        precision: 1,
        latencyMs: 10,
      },
      {
        id: 'Q2',
        category: 'paraphrase',
        expected: ['M2'],
        retrieved: [],
        recall: 0,
        hit: 0,
        rr: 0,
        precision: 0,
        latencyMs: 10,
      },
      {
        id: 'Q3',
        category: 'verbatim',
        expected: ['M3'],
        retrieved: ['M3', 'M9'],
        recall: 1,
        hit: 1,
        rr: 1,
        precision: 0.5,
        latencyMs: 10,
      },
    ];
    const report = aggregateRows(rows);
    expect(report.perCategory.verbatim).toMatchObject({
      n: 2,
      recall: 1,
      hitRate: 1,
      mrr: 1,
      precision: 0.75,
    });
    expect(report.perCategory.paraphrase).toMatchObject({
      n: 1,
      recall: 0,
      hitRate: 0,
    });
    expect(report.overall).toMatchObject({
      n: 3,
      recall: 2 / 3,
      hitRate: 2 / 3,
    });
  });
});

describe('langfuse integration (zero-dep REST client)', () => {
  test('basic auth header encodes pk:sk', () => {
    expect(basicAuthHeader('pk-lf', 'sk-lf')).toBe(
      `Basic ${Buffer.from('pk-lf:sk-lf').toString('base64')}`,
    );
  });

  test('config resolution: env wins, file is the fallback, partial is rejected', () => {
    const fileReader = (path: string) =>
      path.endsWith('eval-langfuse.json')
        ? JSON.stringify({
            url: 'http://file:3000',
            publicKey: 'pk-file',
            secretKey: 'sk-file',
          })
        : null;
    expect(
      resolveLangfuseConfig(
        {
          CKQCLAW_EVAL_LANGFUSE_URL: 'http://env:3000',
          CKQCLAW_EVAL_LANGFUSE_PUBLIC_KEY: 'pk-env',
          CKQCLAW_EVAL_LANGFUSE_SECRET_KEY: 'sk-env',
        },
        fileReader,
      ),
    ).toEqual({
      url: 'http://env:3000',
      publicKey: 'pk-env',
      secretKey: 'sk-env',
      source: 'env',
    });
    expect(resolveLangfuseConfig({}, fileReader)).toEqual({
      url: 'http://file:3000',
      publicKey: 'pk-file',
      secretKey: 'sk-file',
      source: 'file',
    });
    // An incomplete env channel is ignored entirely — file takes over.
    expect(
      resolveLangfuseConfig(
        { CKQCLAW_EVAL_LANGFUSE_URL: 'http://env:3000' },
        fileReader,
      ),
    ).toMatchObject({ url: 'http://file:3000', source: 'file' });
    expect(resolveLangfuseConfig({}, () => null)).toBeNull();
  });

  test('a golden query maps to a dataset item with a stable id', () => {
    const payload = datasetItemPayload(
      {
        id: 'Q01',
        category: 'verbatim',
        text: 'query text',
        expected: ['M01'],
        note: 'n',
      },
      'ckqclaw-auto-recall',
    );
    expect(payload).toEqual({
      id: 'ckqclaw-auto-recall-Q01',
      datasetName: 'ckqclaw-auto-recall',
      input: { query: 'query text', category: 'verbatim' },
      expectedOutput: { expectedMarkers: ['M01'] },
      metadata: { queryId: 'Q01', category: 'verbatim', note: 'n' },
    });
  });

  test('a result row expands into linked metric scores', () => {
    const row: QueryResultRow = {
      id: 'Q01',
      category: 'verbatim',
      expected: ['M01'],
      retrieved: ['M01'],
      recall: 1,
      hit: 1,
      rr: 0.5,
      precision: 0.5,
      latencyMs: 812,
      boundedQueryChars: 42,
    };
    const scores = scorePayloads(row, 'run-x', 'trace-x');
    expect(scores).toHaveLength(4);
    for (const score of scores) {
      expect(score).toMatchObject({
        traceId: 'trace-x',
        datasetRunId: 'run-x',
      });
    }
    expect(scores.map((s) => `${s.name}:${s.value}:${s.dataType}`)).toEqual([
      'recall:1:NUMERIC',
      'hit:1:BOOLEAN',
      'mrr:0.5:NUMERIC',
      'precision:0.5:NUMERIC',
    ]);
    // The comment carries expected-vs-retrieved for at-a-glance debugging.
    expect(scores[0].comment).toContain('expected=[M01]');
    expect(scores[0].comment).toContain('retrieved=[M01]');
  });

  interface CapturedRequest {
    url: string;
    init: RequestInit;
  }

  function fakeFetch(status: number, body: unknown) {
    const calls: CapturedRequest[] = [];
    const impl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { impl, calls };
  }

  const CONFIG = {
    url: 'http://lf:3000',
    publicKey: 'pk-test',
    secretKey: 'sk-test',
    source: 'env' as const,
  };

  test('client sends authorized JSON on every write path', async () => {
    const { impl, calls } = fakeFetch(200, {});
    const client = createLangfuseClient({ config: CONFIG, fetchImpl: impl });

    await client.upsertDatasetItem(
      datasetItemPayload(
        {
          id: 'Q01',
          category: 'verbatim',
          text: 't',
          expected: ['M01'],
        },
        'ckqclaw-auto-recall',
      ),
    );
    await client.ingestTrace({ id: 'tr1', name: 'Q01', metadata: { k: 1 } });
    await client.createDatasetRunItem({
      runName: 'run-x',
      datasetItemId: 'item-1',
      traceId: 'tr1',
    });
    await client.postScores([
      {
        traceId: 'tr1',
        name: 'recall',
        value: 1,
        dataType: 'NUMERIC',
        comment: '',
        datasetRunId: 'run-x',
      },
    ]);

    expect(calls.map((c) => c.url)).toEqual([
      'http://lf:3000/api/public/dataset-items',
      'http://lf:3000/api/public/ingestion',
      'http://lf:3000/api/public/dataset-run-items',
      'http://lf:3000/api/public/scores',
    ]);
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({
        authorization: basicAuthHeader('pk-test', 'sk-test'),
        'content-type': 'application/json',
      });
    }
    const ingest = JSON.parse(String(calls[1].init.body));
    expect(ingest.batch[0]).toMatchObject({ type: 'trace-create' });
    expect(ingest.batch[0].body).toMatchObject({ id: 'tr1', name: 'Q01' });
    const runItem = JSON.parse(String(calls[2].init.body));
    expect(runItem).toEqual({
      runName: 'run-x',
      datasetItemId: 'item-1',
      traceId: 'tr1',
    });
    const scores = JSON.parse(String(calls[3].init.body));
    // v4 contract: a bare array of score bodies.
    expect(Array.isArray(scores)).toBe(true);
    expect(scores).toHaveLength(1);
  });

  test('207 partial success is accepted; errors never echo the secret key', async () => {
    const ok = createLangfuseClient({
      config: CONFIG,
      fetchImpl: async () =>
        new Response('{"errors":[]}', {
          status: 207,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(
      ok.postScores([
        {
          traceId: 't',
          name: 'recall',
          value: 1,
          dataType: 'NUMERIC',
          comment: '',
        },
      ]),
    ).resolves.toBeUndefined();

    const failing = createLangfuseClient({
      config: CONFIG,
      fetchImpl: async () =>
        new Response('boom sk-test leaked', { status: 401 }),
    });
    await expect(
      failing.postScores([
        {
          traceId: 't',
          name: 'recall',
          value: 1,
          dataType: 'NUMERIC',
          comment: '',
        },
      ]),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('native eval.db payload (task AB default landing zone)', () => {
  const rows: QueryResultRow[] = [
    {
      id: 'q1',
      category: 'verbatim',
      expected: ['m1'],
      retrieved: ['m1', 'm2'],
      recall: 1,
      hit: 1,
      rr: 1,
      precision: 0.5,
      latencyMs: 120,
      boundedQueryChars: 40,
      note: 'first',
    },
    {
      id: 'q2',
      category: 'paraphrase',
      expected: ['m2'],
      retrieved: [],
      recall: 0,
      hit: 0,
      rr: 0,
      precision: 0,
      latencyMs: 240,
      boundedQueryChars: 33,
    },
  ];

  test('maps replay rows into the EvalStore upsert shape', () => {
    const aggregate = aggregateRows(rows);
    const payload = evalStoreRunPayload('run-x', 5, rows, aggregate, {
      source: 'env',
    });
    expect(payload.run).toEqual({
      id: 'run-x',
      name: 'run-x',
      kind: 'recall',
      k: 5,
      configJson: { source: 'env' },
      summary: aggregate,
    });
    expect(payload.items).toHaveLength(2);
    // rr column lands as mrr; note only present when set.
    expect(payload.items[0]).toEqual({
      queryId: 'q1',
      category: 'verbatim',
      expected: ['m1'],
      retrieved: ['m1', 'm2'],
      recall: 1,
      hit: 1,
      mrr: 1,
      precision: 0.5,
      latencyMs: 120,
      note: 'first',
    });
    expect(payload.items[1].note).toBeUndefined();
    expect(payload.items[1].mrr).toBe(0);
  });
});
