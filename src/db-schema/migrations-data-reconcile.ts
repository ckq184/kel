import type { DbMigrationContext } from './context.js';
import type { ChannelTurnContext } from '../types.js';
import { logger } from '../logger.js';
import { splitLegacyEmbeddedReferenceContent } from '../message-prompt.js';

// ISSUE-12 波 3 单元 3.7：数据调和三段自 src/db.ts 原文搬运。
// ensureMessageDeliveryColumns（原 db.ts 1343-1360）：v58→v59 messages
// 投递六列与 token_usage/channel_context/turn_id/task_id/session_id/
// source_kind/finalization_reason 列、idx_messages_follow_up_queue
// 索引，无门控幂等。
// reconcileChannelAccountsAndUsernames（原 db.ts 1846-2056）：v48→v50
// channel_account_id/auth_mode/auth_status/transport_status 列与
// channel_accounts 状态回填 UPDATE（计划表 1343-1360+1931-2056 外的
// 1846-1929 为行界缺口段按主题并入本函数）、v44→v45 workspace_
// sessions→workspace_runtime_sessions 重建（tableExists 结构探测）、
// v38→v39 用户名小写迁移（v 判空门+冲突拒改）、v60→v62 interaction
// mode 与 reply mode 重建（?? '0' 门）、DROP group_members 与三个
// canonical 投影回填调用。
// cleanEmbeddedReferenceContent（原 db.ts 2137-2218）：v63→v64 早期
// 飞书引用链自 messages.content 剥离（< 64 门），split 自 message-prompt
// 模块直引，parseChannelTurnContext 经 ctx 注入。搬运体逐字节一致，
// 唯一改写是各函数体首行同名解构 const { … } = ctx（调用点零改动）；
// 五种门控原文保留；logger 模块直引无环。

export function ensureMessageDeliveryColumns(ctx: DbMigrationContext): void {
  const { db, ensureColumn } = ctx;
  // v58 -> v59: persist a sanitized, message-level channel context. Existing
  // rows intentionally remain NULL and continue to decode as context-less.
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'channel_context', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'task_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');
  ensureColumn('messages', 'delivery_mode', 'TEXT');
  ensureColumn('messages', 'delivery_status', 'TEXT');
  ensureColumn('messages', 'delivery_run_id', 'TEXT');
  ensureColumn('messages', 'delivery_priority', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('messages', 'delivery_updated_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_follow_up_queue
      ON messages(chat_jid, delivery_status, delivery_priority, timestamp, id);
  `);
}

export function reconcileChannelAccountsAndUsernames(
  ctx: DbMigrationContext,
): void {
  const {
    db,
    ensureColumn,
    tableExists,
    getRouterStateInternal,
    backfillAgentProfileDefaultsAndWorkspaceMappings,
    removeLegacyAgentToolPolicies,
    reconcileCanonicalRuntimeProjections,
  } = ctx;
  // v48 → v49: first-class channel accounts. Credentials are stored outside
  // SQLite behind secret_ref; routing projections retain the account ID so
  // two bots in the same external chat cannot share a JID/mount accidentally.
  ensureColumn('registered_groups', 'channel_account_id', 'TEXT');
  // v73 → v74 (task Z): workspace-level per-turn auto-memory recall opt-in.
  // 0/NULL = off (backward compatible); any non-1 value also reads as off —
  // unlike container_config this flag must never be able to block a start.
  // Placed after the unique-folder table rebuild above: that migration drops
  // and recreates registered_groups, wiping ensureColumns registered before
  // it on an ancient DB's first boot.
  ensureColumn('channel_mounts', 'channel_account_id', 'TEXT');
  ensureColumn('agent_channel_mounts', 'channel_account_id', 'TEXT');
  ensureColumn(
    'channel_accounts',
    'is_legacy_default',
    'INTEGER NOT NULL DEFAULT 0',
  );
  // v49 → v50: model authorization separately from the live transport.
  // QR protocols may have a socket running while still waiting for a scan;
  // that must never be published as a connected account.
  ensureColumn(
    'channel_accounts',
    'auth_mode',
    "TEXT NOT NULL DEFAULT 'credentials'",
  );
  ensureColumn(
    'channel_accounts',
    'auth_status',
    "TEXT NOT NULL DEFAULT 'draft'",
  );
  ensureColumn(
    'channel_accounts',
    'transport_status',
    "TEXT NOT NULL DEFAULT 'disconnected'",
  );
  db.exec(`
    UPDATE channel_accounts SET auth_mode = CASE
      WHEN provider IN ('wechat', 'whatsapp') THEN 'qr_session'
      WHEN provider IN ('telegram', 'discord') THEN 'bot_token'
      ELSE 'credentials'
    END
    WHERE auth_mode IS NULL OR auth_mode = '' OR auth_mode = 'credentials';
    UPDATE channel_accounts SET auth_status = CASE
      WHEN status = 'connected' THEN 'authorized'
      WHEN status = 'error' THEN 'error'
      ELSE auth_status
    END;
    UPDATE channel_accounts SET transport_status = status
      WHERE transport_status = 'disconnected' AND status != 'disconnected';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rg_channel_account
      ON registered_groups(channel_account_id);
    CREATE INDEX IF NOT EXISTS idx_channel_mounts_account
      ON channel_mounts(channel_account_id);
    CREATE INDEX IF NOT EXISTS idx_agent_channel_mounts_account
      ON agent_channel_mounts(channel_account_id);
  `);

  // v44 → v45: make the SDK resume-state projection explicit. The former
  // `workspace_sessions` name looked like a product conversation model even
  // though it only mirrored `sessions` provider/SDK metadata.
  if (tableExists('workspace_sessions')) {
    db.transaction(() => {
      db.exec(`
        INSERT OR REPLACE INTO workspace_runtime_sessions (
          group_folder, runtime_agent_id, workspace_jid, sdk_session_id,
          provider_id, agent_profile_id, agent_profile_version, identity_hash,
          created_at, updated_at
        )
        SELECT group_folder, session_agent_id, workspace_jid, claude_session_id,
          provider_id, agent_profile_id, agent_profile_version, identity_hash,
          created_at, updated_at
        FROM workspace_sessions
      `);
      db.exec('DROP TABLE workspace_sessions');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_workspace
          ON workspace_runtime_sessions(workspace_jid);
        CREATE INDEX IF NOT EXISTS idx_workspace_runtime_sessions_profile
          ON workspace_runtime_sessions(agent_profile_id);
      `);
    })();
  }

  // v37 → v38: Added users.default_require_mention column (per-user default
  // for require_mention on auto-registered IM group chats). The actual
  // ensureColumn migration runs above with the other users.* additions —
  // its position before assertSchema('users', …) matters because the
  // schema check would otherwise reject pre-v38 databases on startup.

  // v38 → v39: Lowercase usernames + add COLLATE NOCASE uniqueness.
  // R1 added `username.toLowerCase()` to login/register/setup/admin-create/
  // profile-update routes for case-insensitive auth; without this migration
  // any pre-existing mixed-case username (e.g. 'Admin') is permanently
  // locked out (login lowercases input → DB lookup misses → 401).
  // We only run UPDATE; the existing UNIQUE constraint already prevents
  // future mixed-case inserts because the routes lowercase before INSERT.
  // Conflicts (e.g. both 'admin' and 'Admin' rows already exist) are rare
  // because the original UNIQUE was case-sensitive, so they exist only when
  // the operator manually inserted both. We log the conflict and refuse to
  // mutate that row, leaving the operator to clean up by hand.
  {
    const v = getRouterStateInternal('schema_version');
    const numV = v ? parseInt(v, 10) : 0;
    if (numV < 39 || !v) {
      const mixedCaseRows = db
        .prepare(
          // ORDER BY 让多次 dry-run 结果稳定 + 让"早创建的真账号"优先被
          // lowercase 化，避免后注册的混淆账号顶替原账号。
          'SELECT id, username FROM users WHERE username != lower(username) ORDER BY created_at ASC, id ASC',
        )
        .all() as Array<{ id: string; username: string }>;
      if (mixedCaseRows.length > 0) {
        const txn = db.transaction(() => {
          for (const row of mixedCaseRows) {
            const lower = row.username.toLowerCase();
            const conflict = db
              .prepare('SELECT id FROM users WHERE id != ? AND username = ?')
              .get(row.id, lower) as { id: string } | undefined;
            if (conflict) {
              logger.error(
                {
                  userId: row.id,
                  username: row.username,
                  conflictUserId: conflict.id,
                },
                'Username case-normalization migration: conflict, leaving row as-is',
              );
              continue;
            }
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(
              lower,
              row.id,
            );
          }
        });
        txn();
        logger.info(
          { rows: mixedCaseRows.length },
          'Username case-normalization migration v39 completed',
        );
      }
    }
  }

  // v42 → v43: top-level Agent ownership and canonical workspace/channel
  // projections. Tables are created with CREATE IF NOT EXISTS above; this
  // pass backfills sources and removes any projection-only ghosts.
  // v45 → v46: workspace sharing was removed. Drop the legacy membership
  // table so stale grants cannot survive an upgrade.
  // v60 -> v61: interaction behavior belongs to the Workspace↔Agent binding,
  // not the reusable AgentProfile. This column must exist before the generic
  // AgentProfile workspace backfill below: that backfill reads existing
  // bindings through getWorkspaceAgentProfileId(), whose row projection now
  // includes interaction_mode.
  ensureColumn(
    'workspace_agent_profiles',
    'interaction_mode',
    "TEXT NOT NULL DEFAULT 'assistant'",
  );

  // v61 -> v62: "persona" conflated identity with reply delivery. The mode is
  // now named "proactive": the Agent explicitly decides when to call
  // send_message, while its identity remains owned by AgentProfile.
  const replyModeSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (replyModeSchemaVersion < 62) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE workspace_agent_profiles_v62 (
          group_folder TEXT PRIMARY KEY,
          agent_profile_id TEXT NOT NULL,
          interaction_mode TEXT NOT NULL DEFAULT 'assistant'
            CHECK (interaction_mode IN ('assistant', 'proactive')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO workspace_agent_profiles_v62 (
          group_folder, agent_profile_id, interaction_mode, created_at, updated_at
        )
        SELECT
          group_folder,
          agent_profile_id,
          CASE
            WHEN interaction_mode IN ('persona', 'proactive') THEN 'proactive'
            ELSE 'assistant'
          END,
          created_at,
          updated_at
        FROM workspace_agent_profiles;
        DROP TABLE workspace_agent_profiles;
        ALTER TABLE workspace_agent_profiles_v62
          RENAME TO workspace_agent_profiles;
        CREATE INDEX idx_workspace_agent_profiles_profile
          ON workspace_agent_profiles(agent_profile_id);
      `);
    })();
  }
  db.prepare(
    `UPDATE workspace_agent_profiles
     SET interaction_mode = 'assistant'
     WHERE interaction_mode IS NULL
        OR interaction_mode NOT IN ('assistant', 'proactive')`,
  ).run();

  db.exec('DROP TABLE IF EXISTS group_members');
  backfillAgentProfileDefaultsAndWorkspaceMappings();
  removeLegacyAgentToolPolicies();
  reconcileCanonicalRuntimeProjections();
}

export function cleanEmbeddedReferenceContent(ctx: DbMigrationContext): void {
  const { db, getRouterStateInternal, parseChannelTurnContext } = ctx;
  // v63 -> v64: early Feishu reply enrichment embedded quoted ancestors in
  // messages.content, leaking prompt scaffolding into Web history and then
  // duplicating it again during fresh-session recovery. Clean only rows whose
  // direct parent is safely present in the same logical conversation; rows
  // whose quoted context is the sole surviving copy remain untouched.
  const embeddedReferenceSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (embeddedReferenceSchemaVersion < 64) {
    const candidates = db
      .prepare(
        `SELECT id, chat_jid, content, channel_context
         FROM messages
         WHERE content LIKE ?`,
      )
      .all('[引用消息链（最早到最近）]\n%') as Array<{
      id: string;
      chat_jid: string;
      content: string;
      channel_context: unknown;
    }>;
    const findParent = db.prepare(
      `SELECT sender_name, content
       FROM messages
       WHERE id = ? AND chat_jid = ?
       LIMIT 1`,
    );
    const updateMessage = db.prepare(
      `UPDATE messages
       SET content = ?, channel_context = ?
       WHERE id = ? AND chat_jid = ? AND content = ?`,
    );
    let migratedRows = 0;
    db.transaction(() => {
      for (const candidate of candidates) {
        const split = splitLegacyEmbeddedReferenceContent(candidate.content);
        const context = parseChannelTurnContext(candidate.channel_context);
        const parentId = context?.message?.parentId;
        if (!split || !context?.message || !parentId) continue;
        const parent = findParent.get(parentId, candidate.chat_jid) as
          | { sender_name: string | null; content: string }
          | undefined;
        if (!parent) continue;

        const parentText =
          splitLegacyEmbeddedReferenceContent(String(parent.content))
            ?.currentContent ?? String(parent.content);
        const referencedMessages = context.message.referencedMessages?.length
          ? context.message.referencedMessages
          : [
              {
                id: parentId,
                ...(parent.sender_name
                  ? { sender: String(parent.sender_name) }
                  : {}),
                text: parentText,
              },
            ];
        const migratedContext: ChannelTurnContext = {
          ...context,
          message: {
            ...context.message,
            referencedMessages,
          },
        };
        const result = updateMessage.run(
          split.currentContent,
          JSON.stringify(migratedContext),
          candidate.id,
          candidate.chat_jid,
          candidate.content,
        );
        migratedRows += Number(result.changes ?? 0);
      }
    })();
    if (migratedRows > 0) {
      logger.info(
        { migratedRows },
        'Separated legacy Feishu quoted context from canonical message content',
      );
    }
  }
}
