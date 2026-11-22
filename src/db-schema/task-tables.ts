import type { DbMigrationContext } from './context.js';

// ISSUE-12 波 3 单元 3.5：任务表列段自 src/db.ts 原文搬运（原 db.ts
// 1088-1177："Lightweight migrations for existing DBs"——users/invite_
// codes/registered_groups/messages 轻量加列与 scheduled_tasks 全列段
// （含 v62→v63 delivery_route_jid 及 chat_jid 回填、v70→v71 task_runs
// notification 六列、continuation 五列）、updated_at 幂等回填；全部
// ensureColumn/无条件 UPDATE 无门控幂等重放。搬运体逐字节一致，唯一
// 改写是函数体首行同名解构 const { db, ensureColumn } = ctx（调用点
// 零改动）。段序保持原文：本段的 registered_groups 加列（execution_
// mode/custom_cwd/avatar_url 等）是紧随其后的 folder 重建段 SELECT 的
// 既有依赖（重建段内 ORDERING CONTRACT 注释原文引用），不可换位。

export function ensureTaskTableColumns(ctx: DbMigrationContext): void {
  const { db, ensureColumn } = ctx;
  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('invite_codes', 'permission_template', 'TEXT');
  ensureColumn('invite_codes', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn(
    'registered_groups',
    'execution_mode',
    "TEXT DEFAULT 'container'",
  );
  ensureColumn('registered_groups', 'custom_cwd', 'TEXT');
  ensureColumn('registered_groups', 'init_source_path', 'TEXT');
  ensureColumn('registered_groups', 'init_git_url', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('registered_groups', 'created_by', 'TEXT');
  ensureColumn('registered_groups', 'is_home', 'INTEGER DEFAULT 0');
  // v56 -> v57: cache provider chat avatars so binding lists do not need an
  // N+1 provider lookup on every open. Provider sync refreshes this URL.
  ensureColumn('registered_groups', 'avatar_url', 'TEXT');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn(
    'users',
    'default_require_mention',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_mode', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_jid', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_folder', 'TEXT');
  ensureColumn('scheduled_tasks', 'running_until', 'TEXT');
  ensureColumn('scheduled_tasks', 'runner_id', 'TEXT');
  ensureColumn('scheduled_tasks', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('scheduled_tasks', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('scheduled_tasks', 'deleted_at', 'TEXT');
  // v62 -> v63: a task stored only the workspace-level `chat_jid`, so execution
  // had to re-derive its target and fell back to "any group in this folder,
  // preferring web:". Capture the concrete delivery route instead — CKQClaw's
  // JID already encodes provider, external chat, channel account and Feishu
  // thread/root, so one column carries the whole binding. Existing rows are
  // backfilled from `chat_jid`, which is exactly the route they used before.
  ensureColumn('scheduled_tasks', 'delivery_route_jid', 'TEXT');
  db.prepare(
    `UPDATE scheduled_tasks
     SET delivery_route_jid = chat_jid
     WHERE delivery_route_jid IS NULL AND chat_jid IS NOT NULL`,
  ).run();
  ensureColumn('task_runs', 'notification_summary', 'TEXT');
  ensureColumn('task_runs', 'notification_payload', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_attempt',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('task_runs', 'notification_available_at', 'TEXT');
  ensureColumn('task_runs', 'notification_lease_owner', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_lease_token',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('task_runs', 'notification_lease_expires_at', 'TEXT');
  ensureColumn('task_runs', 'notification_lease_payload', 'TEXT');
  ensureColumn(
    'task_runs',
    'notification_generation',
    'INTEGER NOT NULL DEFAULT 0',
  );
  // v70 -> v71: long-task continuation chain. A run whose Agent declared
  // itself unfinished (runner tool task_request_continuation) carries the
  // declared reason/next step and its chain position; the scheduler sweep
  // settles continuation_state to continued/needs_human/abandoned exactly
  // once per request.
  ensureColumn('task_runs', 'continuation_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('task_runs', 'continuation_reason', 'TEXT');
  ensureColumn('task_runs', 'continuation_next_step', 'TEXT');
  ensureColumn('task_runs', 'continuation_state', 'TEXT');
  ensureColumn('task_runs', 'continuation_child_run_id', 'TEXT');
  // Old rows predate updated_at; created_at is the least-surprising baseline.
  db.prepare(
    "UPDATE scheduled_tasks SET updated_at = created_at WHERE updated_at = '' OR updated_at IS NULL",
  ).run();
}
