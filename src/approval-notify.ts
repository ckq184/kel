import type {
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
} from './stream-event.types.js';
import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';

export type {
  ApprovalDecidedPayload,
  ApprovalRequestedPayload,
} from './stream-event.types.js';

/**
 * Approval notification fan-out — the leaf between the approval service and
 * its consumers (Web WS broadcast + IM channel push in index.ts).
 *
 * The service must stay importable without dragging in index.ts/web.ts, so it
 * emits through this module and the host wires the actual delivery at startup
 * (before `startApprovalService()` so no request is missed).
 */

export type ApprovalEvent =
  | { kind: 'approval_requested'; approval: ApprovalRequestedPayload }
  | { kind: 'approval_decided'; approval: ApprovalDecidedPayload };

type ApprovalEventHandler = (event: ApprovalEvent) => void;

const handlers = new Set<ApprovalEventHandler>();

export function onApprovalEvent(handler: ApprovalEventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitApprovalRequested(
  approval: ApprovalRequestedPayload,
): void {
  dispatch({ kind: 'approval_requested', approval });
}

export function emitApprovalDecided(approval: ApprovalDecidedPayload): void {
  dispatch({ kind: 'approval_decided', approval });
}

function dispatch(event: ApprovalEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      // A broken subscriber must never break the approval scan loop.
      logger.error({ err: error }, 'Approval notify handler failed');
    }
  }
}

/** Test hook: drop all subscribers. */
export function resetApprovalNotifyForTests(): void {
  handlers.clear();
}

const INPUT_SUMMARY_MAX_LENGTH = 300;

/**
 * Render a tool input into a bounded summary for IM cards and WS payloads.
 * Rendering only — the full input stays in `pending_approvals.input_json`.
 */
export function resolveApprovalInputSummary(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input ?? null);
  } catch {
    text = String(input);
  }
  if (text.length > INPUT_SUMMARY_MAX_LENGTH) {
    return `${text.slice(0, INPUT_SUMMARY_MAX_LENGTH)}…`;
  }
  return text;
}

export const MIN_APPROVAL_ID_PREFIX = 4;

/**
 * Resolve the workspace chat JID for an approval's group folder. Prefers the
 * `web:` home row (whose broadcast ACL is the workspace owner); falls back to
 * any registered row on the folder. Null when the workspace no longer exists —
 * callers must treat that as default-deny / skip-push.
 */
export function resolveApprovalWorkspaceJid(
  groupFolder: string,
): string | null {
  let fallback: string | null = null;
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (group.folder !== groupFolder) continue;
    if (jid.startsWith('web:')) return jid;
    fallback ??= jid;
  }
  return fallback;
}

export interface MatchableApprovalRef {
  id: string;
  status: string;
}

/**
 * Resolve an IM-command argument (`/approve <prefix>`) to one pending
 * approval. UUID ids are hostile to type on a phone, so a unique prefix is
 * enough; anything ambiguous or short fails with a user-facing reason.
 */
export function matchApprovalByIdPrefix(
  prefix: string,
  rows: readonly MatchableApprovalRef[],
): { ok: true; id: string } | { ok: false; reason: string } {
  const trimmed = prefix.trim();
  if (trimmed.length < MIN_APPROVAL_ID_PREFIX) {
    return {
      ok: false,
      reason: `请提供至少 ${MIN_APPROVAL_ID_PREFIX} 位审批 id 前缀（审批卡片中可复制）`,
    };
  }
  const candidates = rows.filter(
    (row) => row.status === 'pending' && row.id.startsWith(trimmed),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `未找到前缀为 ${trimmed} 的待审批请求（可能已被处理）`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `前缀 ${trimmed} 匹配到 ${candidates.length} 个待审批请求，请提供更长前缀`,
    };
  }
  return { ok: true, id: candidates[0].id };
}
