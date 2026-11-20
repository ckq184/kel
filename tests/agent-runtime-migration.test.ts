import { describe, expect, it, vi } from 'vitest';
import { resolveAgentRuntimeKind } from '../container/agent-runner/src/runtime-config.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { PiSubAgentAdapter } from '../container/agent-runner/src/runtime/pi/pi-subagents.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import {
  IpcTurnDeliveryTracker,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';
import { z } from 'zod';

describe('agent runtime migration contracts', () => {
  it('selects Pi by default and rejects unknown runtime selectors', () => {
    expect(resolveAgentRuntimeKind({})).toBe('pi');
    expect(resolveAgentRuntimeKind({ AGENT_RUNTIME: 'pi' })).toBe('pi');
    expect(resolveAgentRuntimeKind({ CKQCLAW_AGENT_RUNTIME: 'pi' })).toBe('pi');
    expect(() => resolveAgentRuntimeKind({ AGENT_RUNTIME: 'other' })).toThrow(
      'expected pi',
    );
  });

  it('namespaces Claude MCP tools for Pi without changing their handlers', async () => {
    const handler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'delivered' }],
      ok: true,
    });
    const [tool] = adaptClaudeMcpToolsToPi(
      [
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { text: z.string() },
          handler,
        } as any,
      ],
      { namespace: 'mcp__ckqclaw' },
    );

    expect(tool.name).toBe('mcp__ckqclaw__send_message');
    const result = await tool.execute(
      'tool-call-1',
      { text: 'hello' },
      undefined,
      undefined,
      {} as any,
    );
    expect(handler).toHaveBeenCalledWith(
      { text: 'hello' },
      expect.objectContaining({ toolCallId: 'tool-call-1' }),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
  });

  it('uses pi-subagents documented spawn/stop RPC and does not fake result RPC', async () => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const eventBus = {
      on(channel: string, listener: (value: unknown) => void) {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
      emit(channel: string, value: any) {
        if (channel === 'subagents:rpc:spawn') {
          for (const listener of listeners.get(
            `${channel}:reply:${value.requestId}`,
          ) ?? []) {
            listener({ success: true, data: { id: 'agent-1' } });
          }
        }
        if (channel === 'subagents:rpc:stop') {
          for (const listener of listeners.get(
            `${channel}:reply:${value.requestId}`,
          ) ?? []) {
            listener({ success: true });
          }
        }
      },
    };
    const adapter = new PiSubAgentAdapter(eventBus as any);

    await expect(
      adapter.spawn({ type: 'worker', prompt: 'do it', description: 'test' }),
    ).resolves.toMatchObject({ id: 'agent-1', status: 'running' });
    await expect(adapter.stop('agent-1')).resolves.toBeUndefined();
    await expect(adapter.getResult('agent-1')).rejects.toThrow(
      'does not publish a result RPC',
    );
  });

  it('bridges a Pi turn into the existing ContainerOutput stream', async () => {
    const listeners = new Set<(event: any) => void>();
    let disposed = false;
    const session = {
      kind: 'pi' as const,
      sessionId: 'pi-session-1',
      isStreaming: false,
      subscribe(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: 'text_delta',
            delta: 'hello',
            sessionId: 'pi-session-1',
          });
          listener({
            type: 'result',
            sessionId: 'pi-session-1',
            result: {
              text: 'hello',
              sessionId: 'pi-session-1',
              finalizationReason: 'completed',
              stopReason: 'stop',
              usage: { inputTokens: 3, outputTokens: 2 },
            },
          });
        }
      },
      async steer() {},
      async followUp() {},
      async abort() {},
      async compact() {},
      dispose() {
        disposed = true;
      },
    };
    const outputs: any[] = [];
    const result = await runPiQueryAttempt({
      runtime: { createSession: async () => session } as any,
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

    expect(outputs.some((output) => output.streamEvent?.text === 'hello')).toBe(
      true,
    );
    expect(outputs.at(-1)).toMatchObject({
      status: 'success',
      result: 'hello',
      newSessionId: 'pi-session-1',
      inputTurnCompleted: true,
    });
    expect(result.newSessionId).toBe('pi-session-1');
    expect(disposed).toBe(true);
  });

  it('emits an interrupted terminal status so the host can release the query queue', async () => {
    const listeners = new Set<(event: any) => void>();
    let resolvePrompt: (() => void) | null = null;
    const session = {
      kind: 'pi' as const,
      sessionId: 'pi-session-1',
      isStreaming: true,
      subscribe(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: 'text_delta',
            delta: 'partial',
            sessionId: 'pi-session-1',
          });
        }
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      async steer() {},
      async followUp() {},
      async abort() {
        resolvePrompt?.();
      },
      async compact() {},
      dispose() {},
    };
    const outputs: any[] = [];
    const result = await runPiQueryAttempt({
      runtime: { createSession: async () => session } as any,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: 'long running',
      containerInput: {
        prompt: 'long running',
        groupFolder: 'test',
        chatJid: 'test:chat',
        queryRunId: 'run-1',
        turnId: 'turn-1',
      },
      tracker: new IpcTurnDeliveryTracker(),
      emit: (output) => outputs.push(output),
      log: () => {},
      drainInput: () => [],
      shouldClose: () => false,
      shouldInterrupt: () => true,
      acceptIpcMessagesDuringQuery: false,
      onSessionId: () => {},
      onTurnActivated: () => {},
      onTurnCompleted: () => {},
    });

    expect(result.interruptedDuringQuery).toBe(true);
    const interrupted = outputs.find(
      (output) =>
        output.streamEvent?.eventType === 'status' &&
        output.streamEvent?.statusText === 'interrupted',
    );
    // The host releases the query (markRunnerQueryIdle → queued follow-ups
    // dispatch) and the Web finalizes the interrupted card only when this
    // terminal status reaches it; without it the queue wedges until the
    // stuck-runner recovery ceiling restarts a healthy runner.
    expect(interrupted).toBeDefined();
    expect(interrupted).toMatchObject({
      status: 'stream',
      result: null,
      newSessionId: 'pi-session-1',
      queryIdle: true,
    });
    expect(interrupted.streamEvent).toMatchObject({
      queryRunId: 'run-1',
      turnId: 'turn-1',
      sessionId: 'pi-session-1',
    });
  });
});

// ── Task AI: premature stream end must not kill the runner ──────────────────
//
// 2026-11-12 production incident: the provider cut the stream without a result
// event while an IPC turn was pending; the queue invariant at pi-runner.ts
// threw and main() turned that into process exit(1), abandoning a healthy
// 12-minute session. The contract now: first premature end degrades to a
// graceful return (pending carried → main's requeue path retries), a second
// consecutive one publishes a terminal per-turn error WITH receipts (stops the
// host replay storm), and any completed turn resets the budget.

describe('premature stream end recovery (task AI)', () => {
  const CURSOR = { timestamp: '2026-11-12T01:52:11.816Z', id: 'msg-8' };

  function seededMessage(deliveryId: string): IpcInputMessage {
    return {
      text: '总结这个表格',
      receipt: {
        deliveryId,
        chatJid: 'test:chat',
        coveredCursors: [CURSOR],
        cursor: CURSOR,
      },
    };
  }

  /** Session whose prompt resolves while a pending turn is left unconsumed. */
  function prematureSession(sessionId: string) {
    const listeners = new Set<(event: any) => void>();
    return {
      session: {
        kind: 'pi' as const,
        sessionId,
        isStreaming: false,
        subscribe(listener: (event: any) => void) {
          listeners.add(listener);
          // One delta, then the stream just stops — no result event.
          listener({
            type: 'text_delta',
            delta: 'partial',
            sessionId,
          });
          return () => listeners.delete(listener);
        },
        async prompt() {},
        async followUp() {},
        async abort() {},
        async compact() {},
        dispose() {},
      } as any,
      listeners,
    };
  }

  async function runAttempt(
    session: any,
    message: IpcInputMessage,
    outputs: any[],
  ) {
    return runPiQueryAttempt({
      runtime: { createSession: async () => session } as any,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: '把接龙整理成表格',
      containerInput: {
        prompt: '把接龙整理成表格',
        groupFolder: 'test',
        chatJid: 'test:chat',
        queryRunId: 'run-1',
        turnId: 'turn-1',
      },
      tracker: new IpcTurnDeliveryTracker([message]),
      emit: (output) => outputs.push(output),
      log: () => {},
      drainInput: () => [],
      shouldClose: () => false,
      shouldInterrupt: () => false,
      acceptIpcMessagesDuringQuery: true,
      onSessionId: () => {},
      onTurnActivated: () => {},
      onTurnCompleted: () => {},
    });
  }

  it('first premature end returns prematureEnd (no throw) with the pending turn carried for requeue', async () => {
    const { session } = prematureSession('pi-prem-1');
    const outputs: any[] = [];
    const message = seededMessage('d-ai-first');
    const result = await runAttempt(session, message, outputs);
    // The old behavior threw here (process exit); now it degrades.
    expect(result.prematureEnd).toBe(true);
    expect(result.pipedMessagesDuringQuery).toEqual([message]);
    // No terminal error yet — the retry is still in flight.
    expect(outputs.filter((output) => output.status === 'error')).toHaveLength(
      0,
    );
  });

  it('second consecutive premature end publishes a terminal per-turn error with receipts', async () => {
    const outputs: any[] = [];
    // Attempt 1: budget spent on the retry.
    const first = await runAttempt(
      prematureSession('pi-prem-2a').session,
      seededMessage('d-ai-second'),
      outputs,
    );
    expect(first.prematureEnd).toBe(true);
    // Attempt 2 (same delivery id): terminal, receipts acknowledged.
    const second = await runAttempt(
      prematureSession('pi-prem-2b').session,
      seededMessage('d-ai-second'),
      outputs,
    );
    expect(second.prematureTerminal).toBe(true);
    // Acked → nothing left to requeue.
    expect(second.pipedMessagesDuringQuery).toEqual([]);
    const terminal = outputs.find((output) => output.status === 'error');
    expect(terminal).toMatchObject({
      status: 'error',
      inputTurnCompleted: false,
      newSessionId: 'pi-prem-2b',
    });
    expect(terminal.ipcReceipts).toHaveLength(1);
    expect(terminal.ipcReceipts[0]).toMatchObject({
      deliveryId: 'd-ai-second',
    });
    expect(typeof terminal.error).toBe('string');
  });

  it('a completed turn resets the budget, so a later premature end retries again', async () => {
    const listeners = new Set<(event: any) => void>();
    const healthySession = {
      kind: 'pi' as const,
      sessionId: 'pi-prem-3-ok',
      isStreaming: true,
      subscribe(listener: (event: any) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt() {
        for (const listener of listeners) {
          listener({
            type: 'result',
            sessionId: 'pi-prem-3-ok',
            result: {
              text: 'done',
              sessionId: 'pi-prem-3-ok',
              finalizationReason: 'completed',
              stopReason: 'stop',
            },
          });
        }
      },
      async followUp() {},
      async abort() {},
      async compact() {},
      dispose() {},
    } as any;

    const outputs: any[] = [];
    // 1) Premature end spends the budget for this delivery id.
    await runAttempt(
      prematureSession('pi-prem-3a').session,
      seededMessage('d-ai-reset'),
      outputs,
    );
    // 2) A healthy turn completes → budget resets.
    await runPiQueryAttempt({
      runtime: { createSession: async () => healthySession } as any,
      sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
      prompt: 'fine',
      containerInput: {
        prompt: 'fine',
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
    // 3) The same delivery id premature-ends again → retry again, not terminal.
    const third = await runAttempt(
      prematureSession('pi-prem-3b').session,
      seededMessage('d-ai-reset'),
      outputs,
    );
    expect(third.prematureEnd).toBe(true);
    expect(third.prematureTerminal).toBeUndefined();
    expect(outputs.filter((output) => output.status === 'error')).toHaveLength(
      0,
    );
  });
});
