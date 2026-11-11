import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getDefaultEvalStore } from '../eval-store.js';
import { startEvalRun, getEvalTriggerState } from '../eval-trigger.js';
import { validateGoldenSet, type GoldenSet } from '../eval-dataset.js';

/**
 * Native evaluation center API (task AB; web trigger added by task AC).
 *
 * Offline runs land in eval.db from scripts/eval-auto-recall.ts (spawned as
 * an external-executor child process by the trigger endpoints) and observed
 * turns from src/turn-observer.ts; both share eval.db with this route through
 * per-process connections.
 *
 * ACL split (user-ratified plan §1-2): the offline Runs endpoints are visible
 * to every logged-in user; the turns endpoint and both trigger endpoints
 * (cost-bearing action + golden-query log lines) require
 * manage_system_config (the Monitor page precedent).
 */

const RUN_NAME_PATTERN = /^[\w-]{1,64}$/;

const evalRoutes = new Hono<{ Variables: Variables }>();

// GET /runs — offline eval run list, newest first
evalRoutes.get('/runs', authMiddleware, (c) => {
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit =
    Number.isInteger(limitParam) && limitParam >= 1
      ? Math.min(limitParam, 200)
      : 100;
  return c.json({ runs: getDefaultEvalStore().listRuns(limit) });
});

// GET /runs/:id — one run with its per-query items
evalRoutes.get('/runs/:id', authMiddleware, (c) => {
  const loaded = getDefaultEvalStore().getRun(c.req.param('id'));
  if (!loaded) return c.json({ error: 'run not found' }, 404);
  return c.json(loaded);
});

// GET /comparison?ids=a,b,c — side-by-side overall metrics per run
evalRoutes.get('/comparison', authMiddleware, (c) => {
  const idsRaw = c.req.query('ids');
  if (!idsRaw || !idsRaw.trim()) {
    return c.json({ error: 'ids query parameter is required' }, 400);
  }
  const ids = idsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 10);
  return c.json({ comparison: getDefaultEvalStore().compareRuns(ids) });
});

// ── Managed golden sets (task AD; admin only — may carry real user
// memory content). Create/update run the same validateGoldenSet chain as the
// harness; issues are returned verbatim so the editor can list them.

const DATASET_NAME_PATTERN = /^[\w-]{1,64}$/;

evalRoutes.get('/datasets', authMiddleware, systemConfigMiddleware, (c) =>
  c.json({ datasets: getDefaultEvalStore().listDatasets() }),
);

evalRoutes.get(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const dataset = getDefaultEvalStore().getDataset(c.req.param('name'));
    if (!dataset) return c.json({ error: 'dataset not found' }, 404);
    return c.json(dataset);
  },
);

evalRoutes.post(
  '/datasets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: { name?: unknown; description?: unknown; data?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (
      typeof body.name !== 'string' ||
      !DATASET_NAME_PATTERN.test(body.name.trim())
    ) {
      return c.json({ error: 'name must match [\\w-] and be 1-64 chars' }, 400);
    }
    const data = body.data as GoldenSet | undefined;
    if (!data)
      return c.json(
        { error: 'invalid dataset', issues: ['data is required'] },
        400,
      );
    const issues = validateGoldenSet(data);
    if (issues.length > 0)
      return c.json({ error: 'invalid dataset', issues }, 400);
    getDefaultEvalStore().upsertDataset({
      name: body.name.trim(),
      description:
        typeof body.description === 'string' ? body.description : null,
      data,
      source: 'manual',
    });
    return c.json({ ok: true }, 201);
  },
);

evalRoutes.put(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const name = c.req.param('name');
    const existing = getDefaultEvalStore().getDataset(name);
    if (!existing) return c.json({ error: 'dataset not found' }, 404);
    let body: { description?: unknown; data?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const data = body.data as GoldenSet | undefined;
    if (!data)
      return c.json(
        { error: 'invalid dataset', issues: ['data is required'] },
        400,
      );
    const issues = validateGoldenSet(data);
    if (issues.length > 0)
      return c.json({ error: 'invalid dataset', issues }, 400);
    getDefaultEvalStore().upsertDataset({
      name,
      description:
        typeof body.description === 'string' ? body.description : null,
      data,
      // Editor updates keep the set's provenance (builtin stays builtin).
      source: existing.source,
    });
    return c.json({ ok: true });
  },
);

evalRoutes.delete(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const outcome = getDefaultEvalStore().deleteDataset(c.req.param('name'));
    if (outcome === 'not_found') {
      return c.json({ error: 'dataset not found' }, 404);
    }
    if (outcome === 'builtin') {
      return c.json({ error: 'builtin dataset cannot be deleted' }, 409);
    }
    return c.json({ ok: true });
  },
);

// POST /runs/trigger — spawn the offline eval harness (admin only, cost-bearing).
// Arguments are whitelist-validated here; the trigger itself is single-run
// mutexed and turns its injection surface only on these checked values.
evalRoutes.post(
  '/runs/trigger',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: {
      k?: unknown;
      runName?: unknown;
      reset?: unknown;
      dataset?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const k = body.k;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > 10) {
      return c.json({ error: 'k must be an integer between 1 and 10' }, 400);
    }
    const runName = typeof body.runName === 'string' ? body.runName.trim() : '';
    if (!RUN_NAME_PATTERN.test(runName)) {
      return c.json(
        { error: 'runName must match [\\w-] and be 1-64 chars' },
        400,
      );
    }
    const reset = body.reset === true;
    const datasetRaw =
      typeof body.dataset === 'string' && body.dataset.trim()
        ? body.dataset.trim()
        : 'auto-recall';
    if (!DATASET_NAME_PATTERN.test(datasetRaw)) {
      return c.json(
        { error: 'dataset must match [\\w-] and be 1-64 chars' },
        400,
      );
    }

    const authUser = c.get('user') as AuthUser;
    const started = startEvalRun({
      k,
      runName,
      reset,
      dataset: datasetRaw,
      startedBy: authUser.username,
    });
    if (!started.ok) {
      return c.json({ error: 'An eval run is already in progress' }, 409);
    }
    return c.json({ accepted: true, k, runName, reset }, 202);
  },
);

// GET /runs/trigger/status — trigger snapshot + log tail (admin only; lines
// can echo golden-query text fragments).
evalRoutes.get(
  '/runs/trigger/status',
  authMiddleware,
  systemConfigMiddleware,
  (c) => c.json(getEvalTriggerState()),
);

// GET /turns — observed real-conversation turns (manage_system_config only)
evalRoutes.get('/turns', authMiddleware, systemConfigMiddleware, (c) => {
  const workspaceJid = c.req.query('workspace') || undefined;
  const channel = c.req.query('channel') || undefined;
  const recallInjected = c.req.query('recallInjected') === 'true';
  const judgeRaw = c.req.query('judge');
  const judge =
    judgeRaw === 'judged' || judgeRaw === 'pending' ? judgeRaw : undefined;
  const limitParam = Number(c.req.query('limit') ?? '50');
  const offsetParam = Number(c.req.query('offset') ?? '0');
  const result = getDefaultEvalStore().listTurns({
    workspaceJid,
    channel,
    ...(recallInjected ? { recallInjected: true } : {}),
    ...(judge ? { judge } : {}),
    limit: Number.isInteger(limitParam) && limitParam >= 1 ? limitParam : 50,
    offset: Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0,
  });
  return c.json(result);
});

export default evalRoutes;
