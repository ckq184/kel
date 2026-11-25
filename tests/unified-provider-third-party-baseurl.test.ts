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

// ─── 路由层测试基建（沿用 routes-provider-runtime-apply.test.ts 模式）─────
// 注意：schemas.js 会静态牵出 web-context → db → config 依赖链，故本文件对
// src 一律走动态 import，保证 vi.mock 的 config 工厂执行时 tmpDir 已就绪。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-tp-baseurl-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'tp-baseurl-admin',
        username: 'tp-baseurl-admin',
        display_name: 'Third Party Baseurl Admin',
        role: 'admin',
        status: 'active',
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { UnifiedProviderCreateSchema } = await import('../src/schemas.js');

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

const TOKEN_WITHOUT_BASE_URL_ERROR =
  '第三方供应商使用 Auth Token 时必须配置 Base URL';
const NEITHER_BASE_URL_NOR_TOKEN_ERROR =
  '第三方供应商需要提供 Base URL 或 Auth Token';

function storedProvider(providerId: string) {
  return runtimeConfig.getProviders().find((p) => p.id === providerId);
}

async function patchProvider(
  providerId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function putProviderSecrets(
  providerId: string,
  secrets: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}/secrets`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(secrets),
  });
}

// ISSUE-07 项10：third_party 供应商使用 Auth Token 时必须配置 Base URL。
// THESIS-02：接口封口后 type 只接受 third_party，官方型不再可由接口创建。
describe('unified provider third_party base URL rules', () => {
  test('official is rejected at the schema', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'official-bearer',
      type: 'official',
      anthropicAuthToken: 'sk-official-token',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['type'],
        }),
      ]),
    );
  });

  test('third_party + auth-token-only is rejected on anthropicBaseUrl', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-token-only',
      type: 'third_party',
      anthropicAuthToken: 'sk-third-party-token',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['anthropicBaseUrl'],
          message: '第三方供应商使用 Auth Token 时必须配置 Base URL',
        }),
      ]),
    );
  });

  test('third_party + auth token + base URL is allowed', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-full',
      type: 'third_party',
      anthropicAuthToken: 'sk-third-party-token',
      anthropicBaseUrl: 'https://gateway.example.test',
    });
    expect(result.success).toBe(true);
  });

  test('third_party + base-URL-only is allowed (local gateway without auth)', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-gateway',
      type: 'third_party',
      anthropicBaseUrl: 'http://127.0.0.1:8082',
    });
    expect(result.success).toBe(true);
  });

  test('third_party with neither base URL nor auth token stays rejected', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-empty',
      type: 'third_party',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['anthropicBaseUrl'],
          message: '第三方供应商需要提供 Base URL 或 Auth Token',
        }),
      ]),
    );
  });
});

// ─── 路由层（写入口）：PATCH 与 secrets 口不得绕过 create 口规则 ────────
// ISSUE-07 项10 规格审查修复：create 口的 superRefine 曾可被两条写路径绕过
// ——PATCH 把已持有 Auth Token 的 third_party 供应商 baseUrl 置空，以及
// secrets 口为无 baseUrl 的 third_party 供应商补设 Auth Token。
describe('provider write routes enforce the third_party base URL rule', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
    db.initDatabase();
  });

  beforeEach(() => {
    // 每用例重置供应商配置目录，保证 fixture 互不串扰（沿用
    // routes-provider-runtime-apply.test.ts 的隔离方式）。
    fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
    fs.rmSync(path.join(tmpDir, 'container-env'), {
      recursive: true,
      force: true,
    });
  });

  afterAll(() => {
    removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
  });

  test('PATCH clearing baseUrl on a token-holding third_party provider is rejected', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-token-and-baseurl',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
    });

    const response = await patchProvider(provider.id, { anthropicBaseUrl: '' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: TOKEN_WITHOUT_BASE_URL_ERROR,
    });
    expect(storedProvider(provider.id)?.anthropicBaseUrl).toBe(
      'https://gateway.example.test',
    );
  });

  test('PATCH swapping baseUrl on a token-holding third_party provider stays allowed', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-swap-baseurl',
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'gateway-token',
    });

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'https://new.example.test',
    });

    expect(response.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicBaseUrl).toBe(
      'https://new.example.test',
    );
  });

  test('PATCH on a third-party provider edits non-key fields', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-patch-target',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicApiKey: 'sk-third-party',
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'claude-sonnet-4-6',
    });

    expect(response.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicModel).toBe(
      'claude-sonnet-4-6',
    );
  });

  test('PATCH on a third_party provider with cleared token but kept baseUrl stays allowed', async () => {
    // 「token 空 + baseUrl 在场」是合法的二选一状态：先经 secrets 口清空
    // token（该清空本身必须放行），再 PATCH 改写 baseUrl 不应被拦。
    const provider = runtimeConfig.createProvider({
      name: 'tp-cleared-token',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
    });

    const clearResponse = await putProviderSecrets(provider.id, {
      clearAnthropicAuthToken: true,
    });
    expect(clearResponse.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicAuthToken).toBe('');

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'https://relay.example.test',
    });

    expect(response.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicBaseUrl).toBe(
      'https://relay.example.test',
    );
  });

  // ISSUE-16 C1（用户拍板补校验）：PATCH/secrets 不得把 third_party 写成
  // 「Base URL 与 Auth Token 双空」，与 create 口「至少填一项」一致。
  test('PATCH clearing baseUrl on a token-less third_party provider is rejected (no double-empty)', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-baseurl-only',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
    });

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: '   ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: NEITHER_BASE_URL_NOR_TOKEN_ERROR,
    });
    expect(storedProvider(provider.id)?.anthropicBaseUrl).toBe(
      'https://gateway.example.test',
    );
  });

  test('PATCH on a legacy double-empty third_party provider still edits other fields', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-legacy-double-empty',
      type: 'third_party',
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'claude-sonnet-4-6',
    });

    expect(response.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicModel).toBe(
      'claude-sonnet-4-6',
    );
  });

  test('secrets clearing the only credential of a baseUrl-less third_party provider is rejected', async () => {
    // 规则上线前的存量数据：third_party 只有 token、没有 Base URL。
    const provider = runtimeConfig.createProvider({
      name: 'tp-legacy-token-only',
      type: 'third_party',
      anthropicAuthToken: 'legacy-token',
    });

    const response = await putProviderSecrets(provider.id, {
      clearAnthropicAuthToken: true,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: NEITHER_BASE_URL_NOR_TOKEN_ERROR,
    });
    expect(storedProvider(provider.id)?.anthropicAuthToken).toBe(
      'legacy-token',
    );
  });

  test('secrets adding a token to a baseUrl-less third_party provider is rejected', async () => {
    // 无 baseUrl 的 third_party（如规则上线前的存量脏数据）不得补设 token。
    const provider = runtimeConfig.createProvider({
      name: 'tp-no-baseurl',
      type: 'third_party',
    });

    const response = await putProviderSecrets(provider.id, {
      anthropicAuthToken: 'late-token',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: TOKEN_WITHOUT_BASE_URL_ERROR,
    });
    expect(storedProvider(provider.id)?.anthropicAuthToken).toBe('');
  });

  test('secrets adding a token to a third_party provider with baseUrl stays allowed', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'tp-with-baseurl',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
    });

    const response = await putProviderSecrets(provider.id, {
      anthropicAuthToken: 'gateway-token',
    });

    expect(response.status).toBe(200);
    expect(storedProvider(provider.id)?.anthropicAuthToken).toBe(
      'gateway-token',
    );
  });

  test('secrets adding a token to a legacy official provider is rejected (rule is unconditional)', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'legacy-official-bearer-target',
      type: 'official',
      anthropicApiKey: 'official-key',
    });

    const response = await putProviderSecrets(provider.id, {
      anthropicAuthToken: 'Bearer sk-official',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: TOKEN_WITHOUT_BASE_URL_ERROR,
    });
    expect(storedProvider(provider.id)?.anthropicAuthToken).toBe('');
  });
});
