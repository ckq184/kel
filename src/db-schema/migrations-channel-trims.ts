import type { DbMigrationContext } from './context.js';
import { logger } from '../logger.js';

// ISSUE-12 波 3 单元 3.8：渠道退役与裁剪段自 src/db.ts 原文搬运（原
// db.ts 2220-2555：v66→v67 memory_chunks 表族 DROP、v71→v72
// pending_approvals DROP、v72→v73 无代码注释段、v74→v75 Telegram/
// Discord/WhatsApp 渠道退役 trim（children-first 删除序、notify_channels
// 与 definition_snapshot 存量修剪）、v75→v76 billing/redeem/quota 表族
// 与死列 DROP、v76→v77 usage_daily_summary 与 billing 镜像死列 DROP——
// 搬运时 v77 恰为 CURRENT_SCHEMA_VERSION；其后 ISSUE-25 追加 v77→v78
// scheduled_tasks 旧租约两列 DROP。全部 ? '0'/!vXCheck 门新库执行，
// 破坏性 trim 的回滚路径是 enforcePreMigrationBackup 备份门）。
// 计划表 2261-2555 外的 2220-2259（v66→v67/v71→v72/v72→v73 注释）为
// 行界缺口段按 trim 主题并入本单元，提交信息留痕。搬运体逐字节一致，
// 唯一改写是函数体首行同名解构 const { db, getRouterStateInternal,
// tableExists } = ctx（调用点零改动）；logger 模块直引无环。

export function trimRetiredSchemas(ctx: DbMigrationContext): void {
  const { db, getRouterStateInternal, tableExists } = ctx;
  // v66 -> v67: drop the legacy pre-v65 memory chunk index. Workspace Memory
  // v2 (workspace_memory_* tables) replaced it; no code path reads or writes
  // memory_chunks anymore, yet with its FTS shadow tables it dominated
  // production database size (65% of the file, zero writes for months).
  const memoryChunksSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (memoryChunksSchemaVersion < 67) {
    const hadLegacyChunks = tableExists('memory_chunks');
    db.exec(`
      DROP TABLE IF EXISTS memory_chunks_fts;
      DROP TABLE IF EXISTS memory_chunks;
    `);
    if (hadLegacyChunks) {
      logger.info(
        'Dropped legacy memory_chunks tables superseded by Workspace Memory v2',
      );
    }
  }

  // v71 -> v72: drop the tool-approval gate's audit table. The approval gate
  // (policy/extension/loop guard) was rolled back with the survey-driven
  // modules (task U); no code path reads or writes pending_approvals anymore.
  const pendingApprovalsSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (pendingApprovalsSchemaVersion < 72) {
    const hadPendingApprovals = tableExists('pending_approvals');
    db.exec('DROP TABLE IF EXISTS pending_approvals;');
    if (hadPendingApprovals) {
      logger.info(
        'Dropped pending_approvals table superseded by the approval-gate rollback',
      );
    }
  }

  // v72 -> v73 (task V): custom_model_pricing only. The table and its partial
  // unique indexes are created idempotently by the base schema block above
  // (CREATE TABLE/INDEX IF NOT EXISTS), so this bump carries no data migration
  // and needs no versioned step; existing usage rows are never repriced.

  // v74 -> v75 (task AJ): retire the Telegram/Discord/WhatsApp IM channels.
  // User-approved destructive trim (2026-11-12): account rows plus every row
  // owned by the retired channel JID prefixes (chats/messages, mounts,
  // bindings, pinned groups, builder drafts, tasks + their runs/logs) are
  // deleted — the pre-migration backup is the rollback path. Surviving rows
  // only lose retired references: agent IM pointers are NULLed, task delivery
  // routes fall back to chat_jid, and notify_channels lists (task column +
  // run definition snapshots) drop the retired values so the narrowed zod
  // enum keeps validating stored rows. Workspaces are web:*-keyed and stay.
  const channelTrimSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  if (channelTrimSchemaVersion < 75) {
    const retiredPrefixes = ['telegram:', 'discord:', 'whatsapp:'];
    const retiredLike = retiredPrefixes.map((p) => `${p}%`);
    const retiredSet = new Set(['telegram', 'discord', 'whatsapp']);
    const like3 = (col: string) =>
      retiredLike.map((p) => `${col} LIKE ?`).join(' OR ');
    const isRetiredJid = (value: unknown): value is string =>
      typeof value === 'string' &&
      retiredPrefixes.some((prefix) => value.startsWith(prefix));

    let trimmedTaskNotify = 0;
    let trimmedTaskRoutes = 0;
    let trimmedSnapshots = 0;

    const trimRetiredChannels = db.transaction(() => {
      const deletedCounts: Record<string, number> = {};
      const deleteBy = (table: string, sql: string, ...params: unknown[]) => {
        const info = db.prepare(sql).run(...params);
        if (info.changes > 0) deletedCounts[table] = info.changes;
      };

      // Children first: FK enforcement is ON and none of these FKs cascade.
      deleteBy(
        'messages',
        `DELETE FROM messages WHERE ${like3('chat_jid')}`,
        ...retiredLike,
      );
      deleteBy(
        'chats',
        `DELETE FROM chats WHERE ${like3('jid')}`,
        ...retiredLike,
      );
      const retiredTaskIds = `SELECT id FROM scheduled_tasks WHERE ${like3(
        'chat_jid',
      )}`;
      deleteBy(
        'task_run_logs',
        `DELETE FROM task_run_logs WHERE task_id IN (${retiredTaskIds})`,
        ...retiredLike,
      );
      deleteBy(
        'task_runs',
        `DELETE FROM task_runs WHERE task_id IN (${retiredTaskIds})`,
        ...retiredLike,
      );
      deleteBy(
        'scheduled_tasks',
        `DELETE FROM scheduled_tasks WHERE ${like3('chat_jid')}`,
        ...retiredLike,
      );
      deleteBy(
        'registered_groups',
        `DELETE FROM registered_groups WHERE ${like3('jid')}`,
        ...retiredLike,
      );
      deleteBy(
        'im_context_bindings',
        `DELETE FROM im_context_bindings WHERE ${like3('source_jid')}`,
        ...retiredLike,
      );
      deleteBy(
        'channel_mounts',
        `DELETE FROM channel_mounts WHERE channel_type IN ('telegram', 'discord', 'whatsapp')`,
      );
      deleteBy(
        'agent_channel_mounts',
        `DELETE FROM agent_channel_mounts WHERE channel_type IN ('telegram', 'discord', 'whatsapp')`,
      );
      deleteBy(
        'user_pinned_groups',
        `DELETE FROM user_pinned_groups WHERE ${like3('jid')}`,
        ...retiredLike,
      );
      deleteBy(
        'agent_builder_drafts',
        `DELETE FROM agent_builder_drafts WHERE ${like3('source_chat_jid')}`,
        ...retiredLike,
      );
      // Agents live on workspace folders, not channels: drop the ones whose
      // conversation JID was a retired channel, keep the rest and only NULL
      // their retired IM pointers.
      deleteBy(
        'agents',
        `DELETE FROM agents WHERE ${like3('chat_jid')}`,
        ...retiredLike,
      );
      trimmedTaskRoutes += db
        .prepare(
          `UPDATE agents SET last_im_jid = NULL WHERE ${like3('last_im_jid')}`,
        )
        .run(...retiredLike).changes;
      trimmedTaskRoutes += db
        .prepare(
          `UPDATE agents SET spawned_from_jid = NULL WHERE ${like3('spawned_from_jid')}`,
        )
        .run(...retiredLike).changes;
      deleteBy(
        'channel_accounts',
        `DELETE FROM channel_accounts WHERE provider IN ('telegram', 'discord', 'whatsapp')`,
      );

      // Delivery routes pointing at retired chats fall back to chat_jid
      // (same NULL-fallback mapTaskRunRow already applies on read).
      trimmedTaskRoutes += db
        .prepare(
          `UPDATE scheduled_tasks SET delivery_route_jid = NULL WHERE ${like3(
            'delivery_route_jid',
          )}`,
        )
        .run(...retiredLike).changes;

      // notify_channels trim on surviving tasks (stored as a JSON array).
      const updateTaskNotify = db.prepare(
        'UPDATE scheduled_tasks SET notify_channels = ? WHERE id = ?',
      );
      for (const row of db
        .prepare(
          'SELECT id, notify_channels FROM scheduled_tasks WHERE notify_channels IS NOT NULL',
        )
        .all() as Array<{ id: string; notify_channels: string }>) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.notify_channels);
        } catch {
          continue;
        }
        if (!Array.isArray(parsed)) continue;
        const kept = parsed.filter(
          (channel) => typeof channel === 'string' && !retiredSet.has(channel),
        );
        if (kept.length === parsed.length) continue;
        updateTaskNotify.run(
          kept.length > 0 ? JSON.stringify(kept) : null,
          row.id,
        );
        trimmedTaskNotify += 1;
      }

      // Definition snapshots of surviving runs: drop retired notify_channels
      // values and NULL retired delivery routes so retries/notifications
      // never resurrect a deleted provider.
      const updateSnapshot = db.prepare(
        'UPDATE task_runs SET definition_snapshot = ? WHERE id = ?',
      );
      for (const row of db
        .prepare(
          'SELECT id, definition_snapshot FROM task_runs WHERE json_valid(definition_snapshot)',
        )
        .all() as Array<{ id: string; definition_snapshot: string }>) {
        let snapshot: Record<string, unknown>;
        try {
          snapshot = JSON.parse(row.definition_snapshot) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }
        let changed = false;
        if (Array.isArray(snapshot.notify_channels)) {
          const kept = snapshot.notify_channels.filter(
            (channel) =>
              typeof channel === 'string' && !retiredSet.has(channel),
          );
          if (kept.length !== snapshot.notify_channels.length) {
            snapshot.notify_channels = kept.length > 0 ? kept : null;
            changed = true;
          }
        }
        if (isRetiredJid(snapshot.delivery_route_jid)) {
          snapshot.delivery_route_jid = null;
          changed = true;
        }
        if (!changed) continue;
        updateSnapshot.run(JSON.stringify(snapshot), row.id);
        trimmedSnapshots += 1;
      }

      if (Object.keys(deletedCounts).length > 0 || trimmedTaskNotify > 0) {
        logger.info(
          {
            deletedCounts,
            trimmedTaskNotify,
            trimmedTaskRoutes,
            trimmedSnapshots,
          },
          'v75 channel trim: removed retired Telegram/Discord/WhatsApp rows',
        );
      }
    });
    trimRetiredChannels();
  }

  // v75→v76 trim: drop the retired billing/redeem/quota clusters (code paths
  // were removed in the same change; data survives in the pre-migration backup
  // that the enforcePreMigrationBackup gate writes for v<76 databases) and
  // drop dead columns left behind by the auto-memory/billing/plugins prunes.
  const v76Check = getRouterStateInternal('schema_version');
  if (!v76Check || parseInt(v76Check, 10) < 76) {
    const dropRetiredTables = db.transaction(() => {
      // Zero-row dead tables (billing/redeem/quota prune leftovers) plus the
      // billing compatibility tables with operator-review rows (documented as
      // deliberately preserved at the time; the whole commercialization
      // cluster is retired now). Children are dropped before their parents so
      // FK enforcement never blocks the trim.
      for (const table of [
        'redeem_code_usage',
        'user_subscriptions',
        'balance_transactions',
        'user_balances',
        'billing_plans',
        'monthly_usage',
        'daily_usage',
        'user_quotas',
        'redeem_codes',
        'billing_audit_log',
      ]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }

      // Dead columns (additive-era leftovers; SQLite 3.35+ DROP COLUMN).
      const dropColumns: Array<[string, string]> = [
        ['registered_groups', 'auto_memory_recall'],
        ['users', 'subscription_plan_id'],
        ['messages', 'cost_usd'],
      ];
      for (const [table, column] of dropColumns) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        if (cols.some((c) => c.name === column)) {
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
      }
    });
    dropRetiredTables();
    logger.info(
      'v76 prune trim: retired billing/redeem/quota tables and dead columns dropped',
    );
  }

  // v76→v77 trim (ISSUE-09): drop the retired usage_daily_summary table and
  // the dead billing-mirror / legacy columns. Every write path to these
  // columns was removed in the same change; surviving data is untouched and
  // the pre-migration backup (enforcePreMigrationBackup gate, v<77) keeps the
  // dropped values recoverable. turn_runs.heartbeat_at / correlation_id were
  // reviewed and deliberately KEPT (user decision 2026-11-20: channel
  // reliability state machine diagnostics).
  const v77Check = getRouterStateInternal('schema_version');
  if (!v77Check || parseInt(v77Check, 10) < 77) {
    const dropRetiredUsageStructures = db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS usage_daily_summary');

      // Dead columns (additive-era leftovers; SQLite 3.35+ DROP COLUMN).
      const dropColumns: Array<[string, string]> = [
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
      ];
      for (const [table, column] of dropColumns) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>;
        if (cols.some((c) => c.name === column)) {
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
      }
    });
    dropRetiredUsageStructures();
    logger.info(
      'v77 prune trim: retired usage summary table and dead billing-mirror/legacy columns dropped',
    );
  }

  // v77→v78 trim (ISSUE-25): drop scheduled_tasks.running_until / runner_id.
  // They backed the legacy definition-level lease (claimTaskForRun), which
  // the durable task_runs lease superseded; the writer was removed in the
  // same change and every other site only cleared them. A lease value left
  // behind by an old process carries no meaning under V2.
  const v78Check = getRouterStateInternal('schema_version');
  if (!v78Check || parseInt(v78Check, 10) < 78) {
    const dropLegacyTaskLeaseColumns = db.transaction(() => {
      const cols = db
        .prepare('PRAGMA table_info(scheduled_tasks)')
        .all() as Array<{ name: string }>;
      for (const column of ['running_until', 'runner_id']) {
        if (cols.some((c) => c.name === column)) {
          db.exec(`ALTER TABLE scheduled_tasks DROP COLUMN ${column}`);
        }
      }
    });
    dropLegacyTaskLeaseColumns();
    logger.info('v78 prune trim: legacy scheduled_tasks lease columns dropped');
  }
}
