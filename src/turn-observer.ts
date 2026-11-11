import type { StreamEvent } from './stream-event.types.js';
import { redactLogMessage, logger } from './logger.js';
import {
  getObservabilityConfig,
  type ObservabilityConfig,
} from './observability-config.js';
import { getDefaultEvalStore, type EvalStore } from './eval-store.js';

/**
 * Host-side turn observer (task AB).
 *
 * A process singleton tapped into the runAgent result callback
 * (src/index.ts): every ContainerOutput the runner emits passes through
 * `onResult`, which folds the observation facts into eval.db's obs_turns
 * through a bounded async queue.
 *
 * Hard contract (plan §3.3): every public method is synchronous and never
 * throws — observation must never break a live conversation turn. While
 * observability is disabled (missing data/config/observability.json), the
 * whole chain is a no-op with zero database writes.
 *
 * Content handling: `full` mode persists redacted conversation text
 * (redactLogMessage, the host logging boundary); `metadata` mode persists
 * none. The auto_recall stream event itself already carries counts only.
 */

export interface TurnObserverResultContext {
  workspaceJid: string;
  folder: string;
  channel: string;
  interactionMode: string;
  autoRecallEnabled: boolean;
  /** Raw turn input text; redacted in full mode, dropped in metadata mode. */
  inputText: string | null;
  /** Used only when the result carries no inputTurnId of its own. */
  defaultTurnId: string;
  sessionId?: string | null;
  /** Harness adapter version active for this turn; 0/omitted = baseline (task AF). */
  adapterVersion?: number;
}

/** Structural subset of ContainerOutput — no container-runner import. */
export interface TurnObserverResult {
  status: 'success' | 'error' | 'stream' | 'closed';
  result?: string | null;
  inputTurnId?: string;
  turnId?: string;
  sessionId?: string;
  streamEvent?: StreamEvent;
}

type PendingOp =
  | { kind: 'insert'; turn: Record<string, unknown> }
  | { kind: 'update'; turnId: string; patch: Record<string, unknown> };

interface TurnUsageAccumulator {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface TurnObserverOptions {
  getStore?: () => Pick<EvalStore, 'insertTurn' | 'updateTurn'>;
  getConfig?: () => ObservabilityConfig;
  maxQueueSize?: number;
  flushDelayMs?: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_FLUSH_DELAY_MS = 200;
/** Bound on remembered turn ids so long-running processes never leak. */
const SEEN_TURNS_LIMIT = 2000;

export class TurnObserver {
  private readonly queue: PendingOp[] = [];
  private readonly seenTurns = new Set<string>();
  private readonly usageByTurn = new Map<string, TurnUsageAccumulator>();
  private readonly getStore: () => Pick<EvalStore, 'insertTurn' | 'updateTurn'>;
  private readonly getConfig: () => ObservabilityConfig;
  private readonly maxQueueSize: number;
  private readonly flushDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private droppedOps = 0;
  private writeFailures = 0;

  constructor(options: TurnObserverOptions = {}) {
    this.getStore = options.getStore ?? getDefaultEvalStore;
    this.getConfig = options.getConfig ?? getObservabilityConfig;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /**
   * Single host tap: one runner result callback = one call. Never throws.
   */
  onResult(
    context: TurnObserverResultContext,
    result: TurnObserverResult,
  ): void {
    try {
      const config = this.getConfig();
      if (!config.enabled) return;
      const turnId =
        result.inputTurnId || result.turnId || context.defaultTurnId;

      if (!this.seenTurns.has(turnId)) {
        this.seenTurns.add(turnId);
        if (this.seenTurns.size > SEEN_TURNS_LIMIT) {
          const oldest = this.seenTurns.keys().next().value as
            | string
            | undefined;
          if (oldest !== undefined) this.seenTurns.delete(oldest);
        }
        this.enqueue({
          kind: 'insert',
          turn: {
            turnId,
            sessionId: context.sessionId ?? result.sessionId ?? null,
            workspaceJid: context.workspaceJid,
            folder: context.folder,
            channel: context.channel,
            interactionMode: context.interactionMode,
            autoRecallEnabled: context.autoRecallEnabled ? 1 : 0,
            inputText:
              config.contentMode === 'full' && context.inputText
                ? redactLogMessage(context.inputText)
                : null,
            adapterVersion: context.adapterVersion ?? 0,
          },
        });
      }

      if (result.status === 'stream' && result.streamEvent) {
        this.applyStreamEvent(turnId, result.streamEvent);
      }

      if (result.status === 'success' || result.status === 'error') {
        const usage = this.usageByTurn.get(turnId);
        this.usageByTurn.delete(turnId);
        this.enqueue({
          kind: 'update',
          turnId,
          patch: {
            ...(usage ?? {}),
            ...(config.contentMode === 'full' && result.result
              ? { outputText: redactLogMessage(result.result) }
              : {}),
          },
        });
      }
    } catch {
      // Observation must never break the observed turn.
    }
  }

  private applyStreamEvent(turnId: string, event: StreamEvent): void {
    if (event.eventType === 'auto_recall') {
      const facts = event.autoRecall;
      this.enqueue({
        kind: 'update',
        turnId,
        patch: facts
          ? {
              recallInjected: facts.injected ? 1 : 0,
              recallHitCount: facts.hitCount,
              recallLatencyMs: facts.latencyMs,
            }
          : { recallInjected: 0 },
      });
      return;
    }
    if (event.eventType === 'usage' && event.usage) {
      const usage = event.usage;
      const current = this.usageByTurn.get(turnId) ?? {};
      this.usageByTurn.set(turnId, {
        ...current,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUSD,
        durationMs: usage.durationMs,
      });
    }
  }

  private enqueue(op: PendingOp): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.droppedOps += 1;
      if (this.droppedOps === 1 || this.droppedOps % 100 === 0) {
        logger.warn(
          { droppedOps: this.droppedOps, maxQueueSize: this.maxQueueSize },
          'Turn observer queue saturated; newest observations dropped (observability only)',
        );
      }
      return;
    }
    this.queue.push(op);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelayMs);
    // Never hold the process open for observation writes.
    this.timer.unref?.();
  }

  /** Drain the queue into eval.db. Synchronous entry point; never throws. */
  flush(): void {
    const ops = this.queue.splice(0, this.queue.length);
    if (ops.length === 0) return;
    try {
      const store = this.getStore();
      for (const op of ops) {
        if (op.kind === 'insert') store.insertTurn(op.turn as never);
        else store.updateTurn(op.turnId, op.patch as never);
      }
    } catch (error) {
      this.writeFailures += 1;
      if (this.writeFailures === 1) {
        logger.warn(
          { err: error, writeFailures: this.writeFailures, ops: ops.length },
          'Turn observer eval.db write failed (warn-once; observation only)',
        );
      }
    }
  }
}

/** Process singleton — the single host tap in src/index.ts uses this. */
export const turnObserver = new TurnObserver();
