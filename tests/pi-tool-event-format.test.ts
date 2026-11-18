import { describe, expect, test } from 'vitest';
import { IpcTurnDeliveryTracker } from '../container/agent-runner/src/ipc-delivery.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';
import type {
  RuntimeEvent,
  RuntimeSession,
} from '../container/agent-runner/src/runtime/types.js';
import { runPiQueryAttempt } from '../container/agent-runner/src/runtime/pi/pi-runner.js';
import { toUiToolName } from '../container/agent-runner/src/runtime/pi/pi-tool-names.js';
import {
  extractSkillName,
  summarizeToolResult,
} from '../container/agent-runner/src/utils.js';

const SESSION_ID = 'pi-tool-session';
// A fictional token, assembled at runtime so no credential-shaped literal sits
// in the source for the commit-time secret scan to (rightly) mistake for a real one.
const FAKE_JWT = ['eyJhbGc', 'eyJzdWI', 'SflKxw'].join('.');
const BEARER = `Bearer ${FAKE_JWT}`;

type ToolEvent = Extract<
  RuntimeEvent,
  { type: 'tool_start' | 'tool_update' | 'tool_end' }
>;

function tool(
  type: ToolEvent['type'],
  toolName: string,
  extra: Partial<Omit<ToolEvent, 'type' | 'toolName' | 'sessionId'>> = {},
): ToolEvent {
  return {
    type,
    sessionId: SESSION_ID,
    toolName,
    toolCallId: `call-${toolName}`,
    ...extra,
  };
}

/** Drive one fake Pi turn that emits the given runtime events, return the stream events. */
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
  return outputs
    .map((output) => output.streamEvent)
    .filter((event) => event && /^tool_/.test(event.eventType));
}

async function single(event: ToolEvent) {
  const events = await streamEventsFor([event]);
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('tool names shown to the UI', () => {
  test('maps pi built-in names back to the names the UI understands', async () => {
    const piNames = ['bash', 'read', 'write', 'edit', 'find', 'grep'];
    const events = await streamEventsFor(
      piNames.map((name) => tool('tool_start', name)),
    );
    expect(events.map((event) => event?.toolName)).toEqual([
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
    ]);
  });

  test('leaves ls, MCP tools and sub-agent tools under their own names', async () => {
    const names = [
      'ls',
      'mcp__ckqclaw__send_message',
      'Agent',
      'get_subagent_result',
      'steer_subagent',
    ];
    const events = await streamEventsFor(
      names.map((name) => tool('tool_start', name)),
    );
    expect(events.map((event) => event?.toolName)).toEqual(names);
  });

  test('applies to progress and end events too', async () => {
    const events = await streamEventsFor([
      tool('tool_update', 'bash'),
      tool('tool_end', 'bash'),
    ]);
    expect(events.map((event) => event?.toolName)).toEqual(['Bash', 'Bash']);
  });

  test('toUiToolName only remaps the six built-ins', () => {
    expect(toUiToolName('bash')).toBe('Bash');
    expect(toUiToolName('find')).toBe('Glob');
    expect(toUiToolName('Bash')).toBe('Bash');
    expect(toUiToolName('powershell')).toBe('powershell');
  });
});

describe('tool input reaches the UI as a redacted summary, not raw arguments', () => {
  test('summarizes and redacts the command, and sends no raw toolInput', async () => {
    const event = await single(
      tool('tool_start', 'bash', {
        input: { command: `curl -H "Authorization: ${BEARER}" https://api` },
      }),
    );
    expect(event.toolInputSummary).toMatch(/^command: /);
    expect(event.toolInputSummary).toContain('[REDACTED]');
    expect(event.toolInputSummary).not.toContain('SflKxw');
    expect(event.toolInput).toBeUndefined();
  });

  test('has no summary while the streamed arguments are still empty', async () => {
    const event = await single(tool('tool_start', 'bash', { input: {} }));
    expect(event.toolInputSummary).toBeUndefined();
  });

  test('progress events carry the summary as well', async () => {
    const event = await single(
      tool('tool_update', 'read', { input: { path: '/ws/src/index.ts' } }),
    );
    expect(event.eventType).toBe('tool_progress');
    expect(event.toolInputSummary).toBe('path: /ws/src/index.ts');
  });

  test('keeps the raw input only for AskUserQuestion, which the ask panel renders', async () => {
    const input = { questions: [{ question: 'Proceed?', options: [] }] };
    const event = await single(
      tool('tool_start', 'AskUserQuestion', { input }),
    );
    expect(event.toolInput).toEqual(input);
  });
});

describe('tool results are bounded and redacted', () => {
  test('truncates a large result and redacts secrets inside it', async () => {
    const text = `header ${BEARER} ${'x'.repeat(2000)}`;
    const event = await single(
      tool('tool_end', 'bash', {
        result: { content: [{ type: 'text', text }], details: undefined },
      }),
    );
    expect(event.eventType).toBe('tool_use_end');
    expect(event.toolResult).toContain('Bearer [REDACTED]');
    expect(event.toolResult).not.toContain('SflKxw');
    expect(event.toolResult!.length).toBeLessThanOrEqual(403);
  });

  test('bounds the live detail on progress events', async () => {
    const event = await single(
      tool('tool_update', 'bash', {
        input: { command: 'cat big.log' },
        result: {
          content: [{ type: 'text', text: 'y'.repeat(5000) }],
          details: undefined,
        },
      }),
    );
    expect(event.detail!.length).toBeLessThanOrEqual(403);
    expect(event.detail!.startsWith('yyyy')).toBe(true);
  });

  test('an end event without a result carries no toolResult', async () => {
    const event = await single(
      tool('tool_end', 'read', { input: { path: '/ws/a.ts' } }),
    );
    expect(event.toolResult).toBeUndefined();
  });
});

describe('skill label', () => {
  test('reading a SKILL.md is reported as a skill', async () => {
    const event = await single(
      tool('tool_start', 'read', {
        input: { path: '/workspace/.claude/skills/pdf-tools/SKILL.md' },
      }),
    );
    expect(event.toolName).toBe('Skill');
    expect(event.skillName).toBe('pdf-tools');
    expect(event.toolInputSummary).toContain('SKILL.md');
  });

  test('reading an ordinary file stays a Read', async () => {
    const event = await single(
      tool('tool_start', 'read', {
        input: { path: '/workspace/src/index.ts' },
      }),
    );
    expect(event.toolName).toBe('Read');
    expect(event.skillName).toBeUndefined();
  });

  test('a partially streamed path does not trigger the skill label', async () => {
    const event = await single(
      tool('tool_start', 'read', {
        input: { path: '/workspace/.claude/skills/pdf-tools/SKILL.' },
      }),
    );
    expect(event.toolName).toBe('Read');
    expect(event.skillName).toBeUndefined();
  });
});

describe('summarizeToolResult', () => {
  test('accepts plain strings and text blocks', () => {
    expect(summarizeToolResult('  hello  ')).toBe('hello');
    expect(
      summarizeToolResult([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  test('understands the Pi AgentToolResult shape', () => {
    expect(
      summarizeToolResult({
        content: [{ type: 'text', text: 'file contents' }],
        details: { truncated: false },
      }),
    ).toBe('file contents');
  });

  test('represents images and returns undefined for empty results', () => {
    expect(summarizeToolResult([{ type: 'image' }])).toBe('[image]');
    expect(summarizeToolResult('   ')).toBeUndefined();
    expect(summarizeToolResult(undefined)).toBeUndefined();
    expect(
      summarizeToolResult({ content: [], details: undefined }),
    ).toBeUndefined();
  });

  test('truncates to the limit with an ellipsis', () => {
    expect(summarizeToolResult('z'.repeat(1000))).toBe(`${'z'.repeat(400)}...`);
    expect(summarizeToolResult('z'.repeat(50), 10)).toBe(
      `${'z'.repeat(10)}...`,
    );
  });

  test('previews a huge result instead of collapsing it to a placeholder', () => {
    const out = summarizeToolResult(`start ${'q'.repeat(200 * 1024)}`);
    expect(out!.startsWith('start qqq')).toBe(true);
    expect(out).not.toContain('REDACTED LARGE INPUT');
    expect(out!.length).toBeLessThanOrEqual(403);
  });
});

describe('extractSkillName', () => {
  test('returns the directory name for a read of SKILL.md', () => {
    expect(
      extractSkillName('read', { path: '/a/skills/code-review/SKILL.md' }),
    ).toBe('code-review');
  });

  test('is undefined for other files, other tools and bad input', () => {
    expect(extractSkillName('read', { path: '/a/README.md' })).toBeUndefined();
    expect(
      extractSkillName('bash', { path: '/a/skills/x/SKILL.md' }),
    ).toBeUndefined();
    expect(extractSkillName('read', undefined)).toBeUndefined();
    expect(extractSkillName('read', { path: 42 })).toBeUndefined();
    expect(extractSkillName('read', { path: '/SKILL.md' })).toBeUndefined();
  });
});
