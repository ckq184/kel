import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v75-channel-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));

beforeAll(() => {
  const legacy = new Database(path.join(store, 'messages.db'));
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '74');

    CREATE TABLE chats (
      jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT
    );
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, source_jid TEXT, sender TEXT, sender_name TEXT,
      content TEXT, timestamp TEXT, is_from_me INTEGER, attachments TEXT,
      delivery_status TEXT, delivery_priority INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent', script_command TEXT,
      next_run TEXT, last_run TEXT, last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, created_by TEXT, notify_channels TEXT,
      delivery_route_jid TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT '', deleted_at TEXT
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE, trigger_type TEXT NOT NULL,
      scheduled_for TEXT NOT NULL, definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL, available_at TEXT NOT NULL,
      idempotency_key TEXT, lease_expires_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE TABLE workspaces (
      jid TEXT PRIMARY KEY, folder TEXT NOT NULL, owner_user_id TEXT,
      name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO workspaces (jid, folder, name, created_at, updated_at)
      VALUES ('web:ws-1', 'folder-a', 'WS', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      added_at TEXT NOT NULL, avatar_url TEXT, container_config TEXT,
      execution_mode TEXT, custom_cwd TEXT, init_source_path TEXT,
      init_git_url TEXT, created_by TEXT, is_home INTEGER DEFAULT 0,
      selected_skills TEXT, target_agent_id TEXT, target_main_jid TEXT,
      reply_policy TEXT, channel_account_id TEXT
    );
    CREATE TABLE channel_accounts (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, provider TEXT NOT NULL,
      name TEXT NOT NULL, secret_ref TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
      is_legacy_default INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT NOT NULL DEFAULT 'credentials',
      auth_status TEXT NOT NULL DEFAULT 'draft',
      transport_status TEXT NOT NULL DEFAULT 'disconnected',
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE im_context_bindings (
      source_jid TEXT NOT NULL, context_type TEXT NOT NULL,
      context_id TEXT NOT NULL, workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL, last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE TABLE channel_mounts (
      channel_jid TEXT PRIMARY KEY, channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL, session_id TEXT,
      channel_account_id TEXT,
      routing_mode TEXT NOT NULL, reply_policy TEXT NOT NULL,
      activation_mode TEXT NOT NULL, audience_mode TEXT NOT NULL,
      owner_im_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_channel_mounts (
      channel_jid TEXT PRIMARY KEY, agent_profile_id TEXT, owner_user_id TEXT,
      channel_type TEXT NOT NULL, workspace_jid TEXT NOT NULL,
      workspace_folder TEXT, session_id TEXT, channel_account_id TEXT,
      routing_mode TEXT NOT NULL, reply_policy TEXT NOT NULL,
      activation_mode TEXT NOT NULL, audience_mode TEXT NOT NULL,
      owner_im_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE user_pinned_groups (
      user_id TEXT NOT NULL, jid TEXT NOT NULL, PRIMARY KEY (user_id, jid)
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      name TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', created_at TEXT NOT NULL,
      last_im_jid TEXT, spawned_from_jid TEXT
    );
    CREATE TABLE agent_builder_drafts (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
      source_group TEXT NOT NULL, source_chat_jid TEXT NOT NULL,
      definition_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  const insert = (sql: string, ...params: unknown[]) =>
    legacy.prepare(sql).run(...params);

  // chats + messages: retired vs kept
  insert(
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    'telegram:100',
    'Retired TG chat',
    '2026-01-01T00:00:00.000Z',
  );
  insert(
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
    'feishu:200',
    'Kept feishu chat',
    '2026-01-02T00:00:00.000Z',
  );
  insert(
    `INSERT INTO messages (id, chat_jid, content, timestamp) VALUES (?, ?, ?, ?)`,
    'm-tg-1',
    'telegram:100',
    'retired',
    '2026-01-01T00:00:01.000Z',
  );
  insert(
    `INSERT INTO messages (id, chat_jid, content, timestamp) VALUES (?, ?, ?, ?)`,
    'm-feishu-1',
    'feishu:200',
    'kept',
    '2026-01-02T00:00:01.000Z',
  );

  // scheduled_tasks: retired-owner task, mixed notify, retired-only notify,
  // retired delivery route
  insert(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, created_at, notify_channels, delivery_route_jid)
     VALUES ('task-tg', 'folder-a', 'telegram:100', 'p', 'daily', '09:00', '2026-01-01T00:00:00.000Z', '["telegram"]', NULL)`,
  );
  insert(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, created_at, notify_channels, delivery_route_jid)
     VALUES ('task-mixed', 'folder-a', 'feishu:200', 'p', 'daily', '09:00', '2026-01-01T00:00:00.000Z', '["feishu","telegram","discord"]', 'discord:300')`,
  );
  insert(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, created_at, notify_channels, delivery_route_jid)
     VALUES ('task-tg-only', 'folder-a', 'feishu:200', 'p', 'daily', '09:00', '2026-01-01T00:00:00.000Z', '["whatsapp"]', 'feishu:200')`,
  );

  // task_runs: one under the retired task (deleted with it), one surviving
  // with retired values inside its definition snapshot
  insert(
    `INSERT INTO task_runs (id, task_id, occurrence_key, trigger_type, scheduled_for, definition_snapshot, status, available_at, created_at, updated_at)
     VALUES ('run-tg', 'task-tg', 'occ-1', 'schedule', '2026-01-01T09:00:00.000Z', '{}', 'completed', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:01.000Z')`,
  );
  insert(
    `INSERT INTO task_runs (id, task_id, occurrence_key, trigger_type, scheduled_for, definition_snapshot, status, available_at, created_at, updated_at)
     VALUES ('run-kept', 'task-mixed', 'occ-2', 'schedule', '2026-01-02T09:00:00.000Z',
       '{"prompt":"p","group_folder":"folder-a","chat_jid":"feishu:200","delivery_route_jid":"whatsapp:400","notify_channels":["feishu","discord"]}',
       'completed', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:00.000Z', '2026-01-02T09:00:01.000Z')`,
  );
  insert(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status) VALUES ('task-tg', '2026-01-01T09:00:00.000Z', 5, 'success')`,
  );

  // registered_groups / mounts / bindings / pinned / drafts
  insert(
    `INSERT INTO registered_groups (jid, name, folder, added_at) VALUES ('telegram:100', 'TG', 'folder-a', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO registered_groups (jid, name, folder, added_at, is_home) VALUES ('web:ws-1', 'WS home', 'folder-a', '2026-01-01T00:00:00.000Z', 1)`,
  );
  insert(
    `INSERT INTO registered_groups (jid, name, folder, added_at, target_main_jid) VALUES ('feishu:200', 'Feishu', 'folder-a', '2026-01-01T00:00:00.000Z', 'web:ws-1')`,
  );
  insert(
    `INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, created_at, updated_at)
     VALUES ('acc-tg', 'user-1', 'telegram', 'TG bot', 'channel-account:acc-tg', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, created_at, updated_at)
     VALUES ('acc-wa', 'user-1', 'whatsapp', 'WA', 'channel-account:acc-wa', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO channel_accounts (id, owner_user_id, provider, name, secret_ref, created_at, updated_at)
     VALUES ('acc-feishu', 'user-1', 'feishu', 'Feishu bot', 'channel-account:acc-feishu', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO im_context_bindings (source_jid, context_type, context_id, workspace_jid, agent_id, last_active_at, created_at, updated_at)
     VALUES ('discord:500', 'thread', 't1', 'web:ws-1', 'agent-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO im_context_bindings (source_jid, context_type, context_id, workspace_jid, agent_id, last_active_at, created_at, updated_at)
     VALUES ('feishu:200', 'thread', 't2', 'web:ws-1', 'agent-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO channel_mounts (channel_jid, channel_type, workspace_jid, routing_mode, reply_policy, activation_mode, audience_mode, created_at, updated_at)
     VALUES ('telegram:100', 'telegram', 'web:ws-1', 'single_session', 'source_only', 'auto', 'everyone', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO channel_mounts (channel_jid, channel_type, workspace_jid, routing_mode, reply_policy, activation_mode, audience_mode, created_at, updated_at)
     VALUES ('feishu:200', 'feishu', 'web:ws-1', 'single_session', 'source_only', 'auto', 'everyone', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO agent_channel_mounts (channel_jid, channel_type, workspace_jid, routing_mode, reply_policy, activation_mode, audience_mode, created_at, updated_at)
     VALUES ('whatsapp:600', 'whatsapp', 'web:ws-1', 'single_session', 'source_only', 'auto', 'everyone', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO agent_channel_mounts (channel_jid, channel_type, workspace_jid, routing_mode, reply_policy, activation_mode, audience_mode, created_at, updated_at)
     VALUES ('feishu:200', 'feishu', 'web:ws-1', 'single_session', 'source_only', 'auto', 'everyone', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO user_pinned_groups (user_id, jid) VALUES ('user-1', 'telegram:100')`,
  );
  insert(
    `INSERT INTO user_pinned_groups (user_id, jid) VALUES ('user-1', 'feishu:200')`,
  );
  insert(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, created_at, last_im_jid, spawned_from_jid)
     VALUES ('agent-tg', 'folder-a', 'telegram:100', 'TG agent', 'p', '2026-01-01T00:00:00.000Z', 'telegram:100', 'telegram:100')`,
  );
  insert(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, created_at, last_im_jid, spawned_from_jid)
     VALUES ('agent-web', 'folder-a', 'web:ws-1', 'Web agent', 'p', '2026-01-01T00:00:00.000Z', 'discord:700', 'feishu:200')`,
  );
  insert(
    `INSERT INTO agent_builder_drafts (id, owner_user_id, source_group, source_chat_jid, definition_json, created_at, updated_at)
     VALUES ('draft-tg', 'user-1', 'folder-a', 'telegram:100', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert(
    `INSERT INTO agent_builder_drafts (id, owner_user_id, source_group, source_chat_jid, definition_json, created_at, updated_at)
     VALUES ('draft-feishu', 'user-1', 'folder-a', 'feishu:200', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );

  legacy.close();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function countRows(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { count: number } | undefined)
    ?.count as number;
}

describe('schema v75 retired channel trim', () => {
  test('deletes Telegram/Discord/WhatsApp rows and trims surviving references', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const raw = new Database(path.join(store, 'messages.db'), {
      readonly: true,
    });

    // Retired rows are gone across every owning table.
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM channel_accounts WHERE provider IN ('telegram','discord','whatsapp')`,
      ),
    ).toBe(0);
    expect(
      countRows(raw, `SELECT COUNT(*) AS count FROM channel_accounts`),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM chats WHERE jid LIKE 'telegram:%' OR jid LIKE 'discord:%' OR jid LIKE 'whatsapp:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM messages WHERE chat_jid LIKE 'telegram:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM scheduled_tasks WHERE id = 'task-tg'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM task_runs WHERE id = 'run-tg'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM task_run_logs WHERE task_id = 'task-tg'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM registered_groups WHERE jid LIKE 'telegram:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM im_context_bindings WHERE source_jid LIKE 'discord:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM channel_mounts WHERE channel_type IN ('telegram','discord','whatsapp')`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM agent_channel_mounts WHERE channel_type IN ('telegram','discord','whatsapp')`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM user_pinned_groups WHERE jid LIKE 'telegram:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM agent_builder_drafts WHERE source_chat_jid LIKE 'telegram:%'`,
      ),
    ).toBe(0);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM agents WHERE chat_jid LIKE 'telegram:%'`,
      ),
    ).toBe(0);

    // Surviving rows only lose retired references.
    const agentWeb = raw
      .prepare(
        `SELECT last_im_jid, spawned_from_jid FROM agents WHERE id = 'agent-web'`,
      )
      .get() as { last_im_jid: string | null; spawned_from_jid: string | null };
    expect(agentWeb).toEqual({
      last_im_jid: null,
      spawned_from_jid: 'feishu:200',
    });

    const mixedTask = raw
      .prepare(
        `SELECT notify_channels, delivery_route_jid FROM scheduled_tasks WHERE id = 'task-mixed'`,
      )
      .get() as {
      notify_channels: string | null;
      delivery_route_jid: string | null;
    };
    expect(mixedTask.notify_channels).toBe('["feishu"]');
    expect(mixedTask.delivery_route_jid).toBeNull();

    const tgOnlyTask = raw
      .prepare(
        `SELECT notify_channels, delivery_route_jid FROM scheduled_tasks WHERE id = 'task-tg-only'`,
      )
      .get() as {
      notify_channels: string | null;
      delivery_route_jid: string | null;
    };
    expect(tgOnlyTask.notify_channels).toBeNull();
    expect(tgOnlyTask.delivery_route_jid).toBe('feishu:200');

    const keptSnapshot = JSON.parse(
      (
        raw
          .prepare(
            `SELECT definition_snapshot FROM task_runs WHERE id = 'run-kept'`,
          )
          .get() as { definition_snapshot: string }
      ).definition_snapshot,
    ) as {
      notify_channels: string[] | null;
      delivery_route_jid: string | null;
    };
    expect(keptSnapshot.notify_channels).toEqual(['feishu']);
    expect(keptSnapshot.delivery_route_jid).toBeNull();

    // Kept-channel rows are untouched.
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM chats WHERE jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM messages WHERE chat_jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM registered_groups WHERE jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM channel_mounts WHERE channel_jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM im_context_bindings WHERE source_jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM user_pinned_groups WHERE jid = 'feishu:200'`,
      ),
    ).toBe(1);
    expect(
      countRows(
        raw,
        `SELECT COUNT(*) AS count FROM agent_builder_drafts WHERE source_chat_jid = 'feishu:200'`,
      ),
    ).toBe(1);

    raw.close();
    db.closeDatabase();
  });

  test('a v75 database re-opens without touching kept rows', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const raw = new Database(path.join(store, 'messages.db'), {
      readonly: true,
    });
    expect(
      countRows(raw, `SELECT COUNT(*) AS count FROM channel_accounts`),
    ).toBe(1);
    expect(
      countRows(raw, `SELECT COUNT(*) AS count FROM scheduled_tasks`),
    ).toBe(2);
    raw.close();
    db.closeDatabase();
  });
});
