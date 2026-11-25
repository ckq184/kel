/**
 * ISSUE-21 C5（ISSUE-09 遗留的负向用例）：POST /api/auth/avatar 只服务当前
 * 登录用户的头像。未知 target（包括已下线的 `target=ai`）必须返回 400，且
 * 不写头像文件、不改用户记录；未登录请求在进入处理器之前被拒绝。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-routes-avatar-'));
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

// The real middleware verifies a signed session cookie; this stand-in keeps
// the same contract (no credential → 401 before the handler runs).
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  authMiddleware: async (c: any, next: any) => {
    const userId = c.req.header('x-test-user');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', {
      id: userId,
      username: userId,
      role: 'member',
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const { AVATARS_DIR } = await import('../src/avatar-upload.js');
const { default: authRoutes } = await import('../src/routes/auth.js');

const userId = 'avatar-user';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function avatarRequest(query: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append(
    'avatar',
    new File([PNG_1X1], 'avatar.png', { type: 'image/png' }),
  );
  return authRoutes.request(`/avatar${query}`, {
    method: 'POST',
    body: form,
    headers,
  });
}

function avatarFiles(): string[] {
  return fs.existsSync(AVATARS_DIR) ? fs.readdirSync(AVATARS_DIR) : [];
}

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: userId,
    username: userId,
    password_hash: 'hash',
    display_name: 'Avatar User',
    role: 'member',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /api/auth/avatar negative paths', () => {
  test.each(['?target=ai', '?target=bogus'])(
    'unknown target %s returns 400 without writing a file or touching the user',
    async (query) => {
      const before = db.getUserById(userId)?.avatar_url ?? null;
      const res = await avatarRequest(query, { 'x-test-user': userId });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('/api/config/appearance/avatar');
      expect(avatarFiles()).toEqual([]);
      expect(db.getUserById(userId)?.avatar_url ?? null).toBe(before);
    },
  );

  test('an unauthenticated upload is rejected before the handler runs', async () => {
    const res = await avatarRequest('');
    expect(res.status).toBe(401);
    expect(avatarFiles()).toEqual([]);
  });
});
