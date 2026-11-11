import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Native evaluation store (task AB) — `data/db/eval.db`.
 *
 * A separate SQLite database, deliberately outside messages.db: the offline
 * eval executor (scripts/eval-auto-recall.ts) and the always-on server
 * (turn observer) write here as two independent processes, a risk surface the
 * main database has never carried. WAL + busy_timeout make that safe, and an
 * in-library user_version stamp keeps future schema evolution self-contained
 * (messages.db's CURRENT_SCHEMA_VERSION is untouched by design).
 *
 * Versioning contract mirrors db.ts: forward-only migrations, refuse
 * downgrades, no backup gate needed at v1 (fresh file, no legacy installs).
 */

const EVAL_SCHEMA_VERSION = 1;

/**
 * Score-name registry shared by backend, runner emissions, and the eval page
 * (the minimal form of Langfuse's ScoreConfig — prevents naming drift between
 * offline metrics and turn observations).
 */
export const SCORE_DEFINITIONS = {
  recall: { name: 'recall', dataType: 'NUMERIC', minValue: 0, maxValue: 1 },
  hit: { name: 'hit', dataType: 'BOOLEAN', minValue: 0, maxValue: 1 },
  mrr: { name: 'mrr', dataType: 'NUMERIC', minValue: 0, maxValue: 1 },
  precision: {
    name: 'precision',
    dataType: 'NUMERIC',
    minValue: 0,
    maxValue: 1,
  },
  recall_injected: {
    name: 'recall_injected',
    dataType: 'BOOLEAN',
    minValue: 0,
    maxValue: 1,
  },
  recall_utilized: {
    name: 'recall_utilized',
    dataType: 'BOOLEAN',
    minValue: 0,
    maxValue: 1,
  },
  turn_latency_ms: {
    name: 'turn_latency_ms',
    dataType: 'NUMERIC',
    minValue: 0,
    maxValue: 3_600_000,
  },
  turn_tokens: {
    name: 'turn_tokens',
    dataType: 'NUMERIC',
    minValue: 0,
    maxValue: 1_000_000_000,
  },
} as const;

export type ScoreDefinition =
  (typeof SCORE_DEFINITIONS)[keyof typeof SCORE_DEFINITIONS];

// ── Run records ─────────────────────────────────────────────────────────────

export interface EvalRunCategoryStat {
  n: number;
  recall: number;
  hitRate: number;
  mrr: number;
  precision: number;
}

export interface EvalRunSummary {
  overall: EvalRunCategoryStat;
  perCategory: Record<string, EvalRunCategoryStat>;
}

export interface EvalRunInput {
  id: string;
  name: string;
  kind?: string;
  k: number;
  configJson?: Record<string, unknown> | null;
  summary?: EvalRunSummary | null;
  judgePromptHash?: string | null;
  judgeModel?: string | null;
  createdAt?: string;
}

export interface EvalRunRecord extends EvalRunInput {
  kind: string;
  configJson: Record<string, unknown> | null;
  summary: EvalRunSummary | null;
  judgePromptHash: string | null;
  judgeModel: string | null;
  createdAt: string;
}

export interface EvalRunItemInput {
  queryId: string;
  category: string;
  expected: string[];
  retrieved: string[];
  recall: number;
  hit: number;
  mrr: number;
  precision: number;
  latencyMs: number;
  note?: string | null;
}

export interface EvalRunItemRecord extends Required<EvalRunItemInput> {
  id: number;
  runId: string;
}

export interface EvalRunComparisonRow {
  id: string | null;
  name: string | null;
  k: number | null;
  itemCount: number;
  recall: number | null;
  hitRate: number | null;
  mrr: number | null;
  precision: number | null;
}

// ── Observed turns ──────────────────────────────────────────────────────────

export interface ObsTurnInsert {
  turnId: string;
  sessionId?: string | null;
  workspaceJid?: string | null;
  folder?: string | null;
  channel?: string | null;
  interactionMode?: string | null;
  autoRecallEnabled?: number | null;
  recallInjected?: number | null;
  recallHitCount?: number | null;
  recallLatencyMs?: number | null;
  inputText?: string | null;
  outputText?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  judgeUsed?: number | null;
  judgeReasoning?: string | null;
  judgeError?: string | null;
  judgePromptHash?: string | null;
  judgeModel?: string | null;
  createdAt?: string;
}

export type ObsTurnUpdate = Partial<
  Omit<ObsTurnInsert, 'turnId' | 'createdAt'>
>;

export type ObsTurnRecord = Required<ObsTurnInsert>;

export interface ObsTurnListFilter {
  workspaceJid?: string;
  channel?: string;
  /** Filter on recall_injected = 1. */
  recallInjected?: boolean;
  /** 'judged' = judge_used IS NOT NULL; 'pending' = IS NULL; default any. */
  judge?: 'judged' | 'pending';
  limit?: number;
  offset?: number;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface EvalRunRow {
  id: string;
  name: string;
  kind: string;
  k: number;
  config_json: string | null;
  summary_json: string | null;
  judge_prompt_hash: string | null;
  judge_model: string | null;
  created_at: string;
}

interface EvalRunItemRow {
  id: number;
  run_id: string;
  query_id: string;
  category: string;
  expected_json: string;
  retrieved_json: string;
  recall: number;
  hit: number;
  mrr: number;
  precision: number;
  latency_ms: number;
  note: string | null;
}

interface ObsTurnRow {
  turn_id: string;
  session_id: string | null;
  workspace_jid: string | null;
  folder: string | null;
  channel: string | null;
  interaction_mode: string | null;
  auto_recall_enabled: number | null;
  recall_injected: number | null;
  recall_hit_count: number | null;
  recall_latency_ms: number | null;
  input_text: string | null;
  output_text: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  judge_used: number | null;
  judge_reasoning: string | null;
  judge_error: string | null;
  judge_prompt_hash: string | null;
  judge_model: string | null;
  created_at: string;
}

function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRunRow(row: EvalRunRow): EvalRunRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    k: row.k,
    configJson: parseJsonColumn<Record<string, unknown> | null>(
      row.config_json,
      null,
    ),
    summary: parseJsonColumn<EvalRunSummary | null>(row.summary_json, null),
    judgePromptHash: row.judge_prompt_hash,
    judgeModel: row.judge_model,
    createdAt: row.created_at,
  };
}

function mapItemRow(row: EvalRunItemRow): EvalRunItemRecord {
  return {
    id: row.id,
    runId: row.run_id,
    queryId: row.query_id,
    category: row.category,
    expected: parseJsonColumn<string[]>(row.expected_json, []),
    retrieved: parseJsonColumn<string[]>(row.retrieved_json, []),
    recall: row.recall,
    hit: row.hit,
    mrr: row.mrr,
    precision: row.precision,
    latencyMs: row.latency_ms,
    note: row.note,
  };
}

function mapTurnRow(row: ObsTurnRow): ObsTurnRecord {
  return {
    turnId: row.turn_id,
    sessionId: row.session_id,
    workspaceJid: row.workspace_jid,
    folder: row.folder,
    channel: row.channel,
    interactionMode: row.interaction_mode,
    autoRecallEnabled: row.auto_recall_enabled,
    recallInjected: row.recall_injected,
    recallHitCount: row.recall_hit_count,
    recallLatencyMs: row.recall_latency_ms,
    inputText: row.input_text,
    outputText: row.output_text,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    judgeUsed: row.judge_used,
    judgeReasoning: row.judge_reasoning,
    judgeError: row.judge_error,
    judgePromptHash: row.judge_prompt_hash,
    judgeModel: row.judge_model,
    createdAt: row.created_at,
  };
}

export class EvalStore {
  private constructor(private readonly db: Database.Database) {}

  /** Open (and migrate if needed) the eval database at `dbPath`. */
  static open(dbPath?: string): EvalStore {
    const resolved = dbPath ?? path.join(STORE_DIR, 'eval.db');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new Database(resolved);
    db.exec('PRAGMA busy_timeout = 5000');
    const version = (
      db.prepare('PRAGMA user_version').get() as { user_version: number }
    ).user_version;
    if (version > EVAL_SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `eval.db schema v${version} is newer than supported v${EVAL_SCHEMA_VERSION}; refusing downgrade`,
      );
    }
    // Same WAL + NORMAL pairing as messages.db (src/db.ts): two writer
    // processes (server + eval script) interleave safely, and busy_timeout
    // absorbs the rare write-write contention window.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    if (version < EVAL_SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_runs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'recall',
          k INTEGER NOT NULL,
          config_json TEXT,
          summary_json TEXT,
          judge_prompt_hash TEXT,
          judge_model TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eval_run_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
          query_id TEXT NOT NULL,
          category TEXT NOT NULL,
          expected_json TEXT NOT NULL,
          retrieved_json TEXT NOT NULL,
          recall REAL NOT NULL,
          hit INTEGER NOT NULL,
          mrr REAL NOT NULL,
          precision REAL NOT NULL,
          latency_ms INTEGER NOT NULL,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS obs_turns (
          turn_id TEXT PRIMARY KEY,
          session_id TEXT,
          workspace_jid TEXT,
          folder TEXT,
          channel TEXT,
          interaction_mode TEXT,
          auto_recall_enabled INTEGER,
          recall_injected INTEGER,
          recall_hit_count INTEGER,
          recall_latency_ms INTEGER,
          input_text TEXT,
          output_text TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL,
          duration_ms INTEGER,
          judge_used INTEGER,
          judge_reasoning TEXT,
          judge_error TEXT,
          judge_prompt_hash TEXT,
          judge_model TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_eval_run_items_run
          ON eval_run_items(run_id);
        CREATE INDEX IF NOT EXISTS idx_obs_turns_created
          ON obs_turns(created_at);
        CREATE INDEX IF NOT EXISTS idx_obs_turns_workspace
          ON obs_turns(workspace_jid);
        PRAGMA user_version = ${EVAL_SCHEMA_VERSION};
      `);
      logger.info(
        { path: resolved, version: EVAL_SCHEMA_VERSION },
        'eval.db initialized',
      );
    }
    return new EvalStore(db);
  }

  close(): void {
    this.db.close();
  }

  // ── eval_runs ─────────────────────────────────────────────────────────────

  /** Insert-or-replace one run together with its items, atomically. */
  upsertRun(run: EvalRunInput, items: readonly EvalRunItemInput[]): void {
    const createdAt = run.createdAt ?? new Date().toISOString();
    const writeRun = this.db.prepare(`
      INSERT INTO eval_runs (id, name, kind, k, config_json, summary_json, judge_prompt_hash, judge_model, created_at)
      VALUES (@id, @name, @kind, @k, @configJson, @summaryJson, @judgePromptHash, @judgeModel, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        k = excluded.k,
        config_json = excluded.config_json,
        summary_json = excluded.summary_json,
        judge_prompt_hash = excluded.judge_prompt_hash,
        judge_model = excluded.judge_model
    `);
    const deleteItems = this.db.prepare(
      'DELETE FROM eval_run_items WHERE run_id = ?',
    );
    const insertItem = this.db.prepare(`
      INSERT INTO eval_run_items
        (run_id, query_id, category, expected_json, retrieved_json, recall, hit, mrr, precision, latency_ms, note)
      VALUES
        (@runId, @queryId, @category, @expectedJson, @retrievedJson, @recall, @hit, @mrr, @precision, @latencyMs, @note)
    `);
    this.db.transaction(() => {
      writeRun.run({
        id: run.id,
        name: run.name,
        kind: run.kind ?? 'recall',
        k: run.k,
        configJson: run.configJson ? JSON.stringify(run.configJson) : null,
        summaryJson: run.summary ? JSON.stringify(run.summary) : null,
        judgePromptHash: run.judgePromptHash ?? null,
        judgeModel: run.judgeModel ?? null,
        createdAt,
      });
      deleteItems.run(run.id);
      for (const item of items) {
        insertItem.run({
          runId: run.id,
          queryId: item.queryId,
          category: item.category,
          expectedJson: JSON.stringify(item.expected),
          retrievedJson: JSON.stringify(item.retrieved),
          recall: item.recall,
          hit: item.hit,
          mrr: item.mrr,
          precision: item.precision,
          latencyMs: item.latencyMs,
          note: item.note ?? null,
        });
      }
    })();
  }

  listRuns(limit = 100): EvalRunRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM eval_runs ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(limit) as EvalRunRow[];
    return rows.map(mapRunRow);
  }

  getRun(
    id: string,
  ): { run: EvalRunRecord; items: EvalRunItemRecord[] } | null {
    const runRow = this.db
      .prepare('SELECT * FROM eval_runs WHERE id = ?')
      .get(id) as EvalRunRow | undefined;
    if (!runRow) return null;
    const itemRows = this.db
      .prepare('SELECT * FROM eval_run_items WHERE run_id = ? ORDER BY id')
      .all(id) as EvalRunItemRow[];
    return { run: mapRunRow(runRow), items: itemRows.map(mapItemRow) };
  }

  /**
   * Side-by-side overall metrics for several runs, recomputed from stored
   * items (the persisted summary stays a cross-check, never the source).
   * Unknown ids yield a null row so callers can show the gap explicitly.
   */
  compareRuns(ids: readonly string[]): Array<EvalRunComparisonRow | null> {
    return ids.map((id) => {
      const runRow = this.db
        .prepare('SELECT * FROM eval_runs WHERE id = ?')
        .get(id) as EvalRunRow | undefined;
      if (!runRow) return null;
      const itemRows = this.db
        .prepare('SELECT * FROM eval_run_items WHERE run_id = ? ORDER BY id')
        .all(id) as EvalRunItemRow[];
      if (itemRows.length === 0) {
        return {
          id: runRow.id,
          name: runRow.name,
          k: runRow.k,
          itemCount: 0,
          recall: null,
          hitRate: null,
          mrr: null,
          precision: null,
        };
      }
      const count = itemRows.length;
      const mean = (pick: (row: EvalRunItemRow) => number): number =>
        itemRows.reduce((sum, row) => sum + pick(row), 0) / count;
      return {
        id: runRow.id,
        name: runRow.name,
        k: runRow.k,
        itemCount: count,
        recall: mean((row) => row.recall),
        hitRate: mean((row) => row.hit),
        mrr: mean((row) => row.mrr),
        precision: mean((row) => row.precision),
      };
    });
  }

  // ── obs_turns ─────────────────────────────────────────────────────────────

  /** Insert one observed turn; a duplicate turnId is ignored (idempotent). */
  insertTurn(turn: ObsTurnInsert): void {
    this.db
      .prepare(
        `
        INSERT INTO obs_turns
          (turn_id, session_id, workspace_jid, folder, channel, interaction_mode,
           auto_recall_enabled, recall_injected, recall_hit_count, recall_latency_ms,
           input_text, output_text, input_tokens, output_tokens, cost_usd, duration_ms,
           judge_used, judge_reasoning, judge_error, judge_prompt_hash, judge_model, created_at)
        VALUES
          (@turnId, @sessionId, @workspaceJid, @folder, @channel, @interactionMode,
           @autoRecallEnabled, @recallInjected, @recallHitCount, @recallLatencyMs,
           @inputText, @outputText, @inputTokens, @outputTokens, @costUsd, @durationMs,
           @judgeUsed, @judgeReasoning, @judgeError, @judgePromptHash, @judgeModel, @createdAt)
        ON CONFLICT(turn_id) DO NOTHING
      `,
      )
      .run({
        sessionId: null,
        workspaceJid: null,
        folder: null,
        channel: null,
        interactionMode: null,
        autoRecallEnabled: null,
        recallInjected: null,
        recallHitCount: null,
        recallLatencyMs: null,
        inputText: null,
        outputText: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        durationMs: null,
        judgeUsed: null,
        judgeReasoning: null,
        judgeError: null,
        judgePromptHash: null,
        judgeModel: null,
        ...turn,
        createdAt: turn.createdAt ?? new Date().toISOString(),
      });
  }

  /** Patch nullable columns; returns false when the turn row is unknown. */
  updateTurn(turnId: string, patch: ObsTurnUpdate): boolean {
    const keys = Object.keys(patch).filter((key) => key !== 'turnId');
    if (keys.length === 0) {
      return Boolean(
        this.db
          .prepare('SELECT 1 FROM obs_turns WHERE turn_id = ?')
          .get(turnId),
      );
    }
    const snakeMap: Record<string, string> = {
      sessionId: 'session_id',
      workspaceJid: 'workspace_jid',
      folder: 'folder',
      channel: 'channel',
      interactionMode: 'interaction_mode',
      autoRecallEnabled: 'auto_recall_enabled',
      recallInjected: 'recall_injected',
      recallHitCount: 'recall_hit_count',
      recallLatencyMs: 'recall_latency_ms',
      inputText: 'input_text',
      outputText: 'output_text',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      costUsd: 'cost_usd',
      durationMs: 'duration_ms',
      judgeUsed: 'judge_used',
      judgeReasoning: 'judge_reasoning',
      judgeError: 'judge_error',
      judgePromptHash: 'judge_prompt_hash',
      judgeModel: 'judge_model',
    };
    const assignments = keys.map((key) => `${snakeMap[key]} = @${key}`);
    const changes = this.db
      .prepare(
        `UPDATE obs_turns SET ${assignments.join(', ')} WHERE turn_id = @turnId`,
      )
      .run({ ...patch, turnId }).changes;
    return changes > 0;
  }

  /** Bounded turn listing with filters + pagination, newest first. */
  listTurns(filter: ObsTurnListFilter): {
    items: ObsTurnRecord[];
    total: number;
  } {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.workspaceJid) {
      conditions.push('workspace_jid = @workspaceJid');
      params.workspaceJid = filter.workspaceJid;
    }
    if (filter.channel) {
      conditions.push('channel = @channel');
      params.channel = filter.channel;
    }
    if (filter.recallInjected === true) {
      conditions.push('recall_injected = 1');
    }
    if (filter.judge === 'judged') {
      conditions.push('judge_used IS NOT NULL');
    } else if (filter.judge === 'pending') {
      conditions.push('judge_used IS NULL');
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS total FROM obs_turns ${where}`)
        .get(params) as { total: number }
    ).total;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM obs_turns ${where}
         ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset }) as ObsTurnRow[];
    return { items: rows.map(mapTurnRow), total };
  }

  /**
   * Turns the recall judge may pick up: finished (duration_ms written),
   * recall-injected, and not yet judged. Ascending so the batch drains oldest
   * first.
   */
  listPendingJudgeTurns(limit: number): ObsTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM obs_turns
         WHERE recall_injected = 1 AND judge_used IS NULL AND duration_ms IS NOT NULL
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as ObsTurnRow[];
    return rows.map(mapTurnRow);
  }
}

// ── Process-level default instance ──────────────────────────────────────────
//
// One connection per process: the server shares it across routes and the turn
// observer; the offline eval script opens its own process-local instance. WAL
// keeps the two processes safe without a shared handle.

let defaultStore: EvalStore | null = null;

export function getDefaultEvalStore(): EvalStore {
  if (!defaultStore) defaultStore = EvalStore.open();
  return defaultStore;
}

/** Test hook — drop the cached connection (closes it if open). */
export function closeDefaultEvalStore(): void {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
}
