import type { DbMigrationContext } from './context.js';

// ISSUE-12 波 3 单元 3.1：initDatabase 基础表族自 src/db.ts 原文搬运
// （原 db.ts 531-779：chats/messages/scheduled_tasks/task_run_logs/
// task_runs 建表与"State tables (replacing JSON files)"第二组 CREATE IF
// NOT EXISTS，全部为无门控幂等建表，每次启动重放）。搬运体逐字节一致，
// 唯一改写是函数体首行同名解构 const { db } = ctx——所有 db.exec 调用点
// 零改动。编排壳（db.ts initDatabase）在 FK 门（原 485-530）之后构造
// DbMigrationContext 并按原行序调用本 step，一段不换位；后续单元同款
// 约定逐段吸收原 781-2555。

export function ensureCoreTables(ctx: DbMigrationContext): void {
  const { db } = ctx;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      channel_context TEXT,
      turn_id TEXT,
      session_id TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      delivery_mode TEXT,
      delivery_status TEXT,
      delivery_run_id TEXT,
      delivery_priority INTEGER NOT NULL DEFAULT 0,
      delivery_updated_at TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      created_by TEXT,
      notify_channels TEXT,
      running_until TEXT,
      runner_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL,
      idempotency_key TEXT,
      scheduled_for TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notification_error TEXT,
      notification_summary TEXT,
      notification_payload TEXT,
      notification_attempt INTEGER NOT NULL DEFAULT 0,
      notification_available_at TEXT,
      notification_lease_owner TEXT,
      notification_lease_token INTEGER NOT NULL DEFAULT 0,
      notification_lease_expires_at TEXT,
      notification_lease_payload TEXT,
      notification_generation INTEGER NOT NULL DEFAULT 0,
      continuation_count INTEGER NOT NULL DEFAULT 0,
      continuation_reason TEXT,
      continuation_next_step TEXT,
      continuation_state TEXT,
      continuation_child_run_id TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_manual_idempotency
      ON task_runs(task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_one_nonterminal
      ON task_runs(task_id)
      WHERE status IN ('queued', 'running', 'retry_wait');
    CREATE INDEX IF NOT EXISTS idx_task_runs_due
      ON task_runs(status, available_at, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_runs_task_created
      ON task_runs(task_id, created_at DESC);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS channel_accounts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      secret_ref TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_legacy_default INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT NOT NULL DEFAULT 'credentials',
      auth_status TEXT NOT NULL DEFAULT 'draft',
      transport_status TEXT NOT NULL DEFAULT 'disconnected',
      status TEXT NOT NULL DEFAULT 'disconnected',
      default_workspace_jid TEXT,
      last_error TEXT,
      connected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_user_id, provider, name)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_accounts_owner_provider
      ON channel_accounts(owner_user_id, provider, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_accounts_one_default
      ON channel_accounts(owner_user_id, provider) WHERE is_default = 1;
    CREATE TABLE IF NOT EXISTS im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      root_message_id TEXT,
      title TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_icb_agent ON im_context_bindings(agent_id);
    CREATE TABLE IF NOT EXISTS channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_workspace ON channel_mounts(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_session ON channel_mounts(session_id);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_type ON channel_mounts(channel_type);
    CREATE TABLE IF NOT EXISTS workspaces (
      jid TEXT PRIMARY KEY,
      folder TEXT NOT NULL,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_home INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_folder ON workspaces(folder);
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id, status);
    -- Runtime resume state projected from the legacy sessions table. This is
    -- deliberately not named sessions: product conversation Sessions live in
    -- agents, while these rows only track SDK/provider resume metadata.
    CREATE TABLE IF NOT EXISTS workspace_runtime_sessions (
      group_folder TEXT NOT NULL,
      runtime_agent_id TEXT NOT NULL DEFAULT '',
      workspace_jid TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT,
      agent_profile_id TEXT,
      agent_profile_version INTEGER,
      identity_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, runtime_agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_workspace ON workspace_runtime_sessions(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_profile ON workspace_runtime_sessions(agent_profile_id);
    CREATE TABLE IF NOT EXISTS agent_channel_mounts (
      channel_jid TEXT PRIMARY KEY,
      agent_profile_id TEXT,
      owner_user_id TEXT,
      channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT,
      session_id TEXT,
      routing_mode TEXT NOT NULL DEFAULT 'single_session',
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      audience_mode TEXT NOT NULL DEFAULT 'everyone',
      owner_im_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_profile ON agent_channel_mounts(agent_profile_id);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_workspace ON agent_channel_mounts(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_session ON agent_channel_mounts(session_id);
  `);
}
