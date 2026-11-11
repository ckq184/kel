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
