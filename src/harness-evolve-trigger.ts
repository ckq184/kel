import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/** Repo root = parent of data/ (config.ts keeps PROJECT_ROOT private). */
const REPO_ROOT = path.dirname(DATA_DIR);

/**
 * Web-triggered harness evolve runs (task AH, RSI Phase 3).
 *
 * Same external-executor model as src/eval-trigger.ts (task AC), kept in an
 * independent module on purpose: that one is welded to the auto-recall CLI's
 * parameter assembly, and this trigger's surface is exactly one workspace JID.
 * The host spawns the existing propose CLI as a child process; the child
 * writes the pending proposal into eval.db itself, so a host restart mid-run
 * only orphans the UI state.
 *
 * Deliberately NO WS events this phase (plan §1-5): the Web tab polls the
 * status snapshot; the log tail rides along for free.
 *
 * Conflation guards: single-run mutex, 15-minute hard timeout, and a JID
 * whitelist that keeps the Windows `shell: true` spawn's injection surface
 * closed — real JIDs are `channel:id[@domain]` shapes, so everything outside
 * `[\w:@.-]` (spaces, quotes, chaining, expansion, separators) is rejected.
 */

const EVOLVE_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TAIL_LINES = 200;

/**
 * Whitelist for workspace JIDs reaching child argv. 1-128 chars of
 * `[\w:@.-]` — covers feishu:123, web:ws-a and excludes every
 * shell metacharacter (win32 `shell: true` defense, eval-trigger precedent).
 */
export const WORKSPACE_JID_PATTERN = /^[\w:@.-]{1,128}$/;

export interface HarnessEvolveTriggerInput {
  workspace: string;
  startedBy: string;
}

export interface HarnessEvolveTriggerResult {
  success: boolean;
  error?: string;
}

export interface HarnessEvolveTriggerStateSnapshot {
  running: boolean;
  workspace: string | null;
  startedAt: number | null;
  startedBy: string | null;
  lines: string[];
  result: HarnessEvolveTriggerResult | null;
}

type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ChildProcess;

let spawnFn: SpawnFn | null = null;

let state: HarnessEvolveTriggerStateSnapshot = {
  running: false,
  workspace: null,
  startedAt: null,
  startedBy: null,
  lines: [],
  result: null,
};

let activeTimeout: ReturnType<typeof setTimeout> | null = null;

/** CLI argument assembly (pure — unit-tested, injection-surface whitelist). */
export function buildHarnessEvolveArgs(workspace: string): string[] {
  return ['scripts/eval-harness-evolve.ts', '--workspace', workspace];
}

/** Test/production wiring: the spawn factory. */
export function injectHarnessEvolveTriggerDeps(next: { spawn: SpawnFn }): void {
  spawnFn = next.spawn;
}

function defaultSpawn(): SpawnFn {
  return (command, args, options) =>
    spawn(command, args, options as never) as ChildProcess;
}

export function getHarnessEvolveTriggerState(): HarnessEvolveTriggerStateSnapshot {
  return {
    running: state.running,
    workspace: state.workspace,
    startedAt: state.startedAt,
    startedBy: state.startedBy,
    lines: [...state.lines],
    result: state.result ? { ...state.result } : null,
  };
}

export function startHarnessEvolveRun(
  input: HarnessEvolveTriggerInput,
): { ok: true } | { ok: false; error: 'busy' | 'invalid_workspace' } {
  if (state.running) return { ok: false, error: 'busy' };
  const workspace = input.workspace.trim();
  if (!WORKSPACE_JID_PATTERN.test(workspace)) {
    return { ok: false, error: 'invalid_workspace' };
  }
  const spawnWith = spawnFn ?? defaultSpawn();

  // Whitelisted argv only: the JID pattern above strips every metacharacter,
  // so the win32 `shell: true` spawn stays closed (eval-trigger lesson).
  const child = spawnWith(
    'npx',
    ['tsx', ...buildHarnessEvolveArgs(workspace)],
    {
      cwd: REPO_ROOT,
      env: process.env,
      ...(process.platform === 'win32' ? { shell: true } : {}),
    },
  );

  state = {
    running: true,
    workspace,
    startedAt: Date.now(),
    startedBy: input.startedBy,
    lines: [],
    result: null,
  };
  logger.info(
    { workspace, startedBy: input.startedBy },
    'Harness evolve triggered via web (external executor child process)',
  );

  const pushLine = (line: string): void => {
    if (!line) return;
    state.lines.push(line);
    if (state.lines.length > MAX_TAIL_LINES) {
      state.lines = state.lines.slice(-MAX_TAIL_LINES);
    }
  };

  const finish = (result: HarnessEvolveTriggerResult): void => {
    if (!state.running) return;
    if (activeTimeout) {
      clearTimeout(activeTimeout);
      activeTimeout = null;
    }
    state.running = false;
    state.result = result;
    if (result.success) {
      logger.info({ workspace }, 'Harness evolve run completed');
    } else {
      logger.error(
        { workspace, error: result.error },
        'Harness evolve run failed',
      );
    }
  };

  activeTimeout = setTimeout(() => {
    child.kill('SIGKILL');
    finish({
      success: false,
      error: `Harness evolve run timed out after ${EVOLVE_RUN_TIMEOUT_MS / 60000} minutes`,
    });
  }, EVOLVE_RUN_TIMEOUT_MS);
  activeTimeout.unref?.();

  // Line splitting without readline (eval-trigger precedent: the fake child
  // processes in tests are plain EventEmitters; manual split keeps partial-line
  // buffering explicit).
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
            error: `Harness evolve run exited with code ${code ?? 'null'}`,
          },
    );
  });

  child.on('error', (err: Error) => {
    finish({ success: false, error: err.message });
  });

  return { ok: true };
}

/** Test hook — drop state and timers between tests. */
export function resetHarnessEvolveTriggerForTests(): void {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  state = {
    running: false,
    workspace: null,
    startedAt: null,
    startedBy: null,
    lines: [],
    result: null,
  };
  spawnFn = null;
}
