import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import { getRegisteredGroup } from '../db.js';
import { getAutoMemoryHostConfig } from '../auto-memory-config.js';
import {
  autoMemorySidecarConfig,
  getAutoMemorySidecarManager,
} from '../auto-memory-ipc.js';
import type {
  AutoMemorySidecarEndpoint,
  AutoMemorySidecarOp,
  AutoMemorySidecarResult,
} from '../auto-memory-sidecar-manager.js';
import { logger } from '../logger.js';
import type { AuthUser, RegisteredGroup } from '../types.js';

/**
 * Auto-memory (mem0) management API — task W.
 *
 * The sidecar protocol already carries delete/delete_all but no caller could
 * reach them, and there was no list op: the auto layer could only store.
 * These routes close that gap for the settings UI: status (three-state
 * degradation), paginated list, keyword search, single delete, and a
 * destructive delete-all passthrough. Config-level endpoint information
 * (llm/embedder) never appears in any response.
 *
 * Permission model (user decision 2026-11-10): authMiddleware + the same
 * workspace resource ACL as Workspace Memory v2 — reads need
 * canAccessGroup, deletes need canModifyGroup, and both hide existence
 * behind 404. Folder and execution mode always come from the registered
 * group row and flow through the shared autoMemorySidecarConfig resolver,
 * so container/host data layouts stay identical to the IPC dispatcher's.
 */

const autoMemoryRoutes = new Hono<{ Variables: Variables }>();

/** Status probe budget — the settings page must not hang on a stuck sidecar. */
export const STATUS_PROBE_BUDGET_MS = 8_000;

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;
const LIST_OFFSET_MAX = 1_000_000;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_QUERY_MAX = 500;
const MEMORY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

autoMemoryRoutes.use('/*', authMiddleware);
autoMemoryRoutes.use(
  '/workspaces/*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        { error: 'request_too_large', message: 'Request is too large' },
        413,
      ),
  }),
);

interface GroupWithJid extends RegisteredGroup {
  jid: string;
}

type ResolvedWorkspace = { group: GroupWithJid } | { error: Response };

/**
 * Resolve the URL's workspaceJid to a registered group under the v2 ACL.
 * Unknown JIDs and forbidden callers are indistinguishable (404) — same
 * hide-existence rule as src/routes/memory.ts.
 */
function resolveWorkspace(
  c: Context,
  workspaceJid: string,
  access: 'read' | 'write',
): ResolvedWorkspace {
  const user = c.get('user') as AuthUser;
  const group = getRegisteredGroup(workspaceJid);
  if (!group) {
    return {
      error: c.json(
        { error: 'not_found', message: 'Workspace not found' },
        404,
      ),
    };
  }
  const permitted =
    access === 'write'
      ? canModifyGroup(user, group)
      : canAccessGroup(user, group);
  if (!permitted) {
    return {
      error: c.json(
        { error: 'not_found', message: 'Workspace not found' },
        404,
      ),
    };
  }
  return { group };
}

function configuredEndpoints(): {
  llm: AutoMemorySidecarEndpoint;
  embedder: AutoMemorySidecarEndpoint;
} | null {
  const config = getAutoMemoryHostConfig();
  if (!config.enabled || !config.llm || !config.embedder) return null;
  return { llm: config.llm, embedder: config.embedder };
}

async function callSidecar(
  group: GroupWithJid,
  op: AutoMemorySidecarOp,
  args: Record<string, unknown>,
): Promise<AutoMemorySidecarResult<unknown>> {
  const endpoints = configuredEndpoints();
  if (!endpoints) {
    return {
      available: false,
      reason: 'not_configured',
    };
  }
  return getAutoMemorySidecarManager().call(
    group.folder,
    autoMemorySidecarConfig(
      group.folder,
      group.executionMode,
      endpoints.llm,
      endpoints.embedder,
    ),
    op,
    args,
  );
}

/**
 * Race a sidecar probe against a short budget. A late rejection of the
 * underlying promise is swallowed (it already lost the race) so a stuck
 * sidecar can never surface as an unhandled rejection or a hung request.
 */
export async function probeWithBudget(
  probe: Promise<AutoMemorySidecarResult<unknown>>,
  budgetMs: number,
): Promise<AutoMemorySidecarResult<unknown>> {
  const guarded = probe.catch(
    (error): AutoMemorySidecarResult<unknown> => ({
      available: false,
      reason: `status probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AutoMemorySidecarResult<unknown>>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        available: false,
        reason: `status probe timed out after ${budgetMs}ms`,
      });
    }, budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function invalidArgs(c: Context, message: string) {
  return c.json({ error: 'invalid_args', message }, 400);
}

function unavailableReceipt(c: Context, reason: string) {
  if (reason === 'not_configured') {
    return c.json(
      { error: 'not_configured', message: 'Auto memory is not configured' },
      503,
    );
  }
  return c.json({ error: 'unavailable', message: reason }, 503);
}

function parsePagination(query: Record<string, string | undefined>): {
  limit: number;
  offset: number;
} | null {
  const rawLimit = query.limit ?? String(LIST_LIMIT_DEFAULT);
  const rawOffset = query.offset ?? '0';
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIST_LIMIT_MAX ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > LIST_OFFSET_MAX
  ) {
    return null;
  }
  return { limit, offset };
}

autoMemoryRoutes.get('/status', async (c) => {
  if (!configuredEndpoints()) {
    return c.json({
      enabled: false,
      available: false,
      reason: 'not_configured',
    });
  }
  const workspaceJid = c.req.query('workspaceJid');
  if (!workspaceJid) {
    // Global state only: no workspace to probe, no sidecar spawn.
    return c.json({ enabled: true, available: true });
  }
  const resolved = resolveWorkspace(c, workspaceJid, 'read');
  if ('error' in resolved) return resolved.error;
  const outcome = await probeWithBudget(
    callSidecar(resolved.group, 'list', { limit: 1, offset: 0 }),
    STATUS_PROBE_BUDGET_MS,
  );
  if (!outcome.available) {
    logger.warn(
      { workspaceJid, reason: outcome.reason },
      'auto-memory status probe unavailable',
    );
    return c.json({
      enabled: true,
      available: false,
      reason: outcome.reason,
    });
  }
  return c.json({ enabled: true, available: true });
});

autoMemoryRoutes.get('/workspaces/:workspaceJid/memories/search', async (c) => {
  const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'read');
  if ('error' in resolved) return resolved.error;

  const query = (c.req.query('q') ?? '').trim();
  const rawLimit = c.req.query('limit') ?? String(SEARCH_LIMIT_DEFAULT);
  const limit = Number(rawLimit);
  if (!query || query.length > SEARCH_QUERY_MAX) {
    return invalidArgs(
      c,
      `q must be 1-${SEARCH_QUERY_MAX} characters after trimming`,
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    return invalidArgs(
      c,
      `limit must be an integer between 1 and ${SEARCH_LIMIT_MAX}`,
    );
  }

  const outcome = await callSidecar(resolved.group, 'search', {
    query,
    limit,
  });
  if (!outcome.available) return unavailableReceipt(c, outcome.reason);
  return c.json({ items: outcome.value });
});

autoMemoryRoutes.get('/workspaces/:workspaceJid/memories', async (c) => {
  const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'read');
  if ('error' in resolved) return resolved.error;

  const pagination = parsePagination(c.req.query());
  if (!pagination) {
    return invalidArgs(
      c,
      `limit must be an integer between 1 and ${LIST_LIMIT_MAX}; offset between 0 and ${LIST_OFFSET_MAX}`,
    );
  }

  const outcome = await callSidecar(resolved.group, 'list', pagination);
  if (!outcome.available) return unavailableReceipt(c, outcome.reason);
  return c.json({ items: outcome.value });
});

autoMemoryRoutes.delete(
  '/workspaces/:workspaceJid/memories/:memoryId',
  async (c) => {
    const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'write');
    if ('error' in resolved) return resolved.error;

    const memoryId = c.req.param('memoryId');
    if (!MEMORY_ID_RE.test(memoryId)) {
      return invalidArgs(c, 'memoryId has an invalid format');
    }

    // Idempotent passthrough — mem0/qdrant delete of a missing id is a
    // no-op, so a repeated delete stays 200.
    const outcome = await callSidecar(resolved.group, 'delete', {
      memory_id: memoryId,
    });
    if (!outcome.available) return unavailableReceipt(c, outcome.reason);
    return c.json({ deleted: true });
  },
);

autoMemoryRoutes.delete('/workspaces/:workspaceJid/memories', async (c) => {
  const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'write');
  if ('error' in resolved) return resolved.error;

  // Destructive but idempotent at the API layer; the UI owns the danger
  // confirmation. No soft delete — schema stays untouched (task boundary).
  const outcome = await callSidecar(resolved.group, 'delete_all', {});
  if (!outcome.available) return unavailableReceipt(c, outcome.reason);
  return c.json({ deletedAll: true });
});

export default autoMemoryRoutes;
