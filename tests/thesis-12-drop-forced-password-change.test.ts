import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis12-'));

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

const flaggedUsername = 'thesis12-flagged';
const flaggedPhrase = 'thesis12-flagged-pass';
const secondUsername = 'thesis12-account';
const secondPhrase = 'thesis12-account-pass';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'thesis12-flagged',
    username: flaggedUsername,
    password_hash: await hashPassword(flaggedPhrase),
    display_name: 'THESIS-12 Flagged',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    // 旧库可能残留的标记：机制删掉后不应再产生任何拦截。
    must_change_password: true,
  });
  db.createUser({
    id: 'thesis12-password',
    username: secondUsername,
    password_hash: await hashPassword(secondPhrase),
    display_name: 'THESIS-12 Password',
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
  const cookie = response.headers.get('set-cookie');
  return { response, cookie: cookie ? cookie.split(';')[0] : null };
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

function interfaceBlock(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('THESIS-12 强制改密机制已去掉', () => {
  test('登录响应与 /me 不再返回强制改密状态', async () => {
    const { response, cookie } = await login(flaggedUsername, flaggedPhrase);
    expect(response.status).toBe(200);
    expect(cookie).toBeTruthy();

    const loginBody = (await response.json()) as {
      user: Record<string, unknown>;
    };
    expect(loginBody.user).not.toHaveProperty('must_change_password');

    const me = await request('GET', '/api/auth/me', { cookie: cookie! });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: Record<string, unknown> };
    expect(meBody.user).not.toHaveProperty('must_change_password');
  });

  test('被标记账号不再被 HTTP 闸门拦住', async () => {
    const { response, cookie } = await login(flaggedUsername, flaggedPhrase);
    expect(response.status).toBe(200);
    expect(cookie).toBeTruthy();

    const protectedResponse = await request('GET', '/api/config/system', {
      cookie: cookie!,
    });
    expect(protectedResponse.status).toBe(200);
  });

  test('普通改密回归：改密后旧密码失效、新密码可登录', async () => {
    const newPhrase = 'thesis12-password-new';
    const { response, cookie } = await login(secondUsername, secondPhrase);
    expect(response.status).toBe(200);
    expect(cookie).toBeTruthy();

    const change = await request(
      'PUT',
      '/api/auth/password',
      { cookie: cookie! },
      { current_password: secondPhrase, new_password: newPhrase },
    );
    expect(change.status).toBe(200);
    const changeBody = (await change.json()) as {
      user: Record<string, unknown>;
    };
    expect(changeBody.user).not.toHaveProperty('must_change_password');

    const oldLogin = await login(secondUsername, secondPhrase);
    expect(oldLogin.response.status).toBe(401);
    const newLogin = await login(secondUsername, newPhrase);
    expect(newLogin.response.status).toBe(200);
  });

  test('后端业务层不再出现强制改密闸门', () => {
    const backendFiles = [
      'src/middleware/auth.ts',
      'src/web.ts',
      'src/routes/auth.ts',
      'src/reset-admin.ts',
    ];
    for (const file of backendFiles) {
      expect(read(file).includes('must_change_password'), file).toBe(false);
      expect(read(file).includes('PASSWORD_CHANGE_REQUIRED'), file).toBe(false);
    }

    const types = read('src/types.ts');
    expect(interfaceBlock(types, 'AuthUser')).not.toContain(
      'must_change_password',
    );
    expect(interfaceBlock(types, 'UserPublic')).not.toContain(
      'must_change_password',
    );
  });

  test('前端与 API 客户端不再出现强制改密跳转与拦截', () => {
    const frontendFiles = listSourceFiles(path.join(root, 'web/src'));
    for (const file of frontendFiles) {
      const source = fs.readFileSync(file, 'utf8');
      const relative = path.relative(root, file);
      expect(source.includes('must_change_password'), relative).toBe(false);
      expect(source.includes('mustChangePassword'), relative).toBe(false);
      expect(source.includes('PASSWORD_CHANGE_REQUIRED'), relative).toBe(false);
    }

    for (const file of listSourceFiles(path.join(root, 'src'))) {
      expect(
        fs.readFileSync(file, 'utf8').includes('PASSWORD_CHANGE_REQUIRED'),
        path.relative(root, file),
      ).toBe(false);
    }
  });
});
