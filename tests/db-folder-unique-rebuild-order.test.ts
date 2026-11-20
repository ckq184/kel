/**
 * Pins the ordering of the registered_groups unique-folder rebuild migration
 * (task Z follow-up fix, 2026-11-10).
 *
 * The rebuild DROPs and recreates registered_groups, so every ensureColumn
 * registered BEFORE it in initDatabase's straight-line order was wiped on an
 * ancient DB's first boot (selected_skills … sender_allowlist, the
 * target_agent indexes) and only self-healed on the second boot. The rebuild
 * must therefore run after its own column dependencies (execution_mode /
 * custom_cwd / avatar_url ensureColumns) but BEFORE the additive
 * registered_groups ensureColumn family — a single initDatabase must converge
 * to the full head schema.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rebuild-order-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dbPath = path.join(store, 'messages.db');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {
    // A failed migration deliberately closes its connection.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The pre-rebuild-era schema: folder carried a UNIQUE constraint, which
 * sqlite implements as sqlite_autoindex_registered_groups_2 — exactly the
 * autoindex the migration probes for. */
function seedAncientDatabase(): void {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      container_config TEXT
    );
    INSERT INTO registered_groups (jid, name, folder, added_at)
      VALUES ('web:ancient', 'Ancient Workspace', 'ancient-folder',
              '2024-01-01T00:00:00.000Z');
  `);
  legacy.close();
}

/** A middle-era DB: still carries the folder UNIQUE constraint (the rebuild
 * migration predates its last boot) but already has populated
 * owner/home-anchoring columns. The rebuild must carry their values, not
 * reset them to NULL/0. */
function seedMiddleEraDatabase(): void {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      added_at TEXT NOT NULL,
      container_config TEXT,
      avatar_url TEXT,
      execution_mode TEXT,
      custom_cwd TEXT,
      init_source_path TEXT,
      init_git_url TEXT,
      created_by TEXT,
      owner_claim_source TEXT,
      is_home INTEGER
    );
    INSERT INTO registered_groups (
        jid, name, folder, added_at, execution_mode, custom_cwd,
        init_source_path, init_git_url, created_by, owner_claim_source, is_home)
      VALUES ('web:middle', 'Middle Era', 'middle-folder',
              '2025-06-01T00:00:00.000Z', 'host', '/data/cwd',
              '/srv/source', 'https://git.example/x.git',
              'user-42', 'explicit', 1);
  `);
  legacy.close();
}

/** Give the next test a pristine store: drop the database file (plus sqlite
 * sidecars) so each seed starts from a fresh disk state. */
function resetDatabaseFile(): void {
  try {
    db.closeDatabase();
  } catch {
    // Not open yet on the very first call.
  }
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function tableColumns(probe: Database.Database): Set<string> {
  return new Set(
    (
      probe.prepare('PRAGMA table_info(registered_groups)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function indexNames(probe: Database.Database): Set<string> {
  return new Set(
    (
      probe
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'registered_groups'",
        )
        .all() as Array<{ name: string }>
    ).map((index) => index.name),
  );
}

describe('unique-folder rebuild migration ordering', () => {
  test('one initDatabase on an ancient DB converges to the full head schema', () => {
    resetDatabaseFile();
    seedAncientDatabase();

    expect(() => db.initDatabase()).not.toThrow();
    db.closeDatabase();

    const probe = new Database(dbPath, { readonly: true });
    try {
      // The rebuild ran: the UNIQUE autoindex is gone and the row survived.
      expect(indexNames(probe)).not.toContain(
        'sqlite_autoindex_registered_groups_2',
      );
      const row = probe
        .prepare(
          'SELECT jid, name, folder FROM registered_groups WHERE jid = ?',
        )
        .get('web:ancient') as
        | { jid: string; name: string; folder: string }
        | undefined;
      expect(row).toMatchObject({
        jid: 'web:ancient',
        name: 'Ancient Workspace',
        folder: 'ancient-folder',
      });

      // Every registered_groups column family — the ones the rebuild used to
      // wipe (ensureColumns formerly above it) and the post-rebuild ones —
      // must exist after this single boot, not after a second one.
      const columns = tableColumns(probe);
      for (const column of [
        'execution_mode',
        'custom_cwd',
        'created_by',
        'is_home',
        'avatar_url',
        'target_agent_id',
        'target_main_jid',
        'reply_policy',
        'require_mention',
        'activation_mode',
        'audience_mode',
        'owner_im_id',
        'conversation_nav_mode',
        'binding_mode',
        'feishu_chat_mode',
        'sender_allowlist',
        'channel_account_id',
      ]) {
        expect(columns, `column ${column} missing after first init`).toContain(
          column,
        );
      }

      // Indexes created later in initDatabase must survive the rebuild too.
      const indexes = indexNames(probe);
      expect(indexes).toContain('idx_rg_target_agent');
      expect(indexes).toContain('idx_rg_target_main');
    } finally {
      probe.close();
    }

    // Re-initializing the migrated database stays idempotent.
    expect(() => db.initDatabase()).not.toThrow();
    db.closeDatabase();
    const recheck = new Database(dbPath, { readonly: true });
    try {
      expect(tableColumns(recheck)).toContain('sender_allowlist');
    } finally {
      recheck.close();
    }
  });

  test('a middle-era DB keeps its owner and home values through the rebuild', () => {
    resetDatabaseFile();
    seedMiddleEraDatabase();

    expect(() => db.initDatabase()).not.toThrow();
    db.closeDatabase();

    const probe = new Database(dbPath, { readonly: true });
    try {
      // The rebuild ran on this database too.
      expect(indexNames(probe)).not.toContain(
        'sqlite_autoindex_registered_groups_2',
      );
      const row = probe
        .prepare(
          `SELECT execution_mode, custom_cwd, init_source_path, init_git_url,
                  created_by, owner_claim_source, is_home
           FROM registered_groups WHERE jid = 'web:middle'`,
        )
        .get() as Record<string, unknown>;
      // Every carried column must survive with its pre-rebuild value —
      // the old INSERT hardcoded NULL for five of these and 0 for is_home,
      // silently stripping workspace ownership and home markers.
      expect(row).toMatchObject({
        execution_mode: 'host',
        custom_cwd: '/data/cwd',
        init_source_path: '/srv/source',
        init_git_url: 'https://git.example/x.git',
        created_by: 'user-42',
        owner_claim_source: 'explicit',
        is_home: 1,
      });
    } finally {
      probe.close();
    }
  });
});
