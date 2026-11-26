import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

// THESIS-21：系统只保留管理员一个角色。前端不再按角色显隐页面或控件，
// 公开用户对象保留 role: 'admin' 并去掉只对多用户有意义的字段。
//
// MCP 页面按 issue 非目标“不改 MCP 页面（THESIS-37）”豁免：系统/个人
// 作用域与“导入宿主机副本”的角色门随 THESIS-37 一起删除。
const MCP_ROLE_GATE_EXEMPT = new Set([
  'web/src/pages/McpServersPage.tsx',
  'web/src/components/mcp-servers/AddMcpServerDialog.tsx',
]);

const root = process.cwd();
const webSourceRoot = path.join(root, 'web/src');

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolute));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files;
}

// 用 TypeScript scanner 剔除注释 token，避免把解释“为什么不再按角色判断”
// 的注释误判成角色门（与 thesis-16 的文案门禁同一方法）。
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.JSX,
    source,
  );
  let result = '';
  let lastEnd = 0;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; ) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      result += source.slice(lastEnd, scanner.getTokenPos());
      lastEnd = scanner.getTextPos();
    }
    token = scanner.scan();
  }
  return result + source.slice(lastEnd);
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function interfaceBlock(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
  );
  expect(match, `${name} interface`).not.toBeNull();
  return match![0];
}

// The user object returned by login/me/profile must keep the single role but
// drop fields that only existed to describe other accounts.
const USER_PUBLIC_FORBIDDEN_FIELDS = [
  'disable_reason',
  'notes',
  'deleted_at',
] as const;

describe('frontend role gates are gone', () => {
  test('web source has no admin guard, role comparison, or multi-user wording', () => {
    const offenders = listSourceFiles(webSourceRoot).flatMap((file) => {
      const relative = path.relative(root, file);
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      const findings: string[] = [];
      if (source.includes('requireAdmin')) {
        findings.push(`${relative}: requireAdmin`);
      }
      if (source.includes('多用户')) {
        findings.push(`${relative}: 多用户`);
      }
      if (source.includes("'member'")) {
        findings.push(`${relative}: 'member'`);
      }
      if (MCP_ROLE_GATE_EXEMPT.has(relative)) return findings;
      const roleComparison = source.match(/\brole\s*[!=]==\s*['"]admin['"]/);
      if (roleComparison) {
        findings.push(`${relative}: ${roleComparison[0]}`);
      }
      return findings;
    });

    expect(offenders).toEqual([]);
  });

  test('frontend user type keeps the single admin role and drops multi-user fields', () => {
    const block = interfaceBlock(read('web/src/stores/auth.ts'), 'UserPublic');

    expect(block).toContain("role: 'admin';");
    expect(block).not.toContain("'member'");
    expect(block).toContain('status:');
    for (const field of USER_PUBLIC_FORBIDDEN_FIELDS) {
      expect(block, field).not.toContain(field);
    }
  });

  test('shared backend user type has the same narrowed shape', () => {
    const block = interfaceBlock(read('src/types.ts'), 'UserPublic');

    expect(block).toContain('role: UserRole;');
    expect(block).toContain('status: UserStatus;');
    for (const field of USER_PUBLIC_FORBIDDEN_FIELDS) {
      expect(block, field).not.toContain(field);
    }
  });
});

// --- Auth API contract -------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-thesis21-'));

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

const username = 'thesis21-admin';
const loginPhrase = 'thesis21-pass';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'thesis21-admin-id',
    username,
    password_hash: await hashPassword(loginPhrase),
    display_name: 'THESIS-21 Admin',
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

function expectNarrowUser(user: Record<string, unknown>) {
  expect(user.role).toBe('admin');
  for (const field of USER_PUBLIC_FORBIDDEN_FIELDS) {
    expect(user, field).not.toHaveProperty(field);
  }
}

async function login(): Promise<string> {
  const response = await request(
    'POST',
    '/api/auth/login',
    {},
    { username, password: loginPhrase },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    user: Record<string, unknown>;
  };
  expectNarrowUser(body.user);
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}

describe('public user object drops multi-user-only fields', () => {
  test('login returns role=admin without disable_reason/notes/deleted_at', async () => {
    await login();
  });

  test('GET /api/auth/me returns the same narrowed user object', async () => {
    const cookie = await login();
    const response = await request('GET', '/api/auth/me', { cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
    };
    expectNarrowUser(body.user);
  });

  test('profile updates return the same narrowed user object', async () => {
    const cookie = await login();
    const response = await request(
      'PUT',
      '/api/auth/profile',
      { cookie },
      { display_name: 'THESIS-21 Renamed' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
    };
    expectNarrowUser(body.user);
  });
});
