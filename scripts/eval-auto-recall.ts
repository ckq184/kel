/**
 * Auto-memory recall quality evaluation — external executor for a
 * self-hosted Langfuse instance (task Z follow-up 4, 2026-11-11).
 *
 * Architecture follows Langfuse's own model: the platform never runs your
 * pipeline; an external executor (this script) runs the experiment and writes
 * results back through the public API:
 *
 *   golden queries  → dataset items (stable ids, upsert by id)
 *   each query      → one trace (metadata: expected/retrieved/latency)
 *                   → one dataset-run-item (runName × traceId linkage)
 *   metrics         → scores on that trace: recall / hit / mrr / precision
 *                     (NUMERIC/BOOLEAN, attached with datasetRunId)
 *
 * Retrieval itself drives the REAL sidecar (real mem0 extraction + real
 * embedder) with the exact production contract (query trimmed then sliced to
 * 500 chars, top-k = 5). Local metric report is still printed/written, so
 * `--no-langfuse` runs standalone.
 *
 * Usage (manual — REAL embedder/LLM requests cost money; same category as
 * `npm run test:real-model`):
 *
 *   npm run eval:auto-recall [-- --reset] [-- --dry-run] [-- --k 5]
 *                           [-- --langfuse] [-- --run-name <name>]
 *
 *   --reset       wipe the eval sidecar store first (forces re-seeding)
 *   --dry-run     offline validation: fixture + env/config status only
 *   --k N         retrieval depth (default 5 — the production contract)
 *   --langfuse    also write back to a Langfuse instance (task AB made the
 *                 native eval.db the default landing zone; export is opt-in)
 *   --no-langfuse accepted no-op kept for compatibility (export already off
 *                 by default)
 *   --run-name    run name (default run-<timestamp>); ids both eval.db and
 *                 a Langfuse dataset run — same name re-runs overwrite
 *
 * Langfuse connection (env wins over file, incomplete channels are ignored):
 *   CKQCLAW_EVAL_LANGFUSE_URL / _PUBLIC_KEY / _SECRET_KEY
 *   data/config/eval-langfuse.json  { url, publicKey, secretKey }
 * Stack lifecycle: npm run eval:langfuse -- up|down|status.
 *
 * Isolation: sidecar store data/eval/auto-recall/store (never a real
 * workspace path). Secrets: endpoint keys are never printed and every
 * console/report string passes redactSecrets().
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Golden-set types + validation (moved to src/eval-dataset.ts, task AD) ───
// Re-exported so the historical import surface (pure-logic unit tests) stays
// intact; the host build compiles src/ only.

import {
  GOLDEN_CATEGORIES,
  QUERY_MAX_CHARS,
  validateGoldenSet,
  type GoldenCategory,
  type GoldenQuery,
  type GoldenSeedItem,
  type GoldenSet,
} from '../src/eval-dataset.js';

export {
  QUERY_MAX_CHARS,
  validateGoldenSet,
  type GoldenCategory,
  type GoldenQuery,
  type GoldenSeedItem,
  type GoldenSet,
};

// ── Dataset resolution (task AD: eval.db first, builtin file fallback) ──────

export type GoldenSetResolution =
  | { data: GoldenSet; source: 'db' | 'builtin-file' }
  | { error: string; issues?: string[] };

/**
 * Resolve the golden set for a run: the managed copy in eval.db wins (web
 * editor writes land there); only `auto-recall` may fall back to the shipped
 * repo file — unknown names are hard errors. Both channels run the same
 * validateGoldenSet gate.
 */
export function resolveGoldenSet(input: {
  dataset: string;
  readFile: () => string | null;
  loadFromDb: (name: string) => GoldenSet | null;
}): GoldenSetResolution {
  const fromDb = input.loadFromDb(input.dataset);
  if (fromDb) {
    const issues = validateGoldenSet(fromDb);
    if (issues.length > 0)
      return { error: 'invalid dataset (eval.db)', issues };
    return { data: fromDb, source: 'db' };
  }
  if (input.dataset === 'auto-recall') {
    const raw = input.readFile();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as GoldenSet;
        const issues = validateGoldenSet(parsed);
        if (issues.length > 0) {
          return { error: 'invalid dataset (builtin file)', issues };
        }
        return { data: parsed, source: 'builtin-file' };
      } catch {
        return { error: 'builtin golden set file is not valid JSON' };
      }
    }
    return { error: 'builtin golden set file not found' };
  }
  return {
    error: `dataset "${input.dataset}" not found (create it in the web eval page first)`,
  };
}

// ── Pure logic (unit-tested in tests/eval-auto-recall-metrics.test.ts) ──────

export function boundedQuery(
  query: string,
  maxChars: number = QUERY_MAX_CHARS,
): string {
  return query.trim().slice(0, maxChars);
}

export function recallAtK(
  expected: readonly string[],
  retrieved: readonly string[],
): number {
  if (expected.length === 0) return 0;
  const hits = new Set(retrieved);
  const covered = expected.filter((marker) => hits.has(marker)).length;
  return covered / expected.length;
}

export function hitRateAtK(
  expected: readonly string[],
  retrieved: readonly string[],
): number {
  const hits = new Set(retrieved);
  return expected.some((marker) => hits.has(marker)) ? 1 : 0;
}

export function reciprocalRank(
  expected: readonly string[],
  retrieved: readonly string[],
): number {
  const wanted = new Set(expected);
  for (let index = 0; index < retrieved.length; index += 1) {
    if (wanted.has(retrieved[index])) return 1 / (index + 1);
  }
  return 0;
}

export function precisionAtK(
  expected: readonly string[],
  retrieved: readonly string[],
): number {
  if (retrieved.length === 0) return 0;
  const wanted = new Set(expected);
  const relevant = retrieved.filter((marker) => wanted.has(marker)).length;
  return relevant / retrieved.length;
}

/** Map one stored/retrieved entry text back to golden markers by key hit.
 * Ambiguous texts (keys of several items) return every matched marker — the
 * harness reports them as integrity warnings instead of guessing. */
export function mapTextToMarkers(
  text: string,
  items: readonly GoldenSeedItem[],
): string[] {
  const matched = new Set<string>();
  for (const item of items) {
    for (const key of item.keys) {
      if (text.includes(key)) {
        matched.add(item.marker);
        break;
      }
    }
  }
  return [...matched];
}

export interface QueryResultRow {
  id: string;
  category: GoldenCategory;
  expected: string[];
  retrieved: string[];
  recall: number;
  hit: number;
  rr: number;
  precision: number;
  latencyMs: number;
  boundedQueryChars: number;
  note?: string;
}

export interface CategoryStat {
  n: number;
  recall: number;
  hitRate: number;
  mrr: number;
  precision: number;
}

export interface AggregateReport {
  overall: CategoryStat;
  perCategory: Record<string, CategoryStat>;
}

export function aggregateRows(
  rows: readonly QueryResultRow[],
): AggregateReport {
  const stat = (group: readonly QueryResultRow[]): CategoryStat => ({
    n: group.length,
    recall: group.reduce((sum, row) => sum + row.recall, 0) / group.length,
    hitRate: group.reduce((sum, row) => sum + row.hit, 0) / group.length,
    mrr: group.reduce((sum, row) => sum + row.rr, 0) / group.length,
    precision:
      group.reduce((sum, row) => sum + row.precision, 0) / group.length,
  });
  const perCategory: Record<string, CategoryStat> = {};
  for (const category of GOLDEN_CATEGORIES) {
    const group = rows.filter((row) => row.category === category);
    if (group.length > 0) perCategory[category] = stat(group);
  }
  return { overall: stat(rows), perCategory };
}

// ── Native eval.db payload (task AB default landing zone) ───────────────────

/** Shape accepted by EvalStore.upsertRun — structural, no store import. */
export interface EvalStoreRunPayload {
  run: {
    id: string;
    name: string;
    kind: 'recall';
    k: number;
    configJson: Record<string, unknown>;
    summary: AggregateReport;
  };
  items: Array<{
    queryId: string;
    category: string;
    expected: string[];
    retrieved: string[];
    recall: number;
    hit: number;
    mrr: number;
    precision: number;
    latencyMs: number;
    note?: string;
  }>;
}

/** Map replay rows + aggregate into the native eval-store upsert payload. */
export function evalStoreRunPayload(
  runName: string,
  k: number,
  rows: readonly QueryResultRow[],
  aggregate: AggregateReport,
  config: Record<string, unknown>,
): EvalStoreRunPayload {
  return {
    run: {
      id: runName,
      name: runName,
      kind: 'recall',
      k,
      configJson: config,
      summary: aggregate,
    },
    items: rows.map((row) => ({
      queryId: row.id,
      category: row.category,
      expected: row.expected,
      retrieved: row.retrieved,
      recall: row.recall,
      hit: row.hit,
      mrr: row.rr,
      precision: row.precision,
      latencyMs: row.latencyMs,
      ...(row.note ? { note: row.note } : {}),
    })),
  };
}

// ── Langfuse integration (zero-dependency REST client) ──────────────────────

export const LANGFUSE_DATASET_NAME = 'ckqclaw-auto-recall';

export interface LangfuseEvalConfig {
  url: string;
  publicKey: string;
  secretKey: string;
  source: 'env' | 'file';
}

const LANGFUSE_ENV_KEYS = {
  url: 'CKQCLAW_EVAL_LANGFUSE_URL',
  publicKey: 'CKQCLAW_EVAL_LANGFUSE_PUBLIC_KEY',
  secretKey: 'CKQCLAW_EVAL_LANGFUSE_SECRET_KEY',
} as const;

/** env channel wins; a channel counts only when complete; file is the
 * fallback. Returns null when neither channel yields a usable triple. */
export function resolveLangfuseConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | null,
  configFilePath?: string,
): LangfuseEvalConfig | null {
  const envUrl = env[LANGFUSE_ENV_KEYS.url];
  const envPublicKey = env[LANGFUSE_ENV_KEYS.publicKey];
  const envSecretKey = env[LANGFUSE_ENV_KEYS.secretKey];
  if (envUrl && envPublicKey && envSecretKey) {
    return {
      url: envUrl.replace(/\/+$/, ''),
      publicKey: envPublicKey,
      secretKey: envSecretKey,
      source: 'env',
    };
  }
  const raw = readFile(configFilePath ?? 'eval-langfuse.json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LangfuseEvalConfig>;
    if (
      typeof parsed.url === 'string' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.secretKey === 'string'
    ) {
      return {
        url: parsed.url.replace(/\/+$/, ''),
        publicKey: parsed.publicKey,
        secretKey: parsed.secretKey,
        source: 'file',
      };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

export function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
}

/** One golden query = one dataset item; stable id makes re-runs an upsert. */
export function datasetItemPayload(
  query: GoldenQuery,
  datasetName: string = LANGFUSE_DATASET_NAME,
): Record<string, unknown> {
  return {
    id: `${datasetName}-${query.id}`,
    datasetName,
    input: { query: query.text, category: query.category },
    expectedOutput: { expectedMarkers: query.expected },
    metadata: {
      queryId: query.id,
      category: query.category,
      ...(query.note ? { note: query.note } : {}),
    },
  };
}

export interface LangfuseScorePayload {
  traceId: string;
  name: string;
  value: number;
  dataType: 'NUMERIC' | 'BOOLEAN';
  comment: string;
  datasetRunId?: string;
}

/** Expand one result row into the four metric scores on its trace. */
export function scorePayloads(
  row: QueryResultRow,
  runName: string,
  traceId: string,
): LangfuseScorePayload[] {
  const comment =
    `expected=[${row.expected.join(',')}] ` +
    `retrieved=[${row.retrieved.join(',') || '—'}]` +
    (row.note ? ` ${row.note}` : '');
  return [
    {
      traceId,
      name: 'recall',
      value: row.recall,
      dataType: 'NUMERIC',
      comment,
      datasetRunId: runName,
    },
    {
      traceId,
      name: 'hit',
      value: row.hit,
      dataType: 'BOOLEAN',
      comment,
      datasetRunId: runName,
    },
    {
      traceId,
      name: 'mrr',
      value: row.rr,
      dataType: 'NUMERIC',
      comment,
      datasetRunId: runName,
    },
    {
      traceId,
      name: 'precision',
      value: row.precision,
      dataType: 'NUMERIC',
      comment,
      datasetRunId: runName,
    },
  ];
}

export interface LangfuseClientOptions {
  config: LangfuseEvalConfig;
  fetchImpl?: typeof fetch;
}

/** Minimal public-API writer: dataset items, traces, run items, scores. */
export function createLangfuseClient(options: LangfuseClientOptions) {
  const { config } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const auth = basicAuthHeader(config.publicKey, config.secretKey);

  const post = async (
    endpoint: string,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await doFetch(`${config.url}${endpoint}`, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      // Never echo credentials: the error body comes from the server, but the
      // secret key would only appear if the server echoed our header — strip
      // it defensively anyway.
      const safe = text.split(config.secretKey).join('***').slice(0, 300);
      throw new Error(`langfuse ${endpoint} HTTP ${response.status}: ${safe}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  return {
    /** Datasets are upserted by name (200 for both create and re-create);
     * item writes 404 on a missing dataset, so ensure it first. */
    async ensureDataset(name: string, description: string) {
      await post('/api/public/datasets', { name, description });
    },
    upsertDatasetItem(payload: Record<string, unknown>) {
      return post('/api/public/dataset-items', payload);
    },
    ingestTrace(trace: {
      id: string;
      name: string;
      metadata: Record<string, unknown>;
    }) {
      return post('/api/public/ingestion', {
        batch: [
          {
            id: trace.id,
            type: 'trace-create',
            timestamp: new Date().toISOString(),
            body: {
              id: trace.id,
              name: trace.name,
              metadata: trace.metadata,
            },
          },
        ],
      });
    },
    createDatasetRunItem(link: {
      runName: string;
      datasetItemId: string;
      traceId: string;
    }) {
      return post('/api/public/dataset-run-items', link);
    },
    async postScores(scores: readonly LangfuseScorePayload[]) {
      // v4 accepts a bare JSON array of score bodies (not a {scores} wrapper);
      // 2xx and 207 (partial batch acceptance) are both success.
      await post('/api/public/scores', [...scores]);
    },
  };
}

// ── Harness (manual; real sidecar + real remote endpoints) ──────────────────

const EVAL_FOLDER = 'eval-auto-recall';
const EVAL_COLLECTION = 'ws-eval-auto-recall';
const EVAL_USER_ID = 'workspace:eval-auto-recall';

interface CliOptions {
  reset: boolean;
  dryRun: boolean;
  k: number;
  /** Task AB: the Langfuse export is opt-in; eval.db is the default store. */
  langfuse: boolean;
  runName: string;
  /** Task AD: managed golden set name (eval.db first, builtin file fallback). */
  dataset: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    reset: false,
    dryRun: false,
    k: 5,
    langfuse: false,
    runName: `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`,
    dataset: 'auto-recall',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reset') options.reset = true;
    else if (arg === '--dry-run') options.dryRun = true;
    // Compatibility no-op: export has been off by default since task AB.
    else if (arg === '--no-langfuse') continue;
    else if (arg === '--langfuse') options.langfuse = true;
    else if (arg === '--run-name') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--run-name expects a value');
      }
      options.runName = value;
      index += 1;
    } else if (arg === '--k') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (Number.isInteger(value) && value >= 1 && value <= 10) {
        options.k = value;
        index += 1;
      } else {
        throw new Error('--k expects an integer between 1 and 10');
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Walk up from this file to the repo root (first dir with package.json). */
function findRepoRoot(): string {
  let dir = path.dirname(path.resolve(import.meta.filename));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found from scripts/eval-auto-recall.ts');
}

/** Belt-and-braces: endpoint keys never reach console or the JSON report. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('***');
  }
  return out;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();

  // 1. Dataset resolution + validation (task AD: eval.db first, builtin file
  // fallback). The store import is lazy so pure-logic unit tests never touch
  // the module graph.
  const { getDefaultEvalStore } = await import('../src/eval-store.js');
  const resolution = resolveGoldenSet({
    dataset: options.dataset,
    readFile: () => {
      try {
        return fs.readFileSync(
          path.join(repoRoot, 'scripts', 'eval', 'auto-recall-golden.json'),
          'utf8',
        );
      } catch {
        return null;
      }
    },
    loadFromDb: (name) => getDefaultEvalStore().getDataset(name)?.data ?? null,
  });
  if ('error' in resolution) {
    process.stderr.write(
      `dataset "${options.dataset}" unusable: ${resolution.error}\n` +
        (resolution.issues
          ? `${resolution.issues.map((i) => `  - ${i}`).join('\n')}\n`
          : ''),
    );
    process.exitCode = 1;
    return;
  }
  const fixture = resolution.data;

  // Load host env + config lazily so unit tests can import the pure logic
  // above without pulling the server module graph.
  await import('../src/load-env.js');
  const { getAutoMemoryHostConfig, getAutoMemoryConfigSource } =
    await import('../src/auto-memory-config.js');
  const { DATA_DIR } = await import('../src/config.js');
  const { AutoMemorySidecarManager, pythonInterpreterCandidates } =
    await import('../src/auto-memory-sidecar-manager.js');

  const langfuseConfig = options.langfuse
    ? resolveLangfuseConfig(
        process.env,
        (file) => {
          try {
            return fs.readFileSync(file, 'utf8');
          } catch {
            return null;
          }
        },
        path.join(DATA_DIR, 'config', 'eval-langfuse.json'),
      )
    : null;
  const hostConfig = getAutoMemoryHostConfig();
  const configSource = getAutoMemoryConfigSource();
  const pythonCandidates = pythonInterpreterCandidates();
  const evalRoot = path.join(DATA_DIR, 'eval', 'auto-recall');
  const storePath = path.join(evalRoot, 'store');

  const langfuseStatusLine = options.langfuse
    ? langfuseConfig
      ? `langfuse: ${langfuseConfig.url} (via ${langfuseConfig.source}); run: ${options.runName}`
      : 'langfuse: --langfuse given but not configured — set CKQCLAW_EVAL_LANGFUSE_URL/_PUBLIC_KEY/_SECRET_KEY or data/config/eval-langfuse.json'
    : 'langfuse: export off (default; pass --langfuse to also write a Langfuse instance)';
  process.stdout.write(
    `dataset: ${options.dataset} (${resolution.source}); ` +
      `golden set: ${fixture.seed.length} memories / ${fixture.queries.length} queries (k=${options.k})\n` +
      `config source: ${configSource}; ` +
      `llm model: ${hostConfig.llm?.model ?? '—'}; ` +
      `embedder model: ${hostConfig.embedder?.model ?? '—'}\n` +
      `eval store: ${storePath}\n` +
      `${langfuseStatusLine}\n`,
  );

  if (options.dryRun) {
    process.stdout.write(
      `python candidates: ${pythonCandidates
        .map((c) => c.command)
        .join(', ')}\n` +
        `auto memory enabled: ${hostConfig.enabled}\n` +
        'dry run complete — no sidecar spawned, no remote requests\n',
    );
    return;
  }

  if (!hostConfig.enabled || !hostConfig.llm || !hostConfig.embedder) {
    process.stderr.write(
      'auto memory is not configured (need llm + embedder; env CKQCLAW_AUTO_MEMORY or data/config/auto-memory.json)\n',
    );
    process.exitCode = 1;
    return;
  }

  const secrets = [hostConfig.llm.apiKey, hostConfig.embedder.apiKey];
  if (langfuseConfig) secrets.push(langfuseConfig.secretKey);
  const say = (text: string): void => {
    process.stdout.write(`${redactSecrets(text, secrets)}\n`);
  };

  if (options.reset) {
    fs.rmSync(storePath, { recursive: true, force: true });
    say('--reset: eval store wiped');
  }

  const manager = new AutoMemorySidecarManager({ idleTtlMs: 0 });
  const sidecarConfig = {
    dataPath: storePath,
    collection: EVAL_COLLECTION,
    userId: EVAL_USER_ID,
    llm: hostConfig.llm,
    embedder: hostConfig.embedder,
  };
  const call = async (
    op: 'add' | 'search' | 'list',
    args: Record<string, unknown>,
  ) => {
    const outcome = await manager.call(EVAL_FOLDER, sidecarConfig, op, args);
    if (!outcome.available) {
      throw new Error(`sidecar ${op} failed: ${outcome.reason}`);
    }
    return outcome.value;
  };

  type StoreEntry = { id?: string; memory?: unknown };
  const entryText = (entry: StoreEntry): string =>
    typeof entry.memory === 'string' ? entry.memory : '';

  try {
    // 2. Idempotent seeding: list first, add only uncovered markers.
    const listOnce = async (): Promise<StoreEntry[]> => {
      const value = await call('list', { limit: 1000, offset: 0 });
      return Array.isArray(value) ? (value as StoreEntry[]) : [];
    };
    let entries = await listOnce();
    const covered = (): Set<string> => {
      const markers = new Set<string>();
      for (const entry of entries) {
        for (const marker of mapTextToMarkers(entryText(entry), fixture.seed)) {
          markers.add(marker);
        }
      }
      return markers;
    };
    const have = covered();
    const missing = fixture.seed.filter((item) => !have.has(item.marker));
    if (missing.length > 0) {
      say(
        `seeding ${missing.length} memories (skipping ${have.size} already present)…`,
      );
      for (const item of missing) {
        const value = (await call('add', {
          messages: [{ role: 'user', content: item.content }],
          metadata: { eval: true, marker: item.marker },
        })) as { results?: Array<{ event?: string }> } | undefined;
        const events =
          value?.results?.map((r) => r.event ?? '?').join(',') ?? '?';
        say(`  seed ${item.marker}: ${events}`);
      }
      entries = await listOnce();
    } else {
      say(
        `store already covers all ${fixture.seed.length} markers — no seeding`,
      );
    }

    // 3. Seed integrity: mapping must be complete and unambiguous.
    const finalCovered = covered();
    const missingAfter = fixture.seed
      .filter((item) => !finalCovered.has(item.marker))
      .map((item) => item.marker);
    const ambiguous: string[] = [];
    for (const entry of entries) {
      const mapped = mapTextToMarkers(entryText(entry), fixture.seed);
      if (mapped.length > 1) ambiguous.push(mapped.join('+'));
    }
    say(
      `seed integrity: ${entries.length} store entries, ${finalCovered.size}/${fixture.seed.length} markers covered` +
        (missingAfter.length ? `, missing: ${missingAfter.join(',')}` : '') +
        (ambiguous.length
          ? `, ambiguous entries: ${ambiguous.join(' | ')}`
          : ''),
    );
    if (missingAfter.length > 0) {
      process.stderr.write(
        'seed incomplete (mem0 extraction dropped keys?) — fix the fixture keys or re-run with --reset\n',
      );
      process.exitCode = 1;
      return;
    }

    // 4. Query replay under the production contract.
    const rows: QueryResultRow[] = [];
    for (const query of fixture.queries) {
      const bounded = boundedQuery(query.text);
      const startedAt = Date.now();
      const value = await call('search', { query: bounded, limit: options.k });
      const latencyMs = Date.now() - startedAt;
      const results = Array.isArray(value) ? (value as StoreEntry[]) : [];
      const retrievedMarkers: string[] = [];
      for (const entry of results) {
        for (const marker of mapTextToMarkers(entryText(entry), fixture.seed)) {
          if (!retrievedMarkers.includes(marker)) retrievedMarkers.push(marker);
        }
      }
      rows.push({
        id: query.id,
        category: query.category,
        expected: query.expected,
        retrieved: retrievedMarkers,
        recall: recallAtK(query.expected, retrievedMarkers),
        hit: hitRateAtK(query.expected, retrievedMarkers),
        rr: reciprocalRank(query.expected, retrievedMarkers),
        precision: precisionAtK(query.expected, retrievedMarkers),
        latencyMs,
        boundedQueryChars: bounded.length,
        note: query.note,
      });
      say(
        `  ${query.id} [${query.category}] expected={${query.expected.join(',')}} retrieved={${retrievedMarkers.join(',') || '—'}} ` +
          `recall=${rows[rows.length - 1].recall.toFixed(2)} rr=${rows[rows.length - 1].rr.toFixed(2)} ${latencyMs}ms (query ${bounded.length} chars)`,
      );
    }

    // 5. Local report.
    const aggregate = aggregateRows(rows);
    const line = (label: string, stat: CategoryStat): string =>
      `${label.padEnd(12)} n=${String(stat.n).padStart(2)}  recall=${pct(stat.recall).padStart(6)}  hit=${pct(stat.hitRate).padStart(6)}  mrr=${stat.mrr.toFixed(2)}  precision=${pct(stat.precision).padStart(6)}`;
    say('\n── recall report ──');
    for (const [category, stat] of Object.entries(aggregate.perCategory)) {
      say(line(category, stat));
    }
    say(line('overall', aggregate.overall));
    for (const row of rows) {
      if (row.note) say(`note ${row.id}: ${row.note}`);
    }
    const slowest = Math.max(...rows.map((row) => row.latencyMs));
    say(
      `latency: max ${slowest}ms (production recall budget is 3000ms — beyond it the turn skips the block)`,
    );

    fs.mkdirSync(evalRoot, { recursive: true });
    const reportPath = path.join(
      evalRoot,
      `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          k: options.k,
          config: {
            source: configSource,
            llmModel: hostConfig.llm.model,
            embedderModel: hostConfig.embedder.model,
          },
          seedIntegrity: {
            storeEntries: entries.length,
            markersCovered: finalCovered.size,
            markersTotal: fixture.seed.length,
            ambiguous,
          },
          rows,
          aggregate,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    say(`report written: ${reportPath}`);

    // 6. Native eval.db write-back (task AB default landing zone). The web
    // eval page reads these rows; same run name re-runs overwrite in place.
    try {
      const { getDefaultEvalStore } = await import('../src/eval-store.js');
      const payload = evalStoreRunPayload(
        options.runName,
        options.k,
        rows,
        aggregate,
        {
          source: configSource,
          dataset: options.dataset,
          datasetOrigin: resolution.source,
          llmModel: hostConfig.llm.model,
          embedderModel: hostConfig.embedder.model,
        },
      );
      getDefaultEvalStore().upsertRun(payload.run, payload.items);
      say(
        `eval.db run written: ${options.runName} (${rows.length} items, k=${options.k})`,
      );
    } catch (error) {
      process.stderr.write(
        `eval.db write failed (local report intact): ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exitCode = 1;
    }

    // 7. Langfuse write-back (external-executor pattern: dataset items are
    // the golden queries, each run row becomes trace + run-item + scores).
    if (langfuseConfig) {
      say(`\n── langfuse write-back (${options.runName}) ──`);
      const client = createLangfuseClient({ config: langfuseConfig });
      try {
        await client.ensureDataset(
          LANGFUSE_DATASET_NAME,
          'CKQClaw auto-recall golden set (query → expected markers)',
        );
        for (const query of fixture.queries) {
          await client.upsertDatasetItem(datasetItemPayload(query));
        }
        say(`dataset items upserted: ${fixture.queries.length}`);
        const allScores: LangfuseScorePayload[] = [];
        for (const row of rows) {
          const traceId = `${options.runName}--${row.id}`;
          await client.ingestTrace({
            id: traceId,
            name: row.id,
            metadata: {
              category: row.category,
              expected: row.expected,
              retrieved: row.retrieved,
              latencyMs: row.latencyMs,
              boundedQueryChars: row.boundedQueryChars,
              ...(row.note ? { note: row.note } : {}),
            },
          });
          await client.createDatasetRunItem({
            runName: options.runName,
            datasetItemId: `${LANGFUSE_DATASET_NAME}-${row.id}`,
            traceId,
          });
          allScores.push(...scorePayloads(row, options.runName, traceId));
        }
        say(`traces + run items written: ${rows.length}`);
        for (let offset = 0; offset < allScores.length; offset += 50) {
          await client.postScores(allScores.slice(offset, offset + 50));
        }
        say(
          `scores written: ${allScores.length} → ${langfuseConfig.url}/datasets (run: ${options.runName})`,
        );
      } catch (error) {
        process.stderr.write(
          `langfuse write-back failed (local report intact): ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await manager.stopAll();
  }
}

// Run only when executed directly (`tsx scripts/eval-auto-recall.ts`), never
// when the unit tests import the pure logic above.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `eval failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
