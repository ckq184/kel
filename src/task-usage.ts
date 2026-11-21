import type { ContainerOutput } from './container-runner.js';
import { recordUsageEvent } from './usage-service.js';

interface IsolatedTaskUsageContext {
  taskId: string;
  workspaceFolder: string;
  /**
   * Billing/attribution owner of the workspace the task executes in (NOT the
   * task creator): admin-created cross-group tasks must charge the member
   * workspace they actually run in — the same scoping rule the run's own
   * gates/mounts apply in task-scheduler's runTaskInner.
   */
  userId: string | null;
}

/**
 * Route one isolated-task runner stream output into the usage ledger.
 *
 * The isolated task path (context_mode='isolated') consumes runner stdout in
 * task-scheduler's runTaskInner stream callback, which historically forwarded
 * stream events only to WebSocket viewers — `usage` events never reached the
 * ledger, freezing analytics/quota/billing for task runs. This mirrors the
 * group-chat path's writeUsageRecords call sites (src/index.ts): every usage
 * stream event becomes exactly one recordUsageEvent, keyed idempotent by the
 * runner-provided eventId (usage_events PRIMARY KEY dedups task retries and
 * stream replays — replay-safe in the "undercount, never double charge"
 * direction).
 */
export function recordIsolatedTaskUsage(
  streamedOutput: ContainerOutput,
  context: IsolatedTaskUsageContext,
): { eventId: string; inserted: boolean } | null {
  const streamEvent = streamedOutput.streamEvent;
  if (streamedOutput.status !== 'stream' || !streamEvent) return null;
  if (streamEvent.eventType !== 'usage' || !streamEvent.usage) return null;
  return recordUsageEvent({
    userId: context.userId || 'system',
    groupFolder: context.workspaceFolder,
    source: 'task',
    usage: streamEvent.usage,
  });
}
