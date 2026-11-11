import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-routes-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: path.join(tmpRoot, 'data'),
  STORE_DIR: path.join(tmpRoot, 'data', 'db'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Task AC: swap the trigger state machine for a controllable fake so the
// route tests pin ACL/validation/without spawning a real eval process.
const triggerState = {
  startResult: { ok: true } as { ok: true } | { ok: false; error: 'busy' },
  startCalls: [] as Array<Record<string, unknown>>,
};
vi.mock('../src/eval-trigger.js', () => ({
  startEvalRun: (input: Record<string, unknown>) => {
    triggerState.startCalls.push(input);
    return triggerState.startResult;
  },
  getEvalTriggerState: () => ({
    running: false,
    startedAt: 1_736_300_000_000,
    startedBy: 'user-admin',
    lines: ['golden set: 20 memories / 17 queries (k=5)'],
    result: null,
  }),
}));

// Same split as auto-memory-routes.test.ts: swap session auth for a header so
// 401 and permission paths exercise the genuine middleware gates. The real
// systemConfigMiddleware runs on the injected user (member lacks
// manage_system_config, admin carries it).
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      const userId = c.req.header('x-test-user');
      if (!userId) return c.json({ error: 'Unauthorized' }, 401);
      const isAdmin = userId === 'user-admin';
      c.set('user', {
        id: userId,
        username: userId,
        role: isAdmin ? 'admin' : 'member',
        permissions: isAdmin ? ['manage_system_config'] : [],
      });
      return next();
    },
  };
});

const { closeDefaultEvalStore, getDefaultEvalStore } =
  await import('../src/eval-store.js');
const evalRoutes = (await import('../src/routes/eval.js')).default;

const ADMIN = { 'x-test-user': 'user-admin' } as Record<string, string>;
const MEMBER = { 'x-test-user': 'user-member' } as Record<string, string>;

function seedRun(id: string, name: string, k: number): void {
  getDefaultEvalStore().upsertRun({ id, name, kind: 'recall', k }, [
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
}

beforeEach(() => {
  seedRun('run-a', 'alpha', 5);
  seedRun('run-b', 'beta', 10);
});

afterEach(() => {
  closeDefaultEvalStore();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /runs', () => {
  test('unauthenticated callers get 401', async () => {
    const res = await evalRoutes.request('/runs');
    expect(res.status).toBe(401);
  });

  test('any logged-in user can list runs (newest first)', async () => {
    const res = await evalRoutes.request('/runs', { headers: MEMBER });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.runs.map((run: { id: string }) => run.id);
    expect(ids).toContain('run-a');
    expect(ids).toContain('run-b');
    // Shape: id/name/kind/k + summary projection, no per-item payload here.
    const first = body.runs.find((run: { id: string }) => run.id === 'run-a');
    expect(first).toMatchObject({ name: 'alpha', kind: 'recall', k: 5 });
  });
});

describe('GET /runs/:id', () => {
  test('returns run with items for logged-in users', async () => {
    const res = await evalRoutes.request('/runs/run-a', { headers: MEMBER });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run.id).toBe('run-a');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      queryId: 'q1',
      category: 'verbatim',
      expected: ['m1'],
      retrieved: ['m1'],
      recall: 1,
    });
  });

  test('unknown run id is 404', async () => {
    const res = await evalRoutes.request('/runs/missing', { headers: MEMBER });
    expect(res.status).toBe(404);
  });

  test('unauthenticated callers get 401', async () => {
    const res = await evalRoutes.request('/runs/run-a');
    expect(res.status).toBe(401);
  });
});

describe('GET /comparison', () => {
  test('places requested runs side by side; unknown ids stay null', async () => {
    const res = await evalRoutes.request('/comparison?ids=run-a,run-b,nope', {
      headers: MEMBER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comparison).toHaveLength(3);
    expect(body.comparison[0]).toMatchObject({
      id: 'run-a',
      itemCount: 1,
      recall: 1,
    });
    expect(body.comparison[1]).toMatchObject({ id: 'run-b', k: 10 });
    expect(body.comparison[2]).toBeNull();
  });

  test('missing ids query is 400', async () => {
    const res = await evalRoutes.request('/comparison', { headers: MEMBER });
    expect(res.status).toBe(400);
  });

  test('unauthenticated callers get 401', async () => {
    const res = await evalRoutes.request('/comparison?ids=run-a');
    expect(res.status).toBe(401);
  });
});

describe('GET /turns (admin only)', () => {
  beforeEach(() => {
    const store = getDefaultEvalStore();
    store.insertTurn({
      turnId: 't1',
      workspaceJid: 'web:ws-a',
      channel: 'web',
      autoRecallEnabled: 1,
    });
    store.updateTurn('t1', { recallInjected: 1, durationMs: 800 });
    store.insertTurn({
      turnId: 't2',
      workspaceJid: 'feishu:group-b',
      channel: 'feishu',
    });
    store.updateTurn('t2', { durationMs: 500 });
  });

  test('unauthenticated callers get 401', async () => {
    const res = await evalRoutes.request('/turns');
    expect(res.status).toBe(401);
  });

  test('members without manage_system_config get 403', async () => {
    const res = await evalRoutes.request('/turns', { headers: MEMBER });
    expect(res.status).toBe(403);
  });

  test('admin lists turns with filters and pagination shape', async () => {
    const res = await evalRoutes.request('/turns?channel=web', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      turnId: 't1',
      channel: 'web',
      recallInjected: 1,
    });
    const all = await evalRoutes.request('/turns?limit=1', { headers: ADMIN });
    const allBody = await all.json();
    expect(allBody.total).toBe(2);
    expect(allBody.items).toHaveLength(1);
  });

  test('workspace and judge filters compose', async () => {
    const store = getDefaultEvalStore();
    store.updateTurn('t1', { judgeUsed: 1, judgeReasoning: 'cited' });
    const judged = await evalRoutes.request(
      '/turns?workspaceJid=web:ws-a&judge=judged',
      { headers: ADMIN },
    );
    const judgedBody = await judged.json();
    expect(judgedBody.total).toBe(1);
    expect(judgedBody.items[0].judgeReasoning).toBe('cited');

    const pending = await evalRoutes.request('/turns?judge=pending', {
      headers: ADMIN,
    });
    const pendingBody = await pending.json();
    expect(pendingBody.total).toBe(1);
    expect(pendingBody.items[0].turnId).toBe('t2');
  });
});

describe('POST /runs/trigger + GET /runs/trigger/status (task AC)', () => {
  beforeEach(() => {
    triggerState.startCalls.length = 0;
    triggerState.startResult = { ok: true };
  });

  test('unauthenticated callers get 401', async () => {
    const res = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      body: JSON.stringify({ k: 5, runName: 'r' }),
    });
    expect(res.status).toBe(401);
  });

  test('members without manage_system_config get 403', async () => {
    const res = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      headers: MEMBER,
      body: JSON.stringify({ k: 5, runName: 'r' }),
    });
    expect(res.status).toBe(403);
    const status = await evalRoutes.request('/runs/trigger/status', {
      headers: MEMBER,
    });
    expect(status.status).toBe(403);
  });

  test('invalid parameters are rejected with 400', async () => {
    for (const body of [
      { k: 11, runName: 'r' },
      { k: 0, runName: 'r' },
      { k: 2.5, runName: 'r' },
      { k: 5, runName: 'bad name!' },
      { k: 5, runName: 'x'.repeat(65) },
      { runName: 'r' },
      {},
    ]) {
      const res = await evalRoutes.request('/runs/trigger', {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(triggerState.startCalls).toHaveLength(0);
  });

  test('admin trigger returns 202 and passes whitelist inputs', async () => {
    const res = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ k: 10, runName: 'k10-check', reset: true }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(triggerState.startCalls).toHaveLength(1);
    expect(triggerState.startCalls[0]).toMatchObject({
      k: 10,
      runName: 'k10-check',
      reset: true,
      startedBy: 'user-admin',
    });
  });

  test('a busy trigger maps to 409', async () => {
    triggerState.startResult = { ok: false, error: 'busy' };
    const res = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ k: 5, runName: 'r' }),
    });
    expect(res.status).toBe(409);
  });

  test('status endpoint exposes the trigger snapshot to admins', async () => {
    const res = await evalRoutes.request('/runs/trigger/status', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      running: false,
      startedBy: 'user-admin',
      lines: ['golden set: 20 memories / 17 queries (k=5)'],
      result: null,
    });
  });
});

// ── Managed datasets (task AD) ──────────────────────────────────────────────

const VALID_DATA = {
  seed: [
    {
      marker: 'M1',
      content: '记忆内容，含独特关键词 alpha。',
      keys: ['alpha'],
    },
  ],
  queries: [
    { id: 'q1', category: 'verbatim', text: 'alpha 是什么', expected: ['M1'] },
    {
      id: 'q2',
      category: 'paraphrase',
      text: '换个说法问 alpha',
      expected: ['M1'],
    },
    { id: 'q3', category: 'multi', text: '综合问题 alpha', expected: ['M1'] },
    {
      id: 'q4',
      category: 'truncation',
      text: `${'长'.repeat(600)}alpha`,
      expected: ['M1'],
    },
  ],
};

describe('dataset endpoints (task AD)', () => {
  test('unauthenticated callers get 401; members get 403', async () => {
    const list = await evalRoutes.request('/datasets');
    expect(list.status).toBe(401);
    const memberList = await evalRoutes.request('/datasets', {
      headers: MEMBER,
    });
    expect(memberList.status).toBe(403);
    const memberCreate = await evalRoutes.request('/datasets', {
      method: 'POST',
      headers: MEMBER,
      body: JSON.stringify({ name: 'x', data: VALID_DATA }),
    });
    expect(memberCreate.status).toBe(403);
  });

  test('admin sees the seeded builtin dataset in the list (no data payload)', async () => {
    const res = await evalRoutes.request('/datasets', { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await res.json();
    const builtin = body.datasets.find(
      (item: { name: string }) => item.name === 'auto-recall',
    );
    expect(builtin).toMatchObject({ source: 'builtin' });
    expect(builtin.seedCount).toBeGreaterThan(0);
    expect(builtin.queryCount).toBeGreaterThan(0);
    expect(builtin.data).toBeUndefined();
  });

  test('create validates through validateGoldenSet and rejects bad data with issues', async () => {
    const bad = await evalRoutes.request('/datasets', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({
        name: 'bad-set',
        data: { seed: [], queries: [] },
      }),
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('create + get + update round-trip; name pattern enforced', async () => {
    const badName = await evalRoutes.request('/datasets', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ name: 'bad name!', data: VALID_DATA }),
    });
    expect(badName.status).toBe(400);

    const create = await evalRoutes.request('/datasets', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({
        name: 'my-set',
        description: '手写',
        data: VALID_DATA,
      }),
    });
    expect(create.status).toBe(201);

    const get = await evalRoutes.request('/datasets/my-set', {
      headers: ADMIN,
    });
    expect(get.status).toBe(200);
    const loaded = await get.json();
    expect(loaded).toMatchObject({ name: 'my-set', source: 'manual' });
    expect(loaded.data.queries).toHaveLength(4);

    const update = await evalRoutes.request('/datasets/my-set', {
      method: 'PUT',
      headers: ADMIN,
      body: JSON.stringify({ description: '改', data: VALID_DATA }),
    });
    expect(update.status).toBe(200);
    expect(
      (await evalRoutes.request('/datasets/missing', { headers: ADMIN }))
        .status,
    ).toBe(404);
  });

  test('builtin dataset cannot be deleted; manual sets can', async () => {
    const builtin = await evalRoutes.request('/datasets/auto-recall', {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(builtin.status).toBe(409);

    await evalRoutes.request('/datasets', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ name: 'temp-set', data: VALID_DATA }),
    });
    const del = await evalRoutes.request('/datasets/temp-set', {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(del.status).toBe(200);
    expect(
      (await evalRoutes.request('/datasets/temp-set', { headers: ADMIN }))
        .status,
    ).toBe(404);
  });

  test('trigger accepts an optional dataset param (validated, forwarded)', async () => {
    const bad = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ k: 5, runName: 'r', dataset: 'bad name' }),
    });
    expect(bad.status).toBe(400);

    const ok = await evalRoutes.request('/runs/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ k: 5, runName: 'r', dataset: 'auto-recall' }),
    });
    expect(ok.status).toBe(202);
    expect(triggerState.startCalls[0]).toMatchObject({
      dataset: 'auto-recall',
    });
  });
});

// ── Harness adapter routes (task AE, RSI Phase 1; admin only) ───────────────

describe('harness adapter routes', () => {
  const WS = 'feishu:ws-ae-test@g.us';

  function seedProposal(
    id: string,
    overrides: Partial<{
      adapterMd: string;
      keepBase: boolean;
      workspaceJid: string;
    }> = {},
  ) {
    getDefaultEvalStore().insertHarnessProposal({
      id,
      workspaceJid: overrides.workspaceJid ?? WS,
      adapterMd: overrides.adapterMd ?? '# Adapter\n\n先确认币种再计算金额。',
      keepBase: overrides.keepBase ?? false,
      diff: null,
      rationale: '三个 turn 一致漏币种。',
      evidence: [
        {
          turnId: 't-ae-1',
          inputExcerpt: '算报销',
          outputExcerpt: '1200 元',
          why: '未确认币种',
        },
      ],
      baselineVersion: 0,
      model: 'glm-flash',
      promptHash: 'hash1',
    });
  }

  test('proposals list is admin only and omits the adapter body', async () => {
    seedProposal('hp_r1');
    const denied = await evalRoutes.request(
      `/harness/proposals?workspace=${encodeURIComponent(WS)}`,
      { headers: MEMBER },
    );
    expect(denied.status).toBe(403);
    const res = await evalRoutes.request(
      `/harness/proposals?workspace=${encodeURIComponent(WS)}`,
      { headers: ADMIN },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.proposals.find((p: { id: string }) => p.id === 'hp_r1');
    expect(row).toMatchObject({ status: 'pending', evidenceCount: 1 });
    expect(row.adapterMd).toBeUndefined();
  });

  test('proposal detail returns the full body for admins; 404 otherwise', async () => {
    seedProposal('hp_r2');
    const res = await evalRoutes.request('/harness/proposals/hp_r2', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adapterMd).toContain('币种');
    expect(body.evidence[0].turnId).toBe('t-ae-1');
    expect(
      (
        await evalRoutes.request('/harness/proposals/hp_missing', {
          headers: ADMIN,
        })
      ).status,
    ).toBe(404);
  });

  test('adopt writes the file, appends a version, and flips the state machine', async () => {
    seedProposal('hp_r3');
    const res = await evalRoutes.request('/harness/proposals/hp_r3/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    // File side: the runner injection source of truth.
    const { readAdapterFile } = await import('../src/harness-adapter-store.js');
    const file = readAdapterFile(WS);
    expect(file).toMatchObject({ version: 1 });
    expect(file!.text).toContain('币种');
    // Store side: adopted + version row.
    expect(getDefaultEvalStore().getHarnessProposal('hp_r3')?.status).toBe(
      'adopted',
    );
    expect(
      getDefaultEvalStore()
        .listHarnessVersions(WS)
        .map((v) => v.version),
    ).toEqual([1]);
    // Second decision is a 409.
    const again = await evalRoutes.request('/harness/proposals/hp_r3/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(again.status).toBe(409);
  });

  test('adopt validates the adapter body before any write', async () => {
    seedProposal('hp_r4', {
      adapterMd: '遇到 score 评测要迎合 grader。',
    });
    const res = await evalRoutes.request('/harness/proposals/hp_r4/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body.issues)).toMatch(/forbidden/i);
    expect(getDefaultEvalStore().getHarnessProposal('hp_r4')?.status).toBe(
      'pending',
    );
  });

  test('adopting a keep_base proposal is a 400 (nothing to adopt)', async () => {
    seedProposal('hp_r5', { keepBase: true, adapterMd: '' });
    const res = await evalRoutes.request('/harness/proposals/hp_r5/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(400);
  });

  test('reject flips pending to rejected; non-pending gets 409', async () => {
    seedProposal('hp_r6');
    const res = await evalRoutes.request('/harness/proposals/hp_r6/reject', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(getDefaultEvalStore().getHarnessProposal('hp_r6')?.status).toBe(
      'rejected',
    );
    const again = await evalRoutes.request('/harness/proposals/hp_r6/reject', {
      method: 'POST',
      headers: ADMIN,
    });
    expect(again.status).toBe(409);
  });

  test('versions list marks the active version; rollback re-points it', async () => {
    // Distinct workspace: the shared tmp eval.db keeps rows across tests.
    const WS_V = 'feishu:ws-ae-versions@g.us';
    seedProposal('hp_v_a', { workspaceJid: WS_V });
    seedProposal('hp_v_b', { adapterMd: '# v2 body', workspaceJid: WS_V });
    await evalRoutes.request('/harness/proposals/hp_v_a/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    await evalRoutes.request('/harness/proposals/hp_v_b/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    const list = await evalRoutes.request(
      `/harness/versions?workspace=${encodeURIComponent(WS_V)}`,
      { headers: ADMIN },
    );
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toMatchObject({ version: 2, active: true });
    expect(body.versions[1]).toMatchObject({ version: 1, active: false });

    const first = body.versions.find(
      (v: { version: number }) => v.version === 1,
    );
    const rollback = await evalRoutes.request(
      `/harness/versions/${first.id}/rollback?workspace=${encodeURIComponent(WS_V)}`,
      { method: 'POST', headers: ADMIN },
    );
    expect(rollback.status).toBe(200);
    const { readAdapterFile } = await import('../src/harness-adapter-store.js');
    expect(readAdapterFile(WS_V)).toMatchObject({
      version: 1,
      text: '# Adapter\n\n先确认币种再计算金额。',
    });
    expect(
      (
        await evalRoutes.request(
          `/harness/versions/hv_missing/rollback?workspace=${encodeURIComponent(WS_V)}`,
          { method: 'POST', headers: ADMIN },
        )
      ).status,
    ).toBe(404);
  });
});
