import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis11-'));

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

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');

const app = web.createAppForTest({} as never);

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(root, relativePath));

const adminUsername = 'thesis11-admin';
const adminPhrase = 'thesis11-admin-pass';
const memberUsername = 'thesis11-member';
const memberPhrase = 'thesis11-member-pass';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'thesis11-admin',
    username: adminUsername,
    password_hash: await hashPassword(adminPhrase),
    display_name: 'THESIS-11 Admin',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.createUser({
    id: 'thesis11-member',
    username: memberUsername,
    password_hash: await hashPassword(memberPhrase),
    display_name: 'THESIS-11 Member',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
});

afterAll(() => {
  removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
});

function request(
  method: string,
  route: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return app.request(route, {
    method,
    headers:
      body === undefined
        ? headers
        : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(username: string, password: string) {
  const response = await request(
    'POST',
    '/api/auth/login',
    {},
    { username, password },
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(p));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const adminProtectedRoutes: Array<[string, string]> = [
  ['GET', '/api/config/system'],
  ['GET', '/api/config/appearance'],
  ['GET', '/api/status/channel-outbox/uncertain'],
];

describe('adminRoleMiddleware replaces the permission middleware', () => {
  test('admin can access the formerly permission-protected endpoints', async () => {
    const cookie = await login(adminUsername, adminPhrase);
    for (const [method, route] of adminProtectedRoutes) {
      const response = await request(method, route, { cookie });
      expect(response.status, `${method} ${route}`).toBe(200);
    }
  });

  test('member is rejected with 403 on the same endpoints', async () => {
    const cookie = await login(memberUsername, memberPhrase);
    for (const [method, route] of adminProtectedRoutes) {
      const response = await request(method, route, { cookie });
      expect(response.status, `${method} ${route}`).toBe(403);
    }
  });
});

describe('user responses no longer carry permissions', () => {
  test('admin /api/auth/me has no permissions field', async () => {
    const cookie = await login(adminUsername, adminPhrase);
    const response = await request('GET', '/api/auth/me', { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user?: Record<string, unknown>;
    };
    expect(body.user).toBeDefined();
    expect(body.user).not.toHaveProperty('permissions');
  });

  test('member /api/auth/me has no permissions field', async () => {
    const cookie = await login(memberUsername, memberPhrase);
    const response = await request('GET', '/api/auth/me', { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user?: Record<string, unknown>;
    };
    expect(body.user).toBeDefined();
    expect(body.user).not.toHaveProperty('permissions');
  });
});

describe('permission system source cleanup', () => {
  test('src/permissions.ts is deleted', () => {
    expect(exists('src/permissions.ts')).toBe(false);
  });

  test('backend source has no permission middleware, names or helpers', () => {
    const forbidden = [
      'requirePermission',
      'PERMISSION_TEMPLATES',
      'systemConfigMiddleware',
      'usersManageMiddleware',
      'inviteManageMiddleware',
      'auditViewMiddleware',
      'manage_system_config',
      'manage_group_env',
      'manage_users',
      'manage_invites',
      'view_audit_log',
      'getDefaultPermissions',
      'normalizePermissions',
      'parsePermissionsFromDb',
      'resolveTemplate',
      'hasPermission',
      'PermissionTemplateKey',
    ];
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(root, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const token of forbidden) {
        if (source.includes(token)) {
          offenders.push(`${path.relative(root, file)}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('backend types no longer declare permission fields or unions', () => {
    const types = read('src/types.ts');
    expect(types).not.toContain('export type Permission ');
    expect(types).not.toContain('permissions: Permission[]');
    expect(types).not.toContain('permission_template');

    const auth = read('src/routes/auth.ts');
    expect(auth).not.toContain('permissions');

    const schemas = read('src/schemas.ts');
    expect(schemas).not.toContain('ALL_PERMISSIONS');
    expect(schemas).not.toContain('PermissionValueSchema');
    expect(schemas).not.toContain('permission_template');
  });

  test('frontend source has no permission gates or permission type', () => {
    const forbidden = [
      'requiredPermission',
      'requiredAnyPermissions',
      'hasPermission',
      'canManage',
      'manage_system_config',
      'filterNavItems',
    ];
    const offenders: string[] = [];
    for (const file of listSourceFiles(path.join(root, 'web/src'))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const token of forbidden) {
        if (source.includes(token)) {
          offenders.push(`${path.relative(root, file)}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    const store = read('web/src/stores/auth.ts');
    expect(store).not.toContain('Permission');
    expect(store).not.toContain('permissions');
  });

  test('all old permission middleware mounts were replaced by admin role checks', () => {
    const countMounts = (source: string) =>
      (source.match(/authMiddleware,\s*adminRoleMiddleware/g) || []).length;

    // config 原有 5 处 adminRole + 16 处 systemConfig 替换
    expect(countMounts(read('src/routes/config.ts'))).toBe(21);
    // monitor 4 处 systemConfig 替换
    expect(countMounts(read('src/routes/monitor.ts'))).toBe(4);
  });

  test('monitor route is guarded by role instead of permission', () => {
    const appSource = read('web/src/App.tsx');
    expect(appSource).not.toContain('requiredPermission');
    expect(appSource).toContain('requireAdmin');
  });

  test('e2e user fixture no longer carries permissions', () => {
    const harness = read('web/tests/e2e/mobile-chat-harness.tsx');
    expect(harness).not.toContain('permissions:');
  });
});
