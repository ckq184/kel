import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/** Repo root = parent of data/ (config.ts keeps PROJECT_ROOT private). */
const REPO_ROOT = path.dirname(DATA_DIR);

/**
 * Web-triggered offline eval runs (task AC).
 *
 * Keeps the external-executor model (plan §1-1): the host spawns the existing
 * CLI harness as a child process instead of embedding the eval pipeline in
 * the server. The harness owns the real sidecar, endpoints, and golden set;
 * it writes results into eval.db itself, so a host restart mid-run only
 * orphans the UI state — the child finishes and lands its rows regardless.
 *
 * Conflation guards (plan §1-3/5): single-run mutex, 15-minute hard timeout,
 * whitelist-only CLI arguments (k integer, runName `[\w-]{1,64}`, fixed
 * flags) so the Windows `shell: true` spawn closes its injection surface.
 */

const EVAL_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TAIL_LINES = 200;

export interface EvalTriggerInput {
  k: number;
  runName: string;
  reset: boolean;
  /** Golden set name (task AD); omit to let the harness default to
   * `auto-recall`. Route-level whitelist `[\\w-]{1,64}` closes the argv
   * injection surface. */
  dataset?: string;
  startedBy: string;
}

export interface EvalTriggerResult {
  success: boolean;
  error?: string;
}

export interface EvalTriggerStateSnapshot {
  running: boolean;
  startedAt: number | null;
  startedBy: string | null;
  lines: string[];
  result: EvalTriggerResult | null;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

interface EvalTriggerDeps {
  broadcastLog: (line: string) => void;
  broadcastComplete: (success: boolean, error?: string) => void;
  spawn: SpawnFn;
}

let deps: EvalTriggerDeps | null = null;

let state: EvalTriggerStateSnapshot = {
  running: false,
  startedAt: null,
  startedBy: null,
  lines: [],
  result: null,
};

let activeTimeout: ReturnType<typeof setTimeout> | null = null;

/** CLI argument assembly (pure — unit-tested, injection-surface whitelist). */
export function buildEvalRunArgs(input: {
  k: number;
  runName: string;
  reset: boolean;
  dataset?: string;
}): string[] {
  const args = [
    'scripts/eval-auto-recall.ts',
    '--k',
    String(input.k),
    '--run-name',
    input.runName,
  ];
  if (input.reset) args.push('--reset');
  if (input.dataset) args.push('--dataset', input.dataset);
  return args;
}

/** Test/production wiring: broadcast channels + spawn factory. */
export function injectEvalTriggerDeps(next: {
  broadcastLog: (line: string) => void;
  broadcastComplete: (success: boolean, error?: string) => void;
  spawn?: SpawnFn;
}): void {
  deps = {
    broadcastLog: next.broadcastLog,
    broadcastComplete: next.broadcastComplete,
    spawn:
      next.spawn ??
      ((command, args, options) =>
        spawn(command, args, options as never) as ChildProcess),
  };
}

function defaultDeps(): EvalTriggerDeps {
  return {
    broadcastLog: () => {},
    broadcastComplete: () => {},
    spawn: (command, args, options) =>
      spawn(command, args, options as never) as ChildProcess,
  };
}

export function getEvalTriggerState(): EvalTriggerStateSnapshot {
  return {
    running: state.running,
    startedAt: state.startedAt,
    startedBy: state.startedBy,
    lines: [...state.lines],
    result: state.result ? { ...state.result } : null,
  };
}

export function startEvalRun(
  input: EvalTriggerInput,
): { ok: true } | { ok: false; error: 'busy' } {
  if (state.running) return { ok: false, error: 'busy' };
  const wired = deps ?? defaultDeps();

  // Whitelisted argv only (plan §1-5): k is a validated integer, runName is
  // `[\w-]{1,64}` (route-level), flags are fixed — safe under win32 shell.
  const child = wired.spawn('npx', ['tsx', ...buildEvalRunArgs(input)], {
    cwd: REPO_ROOT,
    env: process.env,
    ...(process.platform === 'win32' ? { shell: true } : {}),
  });

  state = {
    running: true,
    startedAt: Date.now(),
    startedBy: input.startedBy,
    lines: [],
    result: null,
  };
  logger.info(
    { k: input.k, runName: input.runName, startedBy: input.startedBy },
    'Eval run triggered via web (external executor child process)',
  );

  const pushLine = (line: string): void => {
    if (!line) return;
    state.lines.push(line);
    if (state.lines.length > MAX_TAIL_LINES) {
      state.lines = state.lines.slice(-MAX_TAIL_LINES);
    }
    wired.broadcastLog(line);
  };

  const finish = (result: EvalTriggerResult): void => {
    if (!state.running) return;
    if (activeTimeout) {
      clearTimeout(activeTimeout);
      activeTimeout = null;
    }
    state.running = false;
    state.result = result;
    if (result.success) {
      logger.info({ runName: input.runName }, 'Eval run completed');
    } else {
      logger.error(
        { runName: input.runName, error: result.error },
        'Eval run failed',
      );
    }
    wired.broadcastComplete(result.success, result.error);
  };

  activeTimeout = setTimeout(() => {
    child.kill('SIGKILL');
    finish({
      success: false,
      error: `Eval run timed out after ${EVAL_RUN_TIMEOUT_MS / 60000} minutes`,
    });
  }, EVAL_RUN_TIMEOUT_MS);
  activeTimeout.unref?.();

  // Line splitting without readline: the fake child processes in tests are
  // plain EventEmitters, and manual split('\n') keeps partial-line buffering
  // explicit (the docker-pull precedent does the same via readline over real
  // pipes; here the stream contract is intentionally minimal).
  const attachLineReader = (
    stream:
      | { on(event: 'data', listener: (chunk: unknown) => void): unknown }
      | null
      | undefined,
  ): void => {
    if (!stream) return;
    let pending = '';
    stream.on('data', (chunk: unknown) => {
      pending +=
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) pushLine(line);
    });
  };
  attachLineReader(child.stdout as never);
  attachLineReader(child.stderr as never);

  child.on('close', (code: number | null) => {
    const success = code === 0;
    finish(
      success
        ? { success: true }
        : {
            success: false,
            error: `Eval run exited with code ${code ?? 'null'}`,
          },
    );
  });

  child.on('error', (err: Error) => {
    finish({ success: false, error: err.message });
  });

  return { ok: true };
}

/** Test hook — drop state and timers between tests. */
export function resetEvalTriggerForTests(): void {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  state = {
    running: false,
    startedAt: null,
    startedBy: null,
    lines: [],
    result: null,
  };
  deps = null;
}
