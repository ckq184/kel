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
// user-admin carries manage_system_config (real systemConfigMiddleware runs).
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
const stopAllCalls: number[] = [];

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
      if (op === 'add') {
        // Task Y: mem0 add receipt shape — results list + optional
        // intercepted findings attached by the sidecar redaction pass.
        return {
          available: true,
          value: {
            results: [
              { event: 'ADD', memory: '新增记忆一' },
              { event: 'ADD', memory: '新增记忆二' },
              { event: 'NONE', memory: '已存在条目' },
            ],
            intercepted: ['keyword_value'],
          },
        };
      }
      return { available: true, value: 'ok' };
    },
    // Task X config writes stop live sidecars so the next call respawns
    // with the new endpoints — the route must actually invoke this.
    stopAll: async () => {
      stopAllCalls.push(Date.now());
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
const ADMIN = { 'x-test-user': 'user-admin' } as Record<string, string>;
const CONFIG_FILE = path.join(dataDir, 'config', 'auto-memory.json');

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
  stopAllCalls.length = 0;
  fs.rmSync(CONFIG_FILE, { force: true });
  enableAutoMemory(true);
});

afterEach(() => {
  enableAutoMemory(false);
  fs.rmSync(CONFIG_FILE, { force: true });
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
      source: 'none',
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
    expect(await res.json()).toEqual({
      enabled: true,
      available: true,
      source: 'env',
    });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('status with workspaceJid probes via a lightweight list', async () => {
    const res = await autoMemoryRoutes.request(
      '/status?workspaceJid=web:ws-container',
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      available: true,
      source: 'env',
    });
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
      source: 'env',
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

describe('auto-memory config endpoints (task X)', () => {
  const LLM_IN = {
    baseUrl: 'https://llm.test/v1',
    apiKey: 'sk-llm-secret-123456',
    model: 'gpt-m',
  };
  const EMBEDDER_IN = {
    baseUrl: 'https://embed.test/v1',
    apiKey: 'sk-embed-secret-123456',
    model: 'embed-m',
  };

  beforeEach(() => {
    // The config family manages the file channel — env must stay unset.
    enableAutoMemory(false);
  });

  function put(body: unknown, headers: Record<string, string> = ADMIN) {
    return autoMemoryRoutes.request('/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
  }

  test('unauthenticated callers get 401 on every config endpoint', async () => {
    const get = await autoMemoryRoutes.request('/config');
    expect(get.status).toBe(401);

    const putRes = await put(
      { llm: LLM_IN, embedder: EMBEDDER_IN },
      {} as Record<string, string>,
    );
    expect(putRes.status).toBe(401);

    const del = await autoMemoryRoutes.request('/config', {
      method: 'DELETE',
    });
    expect(del.status).toBe(401);
  });

  test('members without manage_system_config get 403 on every config endpoint', async () => {
    const get = await autoMemoryRoutes.request('/config', {
      headers: OWNER,
    });
    expect(get.status).toBe(403);

    const putRes = await put({ llm: LLM_IN, embedder: EMBEDDER_IN }, OWNER);
    expect(putRes.status).toBe(403);

    const del = await autoMemoryRoutes.request('/config', {
      method: 'DELETE',
      headers: OWNER,
    });
    expect(del.status).toBe(403);
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
  });

  test('GET /config reports the none state uncached with no endpoints', async () => {
    const res = await autoMemoryRoutes.request('/config', { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ source: 'none', enabled: false });
  });

  test('GET /config marks an incomplete file (file source, disabled, one-sided prefill)', async () => {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ llm: LLM_IN }));
    resetAutoMemoryConfigCache();
    const res = await autoMemoryRoutes.request('/config', { headers: ADMIN });
    expect(res.status).toBe(200);
    // sanitizeConfig keeps the individually-valid llm for diagnostics; the
    // view mirrors that (masked) while enabled stays false.
    const body = await res.json();
    expect(body.source).toBe('file');
    expect(body.enabled).toBe(false);
    expect(body.llm).toEqual({
      baseUrl: 'https://llm.test/v1',
      model: 'gpt-m',
      apiKeyMasked: 'sk-l***3456',
    });
    expect(body.embedder).toBeUndefined();
  });

  test('PUT writes the pair, restarts sidecars, and GET masks the keys', async () => {
    const write = await put({ llm: LLM_IN, embedder: EMBEDDER_IN });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ ok: true, sidecarsRestarted: true });
    expect(stopAllCalls).toHaveLength(1);

    // The plaintext key lands in the 0o600 file only — never a response.
    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    expect(stored.llm.apiKey).toBe('sk-llm-secret-123456');
    expect(stored.embedder.apiKey).toBe('sk-embed-secret-123456');

    const get = await autoMemoryRoutes.request('/config', { headers: ADMIN });
    expect(get.headers.get('cache-control')).toContain('no-store');
    const body = await get.json();
    expect(body.source).toBe('file');
    expect(body.enabled).toBe(true);
    expect(body.llm).toEqual({
      baseUrl: 'https://llm.test/v1',
      model: 'gpt-m',
      apiKeyMasked: 'sk-l***3456',
    });
    expect(body.embedder).toEqual({
      baseUrl: 'https://embed.test/v1',
      model: 'embed-m',
      apiKeyMasked: 'sk-e***3456',
    });
    expect(JSON.stringify(body)).not.toContain('sk-llm-secret-123456');
    expect(JSON.stringify(body)).not.toContain('sk-embed-secret-123456');
  });

  test('PUT keeps the old apiKey when blank or the untouched mask round-trips', async () => {
    await put({ llm: LLM_IN, embedder: EMBEDDER_IN });
    expect(stopAllCalls).toHaveLength(1);

    // Blank apiKey = keep (UI leaves the field empty).
    const blank = await put({
      llm: { baseUrl: LLM_IN.baseUrl, apiKey: '', model: 'gpt-2' },
      embedder: { baseUrl: EMBEDDER_IN.baseUrl, model: 'embed-2' },
    });
    expect(blank.status).toBe(200);

    // Prefilled mask sent back verbatim = keep (UI round-trip).
    const masked = await put({
      llm: {
        baseUrl: LLM_IN.baseUrl,
        apiKey: 'sk-l***3456',
        model: 'gpt-3',
      },
      embedder: {
        baseUrl: EMBEDDER_IN.baseUrl,
        apiKey: 'sk-e***3456',
        model: 'embed-3',
      },
    });
    expect(masked.status).toBe(200);

    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    expect(stored.llm.apiKey).toBe('sk-llm-secret-123456');
    expect(stored.embedder.apiKey).toBe('sk-embed-secret-123456');
    expect(stored.llm.model).toBe('gpt-3');
    expect(stored.embedder.model).toBe('embed-3');
    expect(stopAllCalls).toHaveLength(3);
  });

  test('PUT rejects invalid input without touching the file or sidecars', async () => {
    for (const bad of [
      {},
      { llm: LLM_IN },
      {
        llm: { baseUrl: 'ftp://x', apiKey: 'k', model: 'm' },
        embedder: EMBEDDER_IN,
      },
      { llm: { baseUrl: 'https://x', apiKey: 'k' }, embedder: EMBEDDER_IN },
      // Strict field hygiene (OpenDot discipline): no surrounding whitespace.
      {
        llm: { baseUrl: ' https://x', apiKey: 'k', model: 'm' },
        embedder: EMBEDDER_IN,
      },
      {
        llm: { baseUrl: 'https://x', apiKey: 'k', model: 'm ' },
        embedder: EMBEDDER_IN,
      },
      {
        llm: { baseUrl: 'https://x', apiKey: ' k', model: 'm' },
        embedder: EMBEDDER_IN,
      },
      // Blank apiKey cannot "keep" what does not exist yet.
      {
        llm: { baseUrl: 'https://x', apiKey: '', model: 'm' },
        embedder: EMBEDDER_IN,
      },
    ]) {
      const res = await put(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    }
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    expect(stopAllCalls).toHaveLength(0);
  });

  test('PUT bodies beyond 8KB are refused before parsing', async () => {
    const res = await put({
      llm: { ...LLM_IN, apiKey: 'x'.repeat(9 * 1024) },
      embedder: EMBEDDER_IN,
    });
    expect(res.status).toBe(413);
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
  });

  test('env override turns PUT/DELETE into 409 and GET into a read-only view', async () => {
    enableAutoMemory(true);

    const putRes = await put({ llm: LLM_IN, embedder: EMBEDDER_IN });
    expect(putRes.status).toBe(409);
    expect(await putRes.json()).toMatchObject({ error: 'env_override' });

    const del = await autoMemoryRoutes.request('/config', {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ error: 'env_override' });

    const get = await autoMemoryRoutes.request('/config', { headers: ADMIN });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.source).toBe('env');
    // Field-wise only (no whole-object snapshots): short keys mask to '***'
    // and no plaintext apiKey field exists in the view.
    expect(body.llm).toEqual({
      baseUrl: 'https://llm.test/v1',
      model: 'm',
      apiKeyMasked: '***',
    });
    expect(body.llm.apiKey).toBeUndefined();

    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    expect(stopAllCalls).toHaveLength(0);
  });

  test('DELETE clears the file, restarts sidecars, and status follows', async () => {
    await put({ llm: LLM_IN, embedder: EMBEDDER_IN });
    expect(stopAllCalls).toHaveLength(1);

    const del = await autoMemoryRoutes.request('/config', {
      method: 'DELETE',
      headers: ADMIN,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, sidecarsRestarted: true });
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
    expect(stopAllCalls).toHaveLength(2);

    const status = await autoMemoryRoutes.request('/status', {
      headers: OWNER,
    });
    expect(await status.json()).toEqual({
      enabled: false,
      available: false,
      reason: 'not_configured',
      source: 'none',
    });
  });
});

describe('chat capture endpoints (task Y)', () => {
  // Each test seeds its own workspace so message counts stay isolated —
  // initDatabase is idempotent and rows persist across tests in this file.
  let seq = 0;
  const seedWorkspace = (): string => {
    seq += 1;
    const jid = `web:ws-cap-${seq}`;
    db.setRegisteredGroup(jid, {
      name: `Capture ${seq}`,
      folder: `ws-cap-${seq}`,
      added_at: new Date().toISOString(),
      created_by: 'user-1',
    });
    return jid;
  };
  const ts = (second: number) =>
    new Date(Date.UTC(2026, 10, 10, 10, 0, second)).toISOString();
  const seedMessage = (
    chatJid: string,
    id: string,
    content: string,
    opts?: { fromMe?: boolean; sender?: string; timestamp?: string },
  ) => {
    // messages.chat_jid has an FK into chats — ensure the row first.
    db.ensureChatExists(chatJid);
    db.storeMessageDirect(
      id,
      chatJid,
      opts?.sender ?? 'web-user',
      'tester',
      content,
      opts?.timestamp ?? ts(0),
      !!opts?.fromMe,
    );
  };

  test('capture endpoints require login', async () => {
    const preview = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/capture/preview',
    );
    expect(preview.status).toBe(401);

    const capture = await autoMemoryRoutes.request(
      '/workspaces/web:ws-container/capture',
      { method: 'POST', body: JSON.stringify({}) },
    );
    expect(capture.status).toBe(401);
  });

  test('both ACL faces hide the workspace behind 404 for non-owners', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'cap-1', '可提炼内容', { timestamp: ts(1) });

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: STRANGER },
    );
    expect(preview.status).toBe(404);

    const capture = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture`,
      { method: 'POST', headers: STRANGER, body: JSON.stringify({}) },
    );
    expect(capture.status).toBe(404);
    expect(sidecarCalls).toHaveLength(0);
  });

  test('preview counts only conversation rows and never spawns the sidecar', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'cap-1', '第一条用户消息', { timestamp: ts(0) });
    seedMessage(jid, 'cap-2', '助手回复', {
      fromMe: true,
      timestamp: ts(1),
    });
    seedMessage(jid, 'cap-3', 'context_reset', {
      sender: '__system__',
      timestamp: ts(2),
    });
    seedMessage(jid, 'cap-4', '本月配额已用尽', {
      sender: '__billing__',
      timestamp: ts(3),
    });
    seedMessage(jid, 'cap-5', '   ', { timestamp: ts(4) });
    seedMessage(jid, 'cap-6', '最后一条用户消息', { timestamp: ts(5) });

    const res = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: 3,
      chars:
        '第一条用户消息'.length + '助手回复'.length + '最后一条用户消息'.length,
    });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('capture maps roles chronologically and drops system/billing rows', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'cap-1', '第一条用户消息', { timestamp: ts(0) });
    seedMessage(jid, 'cap-2', '助手回复', {
      fromMe: true,
      timestamp: ts(1),
    });
    seedMessage(jid, 'cap-3', 'context_reset', {
      sender: '__system__',
      timestamp: ts(2),
    });
    seedMessage(jid, 'cap-4', '本月配额已用尽', {
      sender: '__billing__',
      timestamp: ts(3),
    });
    seedMessage(jid, 'cap-5', '最后一条用户消息', { timestamp: ts(4) });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      captured: 3,
      added: 2,
      intercepted: 1,
    });

    expect(sidecarCalls).toHaveLength(1);
    const call = sidecarCalls[0];
    expect(call.folder).toBe(`ws-cap-${seq}`);
    expect(call.op).toBe('add');
    expect(call.args.messages).toEqual([
      { role: 'user', content: '第一条用户消息' },
      { role: 'assistant', content: '助手回复' },
      { role: 'user', content: '最后一条用户消息' },
    ]);
    expect(call.args.metadata).toMatchObject({
      source: 'chat_capture',
      // No agentIds in the body → main conversation only, recorded as [''].
      agentIds: [''],
      capturedAt: expect.any(String),
    });
  });

  test('capture keeps the newest 400 messages (server-fixed limit)', async () => {
    const jid = seedWorkspace();
    for (let i = 0; i < 405; i++) {
      seedMessage(jid, `cap-${i}`, `消息${i}`, { timestamp: ts(i) });
    }

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: OWNER },
    );
    expect(await preview.json()).toMatchObject({ messages: 400 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const messages = sidecarCalls[0].args.messages as Array<{
      content: string;
    }>;
    expect(messages).toHaveLength(400);
    // Newest tail kept: the five oldest rows fell out of the 400 window.
    expect(messages[0].content).toBe('消息5');
    expect(messages[399].content).toBe('消息404');
  });

  test('char budget keeps the newest tail within 60k chars', async () => {
    const jid = seedWorkspace();
    const oldest = '早'.repeat(30_000);
    const middle = '中'.repeat(30_000);
    const newest = '新'.repeat(100);
    seedMessage(jid, 'cap-1', oldest, { timestamp: ts(0) });
    seedMessage(jid, 'cap-2', middle, { timestamp: ts(1) });
    seedMessage(jid, 'cap-3', newest, { timestamp: ts(2) });

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: OWNER },
    );
    expect(await preview.json()).toEqual({ messages: 2, chars: 30_100 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const messages = sidecarCalls[0].args.messages as Array<{
      content: string;
    }>;
    expect(messages.map((m) => m.content)).toEqual([middle, newest]);
  });

  test('a single message larger than the budget keeps its newest 60k chars', async () => {
    const jid = seedWorkspace();
    const huge = '巨'.repeat(70_000);
    seedMessage(jid, 'cap-1', huge, { timestamp: ts(0) });

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: OWNER },
    );
    expect(await preview.json()).toEqual({ messages: 1, chars: 60_000 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const messages = sidecarCalls[0].args.messages as Array<{
      content: string;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(huge.slice(huge.length - 60_000));
  });

  test('agentIds scopes capture to the agent sub-conversation jid', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话消息', { timestamp: ts(0) });
    seedMessage(jid, 'main-2', '另一条主会话消息', { timestamp: ts(1) });
    const virtualJid = `${jid}#agent:agent-1`;
    seedMessage(virtualJid, 'sub-1', '子会话消息一', { timestamp: ts(0) });
    seedMessage(virtualJid, 'sub-2', '子会话消息二', {
      fromMe: true,
      timestamp: ts(1),
    });

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=agent-1`,
      { headers: OWNER },
    );
    expect(await preview.json()).toEqual({
      messages: 2,
      chars: '子会话消息一'.length + '子会话消息二'.length,
    });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds: ['agent-1'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, captured: 2 });
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '子会话消息一' },
      { role: 'assistant', content: '子会话消息二' },
    ]);
    expect(sidecarCalls[0].args.metadata).toMatchObject({
      source: 'chat_capture',
      agentIds: ['agent-1'],
    });
  });

  test('capture rejects malformed bodies and invalid agentIds', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'cap-1', '可提炼内容', { timestamp: ts(0) });

    for (const bad of [
      JSON.stringify('not-an-object'),
      JSON.stringify([1, 2]),
      JSON.stringify({ agentIds: 123 }),
      JSON.stringify({ agentIds: [123] }),
      // Explicit-but-empty array is a caller bug — omit it for main-only.
      JSON.stringify({ agentIds: [] }),
      JSON.stringify({ agentIds: ['x'.repeat(129)] }),
    ]) {
      const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
        method: 'POST',
        headers: OWNER,
        body: bad,
      });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    }
    expect(sidecarCalls).toHaveLength(0);
  });

  test('empty conversation: preview reports zero, capture rejects 400', async () => {
    const jid = seedWorkspace();

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview`,
      { headers: OWNER },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ messages: 0, chars: 0 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('capture without endpoint config returns 503 not_configured', async () => {
    enableAutoMemory(false);
    const jid = seedWorkspace();
    seedMessage(jid, 'cap-1', '可提炼内容', { timestamp: ts(0) });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
    expect(sidecarCalls).toHaveLength(0);
  });

  // ── Multi-session capture (task Y2) ─────────────────────────────────────

  test('multi-session capture merges targets in global timestamp order', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-0', '主会话最早', { timestamp: ts(0) });
    seedMessage(`${jid}#agent:a1`, 'a1-1', '子会话一第二条', {
      timestamp: ts(1),
    });
    seedMessage(`${jid}#agent:a2`, 'a2-2', '子会话二消息', {
      fromMe: true,
      timestamp: ts(2),
    });
    seedMessage(`${jid}#agent:a1`, 'a1-3', '子会话一最新', {
      fromMe: true,
      timestamp: ts(3),
    });
    seedMessage(jid, 'main-4', '主会话最新', { timestamp: ts(4) });

    const agentIds = ['', 'a1', 'a2'];
    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=&agentId=a1&agentId=a2`,
      { headers: OWNER },
    );
    const contents = [
      '主会话最早',
      '子会话一第二条',
      '子会话二消息',
      '子会话一最新',
      '主会话最新',
    ];
    const chars = contents.reduce((sum, c) => sum + c.length, 0);
    expect(await preview.json()).toEqual({ messages: 5, chars });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, captured: 5 });
    // Interleaved timestamps from three targets come out globally sorted
    // with per-row roles intact.
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '主会话最早' },
      { role: 'user', content: '子会话一第二条' },
      { role: 'assistant', content: '子会话二消息' },
      { role: 'assistant', content: '子会话一最新' },
      { role: 'user', content: '主会话最新' },
    ]);
    expect(sidecarCalls[0].args.metadata).toMatchObject({
      source: 'chat_capture',
      agentIds,
    });
  });

  test('shared char budget keeps the newest content across sessions', async () => {
    const jid = seedWorkspace();
    // Main alone fits the 60k budget, but a1's newer messages crowd it out
    // once merged — per-session budgets would keep all three rows.
    seedMessage(jid, 'main-0', '旧'.repeat(30_000), { timestamp: ts(0) });
    seedMessage(`${jid}#agent:a1`, 'a1-1', '中'.repeat(30_000), {
      timestamp: ts(1),
    });
    seedMessage(`${jid}#agent:a1`, 'a1-2', '新'.repeat(100), {
      timestamp: ts(2),
    });

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=&agentId=a1`,
      { headers: OWNER },
    );
    expect(await preview.json()).toEqual({ messages: 2, chars: 30_100 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds: ['', 'a1'] }),
    });
    expect(res.status).toBe(200);
    const messages = sidecarCalls[0].args.messages as Array<{
      content: string;
    }>;
    expect(messages.map((m) => m.content)).toEqual([
      '中'.repeat(30_000),
      '新'.repeat(100),
    ]);
  });

  test('shared 400-message cap mixes the newest rows across sessions', async () => {
    const jid = seedWorkspace();
    // Two sessions × 300 short rows = 600 merged; the 400-cap keeps the
    // newest 400 interleaved rows (main even seconds, a1 odd seconds).
    for (let i = 0; i < 300; i++) {
      seedMessage(jid, `main-${i}`, `主${i}`, { timestamp: ts(i * 2) });
      seedMessage(`${jid}#agent:a1`, `a1-${i}`, `子${i}`, {
        timestamp: ts(i * 2 + 1),
      });
    }

    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=&agentId=a1`,
      { headers: OWNER },
    );
    expect(await preview.json()).toMatchObject({ messages: 400 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds: ['', 'a1'] }),
    });
    expect(res.status).toBe(200);
    const messages = sidecarCalls[0].args.messages as Array<{
      content: string;
    }>;
    expect(messages).toHaveLength(400);
    // Newest 400 of 600 = timestamps 200..599 (even=主, odd=子), so the
    // oldest 200 rows (主0..99, 子0..99) fell out.
    expect(messages[0].content).toBe('主100');
    expect(messages[399].content).toBe('子299');
    expect(messages.some((m) => m.content === '主99')).toBe(false);
    expect(messages.some((m) => m.content === '子99')).toBe(false);
  });

  test('duplicate agentIds are deduplicated before capture', async () => {
    const jid = seedWorkspace();
    seedMessage(`${jid}#agent:a1`, 'a1-1', '子会话唯一消息', {
      timestamp: ts(0),
    });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds: ['a1', 'a1', ''] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captured: 1 });
    expect(sidecarCalls[0].args.metadata).toMatchObject({
      agentIds: ['a1', ''],
    });
  });

  test('unknown agentIds contribute zero rows; all-empty targets reject 400', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话消息', { timestamp: ts(0) });

    // Unknown agent (deleted sub-conversation) is skipped silently.
    const preview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=agent-x&agentId=`,
      { headers: OWNER },
    );
    expect(await preview.json()).toEqual({
      messages: 1,
      chars: '主会话消息'.length,
    });

    const emptyPreview = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=agent-x`,
      { headers: OWNER },
    );
    expect(await emptyPreview.json()).toEqual({ messages: 0, chars: 0 });

    const res = await autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ agentIds: ['agent-x'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('preview rejects an oversized agentId query value', async () => {
    const jid = seedWorkspace();
    const res = await autoMemoryRoutes.request(
      `/workspaces/${jid}/capture/preview?agentId=${'x'.repeat(129)}`,
      { headers: OWNER },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_args' });
  });
});

describe('message-pick capture (task Y3)', () => {
  let seq = 0;
  const seedWorkspace = (): string => {
    seq += 1;
    const jid = `web:ws-pick-${seq}`;
    db.setRegisteredGroup(jid, {
      name: `Pick ${seq}`,
      folder: `ws-pick-${seq}`,
      added_at: new Date().toISOString(),
      created_by: 'user-1',
    });
    return jid;
  };
  const ts = (second: number) =>
    new Date(Date.UTC(2026, 10, 11, 9, 0, second)).toISOString();
  const seedMessage = (
    chatJid: string,
    id: string,
    content: string,
    opts?: { fromMe?: boolean; sender?: string; timestamp?: string },
  ) => {
    db.ensureChatExists(chatJid);
    db.storeMessageDirect(
      id,
      chatJid,
      opts?.sender ?? 'web-user',
      'tester',
      content,
      opts?.timestamp ?? ts(0),
      !!opts?.fromMe,
    );
  };
  const post = (jid: string, body: unknown) =>
    autoMemoryRoutes.request(`/workspaces/${jid}/capture`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify(body),
    });

  test('sends exactly the selected messages in timestamp order', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话干扰行', { timestamp: ts(0) });
    seedMessage(`${jid}#agent:a1`, 'sub-1', '选中第一条', { timestamp: ts(1) });
    seedMessage(`${jid}#agent:a1`, 'sub-2', '选中第二条', {
      fromMe: true,
      timestamp: ts(2),
    });

    // Ids passed out of order; output must come back chronologically.
    const res = await post(jid, {
      agentId: 'a1',
      messageIds: ['sub-2', 'sub-1'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      captured: 2,
      added: 2,
      intercepted: 1,
    });
    expect(sidecarCalls).toHaveLength(1);
    expect(sidecarCalls[0].op).toBe('add');
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '选中第一条' },
      { role: 'assistant', content: '选中第二条' },
    ]);
    expect(sidecarCalls[0].args.metadata).toMatchObject({
      source: 'chat_capture',
      mode: 'message_pick',
      agentId: 'a1',
      messageCount: 2,
      capturedAt: expect.any(String),
    });
  });

  test('messageIds without agentId reads the main conversation', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话一', { timestamp: ts(0) });
    seedMessage(`${jid}#agent:a1`, 'sub-1', '子会话一', { timestamp: ts(1) });

    const res = await post(jid, { messageIds: ['main-1'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captured: 1 });
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '主会话一' },
    ]);
    expect(sidecarCalls[0].args.metadata).not.toHaveProperty('agentId');
    expect(sidecarCalls[0].args.metadata).toMatchObject({ messageCount: 1 });
  });

  test('drops ids from other conversations and unknown ids', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话一', { timestamp: ts(0) });
    seedMessage(jid, 'main-2', '主会话二', { timestamp: ts(1) });
    seedMessage(`${jid}#agent:a1`, 'sub-1', '子会话一', { timestamp: ts(2) });

    // sub-1 belongs to a different conversation under this agentId scope.
    const res = await post(jid, {
      messageIds: ['main-1', 'sub-1', 'no-such-id'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ captured: 1 });

    // All ids invalid → same empty-selection receipt as task Y.
    const allInvalid = await post(jid, { messageIds: ['no-such-id'] });
    expect(allInvalid.status).toBe(400);
    expect(await allInvalid.json()).toMatchObject({ error: 'invalid_args' });
    expect(sidecarCalls).toHaveLength(1);
  });

  test('drops system/billing/blank rows picked by id (server fallback)', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'sys-1', 'context_reset', {
      sender: '__system__',
      timestamp: ts(0),
    });
    seedMessage(jid, 'bill-1', '配额提醒', {
      sender: '__billing__',
      timestamp: ts(1),
    });
    seedMessage(jid, 'blank-1', '   ', { timestamp: ts(2) });
    seedMessage(jid, 'ok-1', '正常消息', { timestamp: ts(3) });

    const res = await post(jid, {
      messageIds: ['sys-1', 'bill-1', 'blank-1', 'ok-1'],
    });
    expect(res.status).toBe(200);
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '正常消息' },
    ]);

    const onlyJunk = await post(jid, { messageIds: ['sys-1', 'bill-1'] });
    expect(onlyJunk.status).toBe(400);
    expect(await onlyJunk.json()).toMatchObject({ error: 'invalid_args' });
  });

  test('has no 400-message window — the oldest row stays selectable', async () => {
    const jid = seedWorkspace();
    for (let i = 0; i < 405; i++) {
      seedMessage(jid, `cap-${i}`, `第${i}条`, { timestamp: ts(i) });
    }

    const res = await post(jid, { messageIds: ['cap-0'] });
    expect(res.status).toBe(200);
    expect(sidecarCalls[0].args.messages).toEqual([
      { role: 'user', content: '第0条' },
    ]);
  });

  test('rejects over-budget selections without truncating', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'big-1', '巨'.repeat(31_000), { timestamp: ts(0) });
    seedMessage(jid, 'big-2', '大'.repeat(31_000), { timestamp: ts(1) });

    // 62k chars > 60k budget — refuse (message-pick is exact by design),
    // never silently trim what the user explicitly chose.
    const res = await post(jid, { messageIds: ['big-1', 'big-2'] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_args');
    expect(body.message).toContain('60,000');
    expect(sidecarCalls).toHaveLength(0);

    // >400 ids also refuses.
    const manyIds = Array.from({ length: 401 }, (_, i) => `id-${i}`);
    seedMessage(jid, 'filler', '占位', { timestamp: ts(2) });
    const tooMany = await post(jid, { messageIds: manyIds });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ error: 'invalid_args' });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('messageIds and agentIds are mutually exclusive', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话一', { timestamp: ts(0) });

    const res = await post(jid, {
      messageIds: ['main-1'],
      agentIds: [''],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    expect(sidecarCalls).toHaveLength(0);
  });

  test('rejects malformed messageIds and agentId inputs', async () => {
    const jid = seedWorkspace();
    seedMessage(jid, 'main-1', '主会话一', { timestamp: ts(0) });

    for (const bad of [
      { messageIds: 'x' },
      { messageIds: [] },
      { messageIds: [1] },
      { messageIds: ['ok'], agentId: 5 },
      { messageIds: ['ok'], agentId: 'x'.repeat(129) },
    ]) {
      const res = await post(jid, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_args' });
    }
    expect(sidecarCalls).toHaveLength(0);
  });
});
