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

// Task AH: same treatment for the harness evolve trigger (keep the real JID
// whitelist from the module under test; swap only the process plumbing).
const evolveTriggerState = {
  startResult: { ok: true } as
    | { ok: true }
    | { ok: false; error: 'busy' | 'invalid_workspace' },
  startCalls: [] as Array<Record<string, unknown>>,
};
vi.mock('../src/harness-evolve-trigger.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  startHarnessEvolveRun: (input: Record<string, unknown>) => {
    evolveTriggerState.startCalls.push(input);
    return evolveTriggerState.startResult;
  },
  getHarnessEvolveTriggerState: () => ({
    running: false,
    workspace: 'feishu:ws-ah@g.us',
    startedAt: 1_736_300_000_000,
    startedBy: 'user-admin',
    lines: ['phase3 evidence: clusters 4 (40 turns)'],
    result: null,
  }),
}));

// Task AE follow-up: control the lesson-distillation LLM path so adoption can
// be proven non-blocking. Default = observability-side config disabled (the
// distiller returns immediately), matching the pre-mock behavior.
const reflectState = vi.hoisted(() => ({
  enabled: false,
  completeImpl: null as null | (() => Promise<string>),
}));
vi.mock('../src/auto-memory-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getAutoMemoryHostConfig: () =>
    reflectState.enabled
      ? {
          enabled: true,
          llm: { baseUrl: 'http://llm.test', apiKey: 'k', model: 'test-model' },
        }
      : { enabled: false, llm: undefined },
}));
vi.mock('../src/recall-judge.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createJudgeLlmClient: () => ({
    model: 'test-model',
    complete: () =>
      reflectState.completeImpl
        ? reflectState.completeImpl()
        : Promise.resolve('{"no_entry": true}'),
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

// ── Task AE follow-up: adoption must not block on lesson distillation ──────

describe('harness adopt is non-blocking (task AE follow-up)', () => {
  test('responds 200 while the reflect LLM is still in flight; lesson lands later', async () => {
    const WS_ASYNC = 'feishu:ws-ae-async@g.us';
    reflectState.enabled = true;
    let resolveLlm!: (value: string) => void;
    reflectState.completeImpl = () =>
      new Promise<string>((resolve) => {
        resolveLlm = resolve;
      });
    try {
      getDefaultEvalStore().insertHarnessProposal({
        id: 'hp_async1',
        workspaceJid: WS_ASYNC,
        adapterMd: '# Adapter\n\n非阻塞采纳测试。',
        keepBase: false,
        diff: null,
        rationale: 'r',
        evidence: [],
        baselineVersion: 0,
        model: 'test-model',
        promptHash: 'hash',
      });
      const res = await evalRoutes.request(
        '/harness/proposals/hp_async1/adopt',
        {
          method: 'POST',
          headers: ADMIN,
        },
      );
      // The HTTP round-trip completes before the LLM call resolves.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, version: 1 });
      expect(getDefaultEvalStore().listHarnessLessons(WS_ASYNC)).toHaveLength(
        0,
      );

      resolveLlm(JSON.stringify({ cue: 'c', lesson: 'l', evidence: 'e' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getDefaultEvalStore().listHarnessLessons(WS_ASYNC)).toHaveLength(
        1,
      );
    } finally {
      reflectState.enabled = false;
      reflectState.completeImpl = null;
    }
  });
});

// ── GET /harness/workspaces (task AF) ───────────────────────────────────────

describe('GET /harness/workspaces', () => {
  test('admin only; returns the union with counts', async () => {
    getDefaultEvalStore().insertTurn({
      turnId: 'af-route-t1',
      workspaceJid: 'ws-af-route@g.us',
      adapterVersion: 1,
    });
    const denied = await evalRoutes.request('/harness/workspaces', {
      headers: MEMBER,
    });
    expect(denied.status).toBe(403);
    const res = await evalRoutes.request('/harness/workspaces', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.workspaces.find(
      (w: { workspaceJid: string }) => w.workspaceJid === 'ws-af-route@g.us',
    );
    expect(row).toMatchObject({ turnCount: 1, proposalCount: 0 });
  });
});

// ── Harness acceptance set + probe reports (task AG, RSI Phase 2) ───────────

describe('harness acceptance + probe endpoints (task AG)', () => {
  const WS = 'feishu:ws-ag-route@g.us';

  const QUERIES = [
    {
      id: 'q1',
      text: '把今天的接龙报名整理成表格',
      expectNotes: ['开头声明文件名与记录数', '联系方式脱敏'],
    },
    { id: 'q2', text: '总结本周接龙', expectNotes: ['输出条目数'] },
  ];

  function seedPendingProposal(id = 'hp_ag1'): void {
    getDefaultEvalStore().insertHarnessProposal({
      id,
      workspaceJid: WS,
      adapterMd: '# Adapter\n\n整理表格前先声明文件名与记录数。',
      keepBase: false,
      diff: null,
      rationale: 'r',
      evidence: [],
      baselineVersion: 1,
      model: 'glm-flash',
      promptHash: 'hash',
    });
  }

  test('acceptance set is admin only; PUT validates and GET round-trips', async () => {
    const deniedGet = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      { headers: MEMBER },
    );
    expect(deniedGet.status).toBe(403);
    const deniedPut = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      {
        method: 'PUT',
        headers: MEMBER,
        body: JSON.stringify({ queries: QUERIES }),
      },
    );
    expect(deniedPut.status).toBe(403);

    // Unconfigured workspace reads 404 (datasets precedent).
    const missing = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      { headers: ADMIN },
    );
    expect(missing.status).toBe(404);

    // Invalid bodies get 400 with the validator's issues verbatim.
    const invalid = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      {
        method: 'PUT',
        headers: ADMIN,
        body: JSON.stringify({
          queries: [{ id: 'q1', text: '', expectNotes: [] }],
        }),
      },
    );
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json();
    expect(Array.isArray(invalidBody.issues)).toBe(true);
    expect(invalidBody.issues.join('\n')).toMatch(/text/);
    expect(invalidBody.issues.join('\n')).toMatch(/expectNotes/);

    // Valid PUT then GET round-trips the payload.
    const saved = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      {
        method: 'PUT',
        headers: ADMIN,
        body: JSON.stringify({ queries: QUERIES }),
      },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });
    const loaded = await evalRoutes.request(
      `/harness/acceptance/${encodeURIComponent(WS)}`,
      { headers: ADMIN },
    );
    expect(loaded.status).toBe(200);
    const body = await loaded.json();
    expect(body.workspaceJid).toBe(WS);
    expect(body.queries).toEqual(QUERIES);
    expect(body.updatedAt).toBeTruthy();
  });

  test('probe list is admin only, requires the proposal param, returns reports', async () => {
    seedPendingProposal('hp_ag2');
    const denied = await evalRoutes.request('/harness/probes?proposal=hp_ag2', {
      headers: MEMBER,
    });
    expect(denied.status).toBe(403);
    const noParam = await evalRoutes.request('/harness/probes', {
      headers: ADMIN,
    });
    expect(noParam.status).toBe(400);

    const empty = await evalRoutes.request('/harness/probes?proposal=hp_ag2', {
      headers: ADMIN,
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ probes: [] });

    getDefaultEvalStore().insertHarnessProbe({
      id: 'hpr_ag1',
      proposalId: 'hp_ag2',
      workspaceJid: WS,
      baselineVersion: 1,
      verdict: 'adopt',
      roundsWon: 1,
      roundsLost: 0,
      roundsTied: 1,
      notesBaselineHit: 0,
      notesProposedHit: 2,
      rounds: [
        {
          queryId: 'q1',
          baselineText: '基线回答',
          proposedText: '提案回答',
          judgeDirect: {
            prefer: 'B',
            perNote: [{ note: '开头声明文件名与记录数', pick: 'B' }],
            reasoning: '提案先声明了文件名',
          },
          judgeSwapped: {
            prefer: 'A',
            perNote: [{ note: '开头声明文件名与记录数', pick: 'A' }],
            reasoning: 'swap 后仍选同一份',
          },
          noteHits: [{ note: '开头声明文件名与记录数', arm: 'proposed' }],
        },
      ],
      costUsd: null,
      model: 'glm-flash',
      createdAt: '2026-11-11T03:00:00Z',
    });
    const res = await evalRoutes.request('/harness/probes?proposal=hp_ag2', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probes).toHaveLength(1);
    expect(body.probes[0]).toMatchObject({
      id: 'hpr_ag1',
      verdict: 'adopt',
      roundsWon: 1,
      notesProposedHit: 2,
    });
    expect(body.probes[0].rounds[0].judgeSwapped.prefer).toBe('A');
  });

  test('proposal detail carries the latest probe summary (verdict + votes)', async () => {
    seedPendingProposal('hp_ag3');
    // Without a probe: explicit null, key always present.
    const bare = await evalRoutes.request('/harness/proposals/hp_ag3', {
      headers: ADMIN,
    });
    expect(bare.status).toBe(200);
    expect((await bare.json()).latestProbe).toBeNull();

    getDefaultEvalStore().insertHarnessProbe({
      id: 'hpr_ag2',
      proposalId: 'hp_ag3',
      workspaceJid: WS,
      baselineVersion: 1,
      verdict: 'keep_base',
      roundsWon: 0,
      roundsLost: 2,
      roundsTied: 0,
      notesBaselineHit: 3,
      notesProposedHit: 1,
      rounds: [],
      costUsd: null,
      model: 'glm-flash',
      createdAt: '2026-11-11T04:00:00Z',
    });
    const res = await evalRoutes.request('/harness/proposals/hp_ag3', {
      headers: ADMIN,
    });
    const body = await res.json();
    expect(body.latestProbe).toMatchObject({
      id: 'hpr_ag2',
      verdict: 'keep_base',
      roundsWon: 0,
      roundsLost: 2,
      notesBaselineHit: 3,
      notesProposedHit: 1,
    });
    // Summary stays a summary: no per-round payload on the detail view.
    expect(body.latestProbe.rounds).toBeUndefined();
  });
});

// ── Task AH (RSI Phase 3): clone / evidence-status / evolve trigger ─────────

describe('harness clone / evidence-status / evolve endpoints (task AH)', () => {
  const WS_SRC = 'feishu:ws-ah-src@g.us';
  const WS_TGT = 'feishu:ws-ah-tgt@g.us';

  beforeEach(() => {
    evolveTriggerState.startCalls.length = 0;
    evolveTriggerState.startResult = { ok: true };
  });

  function seedSourceVersion(adapterMd = '# 克隆源 adapter\n\n先声明文件名。') {
    return getDefaultEvalStore().insertHarnessVersion({
      workspaceJid: WS_SRC,
      proposalId: null,
      adapterMd,
      adoptedBy: 'user-admin',
    });
  }

  // ── POST /harness/versions/:id/clone ─────────────────────────────────────

  test('clone is admin only (401/403)', async () => {
    const version = seedSourceVersion();
    const url = `/harness/versions/${version.id}/clone?workspace=${encodeURIComponent(WS_SRC)}`;
    expect(
      (
        await evalRoutes.request(url, {
          method: 'POST',
          body: JSON.stringify({ targetWorkspace: WS_TGT }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await evalRoutes.request(url, {
          method: 'POST',
          headers: MEMBER,
          body: JSON.stringify({ targetWorkspace: WS_TGT }),
        })
      ).status,
    ).toBe(403);
  });

  test('clone rejects a missing/empty/same-as-source target with 400', async () => {
    const version = seedSourceVersion();
    const url = `/harness/versions/${version.id}/clone?workspace=${encodeURIComponent(WS_SRC)}`;
    for (const body of [
      {},
      { targetWorkspace: '' },
      { targetWorkspace: '   ' },
      { targetWorkspace: WS_SRC },
    ]) {
      const res = await evalRoutes.request(url, {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Missing source workspace query → 400 too.
    expect(
      (
        await evalRoutes.request(`/harness/versions/${version.id}/clone`, {
          method: 'POST',
          headers: ADMIN,
          body: JSON.stringify({ targetWorkspace: WS_TGT }),
        })
      ).status,
    ).toBe(400);
  });

  test('clone of an unknown version id is 404', async () => {
    expect(
      (
        await evalRoutes.request(
          `/harness/versions/hv_missing/clone?workspace=${encodeURIComponent(WS_SRC)}`,
          {
            method: 'POST',
            headers: ADMIN,
            body: JSON.stringify({ targetWorkspace: WS_TGT }),
          },
        )
      ).status,
    ).toBe(404);
  });

  test('clone lands a pending proposal in the target and never writes its file', async () => {
    const version = seedSourceVersion();
    const res = await evalRoutes.request(
      `/harness/versions/${version.id}/clone?workspace=${encodeURIComponent(WS_SRC)}`,
      {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ targetWorkspace: WS_TGT }),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.proposal.workspaceJid).toBe(WS_TGT);

    const store = getDefaultEvalStore();
    const detail = store.getHarnessProposal(body.proposal.id);
    expect(detail).toMatchObject({
      workspaceJid: WS_TGT,
      status: 'pending',
      keepBase: false,
      baselineVersion: 0,
      model: 'clone',
    });
    // Full source body + provenance-marked rationale + empty evidence.
    expect(detail!.adapterMd).toContain('克隆源 adapter');
    expect(detail!.rationale).toContain(`克隆自 ${WS_SRC} v${version.version}`);
    expect(detail!.evidence).toEqual([]);
    // The proposal gate holds: no adapter file for the target workspace.
    const { readAdapterFile } = await import('../src/harness-adapter-store.js');
    expect(readAdapterFile(WS_TGT)).toBeNull();
  });

  test('clone baseline is the target current ACTIVE version', async () => {
    // Target workspace has an adopted v1 (via the real adopt flow, which
    // writes its file); the clone must baseline against that, not 0.
    getDefaultEvalStore().insertHarnessProposal({
      id: 'hp_ah_tgt1',
      workspaceJid: WS_TGT,
      adapterMd: '# 目标已有 adapter',
      keepBase: false,
      diff: null,
      rationale: 'r',
      evidence: [],
      baselineVersion: 0,
      model: 'glm-flash',
      promptHash: 'hash',
    });
    await evalRoutes.request('/harness/proposals/hp_ah_tgt1/adopt', {
      method: 'POST',
      headers: ADMIN,
    });
    const version = seedSourceVersion('# 第二份克隆源');
    const res = await evalRoutes.request(
      `/harness/versions/${version.id}/clone?workspace=${encodeURIComponent(WS_SRC)}`,
      {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify({ targetWorkspace: WS_TGT }),
      },
    );
    expect(res.status).toBe(201);
    const detail = getDefaultEvalStore().getHarnessProposal(
      (await res.json()).proposal.id,
    );
    expect(detail!.baselineVersion).toBe(1);
    // Diff is display-only but present for the review UI.
    expect(typeof detail!.diff).toBe('string');
  });

  // ── GET /harness/evidence-status ─────────────────────────────────────────

  test('evidence-status is admin only and requires the workspace param', async () => {
    expect((await evalRoutes.request('/harness/evidence-status')).status).toBe(
      401,
    );
    expect(
      (
        await evalRoutes.request('/harness/evidence-status', {
          headers: MEMBER,
        })
      ).status,
    ).toBe(403);
    expect(
      (await evalRoutes.request('/harness/evidence-status', { headers: ADMIN }))
        .status,
    ).toBe(400);
  });

  test('evidence-status counts turns since the last proposal (all when none)', async () => {
    const WS = 'feishu:ws-ah-es@g.us';
    const store = getDefaultEvalStore();
    for (const [id, at] of [
      ['ah_es_t1', '2026-11-12T10:00:00Z'],
      ['ah_es_t2', '2026-11-12T11:00:00Z'],
      ['ah_es_t3', '2026-11-12T12:00:00Z'],
    ] as const) {
      store.insertTurn({ turnId: id, workspaceJid: WS, createdAt: at });
    }
    store.insertHarnessProposal({
      id: 'hp_ah_es1',
      workspaceJid: WS,
      adapterMd: '',
      keepBase: true,
      diff: null,
      rationale: 'r',
      evidence: [],
      baselineVersion: 0,
      model: 'glm-flash',
      promptHash: 'hash',
      createdAt: '2026-11-12T10:30:00Z',
    });

    const res = await evalRoutes.request(
      `/harness/evidence-status?workspace=${encodeURIComponent(WS)}`,
      { headers: ADMIN },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      turnsSinceLastProposal: 2,
      lastProposalAt: '2026-11-12T10:30:00Z',
      activeVersion: 0,
    });

    // A workspace with no proposals counts its whole history.
    const fresh = await evalRoutes.request(
      `/harness/evidence-status?workspace=${encodeURIComponent('feishu:ws-ah-none@g.us')}`,
      { headers: ADMIN },
    );
    expect(await fresh.json()).toEqual({
      turnsSinceLastProposal: 0,
      lastProposalAt: null,
      activeVersion: 0,
    });
  });

  // ── POST /harness/evolve/trigger + GET /harness/evolve/status ────────────

  test('evolve trigger is admin only (401/403)', async () => {
    expect(
      (
        await evalRoutes.request('/harness/evolve/trigger', {
          method: 'POST',
          body: JSON.stringify({ workspace: 'web:ws-a' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await evalRoutes.request('/harness/evolve/trigger', {
          method: 'POST',
          headers: MEMBER,
          body: JSON.stringify({ workspace: 'web:ws-a' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await evalRoutes.request('/harness/evolve/status', { headers: MEMBER }))
        .status,
    ).toBe(403);
  });

  test('evolve trigger rejects missing or non-JID workspaces with 400', async () => {
    for (const body of [
      {},
      { workspace: '' },
      { workspace: '   ' },
      { workspace: 'feishu:1@g.us;rm -rf /' },
      { workspace: 'a b' },
    ]) {
      const res = await evalRoutes.request('/harness/evolve/trigger', {
        method: 'POST',
        headers: ADMIN,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(evolveTriggerState.startCalls).toHaveLength(0);
  });

  test('admin evolve trigger returns 202 and forwards the workspace', async () => {
    const res = await evalRoutes.request('/harness/evolve/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ workspace: 'feishu:ws-ah@g.us' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      workspace: 'feishu:ws-ah@g.us',
    });
    expect(evolveTriggerState.startCalls).toEqual([
      { workspace: 'feishu:ws-ah@g.us', startedBy: 'user-admin' },
    ]);
  });

  test('a busy evolve trigger maps to 409', async () => {
    evolveTriggerState.startResult = { ok: false, error: 'busy' };
    const res = await evalRoutes.request('/harness/evolve/trigger', {
      method: 'POST',
      headers: ADMIN,
      body: JSON.stringify({ workspace: 'feishu:ws-ah@g.us' }),
    });
    expect(res.status).toBe(409);
  });

  test('evolve status exposes the trigger snapshot to admins', async () => {
    const res = await evalRoutes.request('/harness/evolve/status', {
      headers: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      running: false,
      workspace: 'feishu:ws-ah@g.us',
      startedBy: 'user-admin',
      lines: ['phase3 evidence: clusters 4 (40 turns)'],
    });
  });
});
