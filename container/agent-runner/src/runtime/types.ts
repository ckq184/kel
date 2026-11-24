/**
 * Runtime-neutral contracts used by the Agent Runner.
 *
 * The product protocol intentionally stays outside this module.  A runtime
 * adapter translates its native lifecycle into these events and the existing
 * runner remains responsible for ContainerOutput/StreamEvent correlation.
 */

export type RuntimeKind = 'claude' | 'pi';

export type RuntimeImage = {
  data: string;
  mimeType?: string;
};

export type RuntimeInput = {
  text: string;
  images?: RuntimeImage[];
};

export type RuntimeModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  costUSD: number;
};

export type RuntimeUsage = {
  /** Stable logical run id used by the host usage ledger for replay dedup. */
  eventId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  durationMs?: number;
  numTurns?: number;
  /** Per-model attribution; the root totals must stay the sum of all rows. */
  modelUsage?: Record<string, RuntimeModelUsage>;
};

export type RuntimeResult = {
  text: string;
  sessionId: string;
  finalizationReason: 'completed' | 'interrupted' | 'error';
  stopReason?: string;
  usage?: RuntimeUsage;
  error?: string;
};

export type RuntimeEvent =
  | {
      type: 'text_delta';
      delta: string;
      sessionId: string;
    }
  | {
      type: 'thinking_delta';
      delta: string;
      sessionId: string;
    }
  | {
      /** One assistant message began/finished. The host answer reducer splits
       *  narration vs final answer on these boundaries (ISSUE-02 P0-2). */
      type: 'message_boundary';
      boundary: 'start' | 'stop';
      sessionId: string;
    }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      sessionId: string;
      toolName: string;
      toolCallId?: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: 'status';
      sessionId: string;
      statusText: string;
    }
  | {
      type: 'compaction_start' | 'compaction_end';
      sessionId: string;
      reason?: string;
      error?: string;
    }
  | {
      type: 'subagent';
      sessionId: string;
      lifecycle:
        | 'created'
        | 'started'
        | 'completed'
        | 'failed'
        | 'steered'
        | 'compacted';
      agentId?: string;
      result?: string;
      error?: string;
      details?: unknown;
    }
  | {
      type: 'result';
      sessionId: string;
      result: RuntimeResult;
    };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export type RuntimeSessionOptions = {
  cwd: string;
  sessionDir: string;
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  thinkingLevel?:
    | 'off'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';
  allowedTools?: string[];
  excludedTools?: string[];
  /** Runtime-native custom tools. The Pi adapter accepts Pi ToolDefinitions. */
  customTools?: unknown[];
  /** Extra Agent Skills directories exposed through the runtime loader. */
  skillPaths?: string[];
  /** Extra extensions, including optional third-party adapters. */
  extensionPaths?: string[];
  /** Runtime-specific provider configuration. */
  provider?: {
    endpointKind?: 'official' | 'custom';
    baseUrl?: string;
    apiKey?: string;
    /**
     * Bearer-style token (`ANTHROPIC_AUTH_TOKEN`, ISSUE-04 ⑥). D-2 ②
     * (THESIS-04): official endpoints are retired, so the resolver always
     * folds this into the registered third-party api key.
     */
    authToken?: string;
    /**
     * Host-declared context-window override (ISSUE-04 ①). Written into the
     * registered third-party model definition; undefined keeps the 200k
     * registration default.
     */
    contextWindow?: number;
    /**
     * Extra request headers parsed from `ANTHROPIC_CUSTOM_HEADERS` (ISSUE-18).
     * Applied to custom endpoint registrations only.
     */
    headers?: Record<string, string>;
  };
  /**
   * Product auto-compact toggle (default true). Maps to the runtime-native
   * compaction switch. The historical percentage/window knobs were retired
   * from the UI with ISSUE-04 ⑤: Pi runs reserve-based compaction and owns
   * the threshold; only this explicit runtime-level disable stays expressible.
   */
  autoCompactEnabled?: boolean;
};

export interface RuntimeSession {
  readonly kind: RuntimeKind;
  readonly sessionId: string;
  readonly isStreaming: boolean;
  prompt(input: RuntimeInput): Promise<void>;
  steer(input: RuntimeInput): Promise<void>;
  followUp(input: RuntimeInput): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  dispose(): void;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
}
