import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';

/**
 * Host-side owner of the auto-memory sidecar processes (docs/
 * auto-memory-sidecar-ownership-plan.md, T1).
 *
 * One sidecar process per workspace folder, held by the server instead of
 * each runner: Qdrant local mode is a single-writer store, so per-runner
 * sidecars deadlocked on the `.lock` file whenever a warm interactive
 * container overlapped an isolated task run. With the host as the only
 * spawner, single-writer access holds by construction.
 *
 * Per folder the manager keeps: a lazily spawned `python
 * auto_memory_sidecar.py` child, a serial op queue (the mem0 Memory
 * instance is not thread-safe, and the queue also serializes spawn/init),
 * an idle TTL that stops the process (~140MB RSS) with lazy respawn on the
 * next call, and a crash-restart budget that a successful init handshake
 * resets (task-C semantics). Every failure degrades to
 * `{ available: false }` — auto memory must never break a caller.
 */

export interface AutoMemorySidecarEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AutoMemorySidecarConfig {
  dataPath: string;
  collection: string;
  userId: string;
  llm?: AutoMemorySidecarEndpoint;
  embedder?: AutoMemorySidecarEndpoint;
}

export type AutoMemorySidecarOp =
  | 'add'
  | 'search'
  | 'get'
  | 'list'
  | 'delete'
  | 'delete_all'
  | 'ping';

export type AutoMemorySidecarResult<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export interface PythonInterpreter {
  command: string;
  args: string[];
}

export interface AutoMemorySidecarManagerOptions {
  requestTimeoutMs?: number;
  /** Idle minutes… milliseconds before the sidecar is stopped; 0 disables. */
  idleTtlMs?: number;
  maxSpawnAttempts?: number;
  /**
   * How long a sticky unavailable state (spawn-budget exhaustion,
   * interpreter-resolution failure) holds before the next call retries the
   * environment. Guards against one transient outage window disabling a
   * workspace's auto memory until a server restart (quality review M1).
   */
  budgetCooldownMs?: number;
  /** Defaults to findHostSidecarScript() from this module's location. */
  scriptPath?: string;
  /** Defaults to pythonInterpreterCandidates() probed with spawnSync. */
  interpreterCandidates?: PythonInterpreter[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 600_000;
const DEFAULT_BUDGET_COOLDOWN_MS = 600_000;
const MAX_SPAWN_ATTEMPTS = 3;
const INTERPRETER_PROBE_TIMEOUT_MS = 10_000;
const KNOWN_OPS: ReadonlySet<string> = new Set([
  'add',
  'search',
  'get',
  'list',
  'delete',
  'delete_all',
  'ping',
]);

/**
 * Interpreter candidates for spawning the sidecar, in try order.
 *
 * `python3` on Windows is often the WindowsApps store stub (exit 49), so the
 * py launcher is preferred there. The env override takes the interpreter
 * executable path only — no arguments (point it at a real python.exe).
 */
export function pythonInterpreterCandidates(
  platform: NodeJS.Platform = process.platform,
): PythonInterpreter[] {
  const candidates: PythonInterpreter[] = [];
  const override = process.env.CKQCLAW_AUTO_MEMORY_PYTHON;
  if (override) candidates.push({ command: override, args: [] });
  if (platform === 'win32') candidates.push({ command: 'py', args: ['-3'] });
  candidates.push({ command: 'python3', args: [] });
  return candidates;
}

function interpreterWorks(candidate: PythonInterpreter): boolean {
  // `--version` is shared by python/py/node and the store stub ignores it
  // (exit 49), so a plain exit-code probe separates real interpreters.
  const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
    timeout: INTERPRETER_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return probe.status === 0;
}

export function resolvePythonInterpreter(
  options: {
    candidates?: PythonInterpreter[];
    probe?: (candidate: PythonInterpreter) => boolean;
  } = {},
): PythonInterpreter | null {
  const candidates = options.candidates ?? pythonInterpreterCandidates();
  const probe = options.probe ?? interpreterWorks;
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate auto_memory_sidecar.py for the host server.
 *
 * CKQCLAW_AUTO_MEMORY_SIDECAR is authoritative when set: a set-but-missing
 * override is an operator misconfiguration and returns null instead of
 * silently falling back. Otherwise the search walks up from `startDir` to
 * the package root and expects the repo checkout layout
 * (<root>/container/agent-runner/python/…), falling back to a bundled
 * <root>/python/… layout for packaged distributions.
 */
export function findHostSidecarScript(startDir: string): string | null {
  const override = process.env.CKQCLAW_AUTO_MEMORY_SIDECAR;
  if (override) return fs.existsSync(override) ? override : null;
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const inRepo = path.join(
        dir,
        'container',
        'agent-runner',
        'python',
        'auto_memory_sidecar.py',
      );
      if (fs.existsSync(inRepo)) return inRepo;
      const bundled = path.join(dir, 'python', 'auto_memory_sidecar.py');
      if (fs.existsSync(bundled)) return bundled;
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const toProtocol = (endpoint?: AutoMemorySidecarEndpoint) =>
  endpoint
    ? {
        base_url: endpoint.baseUrl,
        api_key: endpoint.apiKey,
        model: endpoint.model,
      }
    : undefined;

interface SidecarResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

interface PendingRequest {
  resolve: (value: SidecarResponse<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface FolderEntry {
  folder: string;
  child: ChildProcessWithoutNullStreams | null;
  /** Resolved interpreter; null = resolution already failed (cooldown-bound). */
  interpreter: PythonInterpreter | null | undefined;
  spawnAttempts: number;
  spawnCount: number;
  unavailableReason: string | null;
  /** When unavailableReason was set; drives the cooldown self-heal (M1). */
  unavailableSince: number | null;
  pending: Map<number, PendingRequest>;
  nextRequestId: number;
  tail: Promise<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class AutoMemorySidecarManager {
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly maxSpawnAttempts: number;
  private readonly budgetCooldownMs: number;
  private readonly interpreterCandidates: PythonInterpreter[] | undefined;
  private readonly scriptPath: string | null;
  private readonly entries = new Map<string, FolderEntry>();

  constructor(options: AutoMemorySidecarManagerOptions = {}) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxSpawnAttempts = options.maxSpawnAttempts ?? MAX_SPAWN_ATTEMPTS;
    this.budgetCooldownMs =
      options.budgetCooldownMs ?? DEFAULT_BUDGET_COOLDOWN_MS;
    this.interpreterCandidates = options.interpreterCandidates;
    this.scriptPath =
      options.scriptPath ??
      findHostSidecarScript(path.dirname(fileURLToPath(import.meta.url)));
  }

  /**
   * Run one sidecar op for a workspace folder. `config` is used when the
   * (re)spawns; a running sidecar keeps the config it was initialized with
   * until it is stopped by TTL, crash, or an explicit stop().
   */
  async call(
    folder: string,
    config: AutoMemorySidecarConfig,
    op: AutoMemorySidecarOp,
    args: Record<string, unknown>,
  ): Promise<AutoMemorySidecarResult<unknown>> {
    const entry = this.entry(folder);
    return this.enqueue(entry, async () => {
      this.clearIdleTimer(entry);
      try {
        return await this.perform(entry, config, op, args);
      } finally {
        this.scheduleIdleStop(entry);
      }
    });
  }

  /** Workspace reset / operator escape hatch: drop the entry, budget included. */
  async stop(folder: string): Promise<void> {
    const entry = this.entries.get(folder);
    if (!entry) return;
    this.entries.delete(folder);
    await entry.tail.catch(() => {});
    this.shutdownEntry(entry);
  }

  async stopAll(): Promise<void> {
    for (const folder of [...this.entries.keys()]) {
      await this.stop(folder);
    }
  }

  isRunning(folder: string): boolean {
    return Boolean(this.entries.get(folder)?.child);
  }

  /** Test/diagnostics hook: sidecar spawns so far for this folder. */
  spawnCountForTest(folder: string): number {
    return this.entries.get(folder)?.spawnCount ?? 0;
  }

  /** Test hook: simulate an external crash of the sidecar process. */
  killChildForTest(folder: string): void {
    const entry = this.entries.get(folder);
    if (entry) this.killChild(entry);
  }

  private entry(folder: string): FolderEntry {
    let entry = this.entries.get(folder);
    if (!entry) {
      entry = {
        folder,
        child: null,
        interpreter: undefined,
        spawnAttempts: 0,
        spawnCount: 0,
        unavailableReason: null,
        unavailableSince: null,
        pending: new Map(),
        nextRequestId: 1,
        tail: Promise.resolve(),
        idleTimer: null,
      };
      this.entries.set(folder, entry);
    }
    return entry;
  }

  private enqueue<T>(entry: FolderEntry, task: () => Promise<T>): Promise<T> {
    const run = entry.tail.then(task, task);
    entry.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async perform(
    entry: FolderEntry,
    config: AutoMemorySidecarConfig,
    op: AutoMemorySidecarOp,
    args: Record<string, unknown>,
  ): Promise<AutoMemorySidecarResult<unknown>> {
    if (!KNOWN_OPS.has(op)) {
      return { available: false, reason: `unknown auto-memory op: ${op}` };
    }
    if (!config.llm || !config.embedder) {
      return {
        available: false,
        reason:
          'auto memory is not configured (missing llm/embedder endpoints)',
      };
    }
    const ready = await this.ensureReady(entry, config);
    if (!ready.ok) return { available: false, reason: ready.reason };
    const response = await this.request(entry, op, { args });
    if (!response.ok) {
      return {
        available: false,
        reason: response.error ?? `auto-memory ${op} failed`,
      };
    }
    return { available: true, value: response.result };
  }

  private async ensureReady(
    entry: FolderEntry,
    config: AutoMemorySidecarConfig,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (entry.child) return { ok: true };
    if (entry.unavailableReason) {
      // Cooldown self-heal (quality review M1): one transient outage window
      // (embedder outage, mem0ai installed late) must not disable this
      // workspace's auto memory until a server restart — past the cooldown
      // the budget and the interpreter probe both retry.
      if (
        entry.unavailableSince !== null &&
        Date.now() - entry.unavailableSince >= this.budgetCooldownMs
      ) {
        entry.unavailableReason = null;
        entry.unavailableSince = null;
        entry.spawnAttempts = 0;
        entry.interpreter = undefined;
      } else {
        return { ok: false, reason: entry.unavailableReason };
      }
    }
    if (entry.interpreter === undefined) {
      const tried = this.interpreterCandidates ?? pythonInterpreterCandidates();
      entry.interpreter = resolvePythonInterpreter({ candidates: tried });
      if (!entry.interpreter) {
        entry.unavailableReason =
          `no usable Python interpreter for the auto-memory sidecar ` +
          `(tried: ${tried.map((c) => c.command).join(', ')})`;
        entry.unavailableSince = Date.now();
        return { ok: false, reason: entry.unavailableReason };
      }
    }
    return this.spawnSidecar(entry, config);
  }

  private async spawnSidecar(
    entry: FolderEntry,
    config: AutoMemorySidecarConfig,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (entry.spawnAttempts >= this.maxSpawnAttempts) {
      entry.unavailableReason =
        `auto-memory sidecar spawn failed ${this.maxSpawnAttempts} times ` +
        `for workspace ${entry.folder}; giving up until the cooldown ` +
        `(${Math.round(this.budgetCooldownMs / 1000)}s) or stop() resets it`;
      entry.unavailableSince = Date.now();
      return { ok: false, reason: entry.unavailableReason };
    }
    if (!this.scriptPath) {
      entry.unavailableReason =
        'auto-memory sidecar script not found ' +
        '(set CKQCLAW_AUTO_MEMORY_SIDECAR to auto_memory_sidecar.py)';
      return { ok: false, reason: entry.unavailableReason };
    }
    entry.spawnAttempts += 1;
    entry.spawnCount += 1;
    const interpreter = entry.interpreter as PythonInterpreter;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        interpreter.command,
        [...interpreter.args, this.scriptPath],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // mem0ai 2.2.1's telemetry branch (default on) opens a second
          // qdrant-local store at a FIXED shared path (~/.mem0/
          // migrations_qdrant) for every Memory instance — created but
          // never consumed. With one sidecar per workspace, the second
          // concurrent sidecar init dies on "already accessed by another
          // instance of Qdrant client". Force the env off: the store is
          // dead weight, and posthog beacons from a self-hosted host are
          // unwanted telemetry anyway (task X live finding, 2026-11-10).
          env: { ...process.env, MEM0_TELEMETRY: 'false' },
        },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      return {
        ok: false,
        reason: `sidecar spawn failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    child.on('exit', (code) => {
      if (entry.child === child) {
        entry.child = null;
        this.rejectAllPending(
          entry,
          `auto-memory sidecar exited (code ${code ?? 'signal'})`,
        );
      }
    });
    // Rapid-exit children lose the stdin pipe mid-write; the request's own
    // exit rejection handles the failure, EPIPE must not crash the server.
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      logger.warn(
        { folder: entry.folder, stderr: chunk.slice(0, 500) },
        'auto-memory sidecar stderr',
      );
    });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(entry, line));
    entry.child = child;

    // Protocol keys are snake_case (auto_memory_sidecar.py docstring);
    // translated here so the Python side keeps its documented contract.
    const init = await this.request(entry, 'init', {
      config: {
        data_path: config.dataPath,
        collection: config.collection,
        user_id: config.userId,
        llm: toProtocol(config.llm),
        embedder: toProtocol(config.embedder),
      },
    });
    if (!init.ok) {
      // Init failure exits the child too; keep the reason transient (the
      // budget bounds retries) so e.g. a mem0ai install is picked up on the
      // next call instead of sticking for the server's lifetime.
      this.killChild(entry);
      return {
        ok: false,
        reason: init.error ?? 'auto-memory sidecar init failed',
      };
    }
    // A successful handshake proves the environment works; earlier transient
    // failures must not count against future crash restarts.
    entry.spawnAttempts = 0;
    entry.unavailableReason = null;
    return { ok: true };
  }

  private killChild(entry: FolderEntry): void {
    const child = entry.child;
    entry.child = null;
    if (child) {
      child.removeAllListeners();
      child.kill();
    }
  }

  private shutdownEntry(entry: FolderEntry): void {
    this.clearIdleTimer(entry);
    this.rejectAllPending(entry, 'auto-memory sidecar stopped');
    this.killChild(entry);
  }

  private rejectAllPending(entry: FolderEntry, reason: string): void {
    for (const [, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: reason });
    }
    entry.pending.clear();
  }

  private handleLine(entry: FolderEntry, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: {
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
    };
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = entry.pending.get(message.id);
    if (!pending) return;
    entry.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: message.ok === true,
      result: message.result,
      error: message.error,
    });
  }

  private request(
    entry: FolderEntry,
    op: string,
    body: Record<string, unknown> = {},
  ): Promise<SidecarResponse> {
    return new Promise((resolve) => {
      const child = entry.child;
      if (!child) {
        resolve({ ok: false, error: 'auto-memory sidecar is not running' });
        return;
      }
      const timeoutMs = this.requestTimeoutMs;
      const id = entry.nextRequestId++;
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        // A timed-out op wedges the sidecar's serial stdin loop (mem0's
        // client can hang for minutes past our timeout); kill the child so
        // the next call respawns fresh instead of every queued op burning
        // the full timeout behind the hung one (quality review M2).
        this.killChild(entry);
        resolve({
          ok: false,
          error: `auto-memory sidecar ${op} timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      entry.pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...body })}\n`);
    });
  }

  private scheduleIdleStop(entry: FolderEntry): void {
    this.clearIdleTimer(entry);
    if (this.idleTtlMs <= 0) return;
    const timer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.child) {
        logger.info(
          { folder: entry.folder },
          'auto-memory sidecar idle TTL reached — stopping (lazy respawn on next call)',
        );
        this.killChild(entry);
      }
    }, this.idleTtlMs);
    // The server must be able to exit without waiting out the TTL.
    timer.unref();
    entry.idleTimer = timer;
  }

  private clearIdleTimer(entry: FolderEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }
}
