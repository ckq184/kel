import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getDefaultEvalStore } from '../eval-store.js';

/**
 * Native evaluation center API (task AB).
 *
 * Reads only — offline runs are written by scripts/eval-auto-recall.ts and
 * observed turns by src/turn-observer.ts; both share eval.db with this route
 * through per-process connections.
 *
 * ACL split (user-ratified plan §1-2): the offline Runs endpoints are visible
 * to every logged-in user; the real-conversation turns endpoint carries
 * redacted conversation content, so it requires manage_system_config (the
 * Monitor page precedent).
 */

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
