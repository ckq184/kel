import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-upgrade-safety-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dbPath = path.join(store, 'messages.db');
const migrationBackups = path.join(tmp, 'migration-backups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  delete process.env.CKQCLAW_MIGRATION_BACKUP_DIR;
  try {
    db.closeDatabase();
  } catch {
    // A failed migration deliberately closes its connection.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tableExists(probe: Database.Database, table: string): boolean {
  return Boolean(
    probe
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function tableColumns(probe: Database.Database, table: string): string[] {
  return (
    probe.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

// Fabrication helper: re-add a retired column when the current head schema no
// longer creates it, so a fake v76 database converges regardless of which
// schema version the test process booted from.
function addColumnIfMissing(
  probe: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  if (!tableColumns(probe, table).includes(column)) {
    probe.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

describe('database upgrade safety gate', () => {
  test('backs up before destructive migration, preserves audit orphans, and aborts when backup fails', () => {
    db.initDatabase();
    db.closeDatabase();
    expect(fs.existsSync(migrationBackups)).toBe(false);

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'audit-workspace', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      CREATE TABLE balance_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        balance_after REAL NOT NULL,
        description TEXT,
        reference_type TEXT,
        reference_id TEXT,
        actor_id TEXT,
        source TEXT NOT NULL DEFAULT 'system_adjustment',
        operator_type TEXT NOT NULL DEFAULT 'system',
        notes TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description,
        source, operator_type, created_at
      ) VALUES (
        'deleted-user', 'adjustment', 12.5, 12.5, 'retained audit evidence',
        'system_adjustment', 'system', '2026-07-16T00:00:00.000Z'
      );
      UPDATE router_state SET value = '39' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.CKQCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();

    const backupNames = fs.readdirSync(migrationBackups);
    expect(backupNames).toHaveLength(1);
    const backup = new Database(path.join(migrationBackups, backupNames[0]), {
      readonly: true,
    });
    expect(
      (
        backup
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('39');
    expect(tableExists(backup, 'group_members')).toBe(true);
    expect(
      (
        backup
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE user_id = 'deleted-user'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    backup.close();

    const migrated = new Database(dbPath);
    expect(tableExists(migrated, 'group_members')).toBe(false);
    // v76 prune: the retired billing tables are dropped outright — the
    // retained audit evidence lives in the pre-migration backup above.
    expect(tableExists(migrated, 'balance_transactions')).toBe(false);
    migrated.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'must-survive', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      UPDATE router_state SET value = '50' WHERE key = 'schema_version';
    `);
    migrated.close();

    const invalidBackupDir = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(invalidBackupDir, 'blocks mkdir');
    process.env.CKQCLAW_MIGRATION_BACKUP_DIR = invalidBackupDir;
    expect(() => db.initDatabase()).toThrow(/pre-migration backup failed/);

    const afterFailure = new Database(dbPath, { readonly: true });
    expect(tableExists(afterFailure, 'group_members')).toBe(true);
    expect(
      (
        afterFailure
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('50');
    afterFailure.close();

    process.env.CKQCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    db.initDatabase();
    db.closeDatabase();
    const backupCountAfterRetry = fs.readdirSync(migrationBackups).length;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();
    expect(fs.readdirSync(migrationBackups)).toHaveLength(
      backupCountAfterRetry,
    );
  });

  test('v72 drops the approval-gate audit table on upgrade from v71', () => {
    db.initDatabase();
    db.closeDatabase();

    // Fabricate a v71 database that still carries pending_approvals.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT,
        session_id TEXT,
        turn_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      );
      INSERT INTO pending_approvals VALUES (
        'legacy-approval', 'audit-workspace', 'jid', 'send_file',
        '{}', null, null, 'pending', '2026-10-17T00:00:00.000Z', null, null
      );
      UPDATE router_state SET value = '71' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    db.closeDatabase();

    const migrated = new Database(dbPath, { readonly: true });
    expect(tableExists(migrated, 'pending_approvals')).toBe(false);
    migrated.close();

    // A fresh database must not recreate the table (baseline creation was
    // removed together with the CRUD layer).
    db.initDatabase();
    db.closeDatabase();
    const fresh = new Database(dbPath, { readonly: true });
    expect(tableExists(fresh, 'pending_approvals')).toBe(false);
    fresh.close();
  });

  test('v77 drops the dead daily summary table and dead columns on upgrade from v76', () => {
    db.initDatabase();
    db.closeDatabase();

    // A fresh boot at the head schema must not carry the retired table or
    // columns at all (their creation was removed together with the write
    // paths in the same change).
    const freshBoot = new Database(dbPath, { readonly: true });
    expect(tableExists(freshBoot, 'usage_daily_summary')).toBe(false);
    for (const [table, column] of [
      ['usage_records', 'cost_usd'],
      ['usage_records', 'billed_cost_usd'],
      ['usage_events', 'billed_cost_usd'],
      ['registered_groups', 'selected_skills'],
      ['registered_groups', 'mcp_mode'],
      ['registered_groups', 'selected_mcps'],
      ['messages', 'sdk_message_uuid'],
      ['channel_accounts', 'default_agent_profile_id'],
      ['users', 'ai_name'],
      ['users', 'ai_avatar_emoji'],
      ['users', 'ai_avatar_color'],
      ['users', 'ai_avatar_url'],
      ['workspace_memory_provenance', 'recorded_at'],
    ] as Array<[string, string]>) {
      expect(
        tableColumns(freshBoot, table),
        `${table}.${column}`,
      ).not.toContain(column);
    }
    freshBoot.close();

    // Fabricate a v76 database that still carries the retired table and
    // columns, with sentinel rows proving the surviving data is untouched.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        date TEXT NOT NULL,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, model, date)
      );
      INSERT OR REPLACE INTO usage_daily_summary (
        user_id, model, date, total_cost_usd, request_count
      ) VALUES ('user-a', 'model-a', '2026-11-19', 1.25, 2);

      INSERT INTO usage_records (
        id, user_id, group_folder, model, provider_estimated_cost_usd
      ) VALUES ('usage-v76', 'user-a', 'folder-a', 'model-a', 3.5);

      INSERT INTO usage_events (event_id, user_id, group_folder)
      VALUES ('evt-v76', 'user-a', 'folder-a');

      INSERT INTO registered_groups (jid, name, folder, added_at)
      VALUES ('web:legacy-v76', 'Legacy Workspace', 'legacy-folder', '2026-11-19T00:00:00.000Z');

      INSERT INTO chats (jid, name, last_message_time)
      VALUES ('web:legacy-v76', 'Legacy Workspace', '2026-11-19T00:00:00.000Z');

      INSERT INTO messages (id, chat_jid, sender, content, timestamp)
      VALUES ('msg-v76', 'web:legacy-v76', 'user', 'sentinel', '2026-11-19T00:00:00.000Z');

      INSERT INTO channel_accounts (
        id, owner_user_id, provider, name, secret_ref, created_at, updated_at
      ) VALUES ('acct-v76', 'user-a', 'qq', 'Legacy Account', 'secret-v76',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z');

      INSERT INTO users (
        id, username, password_hash, display_name, created_at, updated_at
      ) VALUES ('user-v76', 'legacy-v76', 'hash', 'Legacy User',
        '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z');
    `);
    addColumnIfMissing(
      legacy,
      'usage_records',
      'cost_usd',
      'REAL NOT NULL DEFAULT 0',
    );
    addColumnIfMissing(
      legacy,
      'usage_records',
      'billed_cost_usd',
      'REAL NOT NULL DEFAULT 0',
    );
    addColumnIfMissing(
      legacy,
      'usage_events',
      'billed_cost_usd',
      'REAL NOT NULL DEFAULT 0',
    );
    addColumnIfMissing(legacy, 'registered_groups', 'selected_skills', 'TEXT');
    addColumnIfMissing(
      legacy,
      'registered_groups',
      'mcp_mode',
      "TEXT DEFAULT 'inherit'",
    );
    addColumnIfMissing(legacy, 'registered_groups', 'selected_mcps', 'TEXT');
    addColumnIfMissing(legacy, 'messages', 'sdk_message_uuid', 'TEXT');
    addColumnIfMissing(
      legacy,
      'channel_accounts',
      'default_agent_profile_id',
      'TEXT',
    );
    addColumnIfMissing(legacy, 'users', 'ai_name', 'TEXT');
    addColumnIfMissing(legacy, 'users', 'ai_avatar_emoji', 'TEXT');
    addColumnIfMissing(legacy, 'users', 'ai_avatar_color', 'TEXT');
    addColumnIfMissing(legacy, 'users', 'ai_avatar_url', 'TEXT');
    addColumnIfMissing(
      legacy,
      'workspace_memory_provenance',
      'recorded_at',
      "TEXT NOT NULL DEFAULT 'legacy-rec'",
    );
    legacy.exec(`
      UPDATE usage_records SET cost_usd = 1.5, billed_cost_usd = 2.5 WHERE id = 'usage-v76';
      UPDATE usage_events SET billed_cost_usd = 9.9 WHERE event_id = 'evt-v76';
      UPDATE registered_groups
      SET selected_skills = 'skill-x', mcp_mode = 'custom', selected_mcps = 'mcp-x'
      WHERE jid = 'web:legacy-v76';
      UPDATE messages SET sdk_message_uuid = 'uuid-x' WHERE id = 'msg-v76';
      UPDATE channel_accounts SET default_agent_profile_id = 'profile-x'
      WHERE id = 'acct-v76';
      UPDATE users
      SET ai_name = 'ai-x', ai_avatar_emoji = '🤖', ai_avatar_color = '#123456',
          ai_avatar_url = '/api/auth/avatars/x.png'
      WHERE id = 'user-v76';
      UPDATE router_state SET value = '76' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    db.closeDatabase();

    const migrated = new Database(dbPath, { readonly: true });
    expect(
      (
        migrated
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe(String(db.CURRENT_SCHEMA_VERSION));
    expect(tableExists(migrated, 'usage_daily_summary')).toBe(false);
    for (const [table, column] of [
      ['usage_records', 'cost_usd'],
      ['usage_records', 'billed_cost_usd'],
      ['usage_events', 'billed_cost_usd'],
      ['registered_groups', 'selected_skills'],
      ['registered_groups', 'mcp_mode'],
      ['registered_groups', 'selected_mcps'],
      ['messages', 'sdk_message_uuid'],
      ['channel_accounts', 'default_agent_profile_id'],
      ['users', 'ai_name'],
      ['users', 'ai_avatar_emoji'],
      ['users', 'ai_avatar_color'],
      ['users', 'ai_avatar_url'],
      ['workspace_memory_provenance', 'recorded_at'],
    ] as Array<[string, string]>) {
      expect(
        tableColumns(migrated, table),
        `${table}.${column} survived the v77 trim`,
      ).not.toContain(column);
    }
    // Surviving data is intact — the trim dropped columns, not rows.
    expect(
      (
        migrated
          .prepare(
            "SELECT provider_estimated_cost_usd AS cost FROM usage_records WHERE id = 'usage-v76'",
          )
          .get() as { cost: number }
      ).cost,
    ).toBe(3.5);
    expect(
      migrated
        .prepare(
          "SELECT name, folder FROM registered_groups WHERE jid = 'web:legacy-v76'",
        )
        .get() as { name: string; folder: string },
    ).toEqual({ name: 'Legacy Workspace', folder: 'legacy-folder' });
    expect(
      (
        migrated
          .prepare(
            "SELECT content FROM messages WHERE id = 'msg-v76' AND chat_jid = 'web:legacy-v76'",
          )
          .get() as { content: string }
      ).content,
    ).toBe('sentinel');
    expect(
      (
        migrated
          .prepare("SELECT display_name FROM users WHERE id = 'user-v76'")
          .get() as { display_name: string }
      ).display_name,
    ).toBe('Legacy User');
    expect(
      (
        migrated
          .prepare("SELECT name FROM channel_accounts WHERE id = 'acct-v76'")
          .get() as { name: string }
      ).name,
    ).toBe('Legacy Account');
    expect(
      (
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM usage_events WHERE event_id = 'evt-v76'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    migrated.close();

    // Re-boot on the migrated database stays idempotent and does not
    // resurrect the retired table or columns.
    db.initDatabase();
    db.closeDatabase();
    const reboot = new Database(dbPath, { readonly: true });
    expect(tableExists(reboot, 'usage_daily_summary')).toBe(false);
    expect(tableColumns(reboot, 'usage_records')).not.toContain('cost_usd');
    expect(tableColumns(reboot, 'users')).not.toContain('ai_name');
    reboot.close();
  });

  test('v78 drops the legacy scheduled_tasks lease columns on upgrade from v77', () => {
    db.initDatabase();
    db.closeDatabase();

    // A fresh boot at the head schema no longer creates the columns.
    const freshBoot = new Database(dbPath, { readonly: true });
    expect(tableColumns(freshBoot, 'scheduled_tasks')).not.toContain(
      'running_until',
    );
    expect(tableColumns(freshBoot, 'scheduled_tasks')).not.toContain(
      'runner_id',
    );
    freshBoot.close();

    // Fabricate a v77 database whose task still carries a legacy lease.
    const legacy = new Database(dbPath);
    addColumnIfMissing(legacy, 'scheduled_tasks', 'running_until', 'TEXT');
    addColumnIfMissing(legacy, 'scheduled_tasks', 'runner_id', 'TEXT');
    legacy.exec(`
      INSERT INTO scheduled_tasks (
        id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
        next_run, status, created_at, running_until, runner_id
      ) VALUES ('task-v77', 'folder-a', 'web:folder-a', 'sentinel prompt',
        'cron', '0 * * * *', '2026-11-24T01:00:00.000Z', 'active',
        '2026-11-24T00:00:00.000Z', '2026-11-24T00:30:00.000Z', 'runner-x');
      UPDATE router_state SET value = '77' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    db.closeDatabase();

    const migrated = new Database(dbPath, { readonly: true });
    expect(
      (
        migrated
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe(String(db.CURRENT_SCHEMA_VERSION));
    const columns = tableColumns(migrated, 'scheduled_tasks');
    expect(columns).not.toContain('running_until');
    expect(columns).not.toContain('runner_id');
    // The trim dropped columns, not rows or the live schedule.
    expect(
      migrated
        .prepare(
          "SELECT prompt, next_run, status FROM scheduled_tasks WHERE id = 'task-v77'",
        )
        .get(),
    ).toEqual({
      prompt: 'sentinel prompt',
      next_run: '2026-11-24T01:00:00.000Z',
      status: 'active',
    });
    migrated.close();

    // Re-boot stays idempotent and does not resurrect the columns.
    db.initDatabase();
    db.closeDatabase();
    const reboot = new Database(dbPath, { readonly: true });
    expect(tableColumns(reboot, 'scheduled_tasks')).not.toContain(
      'running_until',
    );
    reboot.close();
  });
});

describe('schema version head', () => {
  test('pins the head version so a bump stays a reviewed decision', () => {
    // Deliberately a literal. The migration tests above compare against
    // CURRENT_SCHEMA_VERSION, which makes each of them tautological on its
    // own: initDatabase stores the very constant they assert on. This is the
    // one assertion that fails when the head moves, forcing whoever bumps it
    // to confirm the matching migration block — and a test covering it —
    // actually landed. Update the literal in the same commit as the migration.
    //
    // MAINTENANCE OBLIGATION: every schema migration must bump this pin in
    // the same commit as its migration block. v70 and v71 both landed
    // without it and the pin rusted two versions deep (restored by the
    // Windows test-baseline triage, task K batch 1).
    // v69: adds Agent-level reasoning effort; see
    // tests/schema-v69-agent-effort.test.ts for migration coverage.
    // v70: runner approval-gate requests (pending_approvals audit table).
    // v71: long-task continuation chain (task_runs continuation_* columns).
    // v72: approval-gate rollback — drops the now-unused pending_approvals
    // table (task U survey-module rollback).
    // v73: custom_model_pricing table + partial unique indexes, created
    // idempotently by the base schema block (task V; no data migration).
    // v74: registered_groups.auto_memory_recall column (task Z; ensureColumn,
    // no data migration).
    // v75: retired Telegram/Discord/WhatsApp channel trim (task AJ; destructive
    // data cleanup gated by the pre-migration backup).
    // v76: drops the retired billing/redeem/quota tables and dead columns
    // (dead-code prune; see tests for the 64d6d7b change).
    // v77: drops usage_daily_summary plus the dead billing-mirror and legacy
    // columns (ISSUE-09; write paths removed in the same change).
    // v78: drops scheduled_tasks.running_until / runner_id, the legacy
    // definition-level lease superseded by task_runs (ISSUE-25).
    expect(db.CURRENT_SCHEMA_VERSION).toBe(78);
  });
});
