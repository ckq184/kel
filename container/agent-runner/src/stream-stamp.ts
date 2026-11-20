import type { StreamEvent } from './types.js';

/**
 * Identity fields every Pi-mapped stream event must carry for the host to
 * correlate it (ISSUE-02 P0-1): the Web run fence routes on `queryRunId`
 * (`observeExact`) and the turn owners / snapshots / message backfill all key
 * off `turnId`.
 */
export interface StreamIdentityStamp {
  /** Current input turn — the durable IPC delivery id when warm, else the
   *  cold-start turn id. Mirrors pi-index's `activeInputTurnId`. */
  turnId?: string;
  /** Exact GroupQueue query attempt that owns this event. */
  queryRunId?: string;
}

/**
 * Fill — never overwrite — the identity fields a stream event lacks. The
 * interrupted status event attaches its own exact turn/query identity inside
 * the runner; preserving pre-existing values keeps that semantics intact.
 * Late events from a superseded run keep the OLD attempt's queryRunId, which
 * is exactly what lets the host fence reject them.
 */
export function stampStreamEventIdentity(
  event: StreamEvent,
  stamp: StreamIdentityStamp,
): StreamEvent {
  const needsTurnId = stamp.turnId !== undefined && event.turnId === undefined;
  const needsQueryRunId =
    stamp.queryRunId !== undefined && event.queryRunId === undefined;
  if (!needsTurnId && !needsQueryRunId) return event;
  return {
    ...event,
    ...(needsTurnId ? { turnId: stamp.turnId } : {}),
    ...(needsQueryRunId ? { queryRunId: stamp.queryRunId } : {}),
  };
}
