import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import type {
  ContainerInput,
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import { PiRuntimeSession } from '../container/agent-runner/src/runtime/pi/pi-session.js';
import type {
  AgentRuntime,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import { stampStreamEventIdentity } from '../container/agent-runner/src/stream-stamp.js';
import { RunStreamFence } from '../src/run-stream-fence.js';
import { TurnOutputCoordinator } from '../src/turn-output-coordinator.js';

/**
 * ISSUE-02 contract tests: Pi stream identity stamping (P0-1) and assistant
 * message boundaries (P0-2). Every scenario drives the real production chain —
 * fake AgentSession emits native Pi AgentSessionEvents → PiRuntimeSession
 * (real mapping) → runPiQueryAttempt (real toStreamEvent + emit) — and stamps
 * exactly the way pi-index's emit wrapper does. No hand-crafted raw_sdk_event
 * fixtures: the boundary events must be *produced* by the mapping under test.
 */

type EmitListener = (event: AgentSessionEvent) => void;

function assistantMessageFixture(text: string, stopReason = 'stop') {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
  };
}

function assistantBoundary(kind: 'start' | 'stop'): AgentSessionEvent {
  return {
    type: kind === 'start' ? 'message_start' : 'message_end',
    message: { role: 'assistant', content: [] },
  } as never;
}

function nonAssistantBoundary(
  role: 'user' | 'toolResult',
  kind: 'start' | 'stop',
): AgentSessionEvent {
  return {
    type: kind === 'start' ? 'message_start' : 'message_end',
    message: { role, content: [] },
  } as never;
}

function thinkingDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [] },
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 0,
      delta,
      partial: { role: 'assistant', content: [] },
    },
  } as never;
}

function textDelta(delta: string): AgentSessionEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [] },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta,
      partial: { role: 'assistant', content: [] },
    },
  } as never;
}

function toolcallStart(): AgentSessionEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [] },
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 0,
      partial: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc-1',
            name: 'read',
            arguments: { path: 'a.txt' },
          },
        ],
      },
    },
  } as never;
}

function toolExecution(kind: 'start' | 'end'): AgentSessionEvent {
  return kind === 'start'
    ? ({
        type: 'tool_execution_start',
        toolCallId: 'tc-1',
        toolName: 'read',
        args: { path: 'a.txt' },
      } as never)
    : ({
        type: 'tool_execution_end',
        toolCallId: 'tc-1',
        toolName: 'read',
        result: 'ok',
        isError: false,
      } as never);
}

function agentEnd(finalText: string): AgentSessionEvent {
  return {
    type: 'agent_end',
    willRetry: false,
    messages: [assistantMessageFixture(finalText)],
  } as never;
}

function scriptedAgentSession(sessionId: string, events: AgentSessionEvent[]) {
  const listeners = new Set<EmitListener>();
  return {
    sessionId,
    isStreaming: false,
    subscribe(listener: EmitListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    async compact() {},
    dispose() {},
  };
}

function hangingAgentSession(
  sessionId: string,
  events: AgentSessionEvent[],
  onScriptDone: () => void,
) {
  const listeners = new Set<EmitListener>();
  let streaming = true;
  let releaseHang: (() => void) | undefined;
  return {
    sessionId,
    get isStreaming() {
      return streaming;
    },
    subscribe(listener: EmitListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const event of events) {
        for (const listener of listeners) listener(event);
      }
      onScriptDone();
      await new Promise<void>((resolve) => {
        releaseHang = resolve;
      });
    },
    async steer() {},
    async followUp() {},
    async abort() {
      streaming = false;
      releaseHang?.();
    },
    async compact() {},
    dispose() {},
  };
}

interface RunTurnOptions {
  session: RuntimeSession;
  stamp?: { turnId?: string; queryRunId?: string };
  containerInput?: Partial<ContainerInput>;
  shouldInterrupt?: () => boolean;
}

async function runTurnWith(options: RunTurnOptions): Promise<{
  outputs: ContainerOutput[];
  streamEvents: StreamEvent[];
}> {
  const outputs: ContainerOutput[] = [];
  await runPiQueryAttempt({
    runtime: { createSession: async () => options.session } as AgentRuntime,
    sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
    prompt: 'user message',
    containerInput: {
      prompt: 'user message',
      groupFolder: 'test',
      chatJid: 'test:chat',
      turnId: 'turn-initial',
      queryRunId: 'run-b',
      ...options.containerInput,
    },
    tracker: new IpcTurnDeliveryTracker(),
    emit: (output) => {
      if (output.streamEvent && options.stamp) {
        output = {
          ...output,
          streamEvent: stampStreamEventIdentity(
            output.streamEvent,
            options.stamp,
          ),
        };
      }
      outputs.push(output);
    },
    log: () => {},
    drainInput: () => [],
    shouldClose: () => false,
    shouldInterrupt: options.shouldInterrupt ?? (() => false),
    acceptIpcMessagesDuringQuery: false,
    onSessionId: () => {},
    onTurnActivated: () => {},
    onTurnCompleted: () => {},
  });
  return {
    outputs,
    streamEvents: outputs.flatMap((output) =>
      output.streamEvent ? [output.streamEvent] : [],
    ),
  };
}

/** Narration → top-level tool → tool result → new message → final answer. */
function fullToolTurnEvents(): AgentSessionEvent[] {
  return [
    assistantBoundary('start'),
    thinkingDelta('思考中'),
    textDelta('我先查一下这个文件。'),
    toolcallStart(),
    assistantBoundary('stop'),
    toolExecution('start'),
    toolExecution('end'),
    assistantBoundary('start'),
    textDelta('# 结论\n'),
    textDelta('最终报告'),
    assistantBoundary('stop'),
    agentEnd('# 结论\n最终报告'),
  ];
}

describe('stampStreamEventIdentity (P0-1 stamping primitive)', () => {
  test('fills both missing identity fields', () => {
    const stamped = stampStreamEventIdentity(
      { eventType: 'text_delta', text: 'hi' } as StreamEvent,
      { turnId: 'turn-current', queryRunId: 'run-b' },
    );
    expect(stamped).toEqual({
      eventType: 'text_delta',
      text: 'hi',
      turnId: 'turn-current',
      queryRunId: 'run-b',
    });
  });

  test('preserves values the event already carries (interrupted semantics)', () => {
    const own = {
      eventType: 'status',
      statusText: 'interrupted',
      turnId: 'turn-initial',
      queryRunId: 'run-a',
    } as StreamEvent;
    expect(
      stampStreamEventIdentity(own, {
        turnId: 'turn-current',
        queryRunId: 'run-b',
      }),
    ).toBe(own);
  });

  test('fills only the missing half and adds no extra keys', () => {
    const stamped = stampStreamEventIdentity(
      { eventType: 'usage', turnId: 'own-turn' } as StreamEvent,
      { turnId: 'turn-current', queryRunId: 'run-b' },
    );
    expect(stamped).toEqual({
      eventType: 'usage',
      turnId: 'own-turn',
      queryRunId: 'run-b',
    });
  });

  test('returns the same object when the stamp carries no values', () => {
    const event = { eventType: 'usage' } as StreamEvent;
    expect(stampStreamEventIdentity(event, {})).toBe(event);
    expect(stampStreamEventIdentity(event, { turnId: undefined })).toBe(event);
  });
});

describe('Pi runner stream identity stamping (P0-1)', () => {
  test('every stream event of a full tool turn carries turnId and queryRunId', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-1', fullToolTurnEvents()) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
    });

    expect(run.streamEvents.length).toBeGreaterThan(0);
    for (const event of run.streamEvents) {
      expect(event.turnId).toBe('turn-current');
      expect(event.queryRunId).toBe('run-b');
    }
    expect(
      run.outputs.at(-1)?.status === 'success' &&
        run.outputs.at(-1)?.result === '# 结论\n最终报告',
    ).toBe(true);
  });

  test('stamped events pass the run fence while their run is active; late events from a superseded run stay rejected', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-2', fullToolTurnEvents()) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
    });

    const fence = new RunStreamFence();
    const jid = 'web:alpha';
    fence.start(jid, 'run-b');
    for (const event of run.streamEvents) {
      const decision = event.queryRunId
        ? fence.observeExact(jid, event.queryRunId, event.turnId)
        : fence.observe(jid, event.turnId);
      expect(decision.accepted).toBe(true);
    }

    // A→B replacement: run A's late events keep A's queryRunId and must be
    // rejected — the fail-closed semantics of the fence are not relaxed.
    fence.finish(jid, 'run-b');
    fence.start(jid, 'run-c');
    const lateFromA = run.streamEvents[0];
    expect(lateFromA.queryRunId).toBe('run-b');
    expect(
      fence.observeExact(jid, lateFromA.queryRunId!, lateFromA.turnId).accepted,
    ).toBe(false);
    // Unstamped legacy events still fail closed while an exact run is active.
    expect(fence.observe(jid, undefined).accepted).toBe(false);
  });

  test('interrupt mid-message keeps the runner-owned identity on the interrupted event', async () => {
    const interrupt = { requested: false };
    const events = [
      assistantBoundary('start'),
      thinkingDelta('思考中'),
      textDelta('部分回答'),
    ];
    const session = new PiRuntimeSession(
      hangingAgentSession('pi-sess-3', events, () => {
        interrupt.requested = true;
      }) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
      shouldInterrupt: () => interrupt.requested,
    });

    // Deltas emitted before the interrupt are stamped like any other event.
    const deltas = run.streamEvents.filter(
      (event) => event.eventType === 'text_delta',
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0].turnId).toBe('turn-current');
    expect(deltas[0].queryRunId).toBe('run-b');

    // The interrupted terminal event keeps the identity the runner itself
    // attached (containerInput turn/query), not the wrapper stamp.
    const interrupted = run.outputs.find(
      (output) => output.streamEvent?.statusText === 'interrupted',
    );
    expect(interrupted?.streamEvent).toMatchObject({
      eventType: 'status',
      statusText: 'interrupted',
      queryRunId: 'run-b',
      turnId: 'turn-initial',
    });
  });
});

describe('Pi assistant message boundaries (P0-2, contract-equivalent raw_sdk_event)', () => {
  test('assistant message_start/end map to the legacy raw_sdk_event shape field by field', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-4', fullToolTurnEvents()) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
    });

    const boundaries = run.streamEvents.filter(
      (event) => event.eventType === 'raw_sdk_event',
    );
    expect(boundaries.map((event) => event.rawType)).toEqual([
      'stream_event/message_start',
      'stream_event/message_stop',
      'stream_event/message_start',
      'stream_event/message_stop',
    ]);
    expect(boundaries[0]).toMatchObject({
      agentScope: 'main',
      title: 'Assistant message started',
      parentToolUseId: null,
      displayLevel: 'debug',
      sessionId: 'pi-sess-4',
    });
    expect(boundaries[1]).toMatchObject({
      title: 'Assistant message completed',
      parentToolUseId: null,
      displayLevel: 'debug',
    });
  });

  test('user and toolResult message boundaries produce no stream events', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-5', [
        nonAssistantBoundary('user', 'start'),
        nonAssistantBoundary('user', 'stop'),
        nonAssistantBoundary('toolResult', 'start'),
        nonAssistantBoundary('toolResult', 'stop'),
      ]) as never,
    );
    const run = await runTurnWith({ session });
    expect(run.streamEvents).toEqual([]);
  });

  test('the card body keeps writing after a top-level tool call (host reducer over the real Pi chain)', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-6', fullToolTurnEvents()) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
    });

    const coordinator = new TurnOutputCoordinator();
    const visibleAt: string[] = [];
    for (const event of run.streamEvents) {
      const projection = coordinator.reduceStreamEvent(event);
      visibleAt.push(projection.visibleAnswerText);
    }

    const byRawType = (rawType: string) =>
      run.streamEvents.findIndex(
        (event) =>
          event.eventType === 'raw_sdk_event' && event.rawType === rawType,
      );

    // Pre-tool narration is provisionally visible, then rolls back.
    expect(visibleAt[byRawType('stream_event/message_start')]).toBe('');
    expect(
      visibleAt[
        run.streamEvents.findIndex(
          (event) => event.eventType === 'tool_use_start',
        )
      ],
    ).toBe('');
    // message_stop commits the narration discard and reopens on the next start.
    expect(coordinator.lastNarration).toBe('我先查一下这个文件。');
    // The final answer message resumes writing on the live card.
    const messageStartIndices = run.streamEvents
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.eventType === 'raw_sdk_event' &&
          event.rawType === 'stream_event/message_start',
      )
      .map(({ index }) => index);
    const secondStart = messageStartIndices[1];
    expect(visibleAt[secondStart + 1]).toBe('# 结论\n');
    expect(visibleAt[secondStart + 2]).toBe('# 结论\n最终报告');
    expect(coordinator.candidateText).toBe('# 结论\n最终报告');
  });

  test('mid-message visibleAnswerText is non-empty, so interrupt persistence keeps a partial answer', async () => {
    const session = new PiRuntimeSession(
      scriptedAgentSession('pi-sess-7', [
        assistantBoundary('start'),
        thinkingDelta('思考中'),
        textDelta('部分回答'),
      ]) as never,
    );
    const run = await runTurnWith({
      session,
      stamp: { turnId: 'turn-current', queryRunId: 'run-b' },
    });

    const coordinator = new TurnOutputCoordinator();
    let visible = '';
    for (const event of run.streamEvents) {
      visible = coordinator.reduceStreamEvent(event).visibleAnswerText;
    }
    expect(visible).toBe('部分回答');
  });
});

describe('pi-index emit wiring (source contract)', () => {
  test('the production emit wrapper stamps every stream event through stampStreamEventIdentity', () => {
    const source = fs.readFileSync(
      path.resolve('container/agent-runner/src/pi-index.ts'),
      'utf8',
    );
    expect(source).toMatch(/streamEvent:\s*stampStreamEventIdentity\(/);
    expect(source).toMatch(/turnId:\s*activeInputTurnId/);
    expect(source).toMatch(/queryRunId:\s*input\.queryRunId/);
  });
});
