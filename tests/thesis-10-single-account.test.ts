import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis10-'));

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

const username = 'thesis10user';
const loginPhrase = 'thesis10-pass';
const nextLoginPhrase = 'thesis10-newpass';
let loginHash = '';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(root, relativePath));

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  loginHash = await hashPassword(loginPhrase);
  const now = new Date().toISOString();
  db.createUser({
    id: 'thesis10-user',
    username,
    password_hash: loginHash,
    display_name: 'THESIS-10 User',
    role: 'admin',
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

async function login() {
  const response = await request(
    'POST',
    '/api/auth/login',
    {},
    {
      username,
      password: loginPhrase,
    },
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}

describe('single-account API surface', () => {
  test('registration endpoints are gone', async () => {
    const cases: Array<[string, string]> = [
      ['GET', '/api/auth/register/status'],
      ['POST', '/api/auth/register'],
      ['GET', '/api/config/registration'],
      ['PUT', '/api/config/registration'],
    ];
    for (const [method, route] of cases) {
      const response = await request(method, route);
      expect(response.status, `${method} ${route}`).toBe(404);
    }
  });

  test('all admin endpoints are gone', async () => {
    const cases: Array<[string, string]> = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users'],
      ['PATCH', '/api/admin/users/thesis10-user'],
      ['DELETE', '/api/admin/users/thesis10-user'],
      ['POST', '/api/admin/users/thesis10-user/restore'],
      ['DELETE', '/api/admin/users/thesis10-user/sessions'],
      ['GET', '/api/admin/permission-templates'],
      ['GET', '/api/admin/invites'],
      ['POST', '/api/admin/invites'],
      ['DELETE', '/api/admin/invites/thesis10-code'],
      ['GET', '/api/admin/audit-log'],
      ['GET', '/api/admin/audit-log/export'],
    ];
    for (const [method, route] of cases) {
      const response = await request(method, route);
      expect(response.status, `${method} ${route}`).toBe(404);
    }
  });

  test('login rate-limit settings stay available through the backend', async () => {
    const cookie = await login();
    const response = await request('GET', '/api/config/system', { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('maxLoginAttempts');
    expect(body).toHaveProperty('loginLockoutMinutes');
  });
});

describe('audit writes stop', () => {
  test('login, logout and password change write no auth audit rows', async () => {
    expect(db.queryAuthAuditLogs().total).toBe(0);

    const firstCookie = await login();
    const logout = await request('POST', '/api/auth/logout', {
      cookie: firstCookie,
    });
    expect(logout.status).toBe(200);

    const secondCookie = await login();
    const changed = await request(
      'PUT',
      '/api/auth/password',
      { cookie: secondCookie },
      {
        current_password: loginPhrase,
        new_password: nextLoginPhrase,
      },
    );
    expect(changed.status).toBe(200);

    expect(db.queryAuthAuditLogs().total).toBe(0);
  });
});

describe('frontend and source cleanup', () => {
  test('registration and user-management files are deleted', () => {
    for (const file of [
      'src/routes/admin.ts',
      'web/src/pages/UsersPage.tsx',
      'web/src/pages/RegisterPage.tsx',
      'web/src/stores/users.ts',
      'web/src/components/settings/RegistrationSection.tsx',
      'web/src/components/users/AuditLogTab.tsx',
      'web/src/components/users/InviteCodesTab.tsx',
      'web/src/components/users/UserListTab.tsx',
      'web/src/components/users/utils.ts',
    ]) {
      expect(exists(file), file).toBe(false);
    }
  });

  test('routes and login page no longer expose registration or users', () => {
    const appSource = read('web/src/App.tsx');
    expect(appSource).not.toContain('UsersPage');
    expect(appSource).not.toContain('RegisterPage');
    expect(appSource).not.toContain('path="/users"');
    expect(appSource).not.toContain('path="/register"');
    expect(appSource).not.toContain('manage_users');

    const loginSource = read('web/src/pages/LoginPage.tsx');
    expect(loginSource).not.toContain('/api/auth/register');
    expect(loginSource).not.toContain('RegisterStatus');
    expect(loginSource).not.toContain('邀请码');
    expect(loginSource).not.toContain('register');
  });

  test('settings navigation only keeps runtime status under management', () => {
    const navSource = read('web/src/components/settings/SettingsNav.tsx');
    expect(navSource).not.toContain("key: 'registration'");
    expect(navSource).not.toContain("key: 'users'");
    expect(navSource).not.toContain('UserPlus');
    expect(navSource).not.toContain('UserCog');
    expect(navSource).toContain("key: 'monitor'");
  });

  test('registration policy page and security fields are removed', () => {
    const settingsSource = read('web/src/pages/SettingsPage.tsx');
    expect(settingsSource).not.toContain('RegistrationSection');
    expect(settingsSource).not.toContain('UsersPage');
    expect(settingsSource).not.toContain('canManageUsers');
    expect(settingsSource).not.toContain('scope="security"');
    expect(settingsSource).not.toContain("'registration'");
    expect(settingsSource).not.toContain("'users'");

    const sectionSource = read(
      'web/src/components/settings/SystemSettingsSection.tsx',
    );
    expect(sectionSource).not.toContain('maxLoginAttempts');
    expect(sectionSource).not.toContain('loginLockoutMinutes');
    expect(sectionSource).not.toContain('普通成员仍固定使用');
    expect(sectionSource).not.toContain('scope:');

    const typesSource = read('web/src/components/settings/types.ts');
    expect(typesSource).not.toContain('maxLoginAttempts');
    expect(typesSource).not.toContain('loginLockoutMinutes');
    expect(typesSource).not.toContain("'registration'");
    expect(typesSource).not.toContain("'users'");
  });

  test('backend source has no registration or admin route', () => {
    const authSource = read('src/routes/auth.ts');
    expect(authSource).not.toContain('logAuthEvent');
    expect(authSource).not.toContain('/register');
    expect(authSource).not.toContain('registerUserWith');
    expect(authSource).not.toContain('getRegistrationConfig');
    expect(authSource).not.toContain('RegisterSchema');

    const configSource = read('src/routes/config.ts');
    expect(configSource).not.toContain('logAuthEvent');
    expect(configSource).not.toContain('/registration');
    expect(configSource).not.toContain('getRegistrationConfig');
    expect(configSource).not.toContain('saveRegistrationConfig');
    expect(configSource).not.toContain('RegistrationConfigSchema');

    const webSource = read('src/web.ts');
    expect(webSource).not.toContain('adminRoutes');
    expect(webSource).not.toContain('/api/admin');

    const runtimeSource = read('src/runtime-config.ts');
    expect(runtimeSource).not.toContain('getRegistrationConfig');
    expect(runtimeSource).not.toContain('saveRegistrationConfig');
    expect(runtimeSource).not.toContain('registration.json');

    const schemaSource = read('src/schemas.ts');
    expect(schemaSource).not.toContain('RegisterSchema');
    expect(schemaSource).not.toContain('RegistrationConfigSchema');
  });

  test('docs no longer advertise removed routes', () => {
    const api = read('docs/API.md');
    expect(api).not.toContain('/api/admin');
    expect(api).not.toContain('/api/auth/register');
    expect(api).not.toContain('/api/config/registration');

    const acl = read('docs/ACL-MATRIX.md');
    expect(acl).not.toContain('/api/auth/register');

    const claude = read('CLAUDE.md');
    expect(claude).not.toContain('/users');
    expect(claude).not.toContain('/register');
  });
});
