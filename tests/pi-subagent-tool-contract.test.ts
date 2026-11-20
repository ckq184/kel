import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ContainerInput,
  ContainerOutput,
  StreamEvent,
} from '../container/agent-runner/src/types.js';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeInput,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
import { PiRuntimeSession } from '../container/agent-runner/src/runtime/pi/pi-session.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import { feedStreamEventToCard } from '../src/stream-card-feeder.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';
import type { StreamingSession } from '../src/im-channel.js';

/**
 * ISSUE-03 contract tests: subagent identification (runner event-layer
 * normalization, decision A), subagent terminal states + summary persistence
 * equivalents, tool results on tool_use_end, isError passthrough, and
 * toolInputSummary/skillName production.
 *
 * Runner scenarios drive the real chain (fake AgentSession / RuntimeSession →
 * PiRuntimeSession / runPiQueryAttempt). Subagent lifecycle events go through
 * the REAL PiSubAgentAdapter over a fake EventBus, matching production wiring.
 * Host card mapping drives the extracted feedStreamEventToCard with a
 * prototype-linked recording stub. Web scenarios drive the real zustand store.
 */

// ─── Runner harness ─────────────────────────────────────────────────────────

function fakeRuntimeSession(
  sessionId: string,
  script: (emit: (event: RuntimeEvent) => void) => void,
): RuntimeSession {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    kind: 'pi',
    sessionId,
    get isStreaming() {
      return false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      script((event) => {
        for (const listener of listeners) listener(event);
      });
      for (const listener of listeners) {
        listener({
          type: 'result',
          sessionId,
          result: {
            text: 'ok',
            sessionId,
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
}

async function runTurnWith(
  session: RuntimeSession,
): Promise<{ outputs: ContainerOutput[]; streamEvents: StreamEvent[] }> {
  const outputs: ContainerOutput[] = [];
  await runPiQueryAttempt({
    runtime: { createSession: async () => session } as AgentRuntime,
    sessionOptions: { cwd: '/tmp', sessionDir: '/tmp/pi' },
    prompt: 'user message',
    containerInput: {
      prompt: 'user message',
      groupFolder: 'test',
      chatJid: 'test:chat',
    } as ContainerInput,
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
  return {
    outputs,
    streamEvents: outputs.flatMap((output) =>
      output.streamEvent ? [output.streamEvent] : [],
    ),
  };
}

describe('Pi runner tool event mapping (ISSUE-03 decision A)', () => {
  test('normalizes Pi subagent tool names to the product vocabulary', async () => {
    const session = fakeRuntimeSession('pi-sess-tools', (emit) => {
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-tools',
        toolName: 'Agent',
        toolCallId: 'tc-1',
        input: { prompt: '请调研主题并总结', description: '调研任务' },
      });
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-tools',
        toolName: 'get_subagent_result',
        toolCallId: 'tc-2',
        input: {},
      });
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-tools',
        toolName: 'steer_subagent',
        toolCallId: 'tc-3',
        input: {},
      });
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-tools',
        toolName: 'bash',
        toolCallId: 'tc-4',
        input: { command: 'ls -la' },
      });
    });
    const { streamEvents } = await runTurnWith(session);
    const starts = streamEvents.filter(
      (event) => event.eventType === 'tool_use_start',
    );
    expect(starts.map((event) => event.toolName)).toEqual([
      'Task',
      'TaskOutput',
      'TaskStop',
      'bash',
    ]);
  });

  test('tool_use_start carries a toolInputSummary from the tool input', async () => {
    const session = fakeRuntimeSession('pi-sess-summary', (emit) => {
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-summary',
        toolName: 'Agent',
        toolCallId: 'tc-1',
        input: { prompt: '请调研主题并总结' },
      });
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-summary',
        toolName: 'bash',
        toolCallId: 'tc-2',
        input: { command: 'grep -r TODO src/' },
      });
    });
    const { streamEvents } = await runTurnWith(session);
    const starts = streamEvents.filter(
      (event) => event.eventType === 'tool_use_start',
    );
    expect(starts[0].toolInputSummary).toBe('prompt: 请调研主题并总结');
    expect(starts[1].toolInputSummary).toBe('command: grep -r TODO src/');
    // No producer value means no key noise on events without input.
    expect(starts[0].skillName).toBeUndefined();
  });

  test('tool_use_end carries isError only when the tool failed', async () => {
    const session = fakeRuntimeSession('pi-sess-err', (emit) => {
      emit({
        type: 'tool_end',
        sessionId: 'pi-sess-err',
        toolName: 'Agent',
        toolCallId: 'tc-ok',
        result: '子代理结论',
        isError: false,
      });
      emit({
        type: 'tool_end',
        sessionId: 'pi-sess-err',
        toolName: 'bash',
        toolCallId: 'tc-bad',
        result: 'command failed',
        isError: true,
      });
    });
    const { streamEvents } = await runTurnWith(session);
    const ends = streamEvents.filter(
      (event) => event.eventType === 'tool_use_end',
    );
    expect(ends[0]).toMatchObject({
      toolName: 'Task',
      toolUseId: 'tc-ok',
      toolResult: '子代理结论',
    });
    expect('isError' in ends[0]).toBe(false);
    expect(ends[1]).toMatchObject({
      toolUseId: 'tc-bad',
      toolResult: 'command failed',
      isError: true,
    });
  });

  test('skillName is produced for a Skill-named tool input', async () => {
    const session = fakeRuntimeSession('pi-sess-skill', (emit) => {
      emit({
        type: 'tool_start',
        sessionId: 'pi-sess-skill',
        toolName: 'Skill',
        toolCallId: 'tc-s',
        input: { skill: 'daily-report' },
      });
    });
    const { streamEvents } = await runTurnWith(session);
    expect(streamEvents[0]).toMatchObject({
      eventType: 'tool_use_start',
      toolName: 'Skill',
      skillName: 'daily-report',
    });
  });
});

// ─── Subagent lifecycle → task_progress (real adapter wiring) ────────────────

type EmitListener = (event: unknown) => void;

function fakeEventBus() {
  const channels = new Map<string, Set<EmitListener>>();
  return {
    on(channel: string, listener: EmitListener) {
      const set = channels.get(channel) ?? new Set();
      set.add(listener);
      channels.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel: string, value: unknown) {
      for (const listener of channels.get(channel) ?? []) listener(value);
    },
  };
}

function fakeAgentSession(sessionId: string) {
  const listeners = new Set<(event: never) => void>();
  return {
    sessionId,
    isStreaming: false,
    subscribe(listener: (event: never) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const listener of listeners) {
        listener({
          type: 'agent_end',
          willRetry: false,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              stopReason: 'stop',
            },
          ],
        } as never);
      }
    },
    async steer() {},
    async followUp() {},
    async abort() {},
    async compact() {},
    dispose() {},
  };
}

describe('Pi subagent lifecycle → task_progress mapping', () => {
  test('broadcasts map to taskStatus/taskId/taskDescription/taskSummary', async () => {
    const bus = fakeEventBus();
    const agentSession = fakeAgentSession('pi-sess-sub');
    const session = new PiRuntimeSession(agentSession as never, bus as never);
    const originalPrompt = session.prompt.bind(session);
    (session as unknown as { prompt: typeof originalPrompt }).prompt = async (
      input: RuntimeInput,
    ) => {
      bus.emit('subagents:created', {
        id: 'sa-7',
        type: 'worker',
        description: '调研任务',
      });
      bus.emit('subagents:started', { id: 'sa-7' });
      bus.emit('subagents:completed', {
        id: 'sa-7',
        type: 'worker',
        description: '调研任务',
        result: '调研结论摘要',
      });
      await originalPrompt(input);
    };

    const { streamEvents } = await runTurnWith(session);
    const progress = streamEvents.filter(
      (event) => event.eventType === 'task_progress',
    );
    expect(progress.map((event) => event.taskStatus)).toEqual([
      'created',
      'started',
      'completed',
    ]);
    expect(progress.every((event) => event.taskId === 'sa-7')).toBe(true);
    expect(progress.every((event) => event.agentScope === 'subagent')).toBe(
      true,
    );
    // The event mirrors the broadcast: 'created'/'completed' carry the
    // description; the minimal 'started' broadcast does not (and the card
    // keeps its existing title — asserted in the feeder tests).
    expect(progress.map((event) => event.taskDescription)).toEqual([
      '调研任务',
      undefined,
      '调研任务',
    ]);
    expect(progress[2].taskSummary).toBe('调研结论摘要');
  });

  test('failed broadcasts map taskStatus=failed and taskSummary=error', async () => {
    const bus = fakeEventBus();
    const agentSession = fakeAgentSession('pi-sess-sub-fail');
    const session = new PiRuntimeSession(agentSession as never, bus as never);
    const originalPrompt = session.prompt.bind(session);
    (session as unknown as { prompt: typeof originalPrompt }).prompt = async (
      input: RuntimeInput,
    ) => {
      bus.emit('subagents:failed', {
        id: 'sa-8',
        type: 'worker',
        description: '失败任务',
        error: '工具执行失败',
      });
      await originalPrompt(input);
    };

    const { streamEvents } = await runTurnWith(session);
    const progress = streamEvents.filter(
      (event) => event.eventType === 'task_progress',
    );
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      taskStatus: 'failed',
      taskId: 'sa-8',
      taskSummary: '工具执行失败',
    });
  });
});

// ─── Host card mapping (extracted feedStreamEventToCard) ─────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

function recordingCardStub() {
  const calls: RecordedCall[] = [];
  const toolNames = new Map<string, string>();
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const stub = Object.create(StreamingCardController.prototype) as Record<
    string,
    unknown
  >;
  Object.assign(stub, {
    isActive: () => true,
    setThinking: record('setThinking'),
    setSystemStatus: record('setSystemStatus'),
    startTool: (id: string, name: string) => {
      toolNames.set(id, name);
      calls.push({ method: 'startTool', args: [id, name] });
    },
    endTool: record('endTool'),
    updateToolSummary: record('updateToolSummary'),
    updateTask: record('updateTask'),
    pushRecentEvent: record('pushRecentEvent'),
    getToolInfo: (id: string) =>
      toolNames.has(id) ? { name: toolNames.get(id) } : undefined,
  });
  return {
    calls,
    session: stub as unknown as StreamingSession,
  };
}

describe('feedStreamEventToCard (host card mapping)', () => {
  test('a failed tool_use_end marks the card tool as error and shows the result timeline', () => {
    const { calls, session } = recordingCardStub();
    feedStreamEventToCard(
      session,
      {
        eventType: 'tool_use_start',
        toolName: 'bash',
        toolUseId: 'tc-bad',
      },
      '',
    );
    calls.length = 0;

    feedStreamEventToCard(
      session,
      {
        eventType: 'tool_use_end',
        toolUseId: 'tc-bad',
        toolResult: 'command failed with code 1',
        isError: true,
      },
      '',
    );

    const endTool = calls.find((call) => call.method === 'endTool');
    expect(endTool?.args).toEqual(['tc-bad', true]);
    const recent = calls
      .filter((call) => call.method === 'pushRecentEvent')
      .map((call) => call.args[0]);
    expect(recent.some((text) => String(text).includes('❌'))).toBe(true);
    expect(recent.some((text) => String(text).includes('command failed'))).toBe(
      true,
    );
    expect(recent.some((text) => String(text).includes('↳'))).toBe(true);
  });

  test('a successful tool_use_end keeps ✅ and still shows the ↳ result timeline', () => {
    const { calls, session } = recordingCardStub();
    feedStreamEventToCard(
      session,
      {
        eventType: 'tool_use_start',
        toolName: 'read',
        toolUseId: 'tc-ok',
      },
      '',
    );
    calls.length = 0;

    feedStreamEventToCard(
      session,
      {
        eventType: 'tool_use_end',
        toolUseId: 'tc-ok',
        toolResult: '文件内容',
      },
      '',
    );

    expect(calls.find((call) => call.method === 'endTool')?.args).toEqual([
      'tc-ok',
      false,
    ]);
    const recent = calls
      .filter((call) => call.method === 'pushRecentEvent')
      .map((call) => call.args[0]);
    expect(recent.some((text) => String(text).includes('✅'))).toBe(true);
    expect(recent.some((text) => String(text).includes('↳'))).toBe(true);
  });

  test('terminal task_progress updates the card task to completed/error with a summary event', () => {
    const { calls, session } = recordingCardStub();

    feedStreamEventToCard(
      session,
      {
        eventType: 'task_progress',
        taskId: 'sa-7',
        taskStatus: 'completed',
        taskSummary: '调研结论摘要',
        taskDescription: '调研任务',
      },
      '',
    );

    const update = calls.find((call) => call.method === 'updateTask');
    expect(update?.args).toEqual([
      'sa-7',
      expect.objectContaining({
        title: '调研任务',
        status: 'completed',
        summary: '调研结论摘要',
      }),
    ]);
    const recent = calls
      .filter((call) => call.method === 'pushRecentEvent')
      .map((call) => call.args[0]);
    expect(recent.some((text) => String(text).includes('✅'))).toBe(true);

    calls.length = 0;
    feedStreamEventToCard(
      session,
      {
        eventType: 'task_progress',
        taskId: 'sa-8',
        taskStatus: 'failed',
        taskSummary: '工具执行失败',
        taskDescription: '失败任务',
      },
      '',
    );
    expect(calls.find((call) => call.method === 'updateTask')?.args).toEqual([
      'sa-8',
      expect.objectContaining({ status: 'error', summary: '工具执行失败' }),
    ]);
    const recentFail = calls
      .filter((call) => call.method === 'pushRecentEvent')
      .map((call) => call.args[0]);
    expect(recentFail.some((text) => String(text).includes('❌'))).toBe(true);
  });

  test('a non-terminal task_progress keeps the task running and preserves the title', () => {
    const { calls, session } = recordingCardStub();
    feedStreamEventToCard(
      session,
      {
        eventType: 'task_progress',
        taskId: 'sa-7',
        taskStatus: 'created',
        taskDescription: '调研任务',
      },
      '',
    );
    expect(calls.find((call) => call.method === 'updateTask')?.args).toEqual([
      'sa-7',
      expect.objectContaining({ title: '调研任务', status: 'running' }),
    ]);

    // The minimal 'started' broadcast carries no description — the feeder must
    // not regress the card's title back to the 'Task' placeholder.
    calls.length = 0;
    feedStreamEventToCard(
      session,
      {
        eventType: 'task_progress',
        taskId: 'sa-7',
        taskStatus: 'started',
      },
      '',
    );
    const secondUpdate = calls.find((call) => call.method === 'updateTask')
      ?.args[1] as Record<string, unknown>;
    expect(secondUpdate.status).toBe('running');
    expect('title' in secondUpdate).toBe(false);
  });

  test('tool_use_start feeds the toolInputSummary into the card tool lane', () => {
    const { calls, session } = recordingCardStub();
    feedStreamEventToCard(
      session,
      {
        eventType: 'tool_use_start',
        toolName: 'Task',
        toolUseId: 'tc-1',
        toolInputSummary: 'prompt: 请调研主题并总结',
      },
      '',
    );
    const summary = calls.find((call) => call.method === 'updateToolSummary');
    expect(summary?.args).toEqual(['tc-1', 'prompt: 请调研主题并总结']);
  });
});

// ─── Web store (real zustand store, api/ws mocked) ───────────────────────────

const {
  apiGetMock,
  apiPostMock,
  apiPatchMock,
  apiDeleteMock,
  deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshotMock,
  notifyIfHiddenMock,
  showNotificationPromptToastMock,
} = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
  apiDeleteMock: vi.fn(),
  deleteAgentMessageSnapshotMock: vi.fn(),
  deleteGroupMessageSnapshotsMock: vi.fn(),
  loadAgentMessageSnapshotMock: vi.fn(),
  saveAgentMessageSnapshotMock: vi.fn(),
  notifyIfHiddenMock: vi.fn(),
  showNotificationPromptToastMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: apiDeleteMock,
  },
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: {
    getState: () => ({
      loadFiles: vi.fn(),
    }),
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: {
    getState: () => ({
      user: null,
    }),
  },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: notifyIfHiddenMock,
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: showNotificationPromptToastMock,
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: deleteAgentMessageSnapshotMock,
  deleteGroupMessageSnapshots: deleteGroupMessageSnapshotsMock,
  loadAgentMessageSnapshot: loadAgentMessageSnapshotMock,
  saveAgentMessageSnapshot: saveAgentMessageSnapshotMock,
}));

const { useChatStore } = await import('../web/src/stores/chat');

const emptyStreaming = () => ({
  partialText: '',
  thinkingText: '',
  activeTools: [] as Array<Record<string, unknown>>,
  recentEvents: [] as Array<Record<string, unknown>>,
  traceEvents: [] as Array<Record<string, unknown>>,
  taskStates: {} as Record<string, Record<string, unknown>>,
  systemStatus: null,
});

describe('Web chat store subagent contract', () => {
  const jid = 'web:issue03';
  const runId = 'run-issue03';

  beforeEach(() => {
    useChatStore.setState({
      groups: {},
      currentGroup: null,
      messages: {},
      waiting: {},
      // handleStreamEvent is run-scoped fenced: payloads only pass with a
      // matching active run (shouldApplyRunScopedPayload).
      activeRuns: {
        [jid]: {
          chatJid: jid,
          runId,
          startedAt: '2026-11-20T00:00:00.000Z',
          phase: 'running',
        },
      },
      streaming: {},
      sdkTasks: {},
      sdkTaskAliases: {},
    });
  });

  test('Task identification + terminal task_progress finalize + isError fallback', () => {
    // ① Normalized Task tool start creates the virtual SDK task tab.
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'tool_use_start',
        toolName: 'Task',
        toolUseId: 'tc-9',
        toolInputSummary: 'prompt: 请调研主题并总结',
      },
      undefined,
      runId,
    );
    expect(useChatStore.getState().sdkTasks['tc-9']).toMatchObject({
      status: 'running',
      chatJid: jid,
    });

    // ② Terminal task_progress (broadcast id, not the tool id) finalizes the
    //    bound running task with the subagent summary.
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'task_progress',
        taskId: 'sa-7',
        taskStatus: 'completed',
        taskSummary: '调研结论摘要',
      },
      undefined,
      runId,
    );
    expect(useChatStore.getState().sdkTasks['tc-9']).toMatchObject({
      status: 'completed',
      summary: '调研结论摘要',
    });
  });

  test('a failed Task tool_use_end converges the virtual tab to error', () => {
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'tool_use_start',
        toolName: 'Task',
        toolUseId: 'tc-fail',
      },
      undefined,
      runId,
    );
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'tool_use_end',
        toolUseId: 'tc-fail',
        isError: true,
        toolResult: '工具执行失败',
      },
      undefined,
      runId,
    );
    expect(useChatStore.getState().sdkTasks['tc-fail']).toMatchObject({
      status: 'error',
    });
  });

  test('the streaming task lane marks completed/failed task_progress terminal', () => {
    useChatStore.setState({
      streaming: { [jid]: emptyStreaming() },
    });
    useChatStore.getState().handleStreamEvent(
      jid,
      {
        eventType: 'task_progress',
        taskId: 'sa-7',
        taskStatus: 'completed',
        taskDescription: '调研任务',
      },
      undefined,
      runId,
    );
    const streaming = useChatStore.getState().streaming as Record<
      string,
      { taskStates?: Record<string, { status?: string }> } | undefined
    >;
    expect(streaming[jid]?.taskStates?.['sa-7']?.status).toBe('completed');
  });
});

// ─── Source contract: extraction keeps index.ts wiring intact ───────────────

describe('stream-card-feeder extraction (source contract)', () => {
  test('index.ts re-exports feedStreamEventToCard and no longer defines it inline', () => {
    const source = fs.readFileSync(path.resolve('src/index.ts'), 'utf8');
    expect(source).toMatch(
      /export \{ feedStreamEventToCard \} from '\.\/stream-card-feeder\.js'/,
    );
    expect(source).not.toMatch(/function feedStreamEventToCard\(/);
    expect(source).toMatch(/feedStreamEventToCard\(/);
  });
});
