import type { DbMigrationContext } from './context.js';
import { logger } from '../logger.js';

// ISSUE-12 波 3 单元 3.4：用量表族三段自 src/db.ts 原文搬运。
// ensureUsageTables（原 db.ts 1020-1086）：usage_records/usage_events
// 建表与 v51 event_id/provider_estimated_cost_usd/usage_date 列加唯一
// 索引，无门控幂等。
// migrateUsageHistory（原 db.ts 1594-1674）：v27→v28 messages.
// token_usage → usage_records 历史迁移，!v28Check || < 28 门（新库执行）。
// migrateUsageEventLedger（原 db.ts 2058-2129）：v50→v51 幂等事件台账
// （cost_usd 镜像列调和门 hasColumn、legacy event_id 回填、usage_events
// 镜像灌入）与 v55→v56 reasoning 列、usage_date 修复重放，
// v51Check || < 51 门。搬运体逐字节一致，唯一改写是各函数体首行
// 同名解构 const { … } = ctx（调用点零改动）；logger 自模块直引
// （db.ts 既有 import，无环）。门控原文保留，不做风格统一。

export function ensureUsageTables(ctx: DbMigrationContext): void {
  const { db, ensureColumn } = ctx;
  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      usage_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      provider_estimated_cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_user_date
      ON usage_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_group_date
      ON usage_events(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_agent_date
      ON usage_events(agent_id, created_at);
  `);

  // v51 usage event ledger columns. These must be added before creating the
  // event/model uniqueness index because existing databases already have the
  // usage_records table.
  ensureColumn('usage_records', 'event_id', 'TEXT');
  ensureColumn(
    'usage_records',
    'provider_estimated_cost_usd',
    'REAL NOT NULL DEFAULT 0',
  );
  ensureColumn('usage_records', 'usage_date', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event_model
      ON usage_records(event_id, model) WHERE event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_records(usage_date);
    CREATE INDEX IF NOT EXISTS idx_usage_user_usage_date
      ON usage_records(user_id, usage_date);
  `);
}

export function migrateUsageHistory(ctx: DbMigrationContext): void {
  const { db, getRouterStateInternal } = ctx;
  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records.
      // ISSUE-09 (v77): the retired cost_usd mirror column is gone, so the
      // historical per-model cost lands directly in the provider estimate
      // (the same value the v51 UPDATE used to reconcile out of cost_usd).
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          provider_estimated_cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          provider_estimated_cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }
}

export function migrateUsageEventLedger(ctx: DbMigrationContext): void {
  const { db, ensureColumn, getRouterStateInternal, hasColumn } = ctx;
  // v50 -> v51: make usage a first-class, idempotent event ledger. Historical
  // rows predate event IDs, so each row becomes one explicitly marked legacy
  // event; we do not guess which old model rows belonged to the same run.
  // v55 -> v56: Kaboo-compatible reasoning is a fifth, independently visible
  // token class. Historical CKQClaw rows kept Claude thinking folded into
  // output, so they remain reasoning=0 rather than being guessed retroactively.
  ensureColumn(
    'usage_records',
    'reasoning_output_tokens',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(
    'usage_events',
    'reasoning_output_tokens',
    'INTEGER NOT NULL DEFAULT 0',
  );
  const v51Check = getRouterStateInternal('schema_version');
  if (!v51Check || parseInt(v51Check, 10) < 51) {
    db.transaction(() => {
      // ISSUE-09 (v77): pre-v51 databases carried the raw cost in the
      // cost_usd mirror (dropped in v77); reconcile it into the provider
      // estimate while the column still exists. Fresh databases never
      // create the column, so the guard keeps this block bootable there.
      if (hasColumn('usage_records', 'cost_usd')) {
        db.exec(`
          UPDATE usage_records
          SET provider_estimated_cost_usd = cost_usd
          WHERE provider_estimated_cost_usd = 0 AND cost_usd != 0;
        `);
      }

      db.exec(`
        UPDATE usage_records
        SET usage_date = date(created_at, 'localtime')
        WHERE usage_date IS NULL OR usage_date = '';

        UPDATE usage_records
        SET user_id = COALESCE((
          SELECT rg.created_by FROM registered_groups rg
          WHERE rg.folder = usage_records.group_folder
            AND rg.created_by IS NOT NULL
          LIMIT 1
        ), user_id)
        WHERE user_id = 'system';

        UPDATE usage_records
        SET event_id = 'legacy:' || id
        WHERE event_id IS NULL OR event_id = '';

        INSERT OR IGNORE INTO usage_events (
          event_id, user_id, group_folder, agent_id, message_id,
          input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd,
          duration_ms, num_turns, source, created_at
        )
        SELECT event_id, user_id, group_folder, agent_id, message_id,
          input_tokens, output_tokens, cache_read_input_tokens,
          cache_creation_input_tokens, reasoning_output_tokens,
          provider_estimated_cost_usd,
          duration_ms, num_turns, source, created_at
        FROM usage_records;
      `);
    })();
  }
  // Idempotent repair for installations that briefly ran an early v51 build
  // before usage_date was added to the finalized migration.
  db.exec(`
    UPDATE usage_records
    SET usage_date = date(created_at, 'localtime')
    WHERE usage_date IS NULL OR usage_date = '';
  `);
}
