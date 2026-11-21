import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

export type RunnerRuntime = 'host' | 'container';
type RunnerCpuActivity = 'active' | 'inactive' | 'unknown' | 'unavailable';

export interface StuckRecoveryCandidate {
  jid: string;
  idleMs: number;
  reason: 'pending_messages' | 'ipc_injected';
  runtime: RunnerRuntime;
  /** Monotonic identity of the concrete GroupQueue runner lifecycle. */
  runnerGeneration: number;
  /** Exact logical query observed when the candidate was selected. */
  queryId: string | null;
  /** Host-side process identity used by the CPU probe, if registered. */
  runnerPid: number | null;
  /** Absolute debt clock used to reject a later query's fresh IPC work. */
  ipcOwedSinceAt: number | null;
  /** Age of the oldest IPC input still owed by the current logical query. */
  ipcOwedMs: number | null;
}

type StuckRecoveryDecision =
  | {
      action: 'restart';
      reason: 'idle' | 'idle_ceiling' | 'absolute_ipc_ceiling';
    }
  | {
      action: 'defer';
      reason: 'container_grace' | 'cpu_active' | 'cpu_unknown';
    };

type HostProcessTableReader = () => Promise<string>;
type HostRunnerCpuProbe = (
  pid: number,
  context: StuckRecoveryCandidate,
) => Promise<RunnerCpuActivity>;
type HostProcessLivenessProbe = (pid: number) => boolean;

interface RunnerCpuResolutionOptions {
  /** Test seam: defaults to the real host platform. */
  platform?: NodeJS.Platform;
  isProcessAlive?: HostProcessLivenessProbe;
}

const execFileAsync = promisify(execFile);

async function readHostProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pcpu='], {
    timeout: 3000,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * Map a failed `process.kill(pid, 0)` probe to liveness. EPERM means the
 * process exists but is owned by another user (alive); every other failure
 * (ESRCH, invalid pid, …) means it is gone.
 */
export function isProcessKillErrorAlive(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM';
}

export function isHostProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isProcessKillErrorAlive(err);
  }
}

/**
 * Windows has no Unix `ps` (the Git Bash shim exits 1), so the host runner's
 * descendant CPU tree is unobservable. Fall back to a liveness heuristic: a
 * dead runner with owed work is unambiguously stuck — parity with the Unix
 * path, where a dead pid yields no descendants and reads as 'inactive' —
 * while a live runner is conservatively 'unknown' and stays bounded by the
 * recovery ceilings (absolute IPC ceiling / idle ceiling) rather than an
 * unlimited cpu_unknown veto.
 */
export async function probeHostRunnerLivenessWin32(
  pid: number,
  context: Pick<
    StuckRecoveryCandidate,
    'jid' | 'idleMs' | 'reason' | 'runtime' | 'ipcOwedMs'
  >,
  isProcessAlive: HostProcessLivenessProbe = isHostProcessAlive,
): Promise<RunnerCpuActivity> {
  const alive = isProcessAlive(pid);
  logger.info(
    {
      chatJid: context.jid,
      pid,
      idleMs: context.idleMs,
      reason: context.reason,
      runtime: context.runtime,
      ipcOwedMs: context.ipcOwedMs,
      runnerAlive: alive,
    },
    alive
      ? 'Windows: host runner CPU is unobservable; liveness heuristic keeps the live runner under the recovery grace ceilings'
      : 'Windows: host runner process is gone; treating owed work as inactive so recovery can restart it',
  );
  return alive ? 'unknown' : 'inactive';
}

/**
 * Inspect a host runner's real descendant process tree. Docker workloads are
 * deliberately excluded: container processes belong to Docker/containerd,
 * not to the host-side `docker` CLI process tree.
 */
export async function probeHostRunnerCpu(
  pid: number,
  context: Pick<
    StuckRecoveryCandidate,
    'jid' | 'idleMs' | 'reason' | 'runtime' | 'ipcOwedMs'
  >,
  readProcessTable: HostProcessTableReader = readHostProcessTable,
): Promise<RunnerCpuActivity> {
  try {
    const stdout = await readProcessTable();
    const children = new Map<number, number[]>();
    const cpuByPid = new Map<number, number>();
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const processPid = Number.parseInt(parts[0], 10);
      const parentPid = Number.parseInt(parts[1], 10);
      const cpu = Number.parseFloat(parts[2]);
      if (
        Number.isNaN(processPid) ||
        Number.isNaN(parentPid) ||
        Number.isNaN(cpu)
      ) {
        continue;
      }
      const siblings = children.get(parentPid) ?? [];
      siblings.push(processPid);
      children.set(parentPid, siblings);
      cpuByPid.set(processPid, cpu);
    }

    const visited = new Set<number>();
    const stack = [pid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const descendants = children.get(current);
      if (!descendants) continue;
      for (const descendant of descendants) {
        if ((cpuByPid.get(descendant) ?? 0) > 0.5) return 'active';
        stack.push(descendant);
      }
    }
    return 'inactive';
  } catch (err) {
    logger.warn(
      {
        err,
        chatJid: context.jid,
        pid,
        idleMs: context.idleMs,
        reason: context.reason,
        runtime: context.runtime,
        ipcOwedMs: context.ipcOwedMs,
      },
      'Failed to inspect host runner descendant CPU; deferring stuck restart',
    );
    return 'unknown';
  }
}

/**
 * Resolve observable CPU activity without crossing runtime boundaries. The
 * host-side Docker CLI PID is lifecycle plumbing, not the container workload.
 * Windows cannot run the Unix process-table probe, so it resolves through the
 * liveness heuristic instead (see probeHostRunnerLivenessWin32).
 */
export async function resolveRunnerCpuActivity(
  candidate: StuckRecoveryCandidate,
  probe: HostRunnerCpuProbe = probeHostRunnerCpu,
  options: RunnerCpuResolutionOptions = {},
): Promise<RunnerCpuActivity> {
  const pid = candidate.runnerPid;
  if (candidate.runtime !== 'host' || !pid) return 'unavailable';
  if ((options.platform ?? process.platform) === 'win32') {
    return probeHostRunnerLivenessWin32(pid, candidate, options.isProcessAlive);
  }
  return probe(pid, candidate);
}

/**
 * Decide whether an already-idle candidate should restart now. IPC work uses
 * an absolute debt age that ordinary output cannot refresh. Before that
 * ceiling, container work is conservatively preserved because host `ps`
 * cannot observe CPU inside Docker; host probe failures are likewise deferred.
 */
export function decideStuckRunnerRecovery(
  candidate: StuckRecoveryCandidate,
  cpuActivity: RunnerCpuActivity,
  forceRestartMs: number,
): StuckRecoveryDecision {
  if (
    candidate.reason === 'ipc_injected' &&
    candidate.ipcOwedMs !== null &&
    candidate.ipcOwedMs >= forceRestartMs
  ) {
    return { action: 'restart', reason: 'absolute_ipc_ceiling' };
  }

  // CPU activity and unobservable container work are grace signals, not an
  // unlimited veto. Pending-message recovery still needs a hard upper bound.
  if (candidate.idleMs >= forceRestartMs) {
    return { action: 'restart', reason: 'idle_ceiling' };
  }

  if (candidate.runtime === 'container') {
    return { action: 'defer', reason: 'container_grace' };
  }

  if (cpuActivity === 'active') {
    return { action: 'defer', reason: 'cpu_active' };
  }
  if (cpuActivity === 'unknown') {
    return { action: 'defer', reason: 'cpu_unknown' };
  }
  return { action: 'restart', reason: 'idle' };
}
