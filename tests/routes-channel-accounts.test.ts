import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-accounts-route-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.CHANNEL_TEST_USER || 'owner-a',
      username: 'test',
      role: 'admin',
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const channelSecrets = await import('../src/channel-account-secrets.js');
const routes = routeModule.default;
const reload = vi.fn(async () => true);
const disconnect = vi.fn(async () => undefined);
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: reload,
  disconnectChannelAccount: disconnect,
  testChannelAccount: async () => ({ success: true }),
});

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CHANNEL_TEST_USER;
});

async function createQQ(name: string) {
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'qq',
      name,
      credentials: { appId: `qq-${name}`, appSecret: 'test-secret-token' },
    }),
  });
  return { response, body: (await response.json()) as any };
}

describe('channel account routes', () => {
  test('CRUD never returns credentials or secret_ref and enforces owner ACL', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createQQ(`Bot ${Date.now()}`);
    expect(created.response.status).toBe(201);
    expect(created.body.account).toMatchObject({
      provider: 'qq',
      owner_user_id: 'owner-a',
      has_credentials: true,
    });
    expect(JSON.stringify(created.body)).not.toContain('test-secret-token');
    expect(created.body.account).not.toHaveProperty('secret_ref');

    const list = await routes.request('/');
    const listBody = (await list.json()) as any;
    expect(
      listBody.accounts.some((a: any) => a.id === created.body.account.id),
    ).toBe(true);
    expect(JSON.stringify(listBody)).not.toContain('test-secret-token');

    process.env.CHANNEL_TEST_USER = 'owner-b';
    const hidden = await routes.request(`/${created.body.account.id}`);
    expect(hidden.status).toBe(404);
    const forbiddenDelete = await routes.request(
      `/${created.body.account.id}`,
      {
        method: 'DELETE',
      },
    );
    expect(forbiddenDelete.status).toBe(404);

    process.env.CHANNEL_TEST_USER = 'owner-a';
    const toggled = await routes.request(`/${created.body.account.id}/toggle`, {
      method: 'POST',
    });
    expect(toggled.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(created.body.account.id);
  });

  test('publishes one stable encryption key across secret saves', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    await createQQ(`Key owner ${Date.now()}`);
    const keyPath = path.join(tmp, 'config', 'claude-provider.key');
    const firstKey = fs.readFileSync(keyPath, 'utf8');
    channelSecrets.saveChannelAccountSecret('channel-account:key-race-probe', {
      botToken: 'probe',
    });
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(firstKey);
  });

  // Mode bits only: Windows FS has no POSIX permission semantics and stat
  // always reports 0o666; production runs on Linux hosts (task K §3.2).
  test.skipIf(process.platform === 'win32')(
    'encryption key material sits in a mode-0600 file inside a mode-0700 directory',
    async () => {
      process.env.CHANNEL_TEST_USER = 'owner-a';
      await createQQ(`Key mode owner ${Date.now()}`);
      const keyPath = path.join(tmp, 'config', 'claude-provider.key');
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
    },
  );

  test('failed connector cleanup keeps the account disabled and reports a retryable partial success', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createQQ(`Cleanup failure ${Date.now()}`);
    const accountId = created.body.account.id as string;
    disconnect.mockRejectedValueOnce(new Error('socket did not stop'));

    const response = await routes.request(`/${accountId}/toggle`, {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      persisted: true,
      retryable: true,
      account: { id: accountId, enabled: false },
    });
    expect(db.getChannelAccount(accountId)).toMatchObject({
      enabled: false,
      transport_status: 'error',
    });
  });

  test('deprecated Agent default is absent from the public account contract', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'qq',
        name: `No Agent fallback ${Date.now()}`,
        default_agent_profile_id: 'must-be-ignored',
        credentials: {
          appId: `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          appSecret: 'test-secret-token',
        },
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    // ISSUE-09 (v77): the deprecated column was dropped outright, so both the
    // public API and the raw row must not carry the ignored request field.
    expect(body.account).not.toHaveProperty('default_agent_profile_id');
    expect(db.getChannelAccount(body.account.id)).not.toHaveProperty(
      'default_agent_profile_id',
    );
  });

  test('delete is blocked while an account-scoped group is bound', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createQQ(`Bound ${Date.now()}`);
    const accountId = created.body.account.id as string;
    const jid = `qq:same-chat#account:${accountId}`;
    db.setRegisteredGroup(jid, {
      name: 'Bound group',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: 'owner-a',
      channel_account_id: accountId,
      target_main_jid: 'web:owner-home',
    });
    const blocked = await routes.request(`/${accountId}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ binding_count: 1 });

    db.deleteRegisteredGroup(jid);
    const removed = await routes.request(`/${accountId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(db.getChannelAccount(accountId)).toBeUndefined();
  });

  test('legacy account is protected while an unscoped group references it', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const account = db.createChannelAccount({
      id: `legacy-bound-${Date.now()}`,
      owner_user_id: 'owner-a',
      provider: 'feishu',
      name: `Legacy bound ${Date.now()}`,
      secret_ref: `channel-account:legacy-bound-${Date.now()}`,
      is_legacy_default: true,
    });
    db.setRegisteredGroup('feishu:legacy-bound-chat', {
      name: 'Legacy bound chat',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: 'owner-a',
      channel_account_id: account.id,
    });
    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ binding_count: 1 });
  });

  test('failed metadata update restores the previous credential file', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const first = await createQQ(`Atomic first ${Date.now()}`);
    const second = await createQQ(`Atomic second ${Date.now()}`);
    const firstAccount = db.getChannelAccount(first.body.account.id)!;
    const original = channelSecrets.loadChannelAccountSecret(
      firstAccount.secret_ref,
    );

    const response = await routes.request(`/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: second.body.account.name,
        credentials: {
          appId: 'qq-conflict-rollback',
          appSecret: 'replacement-must-rollback',
        },
      }),
    });
    expect(response.status).toBe(409);
    expect(
      channelSecrets.loadChannelAccountSecret(firstAccount.secret_ref),
    ).toEqual(original);
  });

  test('direct POST keeps the first provider account as default without legacy projection', async () => {
    process.env.CHANNEL_TEST_USER = 'post-defaults';
    const first = await createQQ('First QQ bot');
    expect(first.response.status).toBe(201);

    // Deliberately POST without first calling GET /channel-accounts.
    const second = await createQQ('Second QQ bot');
    expect(second.response.status).toBe(201);

    const accounts = db.listChannelAccountsForUser('post-defaults');
    expect(accounts).toHaveLength(2);
    expect(
      accounts.find((account) => account.id === first.body.account.id),
    ).toMatchObject({
      is_default: true,
      is_legacy_default: false,
    });
    expect(second.body.account).toMatchObject({
      is_default: false,
      is_legacy_default: false,
    });
  });

  test('legacy default cannot be deleted while edits and toggle persist on the account', async () => {
    process.env.CHANNEL_TEST_USER = 'legacy-owner';
    const id = `legacy-${Date.now()}`;
    const ref = channelSecrets.channelAccountSecretRef(id);
    channelSecrets.saveChannelAccountSecret(ref, {
      appId: 'legacy-account-app',
      appSecret: 'legacy-before',
    });
    db.createChannelAccount({
      id,
      owner_user_id: 'legacy-owner',
      provider: 'qq',
      name: 'Legacy QQ',
      secret_ref: ref,
      enabled: true,
      is_default: true,
      is_legacy_default: true,
    });
    const listed = await routes.request('/');
    const account = ((await listed.json()) as any).accounts.find(
      (item: any) => item.id === id,
    );
    expect(account).toMatchObject({ is_legacy_default: true });

    const patched = await routes.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          appId: 'legacy-account-app',
          appSecret: 'legacy-after',
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(channelSecrets.loadChannelAccountSecret(ref)).toMatchObject({
      appId: 'legacy-account-app',
      appSecret: 'legacy-after',
    });

    const removed = await routes.request(`/${id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(409);
    expect(db.getChannelAccount(id)).toBeDefined();

    const toggled = await routes.request(`/${id}/toggle`, {
      method: 'POST',
    });
    expect(toggled.status).toBe(200);
    expect(db.getChannelAccount(id)).toMatchObject({ enabled: false });
    expect(channelSecrets.loadChannelAccountSecret(ref)).toMatchObject({
      appSecret: 'legacy-after',
    });
  });

  test('credential reload failure rolls back metadata, secret, and auth state', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const createResponse = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'qq',
        name: `Rollback ${Date.now()}`,
        enabled: false,
        credentials: { appId: 'qq-known-good', appSecret: 'known-good' },
      }),
    });
    const created = (await createResponse.json()) as any;
    const id = created.account.id as string;
    const before = db.getChannelAccount(id)!;
    const beforeSecret = channelSecrets.loadChannelAccountSecret(
      before.secret_ref,
    );
    reload.mockResolvedValueOnce(false);

    const failed = await routes.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Must not persist',
        enabled: true,
        credentials: { appId: 'qq-known-good', appSecret: 'bad-token' },
      }),
    });
    expect(failed.status).toBe(422);
    expect(db.getChannelAccount(id)).toMatchObject({
      name: before.name,
      enabled: false,
      auth_status: 'authorized',
    });
    expect(channelSecrets.loadChannelAccountSecret(before.secret_ref)).toEqual(
      beforeSecret,
    );
  });

  test('failed promotion restores the exact previous default among three accounts', async () => {
    process.env.CHANNEL_TEST_USER = 'three-default-owner';
    const first = await createQQ('First default');
    const second = await createQQ('Second account');
    const third = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'qq',
        name: 'Third account',
        enabled: false,
        credentials: { appId: 'qq-third-good', appSecret: 'third-good' },
      }),
    });
    const thirdAccount = ((await third.json()) as any).account;
    expect(db.getChannelAccount(first.body.account.id)?.is_default).toBe(true);
    expect(db.getChannelAccount(second.body.account.id)?.is_default).toBe(
      false,
    );
    reload.mockResolvedValueOnce(false);
    const failed = await routes.request(`/${thirdAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        is_default: true,
        credentials: { appId: 'qq-third-good', appSecret: 'third-bad' },
      }),
    });
    expect(failed.status).toBe(422);
    expect(db.getChannelAccount(first.body.account.id)?.is_default).toBe(true);
    expect(db.getChannelAccount(second.body.account.id)?.is_default).toBe(
      false,
    );
    expect(db.getChannelAccount(thirdAccount.id)?.is_default).toBe(false);
  });

  test('live disconnected probe downgrades stale connected transport metadata', async () => {
    process.env.CHANNEL_TEST_USER = 'live-probe-owner';
    const created = await createQQ('Stale transport');
    db.updateChannelAccountStatus(created.body.account.id, 'connected');
    routeModule.injectChannelAccountDeps({
      reloadChannelAccount: reload,
      disconnectChannelAccount: disconnect,
      testChannelAccount: async () => ({ success: true }),
      isChannelAccountConnected: () => false,
    });
    const response = await routes.request(`/${created.body.account.id}`);
    expect((await response.json()) as any).toMatchObject({
      account: { transport_status: 'disconnected', status: 'disconnected' },
    });
    routeModule.injectChannelAccountDeps({
      reloadChannelAccount: reload,
      disconnectChannelAccount: disconnect,
      testChannelAccount: async () => ({ success: true }),
    });
  });
});
