import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeTmpDirRecursive } from './helpers/remove-tmp-dir.js';
import {
  asRouteTestUser,
  createTestUserRow,
} from './helpers/route-test-user.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-workspaces-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.CKQCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      username: process.env.CKQCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      role: process.env.CKQCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/workspaces.js');
const routes = routeModule.default;

const OWNER_ID = 'routes-workspace-owner';
const STRANGER_ID = 'routes-workspace-stranger';
const OTHER_OWNER_ID = 'routes-workspace-other-owner';

beforeAll(() => {
  db.initDatabase();
  for (const id of [OWNER_ID, STRANGER_ID, OTHER_OWNER_ID]) {
    createTestUserRow(db, id);
  }
});

afterEach(() => {
  delete process.env.CKQCLAW_TEST_USER_ID;
  delete process.env.CKQCLAW_TEST_USER_ROLE;
});

afterAll(() => {
  removeTmpDirRecursive(tmpDir, [db.closeDatabase]);
});

describe('/api/workspaces canonical read routes', () => {
  test('owner can list workspace summaries and inspect sessions plus mounts', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Canonical Agent',
      identityPrompt: 'Operate from canonical workspace state.',
    });
    db.setRegisteredGroup('web:canonical-owned', {
      name: 'Canonical Owned',
      folder: 'canonical-owned',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('canonical-owned', profile.id);
    db.setSession('canonical-owned', 'claude-canonical-main', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    db.setRegisteredGroup('qq:c2c:canonical-owned-chat', {
      name: 'Canonical Telegram',
      folder: 'owner-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      target_main_jid: 'web:canonical-owned',
      reply_policy: 'mirror',
    });

    asRouteTestUser(OWNER_ID);
    const listRes = await routes.request('/', { method: 'GET' });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.workspaces).toContainEqual(
      expect.objectContaining({
        jid: 'web:canonical-owned',
        folder: 'canonical-owned',
        owner_user_id: OWNER_ID,
        runtime_session_count: 1,
        channel_mount_count: 1,
        agent_profile: expect.objectContaining({
          id: profile.id,
          version: profile.version,
        }),
      }),
    );

    const detailRes = await routes.request('/web:canonical-owned', {
      method: 'GET',
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.runtime_sessions).toEqual([
      expect.objectContaining({
        runtime_agent_id: '',
        sdk_session_id: 'claude-canonical-main',
        agent_profile_id: profile.id,
        agent_profile_version: profile.version,
      }),
    ]);
    expect(detailBody.channel_mounts).toEqual([
      expect.objectContaining({
        channel_jid: 'qq:c2c:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
        workspace_folder: 'canonical-owned',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'mirror',
        agent_profile_id: profile.id,
      }),
    ]);
  });

  test('non-owners cannot list or inspect another account workspace', async () => {
    asRouteTestUser(STRANGER_ID);
    const strangerListRes = await routes.request('/', { method: 'GET' });
    const strangerListBody = await strangerListRes.json();
    expect(strangerListBody.workspaces).not.toContainEqual(
      expect.objectContaining({ jid: 'web:canonical-owned' }),
    );
    const strangerDetailRes = await routes.request('/web:canonical-owned', {
      method: 'GET',
    });
    expect(strangerDetailRes.status).toBe(404);
  });

  test('mount listing is filtered by visible workspaces', async () => {
    db.setRegisteredGroup('web:canonical-other', {
      name: 'Other Owner Workspace',
      folder: 'canonical-other',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      is_home: false,
    });
    db.setRegisteredGroup('qq:c2c:canonical-other-chat', {
      name: 'Other Telegram',
      folder: 'other-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      target_main_jid: 'web:canonical-other',
    });

    asRouteTestUser(OWNER_ID);
    const res = await routes.request('/mounts', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: 'qq:c2c:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
      }),
    );
    expect(body.channel_mounts).not.toContainEqual(
      expect.objectContaining({
        channel_jid: 'qq:c2c:canonical-other-chat',
      }),
    );
  });
});
