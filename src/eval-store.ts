import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import Database from 'better-sqlite3';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { validateGoldenSet, type GoldenSet } from './eval-dataset.js';

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
 * downgrades, no backup gate needed (fresh file, additive migrations only).
 *
 * History: v1 (task AB) eval_runs / eval_run_items / obs_turns;
 * v2 (task AD) eval_datasets + builtin auto-recall seeding;
 * v5 (task AG) harness_acceptance_sets / harness_probes.
 */

const EVAL_SCHEMA_VERSION = 5;

/** Builtin seed source (repo file; content pinned by the golden-set tests). */
const BUILTIN_GOLDEN_SET_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/eval/auto-recall-golden.json',
);

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
  /** Adapter version active when the turn ran; 0 = baseline (task AF). */
  adapterVersion?: number | null;
  createdAt?: string;
}

export type ObsTurnUpdate = Partial<
  Omit<ObsTurnInsert, 'turnId' | 'createdAt'>
>;

export type ObsTurnRecord = Required<ObsTurnInsert>;

// ── Managed golden sets (task AD, eval.db v2) ────────────────────────────────

export type EvalDatasetSource = 'builtin' | 'manual' | 'import';

export interface EvalDatasetUpsertInput {
  name: string;
  description?: string | null;
  data: GoldenSet;
  source: EvalDatasetSource;
}

export interface EvalDatasetRecord {
  name: string;
  description: string | null;
  data: GoldenSet;
  source: EvalDatasetSource;
  createdAt: string;
  updatedAt: string;
}

/** List projection — counts only, never the data payload. */
export interface EvalDatasetListItem {
  name: string;
  description: string | null;
  source: EvalDatasetSource;
  seedCount: number;
  queryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvalDatasetRow {
  name: string;
  description: string | null;
  data_json: string;
  source: string;
  created_at: string;
  updated_at: string;
}

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

// ── Harness adapter (task AE, v3) ───────────────────────────────────────────

/** One trajectory moment a proposal cites as evidence (leak-free by construction). */
export interface HarnessProposalEvidence {
  turnId: string;
  inputExcerpt: string;
  outputExcerpt: string;
  why: string;
}

export interface HarnessProposalInput {
  id: string;
  workspaceJid: string;
  /** Full proposed ADAPTER.md; empty string when keepBase. */
  adapterMd: string;
  keepBase: boolean;
  /** Unified diff vs the baseline version (display only). */
  diff: string | null;
  rationale: string;
  evidence: HarnessProposalEvidence[];
  /** Active version at proposal time; 0 = no adapter yet. */
  baselineVersion: number;
  model: string;
  promptHash: string;
  createdAt?: string;
}

export type HarnessProposalStatus =
  | 'pending'
  | 'adopted'
  | 'rejected'
  | 'invalid';

export interface HarnessProposalListItem {
  id: string;
  workspaceJid: string;
  status: HarnessProposalStatus;
  keepBase: boolean;
  rationale: string;
  evidenceCount: number;
  baselineVersion: number;
  model: string;
  promptHash: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface HarnessProposalRecord extends HarnessProposalListItem {
  adapterMd: string;
  diff: string | null;
  evidence: HarnessProposalEvidence[];
}

export interface HarnessVersionInput {
  workspaceJid: string;
  proposalId: string | null;
  adapterMd: string;
  adoptedBy: string;
}

export interface HarnessVersionRecord {
  id: string;
  workspaceJid: string;
  version: number;
  proposalId: string | null;
  adapterMd: string;
  adoptedBy: string;
  createdAt: string;
}

export interface HarnessLessonInput {
  id: string;
  workspaceJid: string;
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string | null;
  proposalId: string | null;
}

export interface HarnessLessonRecord extends HarnessLessonInput {
  createdAt: string;
}

interface HarnessProposalRow {
  id: string;
  workspace_jid: string;
  status: string;
  adapter_md: string;
  keep_base: number;
  diff_json: string | null;
  rationale: string;
  evidence_json: string;
  baseline_version: number;
  model: string;
  prompt_hash: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface HarnessVersionRow {
  id: string;
  workspace_jid: string;
  version: number;
  proposal_id: string | null;
  adapter_md: string;
  adopted_by: string;
  created_at: string;
}

interface HarnessLessonRow {
  id: string;
  workspace_jid: string;
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string | null;
  proposal_id: string | null;
  created_at: string;
}

// ── Harness probe (task AG, v5) ─────────────────────────────────────────────

/** One acceptance-set question (validated upstream by src/harness-probe.ts). */
export interface HarnessAcceptanceQuery {
  id: string;
  text: string;
  expectNotes: string[];
}

export interface HarnessAcceptanceSetInput {
  workspaceJid: string;
  queries: HarnessAcceptanceQuery[];
}

export interface HarnessAcceptanceSetRecord extends HarnessAcceptanceSetInput {
  updatedAt: string;
}

/** One blind-judge verdict as presented (A/B are presentation-side labels). */
export interface HarnessBlindJudge {
  prefer: 'A' | 'B' | 'tie';
  perNote: Array<{ note: string; pick: 'A' | 'B' | 'tie' }>;
  reasoning: string;
}

/** Per-question probe material (the rounds_json payload). */
export interface HarnessProbeRound {
  queryId: string;
  baselineText: string;
  proposedText: string;
  /** Reply order (baseline=A, proposed=B); null when the judge call failed. */
  judgeDirect: HarnessBlindJudge | null;
  /** Swapped presentation (proposed=A, baseline=B); null on failure. */
  judgeSwapped: HarnessBlindJudge | null;
  /** Note → winning arm after both judges agree (tie otherwise). */
  noteHits: Array<{ note: string; arm: 'baseline' | 'proposed' | 'tie' }>;
}

export type HarnessProbeVerdict = 'adopt' | 'keep_base' | 'inconclusive';

export interface HarnessProbeInput {
  id: string;
  proposalId: string;
  workspaceJid: string;
  /** Active adapter version when the probe ran; 0 = baseline platform prompt. */
  baselineVersion: number;
  verdict: HarnessProbeVerdict;
  roundsWon: number;
  roundsLost: number;
  roundsTied: number;
  notesBaselineHit: number;
  notesProposedHit: number;
  rounds: HarnessProbeRound[];
  costUsd?: number | null;
  model: string;
  createdAt?: string;
}

export type HarnessProbeRecord = Required<HarnessProbeInput>;

interface HarnessProbeRow {
  id: string;
  proposal_id: string;
  workspace_jid: string;
  baseline_version: number;
  verdict: string;
  rounds_won: number;
  rounds_lost: number;
  rounds_tied: number;
  notes_baseline_hit: number;
  notes_proposed_hit: number;
  rounds_json: string;
  cost_usd: number | null;
  model: string;
  created_at: string;
}

function mapProbeRow(row: HarnessProbeRow): HarnessProbeRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    workspaceJid: row.workspace_jid,
    baselineVersion: row.baseline_version,
    verdict: row.verdict as HarnessProbeVerdict,
    roundsWon: row.rounds_won,
    roundsLost: row.rounds_lost,
    roundsTied: row.rounds_tied,
    notesBaselineHit: row.notes_baseline_hit,
    notesProposedHit: row.notes_proposed_hit,
    rounds: parseJsonColumn<HarnessProbeRound[]>(row.rounds_json, []),
    costUsd: row.cost_usd,
    model: row.model,
    createdAt: row.created_at,
  };
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
  adapter_version: number;
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

/**
 * v2 migration seed: the shipped golden JSON becomes the builtin dataset
 * (`auto-recall`). Missing file or invalid content skips seeding (never
 * blocks migration — the file stays the fallback source for the harness).
 */
function seedBuiltinDataset(db: Database.Database): void {
  try {
    const raw = fs.readFileSync(BUILTIN_GOLDEN_SET_PATH, 'utf8');
    const data = JSON.parse(raw) as GoldenSet;
    if (validateGoldenSet(data).length > 0) {
      logger.warn(
        'builtin golden set failed validation — skipping dataset seed',
      );
      return;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO eval_datasets (name, description, data_json, source, created_at, updated_at)
       VALUES ('auto-recall', ?, ?, 'builtin', ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    ).run(
      '内置召回评测集（来源：scripts/eval/auto-recall-golden.json）',
      JSON.stringify(data),
      now,
      now,
    );
  } catch (error) {
    logger.warn(
      { err: error },
      'builtin golden set file unavailable — dataset seed skipped',
    );
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

function mapHarnessVersionRow(row: HarnessVersionRow): HarnessVersionRecord {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    version: row.version,
    proposalId: row.proposal_id,
    adapterMd: row.adapter_md,
    adoptedBy: row.adopted_by,
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
    adapterVersion: row.adapter_version,
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
          adapter_version INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eval_datasets (
          name TEXT PRIMARY KEY,
          description TEXT,
          data_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS harness_proposals (
          id TEXT PRIMARY KEY,
          workspace_jid TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          adapter_md TEXT NOT NULL,
          keep_base INTEGER NOT NULL DEFAULT 0,
          diff_json TEXT,
          rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          baseline_version INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT
        );
        CREATE TABLE IF NOT EXISTS harness_versions (
          id TEXT PRIMARY KEY,
          workspace_jid TEXT NOT NULL,
          version INTEGER NOT NULL,
          proposal_id TEXT,
          adapter_md TEXT NOT NULL,
          adopted_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(workspace_jid, version)
        );
        CREATE TABLE IF NOT EXISTS harness_lessons (
          id TEXT PRIMARY KEY,
          workspace_jid TEXT NOT NULL,
          cue TEXT NOT NULL,
          lesson TEXT NOT NULL,
          evidence TEXT NOT NULL,
          confidence TEXT,
          proposal_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS harness_acceptance_sets (
          workspace_jid TEXT PRIMARY KEY,
          queries_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS harness_probes (
          id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          workspace_jid TEXT NOT NULL,
          baseline_version INTEGER NOT NULL,
          verdict TEXT NOT NULL,
          rounds_won INTEGER NOT NULL,
          rounds_lost INTEGER NOT NULL,
          rounds_tied INTEGER NOT NULL,
          notes_baseline_hit INTEGER NOT NULL,
          notes_proposed_hit INTEGER NOT NULL,
          rounds_json TEXT NOT NULL,
          cost_usd REAL,
          model TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_eval_run_items_run
          ON eval_run_items(run_id);
        CREATE INDEX IF NOT EXISTS idx_obs_turns_created
          ON obs_turns(created_at);
        CREATE INDEX IF NOT EXISTS idx_obs_turns_workspace
          ON obs_turns(workspace_jid);
        CREATE INDEX IF NOT EXISTS idx_harness_proposals_workspace
          ON harness_proposals(workspace_jid, created_at);
        CREATE INDEX IF NOT EXISTS idx_harness_versions_workspace
          ON harness_versions(workspace_jid, version);
        CREATE INDEX IF NOT EXISTS idx_harness_lessons_workspace
          ON harness_lessons(workspace_jid, created_at);
        CREATE INDEX IF NOT EXISTS idx_harness_probes_proposal
          ON harness_probes(proposal_id, created_at);
        PRAGMA user_version = ${EVAL_SCHEMA_VERSION};
      `);
      if (version < 2) {
        seedBuiltinDataset(db);
      }
      if (version < 4) {
        // v4 attribution column (task AF): pre-v4 databases miss it; existing
        // rows backfill to 0 = baseline (no adapter was active).
        const hasColumn = (
          db.prepare('PRAGMA table_info(obs_turns)').all() as {
            name: string;
          }[]
        ).some((col) => col.name === 'adapter_version');
        if (!hasColumn) {
          db.exec(
            'ALTER TABLE obs_turns ADD COLUMN adapter_version INTEGER NOT NULL DEFAULT 0',
          );
        }
      }
      logger.info(
        { path: resolved, version: EVAL_SCHEMA_VERSION, from: version },
        'eval.db initialized/migrated',
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
           judge_used, judge_reasoning, judge_error, judge_prompt_hash, judge_model,
           adapter_version, created_at)
        VALUES
          (@turnId, @sessionId, @workspaceJid, @folder, @channel, @interactionMode,
           @autoRecallEnabled, @recallInjected, @recallHitCount, @recallLatencyMs,
           @inputText, @outputText, @inputTokens, @outputTokens, @costUsd, @durationMs,
           @judgeUsed, @judgeReasoning, @judgeError, @judgePromptHash, @judgeModel,
           @adapterVersion, @createdAt)
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
        adapterVersion: 0,
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

  // ── eval_datasets (task AD) ───────────────────────────────────────────────

  /** Callers validate `data` (validateGoldenSet) before upserting. */
  upsertDataset(input: EvalDatasetUpsertInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eval_datasets (name, description, data_json, source, created_at, updated_at)
         VALUES (@name, @description, @dataJson, @source, @now, @now)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           data_json = excluded.data_json,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run({
        name: input.name,
        description: input.description ?? null,
        dataJson: JSON.stringify(input.data),
        source: input.source,
        now,
      });
  }

  getDataset(name: string): EvalDatasetRecord | null {
    const row = this.db
      .prepare('SELECT * FROM eval_datasets WHERE name = ?')
      .get(name) as EvalDatasetRow | undefined;
    if (!row) return null;
    return {
      name: row.name,
      description: row.description,
      data: parseJsonColumn<GoldenSet>(row.data_json, {
        seed: [],
        queries: [],
      }),
      source: row.source as EvalDatasetSource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listDatasets(): EvalDatasetListItem[] {
    const rows = this.db
      .prepare('SELECT * FROM eval_datasets ORDER BY name')
      .all() as EvalDatasetRow[];
    return rows.map((row) => {
      const data = parseJsonColumn<GoldenSet>(row.data_json, {
        seed: [],
        queries: [],
      });
      return {
        name: row.name,
        description: row.description,
        source: row.source as EvalDatasetSource,
        seedCount: Array.isArray(data.seed) ? data.seed.length : 0,
        queryCount: Array.isArray(data.queries) ? data.queries.length : 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /** Builtin sets are permanent (plan §1-4); the repo file is the fallback. */
  deleteDataset(name: string): 'deleted' | 'not_found' | 'builtin' {
    const row = this.db
      .prepare('SELECT source FROM eval_datasets WHERE name = ?')
      .get(name) as { source: string } | undefined;
    if (!row) return 'not_found';
    if (row.source === 'builtin') return 'builtin';
    this.db.prepare('DELETE FROM eval_datasets WHERE name = ?').run(name);
    return 'deleted';
  }

  // ── harness_proposals / harness_versions / harness_lessons (task AE) ─────

  insertHarnessProposal(input: HarnessProposalInput): void {
    this.db
      .prepare(
        `INSERT INTO harness_proposals
         (id, workspace_jid, status, adapter_md, keep_base, diff_json, rationale,
          evidence_json, baseline_version, model, prompt_hash, created_at)
         VALUES
         (@id, @workspaceJid, 'pending', @adapterMd, @keepBase, @diffJson,
          @rationale, @evidenceJson, @baselineVersion, @model, @promptHash, @createdAt)`,
      )
      .run({
        id: input.id,
        workspaceJid: input.workspaceJid,
        adapterMd: input.adapterMd,
        keepBase: input.keepBase ? 1 : 0,
        diffJson: input.diff,
        rationale: input.rationale,
        evidenceJson: JSON.stringify(input.evidence),
        baselineVersion: input.baselineVersion,
        model: input.model,
        promptHash: input.promptHash,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
  }

  listHarnessProposals(
    workspaceJid: string,
    limit = 100,
  ): HarnessProposalListItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_jid, status, keep_base, rationale, evidence_json,
                baseline_version, model, prompt_hash, created_at, decided_at, decided_by
         FROM harness_proposals WHERE workspace_jid = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(workspaceJid, limit) as (Omit<
      HarnessProposalRow,
      'adapter_md' | 'diff_json'
    > & { evidence_json: string })[];
    return rows.map((row) => ({
      id: row.id,
      workspaceJid: row.workspace_jid,
      status: row.status as HarnessProposalStatus,
      keepBase: row.keep_base === 1,
      rationale: row.rationale,
      evidenceCount: parseJsonColumn<HarnessProposalEvidence[]>(
        row.evidence_json,
        [],
      ).length,
      baselineVersion: row.baseline_version,
      model: row.model,
      promptHash: row.prompt_hash,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
    }));
  }

  getHarnessProposal(id: string): HarnessProposalRecord | null {
    const row = this.db
      .prepare('SELECT * FROM harness_proposals WHERE id = ?')
      .get(id) as HarnessProposalRow | undefined;
    if (!row) return null;
    const evidence = parseJsonColumn<HarnessProposalEvidence[]>(
      row.evidence_json,
      [],
    );
    return {
      id: row.id,
      workspaceJid: row.workspace_jid,
      status: row.status as HarnessProposalStatus,
      keepBase: row.keep_base === 1,
      adapterMd: row.adapter_md,
      diff: row.diff_json,
      rationale: row.rationale,
      evidence,
      evidenceCount: evidence.length,
      baselineVersion: row.baseline_version,
      model: row.model,
      promptHash: row.prompt_hash,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
    };
  }

  /** Only a pending proposal may be decided; each proposal decides once. */
  decideHarnessProposal(
    id: string,
    decision: { status: 'adopted' | 'rejected'; decidedBy: string },
  ): 'ok' | 'not_found' | 'invalid_transition' {
    const result = this.db
      .prepare(
        `UPDATE harness_proposals
         SET status = @status, decided_at = @decidedAt, decided_by = @decidedBy
         WHERE id = @id AND status = 'pending'`,
      )
      .run({
        id,
        status: decision.status,
        decidedAt: new Date().toISOString(),
        decidedBy: decision.decidedBy,
      });
    if (result.changes === 1) return 'ok';
    const row = this.db
      .prepare('SELECT status FROM harness_proposals WHERE id = ?')
      .get(id) as { status: string } | undefined;
    return row ? 'invalid_transition' : 'not_found';
  }

  /** Appends the next version number for the workspace and returns the record. */
  insertHarnessVersion(input: HarnessVersionInput): HarnessVersionRecord {
    const id = `hv_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const insert = this.db.transaction(() => {
      const next =
        (
          this.db
            .prepare(
              'SELECT MAX(version) AS maxVersion FROM harness_versions WHERE workspace_jid = ?',
            )
            .get(input.workspaceJid) as { maxVersion: number | null }
        ).maxVersion ?? 0;
      const version = next + 1;
      this.db
        .prepare(
          `INSERT INTO harness_versions
           (id, workspace_jid, version, proposal_id, adapter_md, adopted_by, created_at)
           VALUES (@id, @workspaceJid, @version, @proposalId, @adapterMd, @adoptedBy, @createdAt)`,
        )
        .run({
          id,
          workspaceJid: input.workspaceJid,
          version,
          proposalId: input.proposalId,
          adapterMd: input.adapterMd,
          adoptedBy: input.adoptedBy,
          createdAt,
        });
      return version;
    });
    const version = insert();
    return {
      id,
      workspaceJid: input.workspaceJid,
      version,
      proposalId: input.proposalId,
      adapterMd: input.adapterMd,
      adoptedBy: input.adoptedBy,
      createdAt,
    };
  }

  listHarnessVersions(workspaceJid: string): HarnessVersionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM harness_versions WHERE workspace_jid = ? ORDER BY version DESC',
      )
      .all(workspaceJid) as HarnessVersionRow[];
    return rows.map(mapHarnessVersionRow);
  }

  /** The active adapter is the highest adopted version (rollback rewrites the file, not history). */
  getActiveHarnessVersion(workspaceJid: string): HarnessVersionRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM harness_versions WHERE workspace_jid = ? ORDER BY version DESC LIMIT 1',
      )
      .get(workspaceJid) as HarnessVersionRow | undefined;
    return row ? mapHarnessVersionRow(row) : null;
  }

  insertHarnessLesson(input: HarnessLessonInput): void {
    this.db
      .prepare(
        `INSERT INTO harness_lessons
         (id, workspace_jid, cue, lesson, evidence, confidence, proposal_id, created_at)
         VALUES (@id, @workspaceJid, @cue, @lesson, @evidence, @confidence, @proposalId, @createdAt)`,
      )
      .run({
        id: input.id,
        workspaceJid: input.workspaceJid,
        cue: input.cue,
        lesson: input.lesson,
        evidence: input.evidence,
        confidence: input.confidence,
        proposalId: input.proposalId,
        createdAt: new Date().toISOString(),
      });
  }

  listHarnessLessons(workspaceJid: string, limit = 100): HarnessLessonRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM harness_lessons WHERE workspace_jid = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(workspaceJid, limit) as HarnessLessonRow[];
    return rows.map((row) => ({
      id: row.id,
      workspaceJid: row.workspace_jid,
      cue: row.cue,
      lesson: row.lesson,
      evidence: row.evidence,
      confidence: row.confidence,
      proposalId: row.proposal_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * All workspaces' lessons, newest first, hard-capped (task AH: the neighbor
   * pool for pickNeighborLessons — bounded so a large library cannot bloat
   * the proposer evidence; default 500).
   */
  listAllHarnessLessons(limit = 500): HarnessLessonRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM harness_lessons ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(Math.min(Math.max(limit, 1), 500)) as HarnessLessonRow[];
    return rows.map((row) => ({
      id: row.id,
      workspaceJid: row.workspace_jid,
      cue: row.cue,
      lesson: row.lesson,
      evidence: row.evidence,
      confidence: row.confidence,
      proposalId: row.proposal_id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Turns recorded for the workspace strictly after `sinceIso`; a null
   * `sinceIso` counts the whole history (no proposal ever). Feeds the Web
   * "evidence since last proposal" banner (task AH; ISO strings compare
   * lexicographically, matching how they are written).
   */
  countTurnsSince(workspaceJid: string, sinceIso: string | null): number {
    const row = sinceIso
      ? (this.db
          .prepare(
            'SELECT COUNT(*) AS total FROM obs_turns WHERE workspace_jid = ? AND created_at > ?',
          )
          .get(workspaceJid, sinceIso) as { total: number })
      : (this.db
          .prepare(
            'SELECT COUNT(*) AS total FROM obs_turns WHERE workspace_jid = ?',
          )
          .get(workspaceJid) as { total: number });
    return row.total;
  }

  /**
   * Workspaces with harness activity (observed turns ∪ proposals), newest
   * turn first; feeds the Web tab's workspace selector (task AF).
   */
  listHarnessWorkspaces(): Array<{
    workspaceJid: string;
    turnCount: number;
    lastTurnAt: string | null;
    proposalCount: number;
  }> {
    interface Row {
      workspace_jid: string;
      turn_count: number;
      last_turn_at: string | null;
      proposal_count: number;
    }
    const rows = this.db
      .prepare(
        `SELECT jid.workspace_jid AS workspace_jid,
                COALESCE(t.turn_count, 0) AS turn_count,
                t.last_turn_at AS last_turn_at,
                COALESCE(p.proposal_count, 0) AS proposal_count
         FROM (SELECT workspace_jid FROM obs_turns WHERE workspace_jid IS NOT NULL
               UNION SELECT workspace_jid FROM harness_proposals) AS jid
         LEFT JOIN (SELECT workspace_jid, COUNT(*) AS turn_count, MAX(created_at) AS last_turn_at
                    FROM obs_turns GROUP BY workspace_jid) AS t
           ON t.workspace_jid = jid.workspace_jid
         LEFT JOIN (SELECT workspace_jid, COUNT(*) AS proposal_count
                    FROM harness_proposals GROUP BY workspace_jid) AS p
           ON p.workspace_jid = jid.workspace_jid
         ORDER BY t.last_turn_at DESC, jid.workspace_jid`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      workspaceJid: row.workspace_jid,
      turnCount: row.turn_count,
      lastTurnAt: row.last_turn_at,
      proposalCount: row.proposal_count,
    }));
  }

  // ── harness_acceptance_sets / harness_probes (task AG, v5) ───────────────

  /** Callers validate `queries` (validateAcceptanceSet) before upserting. */
  upsertAcceptanceSet(input: HarnessAcceptanceSetInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO harness_acceptance_sets (workspace_jid, queries_json, updated_at)
         VALUES (@workspaceJid, @queriesJson, @now)
         ON CONFLICT(workspace_jid) DO UPDATE SET
           queries_json = excluded.queries_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        workspaceJid: input.workspaceJid,
        queriesJson: JSON.stringify(input.queries),
        now,
      });
  }

  getAcceptanceSet(workspaceJid: string): HarnessAcceptanceSetRecord | null {
    const row = this.db
      .prepare('SELECT * FROM harness_acceptance_sets WHERE workspace_jid = ?')
      .get(workspaceJid) as
      | { workspace_jid: string; queries_json: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      workspaceJid: row.workspace_jid,
      queries: parseJsonColumn<HarnessAcceptanceQuery[]>(row.queries_json, []),
      updatedAt: row.updated_at,
    };
  }

  insertHarnessProbe(input: HarnessProbeInput): void {
    this.db
      .prepare(
        `INSERT INTO harness_probes
         (id, proposal_id, workspace_jid, baseline_version, verdict,
          rounds_won, rounds_lost, rounds_tied, notes_baseline_hit,
          notes_proposed_hit, rounds_json, cost_usd, model, created_at)
         VALUES
         (@id, @proposalId, @workspaceJid, @baselineVersion, @verdict,
          @roundsWon, @roundsLost, @roundsTied, @notesBaselineHit,
          @notesProposedHit, @roundsJson, @costUsd, @model, @createdAt)`,
      )
      .run({
        id: input.id,
        proposalId: input.proposalId,
        workspaceJid: input.workspaceJid,
        baselineVersion: input.baselineVersion,
        verdict: input.verdict,
        roundsWon: input.roundsWon,
        roundsLost: input.roundsLost,
        roundsTied: input.roundsTied,
        notesBaselineHit: input.notesBaselineHit,
        notesProposedHit: input.notesProposedHit,
        roundsJson: JSON.stringify(input.rounds),
        costUsd: input.costUsd ?? null,
        model: input.model,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
  }

  /** Probe reports for one proposal, newest first (history, not just latest). */
  listHarnessProbes(proposalId: string, limit = 20): HarnessProbeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM harness_probes WHERE proposal_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(proposalId, limit) as HarnessProbeRow[];
    return rows.map(mapProbeRow);
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
