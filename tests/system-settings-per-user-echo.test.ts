import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'ckqclaw-system-settings-per-user-echo-'),
);

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
        id: 'settings-echo-user',
        username: 'settings-echo-user',
        display_name: 'Settings Echo User',
        role: process.env.CKQCLAW_TEST_ROLE ?? 'member',
        status: 'active',
        permissions: JSON.parse(process.env.CKQCLAW_TEST_PERMISSIONS ?? '[]'),
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const stopGroup = vi.fn(async () => {});
const reconnectUserIMChannels = vi.fn(async () => {});
const runtimeSafetyBlocks = new Map<string, Set<string>>();
const liveGroups: Record<string, any> = {};
const blockGroupsForRuntimeSafety = vi.fn(
  (jids: string[], _reason: string, source = 'default') => {
    for (const jid of jids) {
      const sources = runtimeSafetyBlocks.get(jid) ?? new Set<string>();
      sources.add(source);
      runtimeSafetyBlocks.set(jid, sources);
    }
  },
);
const unblockGroupsForRuntimeSafety = vi.fn(
  (jids: string[], source = 'default') => {
    for (const jid of jids) {
      const sources = runtimeSafetyBlocks.get(jid);
      sources?.delete(source);
      if (sources?.size === 0) runtimeSafetyBlocks.delete(jid);
    }
  },
);
const app = web.createAppForTest({
  queue: {
    stopGroup,
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety,
    unblockGroupsForRuntimeSafety,
    isGroupRuntimeSafetyBlocked: (jid: string) => runtimeSafetyBlocks.has(jid),
  },
  getRegisteredGroups: () => liveGroups,
  sessions: {},
  ensureTerminalContainerStarted: vi.fn(() => true),
  reconnectUserIMChannels,
} as any);

function asUser(role: 'admin' | 'member', permissions: string[] = []): void {
  process.env.CKQCLAW_TEST_ROLE = role;
  process.env.CKQCLAW_TEST_PERMISSIONS = JSON.stringify(permissions);
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'settings-echo-user',
    username: 'settings-echo-user',
    password_hash: 'hash',
    display_name: 'Settings Echo User',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
});

afterAll(() => {
  delete process.env.CKQCLAW_TEST_ROLE;
  delete process.env.CKQCLAW_TEST_PERMISSIONS;
  removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
});

describe('system settings per-user concurrency echo (ISSUE-07 item 1)', () => {
  test('GET /api/config/system echoes maxConcurrentContainersPerUser', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system');
    expect(response.status).toBe(200);
    const body = await response.json();
    // 未配置时默认 null（不启用按用户限制）。
    expect(body).toHaveProperty('maxConcurrentContainersPerUser', null);
  });

  test('PUT persists the per-user limit and echoes it back', async () => {
    asUser('member', ['manage_system_config']);
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrentContainersPerUser: 3 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.maxConcurrentContainersPerUser).toBe(3);

    const getResponse = await app.request('/api/config/system');
    const getBody = await getResponse.json();
    expect(getBody.maxConcurrentContainersPerUser).toBe(3);
  });

  test('PUT without the field keeps the stored per-user limit (merge semantics)', async () => {
    asUser('member', ['manage_system_config']);
    // Web 设置 UI 保存其他字段时不会带上该字段；saveSystemSettings 是
    // {...existing, ...partial} 合并语义，不得把它重置回 null。
    const response = await app.request('/api/config/system', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.maxConcurrentContainersPerUser).toBe(3);
  });
});
