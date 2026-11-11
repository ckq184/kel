/**
 * Task AC: web-triggered offline eval runs.
 *
 * The trigger keeps the external-executor model: the host spawns the existing
 * CLI harness (`scripts/eval-auto-recall.ts`) as a child process, streams its
 * output lines to admins over WS, and enforces single-run mutex + a hard
 * timeout. All process plumbing is injected, so these tests drive a fake
 * child process end-to-end.
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

const broadcastLog = vi.fn();
const broadcastComplete = vi.fn();

const {
  startEvalRun,
  getEvalTriggerState,
  injectEvalTriggerDeps,
  resetEvalTriggerForTests,
  buildEvalRunArgs,
} = await import('../src/eval-trigger.js');

function wire(child: FakeChild): SpawnCall[] {
  const calls: SpawnCall[] = [];
  injectEvalTriggerDeps({
    broadcastLog: broadcastLog as never,
    broadcastComplete: broadcastComplete as never,
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
  resetEvalTriggerForTests();
  currentChild = fakeChild();
});

afterEach(() => {
  resetEvalTriggerForTests();
});

describe('buildEvalRunArgs', () => {
  test('assembles whitelist-safe CLI arguments', () => {
    expect(
      buildEvalRunArgs({ k: 10, runName: 'k10-check', reset: true }),
    ).toEqual([
      'scripts/eval-auto-recall.ts',
      '--k',
      '10',
      '--run-name',
      'k10-check',
      '--reset',
    ]);
    expect(buildEvalRunArgs({ k: 5, runName: 'r', reset: false })).toEqual([
      'scripts/eval-auto-recall.ts',
      '--k',
      '5',
      '--run-name',
      'r',
    ]);
  });
});

describe('startEvalRun', () => {
  test('spawns npx tsx at the repo root and returns 202-shaped ok', () => {
    const calls = wire(currentChild);
    const result = startEvalRun({
      k: 5,
      runName: 'run-a',
      reset: false,
      startedBy: 'admin',
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('npx');
    expect(calls[0].args.slice(0, 2)).toEqual([
      'tsx',
      'scripts/eval-auto-recall.ts',
    ]);
    expect(calls[0].options).toMatchObject({ cwd: expect.any(String) });
  });

  test('rejects a second run while one is active (mutex)', () => {
    wire(currentChild);
    expect(
      startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' }),
    ).toEqual({ ok: true });
    expect(
      startEvalRun({ k: 5, runName: 'b', reset: false, startedBy: 'admin' }),
    ).toEqual({ ok: false, error: 'busy' });
  });

  test('streams stdout/stderr lines to the broadcast and the state tail', () => {
    wire(currentChild);
    startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' });
    currentChild.stdout.emit('data', Buffer.from('line one\n'));
    currentChild.stderr.emit('data', Buffer.from('line two\nline three\n'));
    expect(broadcastLog).toHaveBeenCalledTimes(3);
    expect(getEvalTriggerState().lines).toEqual([
      'line one',
      'line two',
      'line three',
    ]);
  });

  test('exit code 0 completes with success and broadcasts completion', () => {
    wire(currentChild);
    startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' });
    currentChild.emit('close', 0);
    const state = getEvalTriggerState();
    expect(state.running).toBe(false);
    expect(state.result).toEqual({ success: true });
    expect(broadcastComplete).toHaveBeenCalledWith(true, undefined);
    // State survives for the status endpoint until the next run.
    expect(state.lines).toBeDefined();
  });

  test('non-zero exit completes with failure detail', () => {
    wire(currentChild);
    startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' });
    currentChild.emit('close', 1);
    expect(getEvalTriggerState().result).toMatchObject({
      success: false,
      error: expect.stringContaining('1'),
    });
    expect(broadcastComplete).toHaveBeenCalledWith(false, expect.any(String));
  });

  test('spawn error completes immediately', () => {
    const child = fakeChild();
    wire(child);
    startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' });
    child.emit('error', new Error('npx not found'));
    expect(getEvalTriggerState().running).toBe(false);
    expect(getEvalTriggerState().result).toMatchObject({ success: false });
    expect(broadcastComplete).toHaveBeenCalledWith(false, 'npx not found');
  });

  test('a completed run frees the mutex', () => {
    wire(currentChild);
    startEvalRun({ k: 5, runName: 'a', reset: false, startedBy: 'admin' });
    currentChild.emit('close', 0);
    expect(
      startEvalRun({ k: 5, runName: 'b', reset: false, startedBy: 'admin' }),
    ).toEqual({ ok: true });
  });

  test('idle state is safe to read before any run', () => {
    injectEvalTriggerDeps({
      broadcastLog: broadcastLog as never,
      broadcastComplete: broadcastComplete as never,
      spawn: (() => currentChild) as never,
    });
    const state = getEvalTriggerState();
    expect(state.running).toBe(false);
    expect(state.lines).toEqual([]);
    expect(state.result).toBeNull();
  });
});

describe('buildEvalRunArgs dataset flag (task AD)', () => {
  test('omits --dataset when unset (default auto-recall in the harness)', () => {
    expect(buildEvalRunArgs({ k: 5, runName: 'r', reset: false })).toEqual([
      'scripts/eval-auto-recall.ts',
      '--k',
      '5',
      '--run-name',
      'r',
    ]);
  });

  test('appends the whitelist-checked dataset name', () => {
    expect(
      buildEvalRunArgs({ k: 5, runName: 'r', reset: false, dataset: 'my-set' }),
    ).toEqual([
      'scripts/eval-auto-recall.ts',
      '--k',
      '5',
      '--run-name',
      'r',
      '--dataset',
      'my-set',
    ]);
  });
});
