import type { DbMigrationContext } from './context.js';

// ISSUE-12 波 3 单元 3.6：legacy 重建两段自 src/db.ts 原文搬运。
// rebuildRegisteredGroupsFolder（原 db.ts 1178-1342）：registered_groups
// folder UNIQUE 索引重建（含 ORDERING CONTRACT 与 VALUE CARRYING 两段
// 契约注释随段走——重建 DROP 表必须先于 target_agent_id…sender_allowlist
// 全部 additive ensureColumn，SELECT 只依赖上方已保证的列）+ 重建后
// ensureColumn 群 + v57→v58 audience policy 迁移（audiencePolicySchema-
// Version < 58 门，?? '0' 新库执行）。
// migrateLegacySchemaRebuilds（原 db.ts 1361-1592）：promoting→queued
// 修复 UPDATE、agents 五列、rg 双索引、v19→v20 + assertSchema 六表钉、
// created_by 三组回填、v13 is_home、v16→v17 sessions 复合主键重建
// （curVer && < 17 门，新库跳过）、v22 target_main_jid 修复（curVer &&
// < 22 门）。搬运体逐字节一致，唯一改写是各函数体首行同名解构
// const { … } = ctx（调用点零改动）。五种门控原文保留；两函数之间
// 原文夹着 v58→v59 投递列段（归单元 3.7），编排壳按原行序调用保持
// 段序不变。

export function rebuildRegisteredGroupsFolder(ctx: DbMigrationContext): void {
  const { db, ensureColumn, getRouterStateInternal } = ctx;
  // Migration: remove UNIQUE constraint from registered_groups.folder
  // Multiple groups (web:main + feishu chats) share folder='main' by design.
  // The old UNIQUE constraint caused INSERT OR REPLACE to silently delete
  // the conflicting row, making web:main and feishu groups mutually exclusive.
  //
  // ORDERING CONTRACT (task Z follow-up fix): this rebuild DROPs and
  // recreates registered_groups, so it must run BEFORE every additive
  // registered_groups ensureColumn below (target_agent_id … sender_allowlist,
  // channel_account_id) — formerly it sat below them, and
  // an ancient DB's first boot both wiped those columns and then hard-failed
  // the assertSchema('registered_groups', …) pin, only converging after a
  // second boot. Its SELECT depends only on columns guaranteed above:
  // execution_mode (l.~1277), custom_cwd (l.~1282) and avatar_url (l.~1291).
  //
  // VALUE CARRYING (task Z follow-up fix 2): the optional columns below are
  // carried from the source table when present instead of being reset to
  // NULL/0 — a middle-era DB (populated created_by / owner_claim_source /
  // is_home but still carrying the folder UNIQUE index) must not lose its
  // ownership and home markers through the rebuild. Absent columns keep the
  // historical NULL/0 defaults.
  const hasUniqueFolder =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
         WHERE type='index' AND tbl_name='registered_groups'
         AND name='sqlite_autoindex_registered_groups_2'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;
  if (hasUniqueFolder) {
    const sourceColumns = new Set(
      (
        db.prepare('PRAGMA table_info(registered_groups)').all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    const carry = (column: string, missing: string): string =>
      sourceColumns.has(column) ? column : missing;
    const carrySelect = [
      'jid',
      'name',
      'folder',
      'added_at',
      'avatar_url',
      'container_config',
      'execution_mode',
      'custom_cwd',
      carry('init_source_path', 'NULL'),
      carry('init_git_url', 'NULL'),
      carry('created_by', 'NULL'),
      carry('owner_claim_source', 'NULL'),
      carry('is_home', '0'),
    ].join(', ');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          added_at TEXT NOT NULL,
          avatar_url TEXT,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          custom_cwd TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          owner_claim_source TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT ${carrySelect} FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    })();
  }

  ensureColumn('sessions', 'agent_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agents', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn('registered_groups', 'target_agent_id', 'TEXT');
  ensureColumn('registered_groups', 'target_main_jid', 'TEXT');
  ensureColumn(
    'registered_groups',
    'reply_policy',
    "TEXT DEFAULT 'source_only'",
  );
  ensureColumn('registered_groups', 'require_mention', 'INTEGER DEFAULT 0');
  ensureColumn('registered_groups', 'activation_mode', "TEXT DEFAULT 'auto'");
  ensureColumn(
    'registered_groups',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  ensureColumn('registered_groups', 'owner_im_id', 'TEXT');
  ensureColumn('registered_groups', 'owner_claim_source', 'TEXT');
  // Existing owner anchors predate provenance and may include credentials that
  // were transferred between CKQClaw users. Keep them usable for legacy
  // owner-only commands, but never let an ordinary DM silently turn them into
  // Agent Builder trust; the user must re-pair or configure the owner in Web.
  db.prepare(
    `UPDATE registered_groups
     SET owner_claim_source = 'explicit'
     WHERE owner_im_id IS NOT NULL AND owner_im_id <> ''
       AND (owner_claim_source IS NULL OR owner_claim_source = '')`,
  ).run();
  ensureColumn(
    'registered_groups',
    'conversation_source',
    "TEXT DEFAULT 'manual'",
  );
  ensureColumn(
    'registered_groups',
    'conversation_nav_mode',
    "TEXT DEFAULT 'horizontal'",
  );
  ensureColumn(
    'registered_groups',
    'binding_mode',
    "TEXT DEFAULT 'single_context'",
  );
  ensureColumn(
    'registered_groups',
    'native_context_type',
    "TEXT DEFAULT 'none'",
  );
  ensureColumn('registered_groups', 'feishu_chat_mode', 'TEXT');
  ensureColumn('registered_groups', 'feishu_group_message_type', 'TEXT');
  ensureColumn('registered_groups', 'sender_allowlist', 'TEXT');
  ensureColumn(
    'channel_mounts',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  ensureColumn(
    'agent_channel_mounts',
    'audience_mode',
    "TEXT NOT NULL DEFAULT 'everyone'",
  );
  // v57 -> v58: split Feishu's composite owner_mentioned setting into two
  // orthogonal policies. Other providers keep their legacy mode until their
  // connector implements the same audience gate. This is a one-time semantic
  // migration: replaying it on every startup would overwrite a later explicit
  // user choice of audience_mode='everyone' whenever the durable owner anchor
  // (sender_allowlist) is still present.
  const audiencePolicySchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (audiencePolicySchemaVersion < 58) {
    db.exec(`
      UPDATE registered_groups
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only', require_mention = 1
      WHERE jid LIKE 'feishu:%' AND activation_mode = 'owner_mentioned';
      UPDATE registered_groups
      SET audience_mode = 'owner_only'
      WHERE jid LIKE 'feishu:%' AND sender_allowlist IS NOT NULL;
      UPDATE channel_mounts
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only'
      WHERE channel_type = 'feishu' AND activation_mode = 'owner_mentioned';
      UPDATE agent_channel_mounts
      SET activation_mode = 'when_mentioned', audience_mode = 'owner_only'
      WHERE channel_type = 'feishu' AND activation_mode = 'owner_mentioned';
    `);
  }
}

export function migrateLegacySchemaRebuilds(ctx: DbMigrationContext): void {
  const { db, ensureColumn, assertSchema, getRouterStateInternal } = ctx;
  // A process may have crashed after reserving a queued message for a card
  // action but before injecting it. Reservations are process-local, so make
  // those rows claimable again on startup.
  db.prepare(
    `UPDATE messages
     SET delivery_status = 'queued', delivery_updated_at = ?
     WHERE delivery_status = 'promoting'`,
  ).run(new Date().toISOString());
  ensureColumn('agents', 'source_kind', 'TEXT');
  ensureColumn('agents', 'thread_id', 'TEXT');
  ensureColumn('agents', 'root_message_id', 'TEXT');
  ensureColumn('agents', 'title_source', 'TEXT');
  ensureColumn('agents', 'last_active_at', 'TEXT');

  // Add index on target_agent_id for fast lookup of IM bindings
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_agent ON registered_groups(target_agent_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_main ON registered_groups(target_main_jid)',
  );

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
    'channel_context',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'created_at',
    'created_by',
    'revision',
    'updated_at',
    'deleted_at',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'avatar_url',
      'container_config',
      'execution_mode',
      'custom_cwd',
      'init_source_path',
      'init_git_url',
      'created_by',
      'is_home',
      'target_agent_id',
      'target_main_jid',
      'reply_policy',
    ],
    ['trigger_pattern', 'requires_trigger'],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'avatar_url',
    'default_require_mention',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ]);
  assertSchema('user_sessions', [
    'id',
    'user_id',
    'ip_address',
    'user_agent',
    'created_at',
    'expires_at',
    'last_active_at',
  ]);

  // Store schema version after all migrations complete
  // Migrate existing web groups: assign to first admin
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid LIKE 'web:%' AND folder != 'main' AND created_by IS NULL
  `);

  // Backfill owner for legacy web:main if missing.
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid = 'web:main' AND created_by IS NULL
  `);

  // Backfill created_by for feishu/telegram groups by matching sibling groups in the same folder.
  // Only backfill when the folder has exactly one distinct owner; otherwise
  // keep NULL to avoid misrouting ambiguous legacy data.
  db.exec(`
    UPDATE registered_groups
    SET created_by = (
      SELECT MIN(rg2.created_by)
      FROM registered_groups rg2
      WHERE rg2.folder = registered_groups.folder
        AND rg2.created_by IS NOT NULL
    )
    WHERE (jid LIKE 'feishu:%' OR jid LIKE 'telegram:%')
      AND created_by IS NULL
      AND (
        SELECT COUNT(DISTINCT rg3.created_by)
        FROM registered_groups rg3
        WHERE rg3.folder = registered_groups.folder
          AND rg3.created_by IS NOT NULL
      ) = 1
  `);

  // v13 migration: mark existing web:main group as is_home=1
  db.exec(`
    UPDATE registered_groups SET is_home = 1
    WHERE jid = 'web:main' AND folder = 'main' AND is_home = 0
  `);

  // v16→v17 migration: rebuild sessions table with composite primary key
  // Old PK was (group_folder), which cannot store multiple agent sessions per folder.
  // New PK is (group_folder, COALESCE(agent_id, '')) to support per-agent sessions.
  const curVer = getRouterStateInternal('schema_version');
  if (curVer && parseInt(curVer, 10) < 17) {
    db.transaction(() => {
      // Check if the old table has single-column PK by inspecting table_info
      const pkCols = (
        db.prepare("PRAGMA table_info('sessions')").all() as Array<{
          name: string;
          pk: number;
        }>
      ).filter((c) => c.pk > 0);
      // Old schema: single PK column 'group_folder'. New schema: composite PK needs rebuild.
      if (pkCols.length === 1 && pkCols[0].name === 'group_folder') {
        db.exec(`
          CREATE TABLE sessions_new (
            group_folder TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (group_folder, agent_id)
          );
          INSERT OR IGNORE INTO sessions_new (group_folder, session_id, agent_id)
            SELECT group_folder, session_id, COALESCE(agent_id, '') FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
    })();
  }

  // v22: Fix target_main_jid that used folder-based JID (web:${folder})
  // instead of actual registered group JID (web:${uuid}).
  // Only affects non-home workspaces where folder != uuid.
  if (curVer && parseInt(curVer, 10) < 22) {
    const rows = db
      .prepare(
        "SELECT jid, target_main_jid FROM registered_groups WHERE target_main_jid IS NOT NULL AND target_main_jid != ''",
      )
      .all() as Array<{ jid: string; target_main_jid: string }>;
    for (const row of rows) {
      const targetJid = row.target_main_jid;
      // Check if target_main_jid is a real registered group JID
      const exists = db
        .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
        .get(targetJid);
      if (exists) continue;
      // Not a valid JID — try to resolve via folder
      if (!targetJid.startsWith('web:')) continue;
      const folder = targetJid.slice(4);
      const candidates = db
        .prepare(
          "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
        )
        .all(folder) as Array<{ jid: string }>;
      if (candidates.length === 1) {
        db.prepare(
          'UPDATE registered_groups SET target_main_jid = ? WHERE jid = ?',
        ).run(candidates[0].jid, row.jid);
      }
    }
  }
}
