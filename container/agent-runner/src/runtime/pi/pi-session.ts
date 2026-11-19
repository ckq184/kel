/**
 * Pi 运行时的会话适配层：把 `@earendil-works/pi-coding-agent` 的
 * AgentSession 事件流翻译为运行时无关的 RuntimeEvent 契约（../types.ts），
 * 供 pi-runner 上层消费。除 SDK 自身事件外，还经 PiSubAgentAdapter 挂接
 * 子代理生命周期事件（同一监听器集合分发）。
 *
 * 计量核心在 aggregatePiTurnUsage（见其头注释）：回合级 usage 聚合 +
 * 幂等 eventId，语义必须与宿主账本（usage-service / kaboo-pricing）对齐。
 */
import type {
  AgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeInput,
  RuntimeResult,
  RuntimeSession,
  RuntimeUsage,
} from '../types.js';
import { PiSubAgentAdapter } from './pi-subagents.js';

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('');
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * Aggregate one Pi agent turn's billable usage across every assistant message.
 *
 * Pi attaches a per-API-call usage snapshot to each assistant message, so a
 * tool-using turn spans several snapshots; the last message alone undercounts.
 * Semantics that must stay aligned with the host ledger (usage-service /
 * kaboo-pricing, see the Claude path in assistant-usage.ts):
 * - `reasoning` is a subset of Pi's `output` → carve it out so output and
 *   reasoning stay disjoint token classes.
 * - `cacheWrite1h` is a subset of `cacheWrite` (a retention split, not an
 *   increment) → never add it on top.
 * - model attribution prefers `responseModel` (the model that actually served).
 *
 * The event id seeds the host's `usage_events` idempotency key: session id +
 * the turn's first assistant timestamp survive runner restarts and session
 * replays, so a re-delivered turn deduplicates instead of double charging.
 */
export function aggregatePiTurnUsage(
  messages: ReadonlyArray<unknown>,
  sessionId?: string,
): RuntimeUsage | undefined {
  const modelUsage: NonNullable<RuntimeUsage['modelUsage']> = {};
  const root = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
  };
  let durationMs = 0;
  let numTurns = 0;
  let firstTimestamp: number | undefined;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if ((message as { role?: unknown }).role !== 'assistant') continue;
    const usage = (message as { usage?: Record<string, unknown> }).usage;
    if (!usage || typeof usage !== 'object') continue;

    const reasoning = nonNegative(usage.reasoning);
    const output = Math.max(0, nonNegative(usage.output) - reasoning);
    const input = nonNegative(usage.input);
    const cacheRead = nonNegative(usage.cacheRead);
    const cacheWrite = nonNegative(usage.cacheWrite);
    const cost = nonNegative(
      (usage.cost as { total?: unknown } | undefined)?.total,
    );
    const model =
      (
        (message as { responseModel?: unknown }).responseModel ||
        (message as { model?: unknown }).model ||
        ''
      )
        .toString()
        .trim() || 'unknown';

    const row = modelUsage[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
    };
    row.inputTokens += input;
    row.outputTokens += output;
    row.cacheReadInputTokens += cacheRead;
    row.cacheCreationInputTokens += cacheWrite;
    row.reasoningTokens += reasoning;
    row.costUSD += cost;
    modelUsage[model] = row;

    root.inputTokens += input;
    root.outputTokens += output;
    root.reasoningTokens += reasoning;
    root.cacheReadInputTokens += cacheRead;
    root.cacheCreationInputTokens += cacheWrite;
    root.costUSD += cost;
    durationMs += nonNegative((message as { durationMs?: unknown }).durationMs);
    numTurns += 1;
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === 'number' && firstTimestamp === undefined) {
      firstTimestamp = timestamp;
    }
  }

  if (numTurns === 0) return undefined;
  return {
    ...(sessionId !== undefined && firstTimestamp !== undefined
      ? { eventId: `pi:${sessionId}:${firstTimestamp}` }
      : {}),
    ...root,
    durationMs,
    numTurns,
    modelUsage,
  };
}

/** 单个 SDK 事件 → RuntimeEvent 的映射；未识别类型返回 undefined（静默丢弃）。 */
function mapPiEvent(
  event: AgentSessionEvent,
  sessionId: string,
): RuntimeEvent | undefined {
  switch (event.type) {
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') {
        return { type: 'text_delta', delta: update.delta, sessionId };
      }
      if (update.type === 'thinking_delta') {
        return { type: 'thinking_delta', delta: update.delta, sessionId };
      }
      if (update.type === 'toolcall_start') {
        const toolCall = update.partial.content.find(
          (item) => item.type === 'toolCall',
        );
        if (toolCall?.type === 'toolCall') {
          return {
            type: 'tool_start',
            sessionId,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: toolCall.arguments,
          };
        }
      }
      if (update.type === 'toolcall_end') {
        return {
          type: 'tool_end',
          sessionId,
          toolName: update.toolCall.name,
          toolCallId: update.toolCall.id,
          input: update.toolCall.arguments,
        };
      }
      return undefined;
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.args,
      };
    case 'tool_execution_update':
      return {
        type: 'tool_update',
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.args,
        result: event.partialResult,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      };
    case 'compaction_start':
      return { type: 'compaction_start', sessionId, reason: event.reason };
    case 'compaction_end':
      return {
        type: 'compaction_end',
        sessionId,
        reason: event.reason,
        error: event.errorMessage,
      };
    case 'queue_update':
      return {
        type: 'status',
        sessionId,
        statusText: `queued: ${event.steering.length} steer / ${event.followUp.length} follow-up`,
      };
    case 'agent_end': {
      const assistant = [...event.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
      if (!assistant) return undefined;
      const error =
        'errorMessage' in assistant ? assistant.errorMessage : undefined;
      const result: RuntimeResult = {
        text: textFromMessage(assistant),
        sessionId,
        finalizationReason:
          assistant.stopReason === 'aborted'
            ? 'interrupted'
            : assistant.stopReason === 'error'
              ? 'error'
              : 'completed',
        stopReason: assistant.stopReason,
        usage: aggregatePiTurnUsage(event.messages, sessionId),
        ...(error ? { error } : {}),
      };
      return { type: 'result', sessionId, result };
    }
    default:
      return undefined;
  }
}

/**
 * RuntimeSession 的 Pi 实现：订阅 SDK 事件并转发给监听器，提供
 * prompt/steer/followUp/abort/compact 五个操作。dispose 须先退订两个事件
 * 源（SDK + 子代理总线）再释放会话，防 disposed 后仍收到回调。
 */
export class PiRuntimeSession implements RuntimeSession {
  readonly kind = 'pi' as const;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly unsubscribeFromPi: () => void;
  private readonly unsubscribeFromSubagents: () => void;
  private disposed = false;

  constructor(
    private readonly session: AgentSession,
    eventBus?: ConstructorParameters<typeof PiSubAgentAdapter>[0],
  ) {
    this.unsubscribeFromPi = session.subscribe((event) => {
      const mapped = mapPiEvent(event, session.sessionId);
      if (mapped) this.emit(mapped);
    });
    this.unsubscribeFromSubagents = eventBus
      ? new PiSubAgentAdapter(eventBus).onLifecycle(
          session.sessionId,
          (event) => this.emit(event),
        )
      : () => {};
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(input: RuntimeInput): Promise<void> {
    await this.session.prompt(input.text, {
      images: input.images
        ?.filter((image) => !!image.mimeType)
        .map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType || 'image/jpeg',
        })),
    });
  }

  async steer(input: RuntimeInput): Promise<void> {
    await this.session.steer(input.text);
  }

  async followUp(input: RuntimeInput): Promise<void> {
    await this.session.followUp(input.text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async compact(instructions?: string): Promise<void> {
    await this.session.compact(instructions);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFromPi();
    this.unsubscribeFromSubagents();
    this.session.dispose();
    this.listeners.clear();
  }
}
