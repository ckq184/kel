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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-memory-routes-'));
const dataDir = path.join(tmpDir, 'data');
const storeDir = path.join(dataDir, 'db');
const groupsDir = path.join(dataDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Keep the real permission/ACL helpers; only swap session auth for a header
// so 401 and hide-existence 404 paths exercise the genuine middleware gate.
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      const userId = c.req.header('x-test-user');
      if (!userId) return c.json({ error: 'Unauthorized' }, 401);
      c.set('user', {
        id: userId,
        username: userId,
        role: 'member',
        permissions: [],
      });
      return next();
    },
  };
});

// The sidecar manager singleton is swapped for an in-memory recorder; the
// shared resolver (autoMemorySidecarConfig → autoMemoryDataPath) stays real
// so the two execution-mode data layouts are pinned through the route.
const sidecarCalls: Array<{
  folder: string;
  config: Record<string, unknown>;
  op: string;
  args: Record<string, unknown>;
}> = [];
let sidecarBehavior: { available: false; reason: string } | null = null;

vi.mock('../src/auto-memory-ipc.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getAutoMemorySidecarManager: () => ({
    call: async (
      folder: string,
      config: Record<string, unknown>,
      op: string,
      args: Record<string, unknown>,
    ) => {
      sidecarCalls.push({ folder, config, op, args });
      if (sidecarBehavior) return { ...sidecarBehavior };
      if (op === 'list') {
        return {
          available: true,
          value: [
            { id: 'm1', memory: 'first memory', created_at: '2026-01-01' },
            { id: 'm2', memory: 'second memory', created_at: '2026-01-02' },
          ],
        };
      }
      if (op === 'search') {
        return {
          available: true,
          value: [{ id: 'm1', memory: 'search hit', score: 0.9 }],
        };
      }
      return { available: true, value: 'ok' };
    },
  }),
}));

const db = await import('../src/db.js');
const { resetAutoMemoryConfigCache } =
  await import('../src/auto-memory-config.js');
const autoMemoryRoutes = (await import('../src/routes/auto-memory.js')).default;
const { probeWithBudget } = await import('../src/routes/auto-memory.js');

const OWNER = { 'x-test-user': 'user-1' } as Record<string, string>;
const STRANGER = { 'x-test-user': 'user-2' } as Record<string, string>;

function seedWorkspaces(): void {
  db.initDatabase();
  db.setRegisteredGroup('web:ws-container', {
    name: 'Container Workspace',
    folder: 'ws-container',
    added_at: new Date().toISOString(),
    created_by: 'user-1',
  });
  db.setRegisteredGroup('web:ws-host', {
    name: 'Host Workspace',
    folder: 'ws-host',
    added_at: new Date().toISOString(),
    created_by: 'user-1',
    executionMode: 'host',
  });
}

function enableAutoMemory(enabled: boolean): void {
  if (enabled) {
    process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
      enabled: true,
      llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
      embedder: { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'e' },
    });
  } else {
    delete process.env.CKQCLAW_AUTO_MEMORY;
  }
  resetAutoMemoryConfigCache();
}

beforeEach(() => {
  seedWorkspaces();
  sidecarCalls.length = 0;
  sidecarBehavior = null;
  enableAutoMemory(true);
});

afterEach(() => {
  enableAutoMemory(false);
});

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auto-memory management routes (task W)', () => {
  test('unauthenticated callers get 401 on every endpoint family', async () => {
    const status = await autoMemoryRoutes.request('/status');
    expect(status.status).toBe(401);

    const list = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
    );
    expect(list.status).toBe(401);

    const purge = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { method: 'DELETE' },
    );
    expect(purge.status).toBe(401);
  });

  test('unknown workspace JID hides existence behind 404', async () => {
    const res = await autoMemoryRoutes.request(
      '/workspaces/web:missing/memories',
      { headers: OWNER },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  test('non-owner members get 404 for reads and writes (v2 hide-existence)', async () => {
    const read = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { headers: STRANGER },
    );
    expect(read.status).toBe(404);

    const del = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/m1',
      { method: 'DELETE', headers: STRANGER },
    );
    expect(del.status).toBe(404);
    expect(sidecarCalls).toHaveLength(0);
  });

  test('container mode resolves the data/extra layout through the shared IPC resolver', async () => {
    const res = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);

    expect(sidecarCalls).toHaveLength(1);
    const call = sidecarCalls[0];
    expect(call.folder).toBe('ws-container');
    expect(call.op).toBe('list');
    expect(call.args).toEqual({ limit: 20, offset: 0 });
    expect(call.config.dataPath).toBe(
      path.join(dataDir, 'extra', 'ws-container', 'auto-memory'),
    );
    expect(call.config.collection).toBe('ws-ws-container');
    expect(call.config.userId).toBe('workspace:ws-container');
  });

  test('host mode resolves the data/groups layout (two layouts never collide)', async () => {
    const res = await autoMemoryRoutes.request(
      '/workspaces/web:ws-host/memories',
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(sidecarCalls[0].config.dataPath).toBe(
      path.join(groupsDir, 'ws-host', 'extra', 'auto-memory'),
    );
  });

  test('disabled config degrades to coded receipts without spawning', async () => {
    enableAutoMemory(false);

    const status = await autoMemoryRoutes.request('/status', {
      headers: OWNER,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      enabled: false,
      available: false,
      reason: 'not_configured',
    });

    const list = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { headers: OWNER },
    );
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ error: 'not_configured' });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('status reports the global enabled flag without probing', async () => {
    const res = await autoMemoryRoutes.request('/status', { headers: OWNER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, available: true });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('status with workspaceJid probes via a lightweight list', async () => {
    const res = await autoMemoryRoutes.request(
      '/status?workspaceJid=web:ws-container',
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, available: true });
    expect(sidecarCalls).toHaveLength(1);
    expect(sidecarCalls[0].op).toBe('list');
    expect(sidecarCalls[0].args).toEqual({ limit: 1, offset: 0 });
  });

  test('status probe failure reports the reason instead of 500', async () => {
    sidecarBehavior = { available: false, reason: 'no usable python here' };
    const res = await autoMemoryRoutes.request(
      '/status?workspaceJid=web:ws-container',
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      available: false,
      reason: 'no usable python here',
    });
  });

  test('probeWithBudget degrades on a budget miss and never leaks a rejection', async () => {
    let rejectUnderlying: (error: Error) => void = () => {};
    const hanging = new Promise<{ available: boolean }>((_, reject) => {
      rejectUnderlying = reject;
    }).catch(() => ({ available: false }));
    const outcome = await probeWithBudget(hanging, 20);
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.reason).toContain('timed out');
    }
    // A late rejection must not surface as an unhandled rejection.
    rejectUnderlying(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test('list pagination bounds reject invalid query params', async () => {
    for (const bad of [
      'limit=0',
      'limit=101',
      'limit=-5',
      'limit=abc',
      'offset=-1',
      'offset=abc',
      'offset=1.5',
    ]) {
      const res = await autoMemoryRoutes.request(
        `/workspaces/web:ws-container/memories?${bad}`,
        { headers: OWNER },
      );
      expect(res.status).toBe(400, `query "${bad}" should be invalid`);
      expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    }
    expect(sidecarCalls).toHaveLength(0);

    const full = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories?limit=100&offset=40',
      { headers: OWNER },
    );
    expect(full.status).toBe(200);
    expect(sidecarCalls[0].args).toEqual({ limit: 100, offset: 40 });
  });

  test('search mirrors the IPC validation semantics', async () => {
    const empty = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/search',
      { headers: OWNER },
    );
    expect(empty.status).toBe(400);

    const tooLong = await autoMemoryRoutes.request(
      `/workspaces/web:ws-container/memories/search?q=${'a'.repeat(501)}`,
      { headers: OWNER },
    );
    expect(tooLong.status).toBe(400);

    const badLimit = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/search?q=term&limit=51',
      { headers: OWNER },
    );
    expect(badLimit.status).toBe(400);

    const ok = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/search?q=term&limit=5',
      { headers: OWNER },
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.items[0]).toMatchObject({ id: 'm1' });
    expect(sidecarCalls[0].op).toBe('search');
    expect(sidecarCalls[0].args).toEqual({ query: 'term', limit: 5 });
  });

  test('single delete is an owner-gated idempotent passthrough', async () => {
    const badId = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/bad%20id',
      { method: 'DELETE', headers: OWNER },
    );
    expect(badId.status).toBe(400);
    expect(await badId.json()).toMatchObject({ error: 'invalid_args' });

    const res = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories/mem-123',
      { method: 'DELETE', headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(sidecarCalls[0].op).toBe('delete');
    expect(sidecarCalls[0].args).toEqual({ memory_id: 'mem-123' });
  });

  test('delete-all is an owner-gated destructive passthrough', async () => {
    const res = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { method: 'DELETE', headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedAll: true });
    expect(sidecarCalls[0].op).toBe('delete_all');
    expect(sidecarCalls[0].folder).toBe('ws-container');
  });

  test('sidecar unavailability maps to a coded 503 with the reason', async () => {
    sidecarBehavior = {
      available: false,
      reason: 'auto-memory sidecar spawn failed 3 times',
    };
    const res = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/memories',
      { headers: OWNER },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('unavailable');
    expect(body.message).toContain('spawn failed');
  });
});
