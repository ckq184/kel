import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis19-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: path.join(tmpDir, 'db'),
    GROUPS_DIR: path.join(tmpDir, 'groups'),
  };
});

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
        id: 'thesis19-admin',
        username: 'thesis19-admin',
        display_name: 'THESIS-19 Admin',
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
const auth = await import('../src/auth.js');
const { resetAdminAccount, ResetAdminError } =
  await import('../src/reset-admin.js');

const app = web.createAppForTest({} as never);

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const existingId = 'thesis19-existing-user';
const existingUsername = 'thesis19user';
const originalLoginPhrase = 'thesis19-old-pass';
const nextLoginPhrase = 'thesis19-new-pass';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  db.createUser({
    id: existingId,
    username: existingUsername,
    password_hash: await auth.hashPassword(originalLoginPhrase),
    display_name: 'THESIS-19 User',
    role: 'member',
    status: 'disabled',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    must_change_password: false,
  });
  const now = new Date();
  db.createUserSession({
    id: 'thesis19-session',
    user_id: existingId,
    ip_address: null,
    user_agent: null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    last_active_at: now.toISOString(),
  });
});

afterAll(() => {
  removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
});

describe('reset:admin only resets the existing account', () => {
  test('unknown username fails without creating a second account', async () => {
    await expect(
      resetAdminAccount('thesis19-ghost', nextLoginPhrase),
    ).rejects.toMatchObject({
      name: 'ResetAdminError',
      code: 'user_not_found',
    });
    expect(db.getUserByUsername('thesis19-ghost')).toBeUndefined();
    expect(db.getUserCount(true)).toBe(1);
  });

  test('existing account gets a new password, admin role and fresh sessions', async () => {
    await resetAdminAccount(existingUsername, nextLoginPhrase);

    const reset = db.getUserByUsername(existingUsername);
    expect(reset).toBeDefined();
    expect(reset!.role).toBe('admin');
    expect(reset!.status).toBe('active');
    expect(reset!.deleted_at).toBeNull();
    expect(reset!.disable_reason).toBeNull();
    expect(
      await auth.verifyPassword(nextLoginPhrase, reset!.password_hash),
    ).toBe(true);
    expect(
      await auth.verifyPassword(originalLoginPhrase, reset!.password_hash),
    ).toBe(false);
    expect(db.getUserSessions(existingId)).toEqual([]);
  });

  test('short passwords are rejected', async () => {
    await expect(
      resetAdminAccount(existingUsername, 'short'),
    ).rejects.toBeInstanceOf(ResetAdminError);
  });
});

describe('reset:admin CLI entrypoint', () => {
  test('unknown username exits non-zero with a clear error', () => {
    const cliRoot = fs.mkdtempSync(path.join(tmpDir, 'cli-'));
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(root, 'src', 'reset-admin.ts'),
        'thesis19-cli-ghost',
        nextLoginPhrase,
      ],
      { cwd: cliRoot, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'User not found: thesis19-cli-ghost. reset:admin only resets the existing account.',
    );
  }, 30_000);
});

describe('system settings no longer expose the per-user container limit', () => {
  test('GET /api/config/system omits maxConcurrentContainersPerUser', async () => {
    const response = await app.request('/api/config/system');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('maxConcurrentContainersPerUser');
  });

  test('PUT rejects the retired field and does not persist it', async () => {
    // Create the settings file with a valid write first, so the check below is
    // about persistence and not merely "the file never existed".
    const valid = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ containerTimeout: 120000 }),
    });
    expect(valid.status).toBe(200);

    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentContainersPerUser: 3 }),
    });
    // The system settings schema is strict: a field removed from the backend
    // is not silently accepted and persisted.
    expect(response.status).toBe(400);

    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, 'config', 'system-settings.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('maxConcurrentContainersPerUser');

    const getResponse = await app.request('/api/config/system');
    const getBody = (await getResponse.json()) as Record<string, unknown>;
    expect(getBody).not.toHaveProperty('maxConcurrentContainersPerUser');
  });
});

describe('multi-user dead code is removed from src', () => {
  test('index.ts has no per-user reload, admin registration or limit wiring', () => {
    const source = read('src/index.ts');
    for (const symbol of [
      'reloadFeishuConnection',
      'reloadUserIMConfig',
      'reconnectUserIMChannels',
      'registerAdminUser',
      'isUserFeishuConnected',
      'isUserQQConnected',
      'isUserWeChatConnected',
      'setUserConcurrentLimitChecker',
      'createUserContainerConcurrencyChecker',
      'maxConcurrentContainersPerUser',
      'resolveOwnerHomeFolder',
      'ownerHomeFolder',
    ]) {
      expect(source.includes(symbol), symbol).toBe(false);
    }
  });

  test('im-manager.ts has no per-user sealing/locking or legacy disconnect helpers', () => {
    const source = read('src/im-manager.ts');
    for (const symbol of [
      'adminUserIds',
      'registerAdminUser',
      'sealedUsers',
      'withUserLock',
      'disconnectAllUserChannels',
      'markUserReconnectable',
      'disconnectUserFeishu',
      'disconnectUserQQ',
      'disconnectUserWeChat',
      'isFeishuConnected',
      'isQQConnected',
      'isWeChatConnected',
    ]) {
      expect(source.includes(symbol), symbol).toBe(false);
    }
    // The process-wide Feishu health probe is still used at startup.
    expect(source.includes('isAnyFeishuConnected')).toBe(true);
  });

  test('web-context.ts drops the unused IM deps', () => {
    const source = read('src/web-context.ts');
    for (const symbol of [
      'reloadFeishuConnection',
      'reloadUserIMConfig',
      'reconnectUserIMChannels',
      'isFeishuConnected',
      'isUserFeishuConnected',
      'isUserQQConnected',
      'isUserWeChatConnected',
    ]) {
      expect(source.includes(symbol), symbol).toBe(false);
    }
  });

  test('db.ts drops the zero-caller user accessors', () => {
    const source = read('src/db.ts');
    for (const symbol of [
      'getActiveAdminCount',
      'updateUserFieldsAndForceRuntimesToHost',
      'restoreUser',
    ]) {
      expect(source.includes(symbol), symbol).toBe(false);
    }
    expect(/\bdeleteUser\b/.test(source), 'deleteUser').toBe(false);
    // Live admin host-only repair path stays.
    expect(source.includes('forceActiveAdminRuntimesToHost')).toBe(true);
  });

  test('host-execution-policy.ts drops the test-only revocation window', () => {
    const source = read('src/host-execution-policy.ts');
    expect(source.includes('beginHostPrivilegeRevocation')).toBe(false);
    expect(source.includes('endHostPrivilegeRevocation')).toBe(false);
    expect(source.includes('revokingHostPrivilegeUserIds')).toBe(false);
  });

  test('the ownerHomeFolder forwarding chain is gone, the fix-F witness stays', () => {
    for (const file of [
      'src/claude-context-resolver.ts',
      'src/container-runner.ts',
      'src/index.ts',
      'src/task-scheduler.ts',
    ]) {
      expect(read(file).includes('ownerHomeFolder'), file).toBe(false);
    }
    // Deliberate regression guard: the witness parameter is intentionally
    // unused but locks broadcast routing to sourceFolder.
    expect(read('src/task-routing.ts')).toContain('_ownerHomeFolder');
    expect(read('tests/task-routing-decision.test.ts')).toContain(
      "resolveBroadcastFolder('ws-x', 'home-u1')",
    );
  });

  test('per-user container concurrency is removed from config, schema, route and queue', () => {
    for (const file of [
      'src/runtime-config.ts',
      'src/schemas.ts',
      'src/routes/config.ts',
      'src/group-queue.ts',
    ]) {
      const source = read(file);
      expect(source.includes('maxConcurrentContainersPerUser'), file).toBe(
        false,
      );
      expect(source.includes('setUserConcurrentLimitChecker'), file).toBe(
        false,
      );
    }
    expect(read('src/runtime-config.ts').includes('nullableLimitField')).toBe(
      false,
    );
    expect(
      read('src/runtime-config.ts').includes(
        'MAX_CONCURRENT_CONTAINERS_PER_USER',
      ),
    ).toBe(false);
    expect(
      read('src/runtime-config.ts').includes(
        'createUserContainerConcurrencyChecker',
      ),
    ).toBe(false);
  });
});
