import type {
  ContainerInput,
  ContainerOutput,
  StreamEvent,
} from '../../types.js';
import type { McpContext } from '../../mcp-tools.js';
import {
  IpcTurnDeliveryTracker,
  latestIpcDeliveryId,
  type IpcDeliveryReceipt,
  type IpcInputMessage,
} from '../../ipc-delivery.js';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeInput,
  RuntimeResult,
  RuntimeSession,
} from '../types.js';

type PiQueryRunResult = {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  cancelledIpcReceipts?: IpcDeliveryReceipt[];
  pipedMessagesDuringQuery: IpcInputMessage[];
  durableInputTurnCompleted?: boolean;
  /**
   * Task AI: the provider stream ended before the pending input turn(s) got a
   * result. No throw, nothing acked — main's requeue path retries the turn,
   * keeping the runner process alive (2026-11-12 incident: this used to be a
   * process-killing invariant).
   */
  prematureEnd?: boolean;
  /** Task AI: retry budget exhausted — terminal per-turn error published with receipts. */
  prematureTerminal?: boolean;
};

// ── Premature-end budget (task AI) ──────────────────────────────────────────
//
// One auto-retry per delivery id; a second consecutive premature end acks the
// turn with a terminal error (stops the host replay storm instead of looping
// across processes). Any completed turn resets the whole map — conservative
// toward retrying. Bounded so a churning set of delivery ids cannot grow it.

const PREMATURE_END_BUDGET = 1;
const PREMATURE_END_TRACKER_MAX = 32;
const prematureEndCounts = new Map<string, number>();

function prematureEndKey(
  tracker: IpcTurnDeliveryTracker,
  fallbackTurnId: string | undefined,
): string {
  return (
    latestIpcDeliveryId(tracker.unacknowledgedMessages) ||
    fallbackTurnId ||
    'anonymous'
  );
}

function bumpPrematureEnd(key: string): number {
  const next = (prematureEndCounts.get(key) ?? 0) + 1;
  prematureEndCounts.set(key, next);
  if (prematureEndCounts.size > PREMATURE_END_TRACKER_MAX) {
    const oldest = prematureEndCounts.keys().next().value;
    if (oldest !== undefined) prematureEndCounts.delete(oldest);
  }
  return next;
}

type PiQueryRunOptions = {
  runtime: AgentRuntime;
  sessionOptions: Parameters<AgentRuntime['createSession']>[0];
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
  containerInput: ContainerInput;
  tracker: IpcTurnDeliveryTracker;
  emit: (output: ContainerOutput) => void;
  log: (message: string) => void;
  drainInput: () => IpcInputMessage[];
  shouldClose: () => boolean;
  shouldInterrupt: () => boolean;
  acceptIpcMessagesDuringQuery: boolean;
  onSessionId: (sessionId: string) => void;
  onTurnActivated: (messages: IpcInputMessage[]) => void;
  onTurnCompleted: () => void;
  sourceKindOverride?: ContainerOutput['sourceKind'];
};

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toRuntimeInput(
  text: string,
  images?: Array<{ data: string; mimeType?: string }>,
): RuntimeInput {
  return {
    text,
    images: images?.map((image) => ({
      data: image.data,
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    })),
  };
}

function toStreamEvent(
  event: RuntimeEvent,
  containerInput: ContainerInput,
): StreamEvent | undefined {
  switch (event.type) {
    case 'text_delta':
      return {
        eventType: 'text_delta',
        agentScope: 'main',
        displayLevel: 'primary',
        text: event.delta,
        sessionId: event.sessionId,
      };
    case 'thinking_delta':
      return {
        eventType: 'thinking_delta',
        agentScope: 'main',
        displayLevel: 'detail',
        text: event.delta,
        sessionId: event.sessionId,
      };
    case 'tool_start':
      return {
        eventType: 'tool_use_start',
        agentScope: event.toolName.startsWith('mcp__') ? 'main' : 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolInput:
          event.input && typeof event.input === 'object'
            ? (event.input as Record<string, unknown>)
            : undefined,
        sessionId: event.sessionId,
      };
    case 'tool_update':
      return {
        eventType: 'tool_progress',
        agentScope: 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        detail:
          event.result === undefined ? undefined : stringify(event.result),
        sessionId: event.sessionId,
      };
    case 'tool_end':
      return {
        eventType: 'tool_use_end',
        agentScope: 'main',
        displayLevel: 'detail',
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        toolResult:
          event.result === undefined ? undefined : stringify(event.result),
        sessionId: event.sessionId,
      };
    case 'usage':
      return {
        eventType: 'usage',
        agentScope: 'main',
        displayLevel: 'detail',
        usage: {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadInputTokens: event.usage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: event.usage.cacheCreationInputTokens ?? 0,
          reasoningTokens: event.usage.reasoningTokens ?? 0,
          costUSD: event.usage.costUSD ?? 0,
          durationMs: event.usage.durationMs ?? 0,
          numTurns: event.usage.numTurns ?? 0,
        },
        sessionId: event.sessionId,
      };
    case 'status':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.statusText,
        sessionId: event.sessionId,
      };
    case 'compaction_start':
      return {
        eventType: 'compact_boundary',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: 'compaction_start',
        detail: event.reason,
        sessionId: event.sessionId,
      };
    case 'compaction_end':
      return {
        eventType: 'compact_boundary',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.error ? 'compaction_error' : 'compaction_end',
        detail: event.error || event.reason,
        sessionId: event.sessionId,
      };
    case 'subagent':
      return {
        eventType: 'task_progress',
        agentScope: 'subagent',
        displayLevel: 'detail',
        taskId: event.agentId,
        taskStatus: event.lifecycle,
        taskSummary: event.result || event.error,
        rawEvent:
          event.details && typeof event.details === 'object'
            ? (event.details as Record<string, unknown>)
            : undefined,
        sessionId: event.sessionId,
      };
    case 'session':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'debug',
        statusText: `session:${event.sessionId}`,
        sessionId: event.sessionId,
      };
    case 'error':
      return {
        eventType: 'status',
        agentScope: 'system',
        displayLevel: 'detail',
        statusText: event.error,
        sessionId: event.sessionId,
      };
    case 'result':
      return undefined;
  }
}

function emitRuntimeEvent(
  event: RuntimeEvent,
  options: PiQueryRunOptions,
  resultState: { result?: RuntimeResult; fatalError?: string },
): void {
  if (event.type === 'result') {
    resultState.result = event.result;
    return;
  }
  if (event.type === 'error') {
    if (event.fatal) resultState.fatalError = event.error;
  }
  const streamEvent = toStreamEvent(event, options.containerInput);
  if (streamEvent) {
    options.emit({ status: 'stream', result: null, streamEvent });
  }
}

/**
 * Execute one Pi turn behind the existing ContainerOutput/IPC boundary.
 * The host-facing loop remains unchanged; this function is the compatibility
 * seam that lets Pi stream, queue, abort, persist and report a turn using the
 * runner's existing durable delivery semantics.
 */
export async function runPiQueryAttempt(
  options: PiQueryRunOptions,
): Promise<PiQueryRunResult> {
  const session = await options.runtime.createSession(options.sessionOptions);
  options.onSessionId(session.sessionId);
  const resultState: { result?: RuntimeResult; fatalError?: string } = {};
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  let cancelledIpcReceipts: IpcDeliveryReceipt[] = [];
  let completionPublished = false;
  let promptError: unknown;
  let prematureEnded = false;
  let prematureTerminal = false;

  const unsubscribe = session.subscribe((event) =>
    emitRuntimeEvent(event, options, resultState),
  );

  const publishResult = (result: RuntimeResult): void => {
    if (completionPublished) return;
    completionPublished = true;
    const receipts = options.tracker.completeNextTurn();
    const inputTurnCompleted = result.finalizationReason === 'completed';
    if (inputTurnCompleted) {
      // Task AI: a healthy turn clears the premature-end budget — the next
      // stream cut deserves a fresh auto-retry.
      prematureEndCounts.clear();
    }
    // The Pi runtime folds turn usage into RuntimeResult instead of streaming
    // it. Re-emit it as the same `usage` StreamEvent the Claude path produces
    // (and the host ledger consumes) BEFORE the terminal output, mirroring the
    // legacy runner's "ledger first, result second" ordering.
    if (result.usage) {
      const usage = result.usage;
      options.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'usage',
          agentScope: 'main',
          displayLevel: 'detail',
          usage: {
            ...(usage.eventId ? { eventId: usage.eventId } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
            cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
            reasoningTokens: usage.reasoningTokens ?? 0,
            costUSD: usage.costUSD ?? 0,
            durationMs: usage.durationMs ?? 0,
            numTurns: usage.numTurns ?? 0,
            ...(usage.modelUsage
              ? {
                  modelUsage: Object.fromEntries(
                    Object.entries(usage.modelUsage).map(([model, row]) => [
                      model,
                      {
                        inputTokens: row.inputTokens,
                        outputTokens: row.outputTokens,
                        cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
                        cacheCreationInputTokens:
                          row.cacheCreationInputTokens ?? 0,
                        reasoningTokens: row.reasoningTokens ?? 0,
                        costUSD: row.costUSD ?? 0,
                      },
                    ]),
                  ),
                }
              : {}),
          },
          sessionId: result.sessionId,
        },
      });
    }
    options.emit({
      status: inputTurnCompleted ? 'success' : 'error',
      result: result.text || null,
      newSessionId: result.sessionId,
      sourceKind: options.sourceKindOverride ?? 'sdk_final',
      finalizationReason: result.finalizationReason,
      inputTurnCompleted,
      queryIdle: !options.tracker.hasPendingTurns,
      ...(receipts.length > 0 ? { ipcReceipts: receipts } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    if (inputTurnCompleted) {
      options.onTurnCompleted();
      if (options.tracker.hasPendingTurns) {
        completionPublished = false;
        options.onTurnActivated(options.tracker.currentTurnMessages);
      }
    }
  };

  try {
    const promptPromise = session.prompt(
      toRuntimeInput(options.prompt, options.images),
    );
    let promptDone = false;
    promptPromise.then(
      () => {
        promptDone = true;
      },
      (error) => {
        promptDone = true;
        promptError = error;
      },
    );

    while (true) {
      if (options.shouldClose()) {
        closedDuringQuery = true;
        await session.abort().catch(() => undefined);
        break;
      }
      if (options.shouldInterrupt()) {
        interruptedDuringQuery = true;
        const cancelled = options.tracker.cancelCurrentTurn();
        cancelledIpcReceipts = cancelled
          .map((message) => message.receipt)
          .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
        await session.abort().catch(() => undefined);
        break;
      }

      if (options.acceptIpcMessagesDuringQuery) {
        const messages = options.drainInput();
        for (const message of messages) {
          options.tracker.acceptTurn([message]);
          await session.followUp(toRuntimeInput(message.text, message.images));
        }
      }

      if (resultState.result) {
        const result = resultState.result;
        resultState.result = undefined;
        publishResult(result);
      }
      if (resultState.fatalError) {
        throw new Error(resultState.fatalError);
      }
      // AgentSession.prompt() can reject before Pi emits an agent_end event
      // (for example, when credentials are missing). Surface that provider
      // error before the generic queue invariant below so the host can retry
      // or quarantine the provider with the actual cause.
      if (promptDone && promptError) {
        throw promptError;
      }
      if (promptDone && !options.tracker.hasPendingTurns) break;
      if (promptDone && !session.isStreaming && !resultState.result) {
        if (!options.tracker.hasPendingTurns) break;
        // Task AI: the stream ended before the pending turn(s) got a result
        // (2026-11-12 incident: provider cut mid-answer). This used to throw
        // and kill the whole runner; now it degrades — first premature end
        // returns for a requeue retry, a second consecutive one publishes a
        // terminal per-turn error WITH receipts so the host stops replaying.
        const key = prematureEndKey(
          options.tracker,
          options.containerInput.turnId,
        );
        const seen = prematureEndCounts.get(key) ?? 0;
        if (seen < PREMATURE_END_BUDGET) {
          bumpPrematureEnd(key);
          prematureEnded = true;
          options.log(
            `Pi session ended prematurely with ${options.tracker.unacknowledgedMessages.length} pending input turn(s) (key=${key}); returning for requeue retry`,
          );
          break;
        }
        prematureEndCounts.delete(key);
        prematureTerminal = true;
        const terminalReceipts = options.tracker.completeNextTurn();
        options.log(
          `Pi session ended prematurely again (key=${key}); publishing terminal per-turn error`,
        );
        options.emit({
          status: 'error',
          result: null,
          newSessionId: session.sessionId,
          sourceKind: options.sourceKindOverride ?? 'sdk_final',
          finalizationReason: 'error',
          inputTurnCompleted: false,
          queryIdle: !options.tracker.hasPendingTurns,
          ...(terminalReceipts.length > 0
            ? { ipcReceipts: terminalReceipts }
            : {}),
          error:
            'Pi session ended prematurely with pending input turns (retry budget exhausted); please resend the message.',
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await promptPromise.catch(() => undefined);
    if (promptError && !interruptedDuringQuery && !closedDuringQuery) {
      throw promptError;
    }
    if (!closedDuringQuery && !interruptedDuringQuery && resultState.result) {
      publishResult(resultState.result);
    }
    if (interruptedDuringQuery && !closedDuringQuery) {
      // 与旧 runner 对齐:宿主只在该终态上 markRunnerQueryIdle(放行排队
      // follow-up)并让 Web 收束「已停止」;缺失时队列卡死到 stuck-runner
      // 恢复天花板(~10 分钟)误杀健康 runner。
      options.emit({
        status: 'stream',
        result: null,
        streamEvent: {
          eventType: 'status',
          statusText: 'interrupted',
          queryRunId: options.containerInput.queryRunId,
          turnId: options.containerInput.turnId,
          sessionId: session.sessionId,
        },
        newSessionId: session.sessionId,
        queryIdle: !options.tracker.hasPendingTurns,
        ...(cancelledIpcReceipts.length > 0
          ? { ipcReceipts: cancelledIpcReceipts }
          : {}),
      });
    }
  } finally {
    unsubscribe();
    session.dispose();
  }

  return {
    newSessionId: session.sessionId,
    closedDuringQuery,
    interruptedDuringQuery,
    ...(cancelledIpcReceipts.length > 0 ? { cancelledIpcReceipts } : {}),
    pipedMessagesDuringQuery: options.tracker.unacknowledgedMessages,
    durableInputTurnCompleted: completionPublished && !interruptedDuringQuery,
    ...(prematureEnded ? { prematureEnd: true } : {}),
    ...(prematureTerminal ? { prematureTerminal: true } : {}),
  };
}
