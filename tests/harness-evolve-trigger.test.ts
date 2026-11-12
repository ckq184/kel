/**
 * Task AH (RSI Phase 3): web-triggered harness evolve runs.
 *
 * Mirrors the eval-trigger model (task AC) in an independent module: the host
 * spawns the existing CLI (`scripts/eval-harness-evolve.ts`) as a child
 * process, keeps a single-flight mutex + hard timeout, and exposes a status
 * snapshot the Web tab polls (deliberately no WS events this phase). All
 * process plumbing is injected, so these tests drive a fake child end-to-end.
 */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface FakeChild extends EventEmitter {
  killed: boolean;
  kill(): void;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
};

const {
  startHarnessEvolveRun,
  getHarnessEvolveTriggerState,
  injectHarnessEvolveTriggerDeps,
  resetHarnessEvolveTriggerForTests,
  buildHarnessEvolveArgs,
  WORKSPACE_JID_PATTERN,
} = await import('../src/harness-evolve-trigger.js');

function wire(child: FakeChild): SpawnCall[] {
  const calls: SpawnCall[] = [];
  injectHarnessEvolveTriggerDeps({
    spawn: ((
      command: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      return child as never;
    }) as never,
  });
  return calls;
}

let currentChild: FakeChild;

beforeEach(() => {
  vi.clearAllMocks();
  resetHarnessEvolveTriggerForTests();
  currentChild = fakeChild();
});

afterEach(() => {
  resetHarnessEvolveTriggerForTests();
});

describe('WORKSPACE_JID_PATTERN', () => {
  test('accepts real JID shapes and rejects shell metacharacters', () => {
    for (const jid of [
      'feishu:123456',
      'web:ws-a',
      'discord:9@g.us',
      'qq-group_01@group.example.com',
    ]) {
      expect(WORKSPACE_JID_PATTERN.test(jid), jid).toBe(true);
    }
    // Injection surface under win32 shell:true: spaces, quotes, chaining,
    // expansion, path separators — all rejected.
    for (const bad of [
      'feishu:1@g.us;rm -rf',
      'a & b',
      'a | b',
      'a && b',
      'a>b',
      '$(x)',
      '`x`',
      'a b',
      'a"b',
      "a'b",
      '../etc/passwd',
      'a\\b',
      '',
      'x'.repeat(129),
    ]) {
      expect(WORKSPACE_JID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('buildHarnessEvolveArgs', () => {
  test('assembles the fixed evolve CLI arguments', () => {
    expect(buildHarnessEvolveArgs('feishu:9@g.us')).toEqual([
      'scripts/eval-harness-evolve.ts',
      '--workspace',
      'feishu:9@g.us',
    ]);
  });
});

describe('startHarnessEvolveRun', () => {
  test('spawns npx tsx at the repo root and records the workspace', () => {
    const calls = wire(currentChild);
    const result = startHarnessEvolveRun({
      workspace: 'feishu:9@g.us',
      startedBy: 'admin',
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('npx');
    expect(calls[0].args).toEqual([
      'tsx',
      'scripts/eval-harness-evolve.ts',
      '--workspace',
      'feishu:9@g.us',
    ]);
    expect(calls[0].options).toMatchObject({ cwd: expect.any(String) });
    const state = getHarnessEvolveTriggerState();
    expect(state).toMatchObject({
      running: true,
      workspace: 'feishu:9@g.us',
      startedBy: 'admin',
      lines: [],
      result: null,
    });
  });

  test('rejects a workspace that fails the JID whitelist (no spawn)', () => {
    const calls = wire(currentChild);
    expect(
      startHarnessEvolveRun({
        workspace: 'feishu:1@g.us;rm -rf /',
        startedBy: 'admin',
      }),
    ).toEqual({ ok: false, error: 'invalid_workspace' });
    expect(
      startHarnessEvolveRun({ workspace: '   ', startedBy: 'admin' }),
    ).toEqual({ ok: false, error: 'invalid_workspace' });
    expect(calls).toHaveLength(0);
    expect(getHarnessEvolveTriggerState().running).toBe(false);
  });

  test('rejects a second run while one is active (single-flight mutex)', () => {
    wire(currentChild);
    expect(
      startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' }),
    ).toEqual({ ok: true });
    expect(
      startHarnessEvolveRun({ workspace: 'web:ws-b', startedBy: 'admin' }),
    ).toEqual({ ok: false, error: 'busy' });
  });

  test('streams stdout/stderr lines into the state tail', () => {
    wire(currentChild);
    startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
    currentChild.stdout.emit('data', Buffer.from('proposing for web:ws-a\n'));
    currentChild.stderr.emit(
      'data',
      Buffer.from('phase3 evidence: clusters 4 (40 turns)\n'),
    );
    expect(getHarnessEvolveTriggerState().lines).toEqual([
      'proposing for web:ws-a',
      'phase3 evidence: clusters 4 (40 turns)',
    ]);
  });

  test('exit code 0 completes with success', () => {
    wire(currentChild);
    startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
    currentChild.emit('close', 0);
    const state = getHarnessEvolveTriggerState();
    expect(state.running).toBe(false);
    expect(state.result).toEqual({ success: true });
  });

  test('non-zero exit completes with failure detail', () => {
    wire(currentChild);
    startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
    currentChild.emit('close', 1);
    expect(getHarnessEvolveTriggerState().result).toMatchObject({
      success: false,
      error: expect.stringContaining('1'),
    });
  });

  test('spawn error completes immediately', () => {
    const child = fakeChild();
    wire(child);
    startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
    child.emit('error', new Error('npx not found'));
    expect(getHarnessEvolveTriggerState().running).toBe(false);
    expect(getHarnessEvolveTriggerState().result).toMatchObject({
      success: false,
      error: 'npx not found',
    });
  });

  test('a completed run frees the mutex', () => {
    wire(currentChild);
    startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
    currentChild.emit('close', 0);
    expect(
      startHarnessEvolveRun({ workspace: 'web:ws-b', startedBy: 'admin' }),
    ).toEqual({ ok: true });
  });

  test('15-minute timeout kills the child and fails the run', () => {
    vi.useFakeTimers();
    try {
      wire(currentChild);
      startHarnessEvolveRun({ workspace: 'web:ws-a', startedBy: 'admin' });
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(currentChild.killed).toBe(true);
      const state = getHarnessEvolveTriggerState();
      expect(state.running).toBe(false);
      expect(state.result).toMatchObject({
        success: false,
        error: expect.stringMatching(/timed out|timeout/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('idle state is safe to read before any run', () => {
    const state = getHarnessEvolveTriggerState();
    expect(state).toEqual({
      running: false,
      workspace: null,
      startedAt: null,
      startedBy: null,
      lines: [],
      result: null,
    });
  });
});
