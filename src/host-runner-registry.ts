import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { isHostProcessAlive } from './stuck-runner-recovery.js';

const execFileAsync = promisify(execFile);

/**
 * Detached host runners survive a force-killed server (that is what
 * `detached: true` buys the Windows process-tree killer), so the server needs
 * a durable record of the runners it owns to converge the orphans on the next
 * boot. The registry is a single JSON file under data/runtime/ (gitignored
 * with the rest of data/): [{pid, folder, bootId, spawnedAt}].
 */
export interface HostRunnerRegistryEntry {
  pid: number;
  folder: string;
  bootId: string;
  /** Epoch ms captured at spawn time; anchors the pid-reuse guard. */
  spawnedAt: number;
}

type HostRunnerReapDecision =
  | { action: 'kill'; reason: 'stale_boot_alive' }
  | { action: 'keep'; reason: 'current_boot' }
  | { action: 'drop-entry'; reason: 'process_dead' | 'pid_reuse_suspected' };

interface ReapLiveness {
  alive: boolean;
  /** Process creation time (epoch ms) when the platform can observe it. */
  processCreateTimeMs?: number | null;
}

interface ReapOrphanOptions {
  registryPath?: string;
  currentBootId?: string;
  platform?: NodeJS.Platform;
  isProcessAlive?: (pid: number) => boolean;
  getCreateTimeMs?: (pid: number) => Promise<number | null>;
  killProcess?: (pid: number) => Promise<void>;
  /** Max |processCreateTimeMs - spawnedAt| before a live pid is treated as reused. */
  pidReuseToleranceMs?: number;
}

interface ReapOrphanResult {
  killed: number[];
  dropped: number[];
  kept: number[];
}

let serverBootId: string | null = null;

/** Identity of this server process, generated once per boot. */
export function getServerBootId(): string {
  serverBootId ??= crypto.randomUUID();
  return serverBootId;
}

function defaultRegistryPath(): string {
  return path.join(DATA_DIR, 'runtime', 'host-runners.json');
}

export function readHostRunnerRegistry(
  filePath: string = defaultRegistryPath(),
): HostRunnerRegistryEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is HostRunnerRegistryEntry =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as HostRunnerRegistryEntry).pid === 'number' &&
        typeof (item as HostRunnerRegistryEntry).bootId === 'string',
    );
  } catch {
    // Missing or corrupt file: start from an empty table rather than failing
    // the boot — the registry is an orphan-convergence aid, not critical state.
    return [];
  }
}

function writeHostRunnerRegistry(
  filePath: string,
  entries: HostRunnerRegistryEntry[],
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function registerHostRunner(
  entry: HostRunnerRegistryEntry,
  filePath: string = defaultRegistryPath(),
): void {
  try {
    const entries = readHostRunnerRegistry(filePath).filter(
      (item) => item.pid !== entry.pid,
    );
    entries.push(entry);
    writeHostRunnerRegistry(filePath, entries);
  } catch (err) {
    logger.warn(
      { err, pid: entry.pid, folder: entry.folder },
      'Failed to register host runner in the orphan registry',
    );
  }
}

export function unregisterHostRunner(
  pid: number,
  filePath: string = defaultRegistryPath(),
): void {
  try {
    const entries = readHostRunnerRegistry(filePath);
    const next = entries.filter((item) => item.pid !== pid);
    if (next.length === entries.length) return;
    writeHostRunnerRegistry(filePath, next);
  } catch (err) {
    logger.warn({ err, pid }, 'Failed to unregister host runner');
  }
}

/**
 * Pure reap decision for one registry entry. A runner registered under a
 * previous bootId that is still alive is an orphan (the server that owned it
 * died without shutdown hooks) and gets the process-tree kill. The create-time
 * guard protects against pid reuse killing an innocent young process: when the
 * live process was created long after the registration, only the entry is
 * dropped. Entries owned by the current boot are always kept — their normal
 * exit path unregisters them.
 */
export function decideHostRunnerReap(
  registryEntry: HostRunnerRegistryEntry,
  currentBootId: string,
  liveness: ReapLiveness,
  options?: { pidReuseToleranceMs?: number },
): HostRunnerReapDecision {
  if (registryEntry.bootId === currentBootId) {
    return { action: 'keep', reason: 'current_boot' };
  }
  if (!liveness.alive) {
    return { action: 'drop-entry', reason: 'process_dead' };
  }
  const createTime = liveness.processCreateTimeMs;
  if (
    createTime !== null &&
    createTime !== undefined &&
    Math.abs(createTime - registryEntry.spawnedAt) >
      (options?.pidReuseToleranceMs ?? 120_000)
  ) {
    return { action: 'drop-entry', reason: 'pid_reuse_suspected' };
  }
  return { action: 'kill', reason: 'stale_boot_alive' };
}

/** Process creation time where the platform exposes it; null otherwise. */
async function getProcessCreateTimeMs(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTime()`,
        ],
        { timeout: 5000 },
      );
      const fileTime = BigInt(stdout.trim());
      // .NET FILETIME: 100ns ticks since 1601-01-01 UTC.
      return Number(fileTime / 10_000n) - 11_644_473_600_000;
    }
    if (platform === 'linux') {
      return fs.statSync(`/proc/${pid}`).mtimeMs;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultKillProcess(
  pid: number,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: 10_000,
    });
    return;
  }
  process.kill(pid, 'SIGKILL');
}

/**
 * Startup orphan convergence: every registry entry owned by a previous boot
 * whose process is still alive gets the process-tree kill; dead or reused
 * pids only prune the entry; current-boot entries are untouched. The pruned
 * registry is written back only when something changed.
 */
export async function reapOrphanedHostRunners(
  options: ReapOrphanOptions = {},
): Promise<ReapOrphanResult> {
  const result: ReapOrphanResult = { killed: [], dropped: [], kept: [] };
  const registryPath = options.registryPath ?? defaultRegistryPath();
  const currentBootId = options.currentBootId ?? getServerBootId();
  const platform = options.platform ?? process.platform;
  const isProcessAlive = options.isProcessAlive ?? isHostProcessAlive;
  const getCreateTimeMs =
    options.getCreateTimeMs ??
    ((pid: number) => getProcessCreateTimeMs(pid, platform));
  const killProcess =
    options.killProcess ?? ((pid: number) => defaultKillProcess(pid, platform));

  let entries: HostRunnerRegistryEntry[];
  try {
    entries = readHostRunnerRegistry(registryPath);
  } catch (err) {
    logger.warn({ err }, 'Failed to read the host runner registry for reap');
    return result;
  }
  if (entries.length === 0) return result;

  const surviving: HostRunnerRegistryEntry[] = [];
  for (const registryEntry of entries) {
    const decision = decideHostRunnerReap(
      registryEntry,
      currentBootId,
      {
        alive: isProcessAlive(registryEntry.pid),
        processCreateTimeMs: null,
      },
      { pidReuseToleranceMs: options.pidReuseToleranceMs },
    );
    if (decision.action === 'keep') {
      result.kept.push(registryEntry.pid);
      surviving.push(registryEntry);
      continue;
    }
    if (decision.action === 'drop-entry') {
      result.dropped.push(registryEntry.pid);
      logger.info(
        {
          pid: registryEntry.pid,
          folder: registryEntry.folder,
          reason: decision.reason,
        },
        'Host runner registry entry dropped without killing',
      );
      continue;
    }
    // kill: refine with the create-time guard before pulling the trigger.
    let liveness: ReapLiveness = { alive: true };
    try {
      liveness = {
        alive: true,
        processCreateTimeMs: await getCreateTimeMs(registryEntry.pid),
      };
    } catch {
      // Guard unavailable: the bootId mismatch plus liveness is the evidence.
    }
    const refined = decideHostRunnerReap(
      registryEntry,
      currentBootId,
      liveness,
      { pidReuseToleranceMs: options.pidReuseToleranceMs },
    );
    if (refined.action !== 'kill') {
      result.dropped.push(registryEntry.pid);
      logger.warn(
        {
          pid: registryEntry.pid,
          folder: registryEntry.folder,
          reason: refined.reason,
        },
        'Host runner kill avoided by the create-time guard; entry dropped',
      );
      continue;
    }
    try {
      await killProcess(registryEntry.pid);
      result.killed.push(registryEntry.pid);
      logger.warn(
        {
          pid: registryEntry.pid,
          folder: registryEntry.folder,
          bootId: registryEntry.bootId,
        },
        'Reaped orphaned host runner from a previous server boot',
      );
    } catch (err) {
      // Keep the entry so the next boot retries the kill.
      result.kept.push(registryEntry.pid);
      surviving.push(registryEntry);
      logger.error(
        { err, pid: registryEntry.pid, folder: registryEntry.folder },
        'Failed to reap orphaned host runner; entry kept for next boot',
      );
    }
  }

  if (
    result.killed.length > 0 ||
    result.dropped.length > 0 ||
    surviving.length !== entries.length
  ) {
    try {
      writeHostRunnerRegistry(registryPath, surviving);
    } catch (err) {
      logger.warn({ err }, 'Failed to persist the pruned host runner registry');
    }
  }
  return result;
}
