import { describe, expect, test } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import type {
  RuntimeEvent,
  RuntimeResult,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
import {
  PiRuntimeSession,
  aggregatePiTurnUsage,
} from '../container/agent-runner/src/runtime/pi/pi-session.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';

/** Minimal Pi AssistantMessage fixture (pi-ai shape, only accounting-relevant fields). */
function piAssistantMessage(overrides: {
  model: string;
  responseModel?: string;
  timestamp: number;
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    costTotal?: number;
  };
  durationMs?: number;
}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: overrides.model,
    ...(overrides.responseModel
      ? { responseModel: overrides.responseModel }
      : {}),
    usage: {
      input: overrides.usage.input,
      output: overrides.usage.output,
      cacheRead: overrides.usage.cacheRead ?? 0,
      cacheWrite: overrides.usage.cacheWrite ?? 0,
      ...(overrides.usage.cacheWrite1h
        ? { cacheWrite1h: overrides.usage.cacheWrite1h }
        : {}),
      ...(overrides.usage.reasoning !== undefined
        ? { reasoning: overrides.usage.reasoning }
        : {}),
      totalTokens:
        overrides.usage.input +
        overrides.usage.output +
        (overrides.usage.cacheRead ?? 0) +
        (overrides.usage.cacheWrite ?? 0),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: overrides.usage.costTotal ?? 0,
      },
    },
    stopReason: 'stop',
    timestamp: overrides.timestamp,
    ...(overrides.durationMs !== undefined
      ? { durationMs: overrides.durationMs }
      : {}),
  };
}

const toolResultMessage = {
  role: 'toolResult',
  toolCallId: 'call-1',
  content: [],
  usage: {
    input: 999,
    output: 999,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1998,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
  },
  timestamp: 1500,
};

const userMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  timestamp: 900,
};

describe('Pi turn usage aggregation (aggregatePiTurnUsage)', () => {
  test('sums every assistant message of the turn and buckets by served model', () => {
    const usage = aggregatePiTurnUsage(
      [
        userMessage,
        piAssistantMessage({
          model: 'alias-sonnet',
          responseModel: 'claude-sonnet-4-20250514',
          timestamp: 1000,
          durationMs: 1200,
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            reasoning: 20,
            costTotal: 0.01,
          },
        }),
        toolResultMessage,
        piAssistantMessage({
          model: 'claude-sonnet-4-20250514',
          timestamp: 2000,
          durationMs: 800,
          usage: { input: 200, output: 30, reasoning: 10 },
        }),
        piAssistantMessage({
          model: 'claude-haiku-4',
          timestamp: 3000,
          usage: { input: 10, output: 5, costTotal: 0.001 },
        }),
      ],
      'sess-1',
    );

    expect(usage).toBeDefined();
    expect(usage).toMatchObject({
      eventId: 'pi:sess-1:1000',
      inputTokens: 310,
      // reasoning is a subset of Pi's output; the host ledger keeps the two
      // classes disjoint, so it must be carved out of output.
      outputTokens: 50 - 20 + (30 - 10) + 5,
      reasoningTokens: 30,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      costUSD: 0.011,
      durationMs: 2000,
      numTurns: 3,
    });
    expect(Object.keys(usage!.modelUsage ?? {}).sort()).toEqual([
      'claude-haiku-4',
      'claude-sonnet-4-20250514',
    ]);
    expect(usage!.modelUsage).toMatchObject({
      'claude-sonnet-4-20250514': {
        inputTokens: 300,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        reasoningTokens: 30,
        costUSD: 0.01,
      },
      'claude-haiku-4': {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        costUSD: 0.001,
      },
    });
  });

  test('keeps cacheWrite1h as a subset of cacheWrite instead of double counting', () => {
    const usage = aggregatePiTurnUsage(
      [
        piAssistantMessage({
          model: 'm',
          timestamp: 1000,
          usage: { input: 1, output: 1, cacheWrite: 8, cacheWrite1h: 3 },
        }),
      ],
      'sess-1',
    );
    expect(usage).toMatchObject({ cacheCreationInputTokens: 8 });
  });

  test('clamps the reasoning carve-out so output never goes negative', () => {
    const usage = aggregatePiTurnUsage(
      [
        piAssistantMessage({
          model: 'm',
          timestamp: 1000,
          usage: { input: 1, output: 4, reasoning: 9 },
        }),
      ],
      'sess-1',
    );
    expect(usage).toMatchObject({ outputTokens: 0, reasoningTokens: 9 });
  });

  test('falls back to the requested model name and unknown when attribution is missing', () => {
    const usage = aggregatePiTurnUsage(
      [
        piAssistantMessage({
          model: '',
          timestamp: 1000,
          usage: { input: 2, output: 1 },
        }),
      ],
      'sess-1',
    );
    expect(Object.keys(usage!.modelUsage ?? {})).toEqual(['unknown']);
  });

  test('returns undefined for turns without any billable assistant usage', () => {
    expect(
      aggregatePiTurnUsage([userMessage, toolResultMessage], 'sess-1'),
    ).toBeUndefined();
    expect(aggregatePiTurnUsage([], 'sess-1')).toBeUndefined();
  });
});

describe('Pi session mapping (PiRuntimeSession agent_end)', () => {
  function fakeAgentSession(sessionId: string) {
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    return {
      sessionId,
      isStreaming: false,
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit(event: AgentSessionEvent) {
        for (const listener of listeners) listener(event);
      },
      async prompt() {},
      async steer() {},
      async followUp() {},
      async abort() {},
      async compact() {},
      dispose() {},
    };
  }

  test('maps agent_end to a result carrying the whole-turn aggregated usage', () => {
    const agentSession = fakeAgentSession('sess-map');
    const piSession = new PiRuntimeSession(agentSession as never);
    const events: RuntimeEvent[] = [];
    piSession.subscribe((event) => events.push(event));

    agentSession.emit({
      type: 'agent_end',
      willRetry: false,
      messages: [
        piAssistantMessage({
          model: 'm-a',
          timestamp: 1000,
          usage: { input: 10, output: 6, reasoning: 2 },
        }),
        piAssistantMessage({
          model: 'm-b',
          timestamp: 2000,
          usage: { input: 5, output: 3 },
        }),
      ],
    } as never);

    const result = events.find((event) => event.type === 'result');
    expect(result).toBeDefined();
    expect((result as { result: RuntimeResult }).result.usage).toMatchObject({
      eventId: 'pi:sess-map:1000',
      inputTokens: 15,
      outputTokens: 7,
      reasoningTokens: 2,
      numTurns: 2,
    });
  });
});

describe('Pi runner usage stream emission (runPiQueryAttempt)', () => {
  const turnUsage = {
    eventId: 'pi:pi-session-1:1000',
    inputTokens: 100,
    outputTokens: 30,
    reasoningTokens: 20,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 5,
    costUSD: 0.01,
    durationMs: 1200,
    numTurns: 1,
    modelUsage: {
      'claude-sonnet-4-20250514': {
        inputTokens: 100,
        outputTokens: 30,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        reasoningTokens: 20,
        costUSD: 0.01,
      },
    },
  };

  function fakeRuntimeSession(
    sessionId: string,
    usage?: RuntimeResult['usage'],
  ) {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    return {
      session: {
        kind: 'pi' as const,
        sessionId,
        isStreaming: false,
        subscribe(listener: (event: RuntimeEvent) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          for (const listener of listeners) {
            listener({
              type: 'text_delta',
              delta: 'hello',
              sessionId,
            });
            listener({
              type: 'result',
              sessionId,
              result: {
                text: 'hello',
                sessionId,
                finalizationReason: 'completed',
                stopReason: 'stop',
                ...(usage ? { usage } : {}),
              },
            });
          }
        },
        async steer() {},
        async followUp() {},
        async abort() {},
        async compact() {},
        dispose() {},
      } satisfies RuntimeSession,
    };
  }

  async function runTurn(
    usage?: RuntimeResult['usage'],
  ): Promise<ContainerOutput[]> {
    const outputs: ContainerOutput[] = [];
    const { session } = fakeRuntimeSession('pi-session-1', usage);
    await runPiQueryAttempt({
      runtime: { createSession: async () => session } as never,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: 'say hello',
      containerInput: {
        prompt: 'say hello',
        groupFolder: 'test',
        chatJid: 'test:chat',
      },
      tracker: new IpcTurnDeliveryTracker(),
      emit: (output) => outputs.push(output),
      log: () => {},
      drainInput: () => [],
      shouldClose: () => false,
      shouldInterrupt: () => false,
      acceptIpcMessagesDuringQuery: false,
      onSessionId: () => {},
      onTurnActivated: () => {},
      onTurnCompleted: () => {},
    });
    return outputs;
  }

  test('emits the usage stream event before the terminal result', async () => {
    const outputs = await runTurn(turnUsage);
    const usageIndex = outputs.findIndex(
      (output) => output.streamEvent?.eventType === 'usage',
    );
    const successIndex = outputs.findIndex(
      (output) => output.status === 'success',
    );

    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(successIndex).toBeGreaterThan(usageIndex);
    expect(outputs[usageIndex].streamEvent?.usage).toEqual(turnUsage);
  });

  test('does not emit a usage event when the result carries no usage', async () => {
    const outputs = await runTurn(undefined);
    expect(
      outputs.some((output) => output.streamEvent?.eventType === 'usage'),
    ).toBe(false);
    expect(outputs.at(-1)).toMatchObject({ status: 'success' });
  });

  test('replays of the same turn keep one stable eventId for host dedup', async () => {
    const first = await runTurn(turnUsage);
    const second = await runTurn(turnUsage);
    const eventId = (output: ContainerOutput) =>
      output.streamEvent?.eventType === 'usage'
        ? output.streamEvent.usage?.eventId
        : undefined;
    expect(first.map(eventId).filter(Boolean)).toEqual([
      'pi:pi-session-1:1000',
    ]);
    expect(second.map(eventId).filter(Boolean)).toEqual([
      'pi:pi-session-1:1000',
    ]);
  });
});
