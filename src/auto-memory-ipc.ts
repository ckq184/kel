import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  AutoMemorySidecarManager,
  type AutoMemorySidecarConfig,
} from './auto-memory-sidecar-manager.js';
import {
  getAutoMemoryHostConfig,
  type AutoMemoryHostConfig,
} from './auto-memory-config.js';

/**
 * Host-side IPC handler for `auto_memory` task requests (docs/
 * auto-memory-sidecar-ownership-plan.md, T2).
 *
 * Runners call the auto-memory tools over the same file IPC channel as
 * workspace_memory (`data/ipc/{folder}/tasks/`); this handler forwards the
 * op to the host-owned sidecar manager and writes the
 * `auto_memory_result_{requestId}.json` receipt back into the request's
 * tasksDir. Folder and execution mode are derived from the verified IPC
 * namespace — a model-supplied workspace identifier is never trusted, same
 * rule as the workspace_memory case.
 *
 * Only the three ops the runner tools need (search/add/get) are exposed;
 * delete/delete_all stay sidecar-internal. Every failure degrades to a
 * coded `{ success: false }` receipt — auto memory must never break a turn.
 */

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

const IPC_OPERATIONS = new Set(['search', 'add', 'get']);

export type AutoMemoryIpcManager = Pick<AutoMemorySidecarManager, 'call'>;

export interface AutoMemoryIpcData {
  type: 'auto_memory';
  operation?: string;
  requestId?: string;
  query?: string;
  limit?: number;
  messages?: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
  memoryId?: string;
  [key: string]: unknown;
}

export interface AutoMemoryIpcContext {
  /** Verified workspace folder from the IPC directory namespace. */
  folder: string;
  /** Workspace execution mode; anything but 'host' means the container layout. */
  executionMode?: string | null;
  config: AutoMemoryHostConfig;
  manager: AutoMemoryIpcManager;
  /** Bound writeTaskResult for the request's tasksDir and requestId. */
  writeResult: (payload: Record<string, unknown>) => void;
}

/**
 * Host-side Qdrant data path for a workspace folder, by execution mode.
 *
 * `container` workspaces mount `data/extra/{folder}` at `/workspace/extra`,
 * so their pre-existing sidecar data lives in `data/extra/{folder}/
 * auto-memory` (no migration); `host` workspaces run beside
 * `data/groups/{folder}/extra`. The two layouts must never collide — pinned
 * by table-driven tests (plan §6-3).
 */
export function autoMemoryDataPath(
  folder: string,
  executionMode?: string | null,
): string {
  if (executionMode === 'host') {
    return path.join(GROUPS_DIR, folder, 'extra', 'auto-memory');
  }
  return path.join(DATA_DIR, 'extra', folder, 'auto-memory');
}

/**
 * Shared sidecar config resolver — the single source of the per-workspace
 * Qdrant path, collection, and mem0 namespace. The IPC dispatcher and the
 * management routes (src/routes/auto-memory.ts, task W) both build configs
 * here so the container/host data layouts can never drift apart
 * (autoMemoryDataPath layouts are pinned by tests/auto-memory-ipc.test.ts).
 */
export function autoMemorySidecarConfig(
  folder: string,
  executionMode: string | null | undefined,
  llm: AutoMemorySidecarConfig['llm'],
  embedder: AutoMemorySidecarConfig['embedder'],
): AutoMemorySidecarConfig {
  return {
    dataPath: autoMemoryDataPath(folder, executionMode),
    collection: `ws-${folder}`,
    userId: `workspace:${folder}`,
    llm,
    embedder,
  };
}

function buildSidecarConfig(
  ctx: AutoMemoryIpcContext,
  llm: NonNullable<AutoMemoryHostConfig['llm']>,
  embedder: NonNullable<AutoMemoryHostConfig['embedder']>,
): AutoMemorySidecarConfig {
  return autoMemorySidecarConfig(ctx.folder, ctx.executionMode, llm, embedder);
}

/** Validate and translate an IPC request into sidecar op args. */
function buildOpArgs(
  data: AutoMemoryIpcData,
): { op: 'search' | 'add' | 'get'; args: Record<string, unknown> } | null {
  switch (data.operation) {
    case 'search': {
      const query = typeof data.query === 'string' ? data.query.trim() : '';
      if (!query || query.length > 500) return null;
      const limit =
        typeof data.limit === 'number' && Number.isInteger(data.limit)
          ? data.limit
          : 10;
      if (limit < 1 || limit > 50) return null;
      return { op: 'search', args: { query, limit } };
    }
    case 'add': {
      const messages = Array.isArray(data.messages) ? data.messages : undefined;
      if (
        !messages ||
        messages.length === 0 ||
        !messages.every(
          (m) =>
            m &&
            typeof m.role === 'string' &&
            typeof m.content === 'string' &&
            m.content.length > 0,
        )
      ) {
        return null;
      }
      return {
        op: 'add',
        args: {
          messages,
          metadata:
            data.metadata && typeof data.metadata === 'object'
              ? data.metadata
              : {},
        },
      };
    }
    case 'get': {
      const memoryId =
        typeof data.memoryId === 'string' ? data.memoryId.trim() : '';
      if (!memoryId) return null;
      return { op: 'get', args: { memory_id: memoryId } };
    }
    default:
      return null;
  }
}

export async function handleAutoMemoryIpc(
  data: AutoMemoryIpcData,
  ctx: AutoMemoryIpcContext,
): Promise<void> {
  // An invalid requestId cannot name a result file, so no receipt can be
  // written for it (writeTaskResult rejects such ids the same way); the
  // request is dropped with a warning instead of acked.
  if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
    logger.warn(
      {
        folder: ctx.folder,
        operation: data.operation,
        requestId: data.requestId,
      },
      'Rejected auto-memory IPC request with invalid requestId',
    );
    return;
  }
  if (!IPC_OPERATIONS.has(data.operation ?? '')) {
    ctx.writeResult({
      success: false,
      code: 'invalid_operation',
      error: `Unknown auto-memory operation: ${String(data.operation)}`,
    });
    return;
  }
  const config = ctx.config;
  if (!config.enabled || !config.llm || !config.embedder) {
    ctx.writeResult({
      success: false,
      code: 'not_configured',
      error: 'auto memory is not configured (missing llm/embedder endpoints)',
    });
    return;
  }
  const routed = buildOpArgs(data);
  if (!routed) {
    ctx.writeResult({
      success: false,
      code: 'invalid_args',
      error: `Invalid arguments for auto-memory ${String(data.operation)}`,
    });
    return;
  }
  const outcome = await ctx.manager.call(
    ctx.folder,
    buildSidecarConfig(ctx, config.llm, config.embedder),
    routed.op,
    routed.args,
  );
  if (!outcome.available) {
    ctx.writeResult({
      success: false,
      code: 'unavailable',
      error: outcome.reason,
    });
    return;
  }
  ctx.writeResult({ success: true, result: outcome.value });
}

// ── Host-lifecycle singleton ────────────────────────────────────────────────

let managerSingleton: AutoMemorySidecarManager | null = null;

export function getAutoMemorySidecarManager(): AutoMemorySidecarManager {
  if (!managerSingleton) {
    managerSingleton = new AutoMemorySidecarManager();
  }
  return managerSingleton;
}

/** Server shutdown: stop every workspace sidecar process. */
export function closeAutoMemorySidecarManager(): Promise<void> {
  if (!managerSingleton) return Promise.resolve();
  const manager = managerSingleton;
  managerSingleton = null;
  return manager.stopAll();
}
