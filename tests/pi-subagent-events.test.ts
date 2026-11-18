import { describe, expect, test } from 'vitest';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';
import type {
  RuntimeEvent,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';

const SESSION_ID = 'pi-subagent-session';
// A fictional token, assembled at runtime so no credential-shaped literal sits
// in the source for the commit-time secret scan to (rightly) mistake for a real one.
const FAKE_JWT = ['eyJhbGc', 'eyJzdWI', 'SflKxw'].join('.');
const BEARER = `Bearer ${FAKE_JWT}`;

type SubagentEvent = Extract<RuntimeEvent, { type: 'subagent' }>;
type Lifecycle = SubagentEvent['lifecycle'];

function sub(
  lifecycle: Lifecycle,
  agentId: string | undefined,
  extra: Partial<Omit<SubagentEvent, 'type' | 'lifecycle' | 'agentId'>> = {},
): SubagentEvent {
  return {
    type: 'subagent',
    sessionId: SESSION_ID,
    lifecycle,
    agentId,
    ...extra,
  };
}

/** Drive one fake Pi turn that emits the given runtime events, return every stream event. */
async function streamEventsFor(events: RuntimeEvent[]) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const session = {
    kind: 'pi' as const,
    sessionId: SESSION_ID,
    isStreaming: false,
    subscribe(listener: (event: RuntimeEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const listener of listeners) {
        for (const event of events) listener(event);
        listener({
          type: 'result',
          sessionId: SESSION_ID,
          result: {
            text: 'done',
            sessionId: SESSION_ID,
            finalizationReason: 'completed',
            stopReason: 'stop',
          },
        });
      }
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    async compact() {},
    dispose() {},
  } satisfies RuntimeSession;

  const outputs: ContainerOutput[] = [];
  await runPiQueryAttempt({
    runtime: { createSession: async () => session } as never,
    sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
    prompt: 'go',
    containerInput: {
      prompt: 'go',
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
  return outputs.flatMap((output) =>
    output.streamEvent ? [output.streamEvent] : [],
  );
}

async function taskEventsFor(events: RuntimeEvent[]) {
  const all = await streamEventsFor(events);
  return all.filter((event) => /^task_/.test(event.eventType));
}

const types = (events: Array<{ eventType: string }>) =>
  events.map((event) => event.eventType);

describe('sub-agent start becomes a Task the UI can show', () => {
  test('started → task_start keyed by the agent id, with description and type', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', {
        details: { id: 'agent-1', type: 'worker', description: 'audit deps' },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'task_start',
      agentScope: 'task',
      displayLevel: 'primary',
      taskId: 'agent-1',
      toolUseId: 'agent-1',
      taskDescription: 'audit deps',
      subagentType: 'worker',
      taskType: 'subagent',
    });
  });

  test('a long description is capped', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', { details: { description: 'd'.repeat(500) } }),
    ]);
    expect(events[0]!.taskDescription).toBe('d'.repeat(200));
  });

  test('missing details still start a task, without inventing a description', async () => {
    const events = await taskEventsFor([sub('started', 'agent-1')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('task_start');
    expect(events[0]!.taskDescription).toBeUndefined();
    expect(events[0]!.subagentType).toBeUndefined();
  });

  test('created then started announces the task once', async () => {
    const events = await taskEventsFor([
      sub('created', 'agent-1', { details: { isBackground: true } }),
      sub('started', 'agent-1', { details: { description: 'x' } }),
    ]);
    expect(types(events)).toEqual(['task_start']);
  });

  test('started then created announces the task once', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', { details: { description: 'x' } }),
      sub('created', 'agent-1', { details: { isBackground: true } }),
    ]);
    expect(types(events)).toEqual(['task_start']);
  });

  test('the Agent tool call stays an ordinary tool, independent of the task id', async () => {
    const all = await streamEventsFor([
      {
        type: 'tool_start',
        sessionId: SESSION_ID,
        toolName: 'Agent',
        toolCallId: 'call-xyz',
        input: { description: 'audit deps' },
      },
      sub('started', 'agent-1', { details: { description: 'audit deps' } }),
    ]);
    const toolStart = all.find((event) => event.eventType === 'tool_use_start');
    const taskStart = all.find((event) => event.eventType === 'task_start');
    expect(toolStart).toMatchObject({
      toolName: 'Agent',
      toolUseId: 'call-xyz',
    });
    expect(taskStart).toMatchObject({ toolUseId: 'agent-1' });
  });
});

describe('sub-agent end becomes a task_notification', () => {
  test('completed → task_notification completed, with the result as summary', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1'),
      sub('completed', 'agent-1', { result: 'all good' }),
    ]);
    expect(types(events)).toEqual(['task_start', 'task_notification']);
    expect(events[1]).toMatchObject({
      agentScope: 'task',
      displayLevel: 'primary',
      taskId: 'agent-1',
      toolUseId: 'agent-1',
      taskStatus: 'completed',
      taskSummary: 'all good',
      summary: 'all good',
    });
    expect(events[1]!.isBackground).toBeUndefined();
  });

  test('failed → task_notification failed, preferring the error text', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1'),
      sub('failed', 'agent-1', { error: 'boom', result: 'partial output' }),
    ]);
    expect(events[1]).toMatchObject({
      eventType: 'task_notification',
      taskStatus: 'failed',
      taskSummary: 'boom',
    });
  });

  test('a failure with no text still finishes the task', async () => {
    const events = await taskEventsFor([sub('failed', 'agent-1')]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'task_notification',
      taskStatus: 'failed',
    });
    expect(events[0]!.taskSummary).toBeUndefined();
  });

  test('the summary is truncated and redacted', async () => {
    const events = await taskEventsFor([
      sub('completed', 'agent-1', {
        result: `done ${BEARER} ${'x'.repeat(2000)}`,
      }),
    ]);
    const summary = events[0]!.taskSummary!;
    expect(summary).toContain('Bearer [REDACTED]');
    expect(summary).not.toContain('SflKxw');
    expect(summary.length).toBeLessThanOrEqual(403);
  });

  test('a completion with no earlier start is still reported', async () => {
    const events = await taskEventsFor([
      sub('completed', 'agent-9', { result: 'late' }),
    ]);
    expect(types(events)).toEqual(['task_notification']);
    expect(events[0]).toMatchObject({
      taskId: 'agent-9',
      toolUseId: 'agent-9',
    });
  });

  test('a finished agent that is resumed is announced again', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1'),
      sub('completed', 'agent-1', { result: 'one' }),
      sub('started', 'agent-1'),
      sub('completed', 'agent-1', { result: 'two' }),
    ]);
    expect(types(events)).toEqual([
      'task_start',
      'task_notification',
      'task_start',
      'task_notification',
    ]);
  });
});

describe('background completion is flagged so the Web can notify', () => {
  test('a background agent completes with isBackground', async () => {
    const events = await taskEventsFor([
      sub('created', 'bg-1', { details: { isBackground: true } }),
      sub('completed', 'bg-1', { result: 'done' }),
    ]);
    const done = events.find(
      (event) => event.eventType === 'task_notification',
    );
    expect(done?.isBackground).toBe(true);
  });

  test('a failed background agent is flagged too', async () => {
    const events = await taskEventsFor([
      sub('created', 'bg-1', { details: { isBackground: true } }),
      sub('failed', 'bg-1', { error: 'boom' }),
    ]);
    const done = events.find(
      (event) => event.eventType === 'task_notification',
    );
    expect(done).toMatchObject({ taskStatus: 'failed', isBackground: true });
  });

  test('only the agents announced as background are flagged', async () => {
    const events = await taskEventsFor([
      sub('created', 'bg-1', { details: { isBackground: true } }),
      sub('started', 'fg-1'),
      sub('completed', 'fg-1', { result: 'a' }),
      sub('completed', 'bg-1', { result: 'b' }),
    ]);
    const done = events.filter(
      (event) => event.eventType === 'task_notification',
    );
    expect(done.map((event) => [event.taskId, event.isBackground])).toEqual([
      ['fg-1', undefined],
      ['bg-1', true],
    ]);
  });

  test('the flag does not leak to a later foreground run of the same id', async () => {
    const events = await taskEventsFor([
      sub('created', 'a-1', { details: { isBackground: true } }),
      sub('completed', 'a-1', { result: 'first' }),
      sub('started', 'a-1'),
      sub('completed', 'a-1', { result: 'second' }),
    ]);
    const done = events.filter(
      (event) => event.eventType === 'task_notification',
    );
    expect(done.map((event) => event.isBackground)).toEqual([true, undefined]);
  });
});

describe('steered and compacted stay progress, never a status change', () => {
  test('steered and compacted on a running agent → task_progress with a summary', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', {
        details: { type: 'worker', description: 'audit deps' },
      }),
      sub('steered', 'agent-1'),
      sub('compacted', 'agent-1'),
    ]);
    expect(types(events)).toEqual([
      'task_start',
      'task_progress',
      'task_progress',
    ]);
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({ taskId: 'agent-1', toolUseId: 'agent-1' });
      expect(event.taskSummary).toBeTruthy();
      expect(event.taskStatus).toBeUndefined();
    }
  });

  test('progress keeps the task title, which the Feishu card re-applies on every progress event', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', {
        details: { type: 'worker', description: 'audit deps' },
      }),
      sub('steered', 'agent-1'),
    ]);
    expect(events[1]).toMatchObject({
      taskDescription: 'audit deps',
      subagentType: 'worker',
    });
  });

  test('progress for an unknown or already finished agent is dropped', async () => {
    const events = await taskEventsFor([
      sub('steered', 'ghost'),
      sub('started', 'agent-1'),
      sub('completed', 'agent-1', { result: 'ok' }),
      sub('compacted', 'agent-1'),
    ]);
    expect(types(events)).toEqual(['task_start', 'task_notification']);
  });
});

describe('hygiene', () => {
  test('an event without an agent id cannot be correlated and is dropped', async () => {
    const events = await taskEventsFor([
      sub('started', undefined),
      sub('completed', undefined, { result: 'x' }),
      sub('failed', undefined, { error: 'x' }),
    ]);
    expect(events).toEqual([]);
  });

  test('the raw lifecycle payload never leaves the runner', async () => {
    const events = await taskEventsFor([
      sub('started', 'agent-1', { details: { id: 'agent-1', secret: BEARER } }),
      sub('completed', 'agent-1', {
        result: 'ok',
        details: { id: 'agent-1', result: BEARER, usage: { total: 1 } },
      }),
      sub('steered', 'agent-1'),
    ]);
    for (const event of events) {
      expect(event.rawEvent).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain('SflKxw');
    }
  });

  test('no sub-agent lifecycle is reported as a bare task_progress with a made-up running status', async () => {
    const events = await taskEventsFor([
      sub('created', 'agent-1', { details: { isBackground: true } }),
      sub('started', 'agent-1'),
      sub('completed', 'agent-1', { result: 'ok' }),
    ]);
    expect(types(events)).not.toContain('task_progress');
  });
});
