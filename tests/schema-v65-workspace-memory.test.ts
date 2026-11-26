import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v65-memory-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: dataDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:legacy-project', {
    name: 'Legacy project',
    folder: 'legacy-project',
    added_at: '2026-07-28T00:00:00.000Z',
    created_by: 'alice',
    is_home: false,
  } as any);
  db.closeDatabase();

  const raw = new Database(databasePath);
  raw.exec(`
    DROP TRIGGER IF EXISTS trg_workspace_memory_store_after_workspace_insert;
    DROP TABLE IF EXISTS workspace_memory_fts;
    DROP TABLE IF EXISTS workspace_memory_audit_events;
    DROP TABLE IF EXISTS workspace_memory_outbox;
    DROP TABLE IF EXISTS workspace_memory_mutation_requests;
    DROP TABLE IF EXISTS workspace_memory_tombstones;
    DROP TABLE IF EXISTS workspace_memory_provenance;
    DROP TABLE IF EXISTS workspace_memory_versions;
    DROP TABLE IF EXISTS workspace_memory_items;
    DROP TABLE IF EXISTS workspace_memory_stores;
    UPDATE router_state SET value = '64' WHERE key = 'schema_version';
  `);
  raw.close();

  fs.mkdirSync(path.join(groupsDir, 'user-global', 'alice'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(groupsDir, 'user-global', 'alice', 'CLAUDE.md'),
    'legacy global must not be copied',
  );
  fs.mkdirSync(path.join(dataDir, 'memory', 'legacy-project'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, 'memory', 'legacy-project', '2026-07-28.md'),
    'legacy date must not be copied',
  );
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v65 Workspace Memory migration', () => {
  test('creates one empty store per workspace without importing global/date files', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.ensureUserHomeGroup('new-user', 'new-user');
    expect(
      fs.existsSync(
        path.join(groupsDir, 'user-global', 'new-user', 'CLAUDE.md'),
      ),
    ).toBe(false);
    db.closeDatabase();

    const raw = new Database(databasePath, { readonly: true });
    const store = raw
      .prepare(
        `SELECT workspace_jid, revision
         FROM workspace_memory_stores
         WHERE workspace_jid = 'web:legacy-project'`,
      )
      .get() as { workspace_jid: string; revision: number };
    expect(store).toEqual({
      workspace_jid: 'web:legacy-project',
      revision: 0,
    });
    expect(
      (
        raw
          .prepare('SELECT COUNT(*) AS count FROM workspace_memory_items')
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      raw
        .prepare(
          `SELECT 1 FROM workspace_memory_stores
           WHERE workspace_jid = 'web:main'`,
        )
        .get(),
    ).toBeTruthy();
    expect(
      raw
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_memory_fts'`,
        )
        .get(),
    ).toBeTruthy();
    // ISSUE-07 项7（用户决策 A）：workspace_memory_outbox 停写停建，v64 旧库
    // 升级路径也不再重建该表。
    expect(
      raw
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_memory_outbox'`,
        )
        .get(),
    ).toBeFalsy();
    raw.close();
  });

  test('retires workspace_memory_outbox: schema drops the table and the store no longer writes it', () => {
    // 存量清理：schema 阶段幂等 DROP，即使旧库带着 pending 行启动也被清掉。
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS workspace_memory_outbox (
        id TEXT PRIMARY KEY,
        workspace_jid TEXT NOT NULL,
        store_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      INSERT INTO workspace_memory_outbox (
        id, workspace_jid, store_id, item_id, item_revision, event_type,
        payload_json, status, created_at, updated_at
      ) VALUES (
        'wmo_legacy_pending', 'web:legacy-project', 'wms_legacy', 'wmi_legacy', 1,
        'memory.created', '{}', 'pending', '2026-07-28T00:00:00.000Z',
        '2026-07-28T00:00:00.000Z'
      );
    `);
    legacy.close();

    db.initDatabase();
    db.closeDatabase();

    const raw = new Database(databasePath, { readonly: true });
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = 'workspace_memory_outbox'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    raw.close();

    // 源码断言：store 不再建表也不再写 outbox（audit_events/tombstones 保留）。
    const storeSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'memory-store.ts'),
      'utf8',
    );
    expect(storeSource).not.toMatch(/CREATE TABLE[^;]*workspace_memory_outbox/);
    expect(storeSource).not.toMatch(/INSERT INTO workspace_memory_outbox/);
    expect(storeSource).toContain('workspace_memory_audit_events');
    expect(storeSource).toContain('workspace_memory_tombstones');
  });
});
