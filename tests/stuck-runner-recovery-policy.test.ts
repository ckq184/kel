import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  decideStuckRunnerRecovery,
  probeHostRunnerCpu,
  resolveRunnerCpuActivity,
  isProcessKillErrorAlive,
} = await import('../src/stuck-runner-recovery.js');
const { logger } = await import('../src/logger.js');

type Candidate =
  import('../src/stuck-runner-recovery.js').StuckRecoveryCandidate;

const FORCE_RESTART_MS = 10 * 60 * 1000;

function ipcCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    jid: 'web:stuck-policy',
    idleMs: 3 * 60 * 1000,
    reason: 'ipc_injected',
    runtime: 'host',
    runnerGeneration: 1,
    queryId: 'query-1',
    runnerPid: 4242,
    ipcOwedSinceAt: 1,
    ipcOwedMs: 3 * 60 * 1000,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('stuck runner recovery policy', () => {
  test('host CPU activity defers at 3m but the absolute IPC ceiling forces at 10m', () => {
    expect(
      decideStuckRunnerRecovery(ipcCandidate(), 'active', FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'cpu_active' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ ipcOwedMs: FORCE_RESTART_MS }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'absolute_ipc_ceiling' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          reason: 'pending_messages',
          idleMs: FORCE_RESTART_MS,
          ipcOwedMs: null,
        }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('container work is never inferred from the host docker CLI process tree', () => {
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ runtime: 'container' }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'defer', reason: 'container_grace' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          runtime: 'container',
          idleMs: 30_000,
          ipcOwedMs: FORCE_RESTART_MS,
        }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'absolute_ipc_ceiling' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          reason: 'pending_messages',
          runtime: 'container',
          idleMs: FORCE_RESTART_MS,
          ipcOwedMs: null,
        }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('container runtime never invokes the host process-tree probe', async () => {
    const hostProbe = vi.fn().mockResolvedValue('active');

    await expect(
      resolveRunnerCpuActivity(
        ipcCandidate({ runtime: 'container', runnerPid: 4242 }),
        hostProbe,
      ),
    ).resolves.toBe('unavailable');
    expect(hostProbe).not.toHaveBeenCalled();
  });

  test('host CPU probe failures log context and conservatively defer', async () => {
    const candidate = ipcCandidate();
    const cpuActivity = await probeHostRunnerCpu(4242, candidate, async () => {
      throw new Error('ps unavailable');
    });

    expect(cpuActivity).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: candidate.jid,
        pid: 4242,
        idleMs: candidate.idleMs,
        reason: candidate.reason,
        runtime: candidate.runtime,
        ipcOwedMs: candidate.ipcOwedMs,
      }),
      'Failed to inspect host runner descendant CPU; deferring stuck restart',
    );
    expect(
      decideStuckRunnerRecovery(candidate, cpuActivity, FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'cpu_unknown' });

    expect(
      decideStuckRunnerRecovery(
        { ...candidate, idleMs: FORCE_RESTART_MS },
        cpuActivity,
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('host CPU probe detects active nested descendants', async () => {
    const cpuActivity = await probeHostRunnerCpu(
      100,
      ipcCandidate(),
      async () => ['100 1 0.0', '200 100 0.0', '300 200 1.5'].join('\n'),
    );

    expect(cpuActivity).toBe('active');
  });

  test('container pending-message recovery gets the same 3m grace', () => {
    const pending: Candidate = {
      ...ipcCandidate(),
      reason: 'pending_messages',
      runtime: 'container',
      ipcOwedMs: null,
    };

    expect(
      decideStuckRunnerRecovery(pending, 'unavailable', FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'container_grace' });
  });
});

describe('windows stuck-runner recovery branch (win32)', () => {
  test('a dead runner process resolves to inactive without invoking the ps probe', async () => {
    const psProbe = vi.fn(probeHostRunnerCpu);

    const activity = await resolveRunnerCpuActivity(ipcCandidate(), psProbe, {
      platform: 'win32',
      isProcessAlive: () => false,
    });

    expect(activity).toBe('inactive');
    expect(psProbe).not.toHaveBeenCalled();
  });

  test('a live runner stays unobservable (unknown) and never invokes ps', async () => {
    const psProbe = vi.fn(probeHostRunnerCpu);

    const activity = await resolveRunnerCpuActivity(ipcCandidate(), psProbe, {
      platform: 'win32',
      isProcessAlive: () => true,
    });

    expect(activity).toBe('unknown');
    expect(psProbe).not.toHaveBeenCalled();
  });

  test('a dead runner with owed idle work restarts at the idle threshold (Unix parity)', async () => {
    // The ps probe must never be consulted on win32, even one that would
    // report activity — liveness is the only observable signal there.
    const activity = await resolveRunnerCpuActivity(
      ipcCandidate(),
      async () => 'active',
      { platform: 'win32', isProcessAlive: () => false },
    );

    expect(activity).toBe('inactive');
    expect(
      decideStuckRunnerRecovery(ipcCandidate(), activity, FORCE_RESTART_MS),
    ).toEqual({ action: 'restart', reason: 'idle' });
  });

  test('a live runner keeps the conservative grace: defer within, ceiling beyond', async () => {
    const candidate = ipcCandidate();

    expect(
      decideStuckRunnerRecovery(candidate, 'unknown', FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'cpu_unknown' });
    expect(
      decideStuckRunnerRecovery(
        { ...candidate, idleMs: FORCE_RESTART_MS },
        'unknown',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('non-windows platforms keep delegating to the process-table probe', async () => {
    const psProbe = vi.fn().mockResolvedValue('active');
    const liveness = vi.fn(() => false);

    const activity = await resolveRunnerCpuActivity(ipcCandidate(), psProbe, {
      platform: 'linux',
      isProcessAlive: liveness,
    });

    expect(activity).toBe('active');
    expect(liveness).not.toHaveBeenCalled();
  });

  test('process.kill failure mapping: EPERM means alive, anything else means gone', () => {
    expect(isProcessKillErrorAlive({ code: 'EPERM' })).toBe(true);
    expect(isProcessKillErrorAlive({ code: 'ESRCH' })).toBe(false);
    expect(isProcessKillErrorAlive(new Error('boom'))).toBe(false);
    expect(isProcessKillErrorAlive(null)).toBe(false);
  });
});
