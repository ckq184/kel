import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import {
  decidePendingApproval,
  getPendingApproval,
  upsertPendingApproval,
} from './db.js';
import { logger } from './logger.js';
import {
  emitApprovalDecided,
  emitApprovalRequested,
  resolveApprovalInputSummary,
} from './approval-notify.js';

/**
 * Approval request service — bridges the durable file protocol from the
 * runner's approval gate to the database and the approval API.
 *
 * Transport truth lives on the filesystem: runners write requests under
 * `data/ipc/{folder}/approvals/pending/`, this service mirrors them into
 * `pending_approvals`, and an approve/deny decision is written back to
 * `data/ipc/{folder}/approvals/decisions/{id}.json` where the suspended
 * runner picks it up within its poll interval.
 *
 * v1 uses a 2s directory scan rather than fs.watch: workspace roots are
 * dynamic (one per workspace), and a missed event self-heals on the next
 * tick — the runner waits up to timeoutMs anyway.
 */

const IPC_ROOT = path.join(DATA_DIR, 'ipc');
const SCAN_INTERVAL_MS = 2_000;

export interface ApprovalRequestFile {
  id: string;
  toolName: string;
  input: unknown;
  groupFolder: string;
  chatJid: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
  timeoutMs: number;
}

export interface ApprovalDecisionFile {
  id: string;
  approved: boolean;
  decidedBy?: string;
  decidedAt: string;
}

let scanTimer: ReturnType<typeof setInterval> | null = null;
let seenRequestIds = new Set<string>();

export function startApprovalService(): void {
  if (scanTimer) return;
  scanTimer = setInterval(scanApprovalRequests, SCAN_INTERVAL_MS);
  scanTimer.unref?.();
}

export function stopApprovalService(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

/** Test hook: forget which requests were already mirrored. */
export function resetApprovalServiceForTests(): void {
  seenRequestIds = new Set<string>();
}

function listWorkspaceFolders(): string[] {
  try {
    return fs
      .readdirSync(IPC_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function scanApprovalRequests(): void {
  for (const folder of listWorkspaceFolders()) {
    const pendingDir = path.join(IPC_ROOT, folder, 'approvals', 'pending');
    let files: string[];
    try {
      files = fs
        .readdirSync(pendingDir)
        .filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const fileId = file.replace(/\.json$/, '');
      if (seenRequestIds.has(fileId)) continue;
      let request: ApprovalRequestFile;
      try {
        request = JSON.parse(
          fs.readFileSync(path.join(pendingDir, file), 'utf8'),
        ) as ApprovalRequestFile;
      } catch {
        continue; // half-written or garbage — retried next tick
      }
      if (!request?.id || typeof request.toolName !== 'string') continue;
      seenRequestIds.add(fileId);
      try {
        const inserted = upsertPendingApproval({
          id: request.id,
          group_folder: request.groupFolder || folder,
          chat_jid: request.chatJid || '',
          tool_name: request.toolName,
          input_json: JSON.stringify(request.input ?? null),
          session_id: request.sessionId ?? null,
          turn_id: request.turnId ?? null,
          created_at: request.createdAt || new Date().toISOString(),
        });
        // Only genuinely new rows notify. After a host restart the seen set is
        // gone and pending files are rescanned, but the DB rows already exist
        // (inserted === false), so channels and WS clients are not spammed.
        if (inserted) {
          logger.info(
            { approvalId: request.id, tool: request.toolName, folder },
            'Tool approval requested by runner',
          );
          emitApprovalRequested({
            id: request.id,
            groupFolder: request.groupFolder || folder,
            chatJid: request.chatJid || '',
            toolName: request.toolName,
            inputSummary: resolveApprovalInputSummary(request.input),
            sessionId: request.sessionId ?? null,
            turnId: request.turnId ?? null,
            createdAt: request.createdAt || new Date().toISOString(),
            timeoutMs: request.timeoutMs,
          });
        } else {
          // A decided row with a lingering pending file is residue from a
          // host crash between decide and cleanup (pre-I1 shape): the runner
          // already got its decision, so remove the file and skip the
          // startup replay log instead of re-announcing dead requests.
          const row = getPendingApproval(request.id);
          if (row && row.status !== 'pending') {
            removePendingRequestFile(folder, request.id);
            logger.debug(
              { approvalId: request.id, folder },
              'Removed stale decided pending approval file',
            );
          } else {
            logger.info(
              { approvalId: request.id, tool: request.toolName, folder },
              'Tool approval requested by runner',
            );
          }
        }
      } catch (error) {
        logger.warn({ err: error }, 'Failed to mirror approval request');
      }
    }
  }
}

export function resolveApprovalIpcDir(groupFolder: string): string {
  return path.join(IPC_ROOT, groupFolder, 'approvals', 'decisions');
}

function removePendingRequestFile(groupFolder: string, id: string): void {
  const pendingFile = path.join(
    IPC_ROOT,
    groupFolder,
    'approvals',
    'pending',
    `${id}.json`,
  );
  try {
    fs.unlinkSync(pendingFile);
  } catch (error) {
    logger.warn(
      { approvalId: id, groupFolder, err: error },
      'Failed to clean up decided pending approval file',
    );
  }
}

/**
 * Record a decision and hand it to the suspended runner via the decisions
 * directory. Returns false when the approval is unknown or already decided.
 */
export function decideApproval(
  id: string,
  approved: boolean,
  decidedBy: string | null,
): boolean {
  const row = getPendingApproval(id);
  if (!row || row.status !== 'pending') return false;
  const decision: ApprovalDecisionFile = {
    id,
    approved,
    ...(decidedBy ? { decidedBy } : {}),
    decidedAt: new Date().toISOString(),
  };
  const decisionsDir = resolveApprovalIpcDir(row.group_folder);
  const file = path.join(decisionsDir, `${id}.json`);
  fs.mkdirSync(decisionsDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(decision, null, 2));
  fs.renameSync(tmp, file);
  const decided = decidePendingApproval(
    id,
    approved ? 'approved' : 'denied',
    decidedBy,
  );
  if (decided) {
    // The runner consumes only the decisions file, so the pending request is
    // dead weight once the row is decided — remove it, or every startup
    // replays a "requested" log line for a decision that already happened.
    removePendingRequestFile(row.group_folder, id);
    emitApprovalDecided({
      id,
      groupFolder: row.group_folder,
      toolName: row.tool_name,
      approved,
      decidedBy: decidedBy ?? null,
      decidedAt: decision.decidedAt,
      status: approved ? 'approved' : 'denied',
    });
  }
  return decided;
}
