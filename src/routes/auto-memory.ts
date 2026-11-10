import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import { getMessagesPage, getRegisteredGroup } from '../db.js';
import {
  clearAutoMemoryHostConfig,
  getAutoMemoryConfigSource,
  getAutoMemoryHostConfig,
  writeAutoMemoryHostConfig,
  type AutoMemoryEndpointConfig,
} from '../auto-memory-config.js';
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
 * Auto-memory (mem0) management API — task W, config endpoints — task X.
 *
 * The sidecar protocol already carried delete/delete_all but no caller could
 * reach them, and there was no list op: the auto layer could only store.
 * These routes close that gap for the settings UI: status (three-state
 * degradation), paginated list, keyword search, single delete, and a
 * destructive delete-all passthrough. Workspace responses never carry
 * config-level endpoint information; the /config family (task X) exposes a
 * masked view (baseUrl/model plaintext, apiKey masked) for admins to
 * manage the file channel, plus a write path that stops live sidecars so
 * the next call respawns with the new endpoints.
 *
 * Permission model (user decision 2026-11-10): workspace endpoints use
 * authMiddleware + the same resource ACL as Workspace Memory v2 — reads
 * need canAccessGroup, deletes need canModifyGroup, and both hide
 * existence behind 404. The /config endpoints are system config
 * (systemConfigMiddleware / manage_system_config), mounted per path
 * segment; the two faces must not leak into each other. Folder and
 * execution mode always come from the registered group row and flow
 * through the shared autoMemorySidecarConfig resolver, so container/host
 * data layouts stay identical to the IPC dispatcher's.
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
// Task Y chat-capture budget — server-fixed on purpose (cost cap), never
// accepted from the client (user decision 2026-11-10).
const CAPTURE_MESSAGE_LIMIT = 400;
const CAPTURE_CHAR_BUDGET = 60_000;
const CAPTURE_AGENT_ID_MAX = 128;

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
// Task X config endpoints: system-config permission + a tighter credential
// body budget (OpenDot discipline — same 8KB). Registered after the global
// authMiddleware so the permission check sees the resolved user.
autoMemoryRoutes.use(
  '/config',
  systemConfigMiddleware,
  bodyLimit({
    maxSize: 8 * 1024,
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
  // `source` (env/file/none, task X) is non-sensitive and lets the UI mark
  // the env-overridden state as read-only.
  const source = getAutoMemoryConfigSource();
  if (!configuredEndpoints()) {
    return c.json({
      enabled: false,
      available: false,
      reason: 'not_configured',
      source,
    });
  }
  const workspaceJid = c.req.query('workspaceJid');
  if (!workspaceJid) {
    // Global state only: no workspace to probe, no sidecar spawn.
    return c.json({ enabled: true, available: true, source });
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
      source,
    });
  }
  return c.json({ enabled: true, available: true, source });
});

// ── Config endpoints (task X) ────────────────────────────────────────────────

/** Same mask shape as src/routes/config.ts credentials (≤8 chars → '***'). */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

interface ConfigEndpointInput {
  baseUrl: string;
  /** Absent/blank/mask-verbatim all mean "keep the stored key" (PUT only). */
  apiKey?: string;
  model: string;
}

/**
 * Strict field validation (OpenDot discipline): types, no surrounding
 * whitespace, http(s) baseUrl. Blank apiKey is allowed here — the route
 * resolves keep-old semantics against the current config before writing.
 */
function parseEndpointInput(
  raw: unknown,
  label: string,
): { value: ConfigEndpointInput } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object` };
  }
  const { baseUrl, apiKey, model } = raw as Record<string, unknown>;
  if (
    typeof baseUrl !== 'string' ||
    typeof model !== 'string' ||
    (apiKey !== undefined && typeof apiKey !== 'string')
  ) {
    return { error: `${label}.baseUrl/model/apiKey must be strings` };
  }
  if (apiKey !== undefined && apiKey !== apiKey.trim()) {
    return { error: `${label}.apiKey must not have surrounding whitespace` };
  }
  if (!baseUrl.trim() || !model.trim()) {
    return { error: `${label}.baseUrl and ${label}.model must not be empty` };
  }
  if (baseUrl !== baseUrl.trim() || model !== model.trim()) {
    return {
      error: `${label}.baseUrl/model must not have surrounding whitespace`,
    };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { error: `${label}.baseUrl must start with http:// or https://` };
  }
  return { value: { baseUrl, apiKey, model } };
}

/**
 * Config writes must take effect: live sidecars hold their spawn-time
 * endpoints, so stop them all and let the next call respawn with the new
 * config. A stop failure never rolls back the persisted file — it only
 * means existing sidecars keep serving until they idle out.
 */
async function stopAllSidecars(): Promise<boolean> {
  try {
    await getAutoMemorySidecarManager().stopAll();
    return true;
  } catch (error) {
    logger.warn(
      { err: error },
      'auto-memory sidecar stopAll failed after a config change',
    );
    return false;
  }
}

function envOverride(c: Context) {
  return c.json(
    {
      error: 'env_override',
      message:
        'CKQCLAW_AUTO_MEMORY is set — the env channel owns the config; clear it to use the file channel',
    },
    409,
  );
}

autoMemoryRoutes.get('/config', (c) => {
  // Masked credential view — baseUrl/model plaintext for form prefill,
  // apiKey masked. Never cached.
  c.header('Cache-Control', 'private, no-store');
  const source = getAutoMemoryConfigSource();
  const config = getAutoMemoryHostConfig();
  const view = (endpoint: AutoMemoryEndpointConfig | undefined) =>
    endpoint
      ? {
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          apiKeyMasked: maskApiKey(endpoint.apiKey),
        }
      : undefined;
  return c.json({
    source,
    enabled: config.enabled,
    ...(config.llm ? { llm: view(config.llm) } : {}),
    ...(config.embedder ? { embedder: view(config.embedder) } : {}),
  });
});

autoMemoryRoutes.put('/config', async (c) => {
  if (getAutoMemoryConfigSource() === 'env') return envOverride(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidArgs(c, 'body must be a JSON object with llm and embedder');
  }
  const raw = body as Record<string, unknown>;
  const llm = parseEndpointInput(raw.llm, 'llm');
  if ('error' in llm) return invalidArgs(c, llm.error);
  const embedder = parseEndpointInput(raw.embedder, 'embedder');
  if ('error' in embedder) return invalidArgs(c, embedder.error);

  // Keep-old resolution: blank (UI left empty) or the prefill mask sent back
  // verbatim both retain the stored key — a mask must never be persisted as
  // if it were a plaintext credential.
  const current = getAutoMemoryHostConfig();
  const resolveKey = (
    input: ConfigEndpointInput,
    old: AutoMemoryEndpointConfig | undefined,
  ): string => {
    if (input.apiKey === undefined || input.apiKey === '') {
      return old?.apiKey ?? '';
    }
    if (old && input.apiKey === maskApiKey(old.apiKey)) return old.apiKey;
    return input.apiKey;
  };

  const result = writeAutoMemoryHostConfig({
    llm: {
      baseUrl: llm.value.baseUrl,
      apiKey: resolveKey(llm.value, current.llm),
      model: llm.value.model,
    },
    embedder: {
      baseUrl: embedder.value.baseUrl,
      apiKey: resolveKey(embedder.value, current.embedder),
      model: embedder.value.model,
    },
  });
  if (!result.ok) {
    if (result.error === 'env_override') return envOverride(c);
    if (result.error === 'invalid_endpoints') {
      return invalidArgs(c, result.message);
    }
    return c.json({ error: 'write_failed', message: result.message }, 500);
  }
  const sidecarsRestarted = await stopAllSidecars();
  return c.json({ ok: true, sidecarsRestarted });
});

autoMemoryRoutes.delete('/config', async (c) => {
  if (getAutoMemoryConfigSource() === 'env') return envOverride(c);
  const result = clearAutoMemoryHostConfig();
  if (!result.ok) {
    if (result.error === 'env_override') return envOverride(c);
    return c.json({ error: 'clear_failed', message: result.message }, 500);
  }
  const sidecarsRestarted = await stopAllSidecars();
  return c.json({ ok: true, sidecarsRestarted });
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

// ── Chat capture endpoints (task Y) ──────────────────────────────────────────

/**
 * Assemble the text-message payload for a chat capture: the newest
 * CAPTURE_MESSAGE_LIMIT rows in chronological order, non-conversation rows
 * (session separators, billing notices, empty bodies) dropped, roles mapped
 * from is_from_me, then the char budget filled from the newest message
 * backwards so overflow trims the oldest content (user decision 2026-11-10:
 * capture everything, keep the newest part). Never logs message content.
 */
function assembleCaptureMessages(chatJid: string): {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  chars: number;
} {
  const rows = getMessagesPage(chatJid, undefined, CAPTURE_MESSAGE_LIMIT)
    .slice()
    .reverse()
    .filter(
      (row) =>
        row.sender !== '__system__' &&
        row.sender !== '__billing__' &&
        row.content.trim().length > 0,
    )
    .map((row) => ({
      role: (row.is_from_me ? 'assistant' : 'user') as 'user' | 'assistant',
      content: row.content,
    }));

  const kept: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let chars = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (chars + row.content.length > CAPTURE_CHAR_BUDGET) {
      if (kept.length === 0) {
        // The newest message alone busts the budget — keep its tail so a
        // single huge turn never yields an empty capture.
        kept.push({
          role: row.role,
          content: row.content.slice(row.content.length - CAPTURE_CHAR_BUDGET),
        });
        chars = CAPTURE_CHAR_BUDGET;
      }
      break;
    }
    kept.push(row);
    chars += row.content.length;
  }
  kept.reverse();
  return { messages: kept, chars };
}

/** agentId is optional; blank-after-trim means the main conversation. */
function parseCaptureAgentId(
  raw: string | undefined,
): { agentId?: string } | { error: string } {
  const agentId = raw?.trim();
  if (!agentId) return {};
  if (agentId.length > CAPTURE_AGENT_ID_MAX) {
    return {
      error: `agentId must be at most ${CAPTURE_AGENT_ID_MAX} characters`,
    };
  }
  return { agentId };
}

autoMemoryRoutes.get('/workspaces/:workspaceJid/capture/preview', (c) => {
  const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'read');
  if ('error' in resolved) return resolved.error;

  const agent = parseCaptureAgentId(c.req.query('agentId'));
  if ('error' in agent) return invalidArgs(c, agent.error);

  // Cost preview only — assembles from the DB, never spawns the sidecar
  // (works even when auto memory is not configured yet).
  const chatJid = agent.agentId
    ? `${resolved.group.jid}#agent:${agent.agentId}`
    : resolved.group.jid;
  const { messages, chars } = assembleCaptureMessages(chatJid);
  return c.json({ messages: messages.length, chars });
});

autoMemoryRoutes.post('/workspaces/:workspaceJid/capture', async (c) => {
  const resolved = resolveWorkspace(c, c.req.param('workspaceJid'), 'write');
  if ('error' in resolved) return resolved.error;

  // Absent body = {}; present body must be a JSON object (agentId optional).
  const body = await c.req.json().catch(() => null);
  if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
    return invalidArgs(c, 'body must be a JSON object');
  }
  if (body?.agentId !== undefined && typeof body.agentId !== 'string') {
    return invalidArgs(c, 'agentId must be a string');
  }
  const agent = parseCaptureAgentId(body?.agentId);
  if ('error' in agent) return invalidArgs(c, agent.error);

  const chatJid = agent.agentId
    ? `${resolved.group.jid}#agent:${agent.agentId}`
    : resolved.group.jid;
  const { messages } = assembleCaptureMessages(chatJid);
  if (messages.length === 0) {
    return invalidArgs(c, 'no capturable text messages in this conversation');
  }

  const metadata: Record<string, unknown> = {
    source: 'chat_capture',
    capturedAt: new Date().toISOString(),
  };
  if (agent.agentId) metadata.agentId = agent.agentId;

  const outcome = await callSidecar(resolved.group, 'add', {
    messages,
    metadata,
  });
  if (!outcome.available) return unavailableReceipt(c, outcome.reason);

  // mem0 add receipt: a bare results list, or {results, intercepted?} once
  // the sidecar attached its redaction findings (attach_intercepted).
  const value = outcome.value;
  const dict =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const results = Array.isArray(value)
    ? value
    : dict && Array.isArray(dict.results)
      ? dict.results
      : [];
  const intercepted =
    dict && Array.isArray(dict.intercepted) ? dict.intercepted : [];
  const added = results.filter(
    (item) =>
      item &&
      typeof item === 'object' &&
      (item as { event?: unknown }).event === 'ADD',
  ).length;
  return c.json({
    ok: true,
    captured: messages.length,
    added,
    intercepted: intercepted.length,
  });
});

export default autoMemoryRoutes;
