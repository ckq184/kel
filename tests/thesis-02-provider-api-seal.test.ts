/**
 * THESIS-02 供应商（一）：接口封口。
 *
 * 验收锚点：
 * - 创建官方型供应商被 Schema 拒绝（HTTP 400）；
 * - OAuth 与订阅用量三条路由下线（404）；
 * - 三处"已配置"判断只认第三方：Base URL + Auth Token，或 Base URL + API Key；
 * - 官方凭据字段不再进入 create/secrets 输入。
 *
 * storage 层仍保留 `official` 取值（D-4 ①），因此测试里仍可直接用
 * `runtimeConfig.createProvider({ type: 'official' })` 构造存量夹具，
 * 用来验证接口与判断口径已经不再把它算作可用配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis-02-'));
const dataDir = path.join(root, 'data');
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

vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authMiddleware: async (c: any, next: any) => {
    const userId = c.req.header('x-test-user');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', {
      id: userId,
      username: userId,
      display_name: userId,
      role: 'admin',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const web = await import('../src/web.js');
const { UnifiedProviderCreateSchema, UnifiedProviderSecretsSchema } =
  await import('../src/schemas.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

const adminId = 'thesis-02-admin';
const providerFile = path.join(dataDir, 'config', 'claude-provider.json');
const poolFile = path.join(dataDir, 'config', 'provider-pool.json');

function resetProviders(): void {
  fs.rmSync(providerFile, { force: true });
  fs.rmSync(poolFile, { force: true });
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-test-user': adminId };
}

function createProviderRequest(
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request('/api/config/claude/providers', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
}

async function setupStatus(): Promise<{ claudeConfigured: boolean }> {
  const response = await app.request('/api/auth/me', {
    headers: { 'x-test-user': adminId },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    setupStatus: { claudeConfigured: boolean };
  };
  return body.setupStatus;
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: adminId,
    username: adminId,
    password_hash: 'hash',
    display_name: 'Thesis 02 Admin',
    role: 'admin',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

beforeEach(resetProviders);

afterAll(() => {
  removeTmpDirRecursive(root, [db.closeDatabase]);
});

describe('provider input schema seal', () => {
  test('rejects type official', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'official-provider',
      type: 'official',
      anthropicApiKey: 'sk-official',
    });
    expect(result.success).toBe(false);
  });

  test('accepts third-party base URL + API key and strips official credential inputs', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-api-key',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicApiKey: 'sk-third-party',
      claudeCodeOauthToken: 'legacy-oauth-token',
      claudeOAuthCredentials: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('claudeCodeOauthToken' in result.data).toBe(false);
      expect('claudeOAuthCredentials' in result.data).toBe(false);
      expect(result.data.anthropicApiKey).toBe('sk-third-party');
    }
  });

  test('secrets schema rejects an official-token-only payload', () => {
    const result = UnifiedProviderSecretsSchema.safeParse({
      claudeCodeOauthToken: 'legacy-oauth-token',
    });
    expect(result.success).toBe(false);
  });
});

describe('HTTP provider interface seal', () => {
  test('POST type=official returns 400 and stores nothing', async () => {
    const response = await createProviderRequest({
      name: 'official-create',
      type: 'official',
    });

    expect(response.status).toBe(400);
    expect(runtimeConfig.getProviders()).toEqual([]);
  });

  test('POST third-party base URL + API key still works', async () => {
    const response = await createProviderRequest({
      name: 'third-party-create',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicApiKey: 'sk-third-party',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      hasAnthropicApiKey: true,
    });
    expect(runtimeConfig.getProviders()).toHaveLength(1);
  });

  test.each([
    ['GET', '/api/config/claude/providers/any-id/usage'],
    ['POST', '/api/config/claude/oauth/start'],
    ['POST', '/api/config/claude/oauth/callback'],
  ])('%s %s is removed (404)', async (method, route) => {
    const response = await app.request(route, {
      method,
      headers: jsonHeaders(),
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(response.status).toBe(404);
  });
});

describe('setupStatus only counts third-party configurations', () => {
  test('base URL + Auth Token is configured', async () => {
    runtimeConfig.createProvider({
      name: 'third-party-token',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
    });

    await expect(setupStatus()).resolves.toMatchObject({
      claudeConfigured: true,
    });
  });

  test('base URL + API Key is configured', async () => {
    runtimeConfig.createProvider({
      name: 'third-party-api-key',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicApiKey: 'sk-third-party',
    });

    await expect(setupStatus()).resolves.toMatchObject({
      claudeConfigured: true,
    });
  });

  test('official-only credentials are not configured', async () => {
    runtimeConfig.createProvider({
      name: 'legacy-official',
      type: 'official',
      anthropicApiKey: 'sk-official',
      claudeCodeOauthToken: 'legacy-oauth-token',
    });

    await expect(setupStatus()).resolves.toMatchObject({
      claudeConfigured: false,
    });
  });

  test('empty configuration is not configured', async () => {
    await expect(setupStatus()).resolves.toMatchObject({
      claudeConfigured: false,
    });
  });
});

describe('provider merge-state validation is unconditional', () => {
  test('PATCH on a legacy official token-only provider is rejected', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'legacy-official-patch',
      type: 'official',
      anthropicAuthToken: 'Bearer legacy',
      enabled: true,
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}`,
      {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ anthropicModel: 'claude-sonnet-4-6' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '第三方供应商使用 Auth Token 时必须配置 Base URL',
    });
    expect(runtimeConfig.getProviders()[0].anthropicModel).toBe('');
  });

  test('secrets adding an Auth Token to a legacy official provider is rejected', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'legacy-official-bearer',
      type: 'official',
      anthropicApiKey: 'sk-official',
      enabled: true,
    });

    const response = await app.request(
      `/api/config/claude/providers/${provider.id}/secrets`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ anthropicAuthToken: 'Bearer legacy' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: '第三方供应商使用 Auth Token 时必须配置 Base URL',
    });
    expect(runtimeConfig.getProviders()[0].anthropicAuthToken).toBe('');
  });
});
