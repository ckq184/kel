import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis20-'));

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

const TEST_USER_ID = 'thesis20-admin';

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: TEST_USER_ID,
        username: TEST_USER_ID,
        display_name: 'THESIS-20 Account',
        role: 'admin',
        status: 'active',
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const hostPolicy = await import('../src/host-execution-policy.js');
const webContext = await import('../src/web-context.js');
const { processIpcTaskOps } = await import('../src/ipc/task-ops.js');

const app = web.createAppForTest({} as never);
const root = process.cwd();

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: TEST_USER_ID,
    username: TEST_USER_ID,
    password_hash: 'hash',
    display_name: 'THESIS-20 Account',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.ensureUserHomeGroup(TEST_USER_ID, TEST_USER_ID);
});

afterAll(() => {
  removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
});

describe('single role in the backend', () => {
  test('UserRole only contains admin', () => {
    const types = read('src/types.ts');
    expect(types).toContain("export type UserRole = 'admin';");
    expect(types).not.toContain("'admin' | 'member'");
  });

  test('users.role defaults to admin', () => {
    const schema = read('src/db-schema/auth-tables.ts');
    expect(schema).toContain("role TEXT NOT NULL DEFAULT 'admin'");
  });

  test('backend and runner no longer contain role machinery', () => {
    const forbidden = [
      'adminRoleMiddleware',
      'hasHostExecutionPermission',
      'isAdminHome',
      "'member'",
      '"member"',
    ];
    const offenders: string[] = [];
    for (const dir of ['src', 'container/agent-runner/src']) {
      for (const file of listSourceFiles(path.join(root, dir))) {
        const source = fs.readFileSync(file, 'utf8');
        for (const token of forbidden) {
          if (source.includes(token)) {
            offenders.push(`${path.relative(root, file)}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('admin role middleware is gone from the auth middleware module', () => {
    const middleware = read('src/middleware/auth.ts');
    expect(middleware).not.toContain('adminRoleMiddleware');
  });
});

describe('legacy role rows', () => {
  test('rows persisted with a non-admin role are read back as admin', () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'thesis20-legacy-role',
      username: 'thesis20-legacy-role',
      password_hash: 'hash',
      display_name: 'Legacy role row',
      // Legacy database rows may carry the old role value; the reader must
      // still interpret every account as admin.
      role: 'member' as never,
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
    expect(db.getUserById('thesis20-legacy-role')?.role).toBe('admin');
  });
});

describe('host execution no longer depends on role', () => {
  test('an active owner can execute on host without a role field', () => {
    expect(hostPolicy.canExecuteOnHost({ status: 'active' })).toBe(true);
    expect(hostPolicy.canExecuteOnHost({ status: 'disabled' })).toBe(false);
    expect(hostPolicy.canExecuteOnHost(undefined)).toBe(false);
  });
});

describe('workspace ownership stays enforced for the single account', () => {
  test('another admin account cannot access the owner home workspace', () => {
    const home = {
      name: 'Home',
      folder: 'home-owner',
      added_at: new Date().toISOString(),
      is_home: true,
      created_by: 'owner-account',
      jid: 'web:home-owner',
    };
    expect(
      webContext.canAccessGroup({ id: 'owner-account' }, home as never),
    ).toBe(true);
    expect(
      webContext.canAccessGroup({ id: 'other-account' }, home as never),
    ).toBe(false);
  });

  test('non-home Agent still cannot create script tasks', async () => {
    const results: Array<Record<string, unknown>> = [];
    await processIpcTaskOps({
      data: {
        type: 'schedule_task',
        requestId: 'thesis20-request',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'web:other-workspace',
        prompt: 'run the script',
        execution_type: 'script',
        script_command: 'echo hi',
      },
      sourceGroup: 'flow-thesis20',
      isHome: false,
      sourceGroupEntry: undefined,
      tasksDir: path.join(tmpDir, 'ipc', 'flow-thesis20', 'tasks'),
      ipcAgentId: null,
      writeTaskResult: (_tasksDir, _type, _requestId, payload) => {
        results.push(payload);
      },
      getRegisteredGroups: () => ({}),
      ipcActorCanAccessGroupJid: () => true,
      ipcActorCanManageTask: () => true,
      isAdminHostOnlyOwner: () => false,
      SAFE_REQUEST_ID_RE: /^[A-Za-z0-9_-]{1,128}$/,
    } as never);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toMatch(/script/i);
  });
});

describe('formerly admin-only surfaces only need a logged-in account', () => {
  test('system settings, appearance and outbox endpoints return 200', async () => {
    for (const route of [
      '/api/config/system',
      '/api/config/appearance',
      '/api/status/channel-outbox/uncertain',
    ]) {
      const response = await app.request(route);
      expect(response.status, route).toBe(200);
    }
  });

  test('the single account receives setup status', async () => {
    const response = await app.request('/api/auth/me');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user?: Record<string, unknown>;
      setupStatus?: Record<string, unknown>;
    };
    expect(body.user?.role).toBe('admin');
    expect(body.setupStatus).toBeDefined();
  });
});
