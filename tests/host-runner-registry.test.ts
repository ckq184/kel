import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  decideHostRunnerReap,
  readHostRunnerRegistry,
  registerHostRunner,
  unregisterHostRunner,
  reapOrphanedHostRunners,
} = await import('../src/host-runner-registry.js');

const { logger } = await import('../src/logger.js');

type HostRunnerRegistryEntry =
  import('../src/host-runner-registry.js').HostRunnerRegistryEntry;

const createdDirs: string[] = [];
const NOW = 1_700_000_000_000;

afterEach(() => {
  vi.clearAllMocks();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempFile(label: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `runner-registry-${label}-`),
  );
  createdDirs.push(dir);
  return path.join(dir, 'host-runners.json');
}

function entry(
  overrides: Partial<HostRunnerRegistryEntry> = {},
): HostRunnerRegistryEntry {
  return {
    pid: 4242,
    folder: 'flow-abc',
    bootId: 'boot-old',
    spawnedAt: NOW,
    ...overrides,
  };
}

describe('decideHostRunnerReap', () => {
  test('a stale-boot live runner is reaped', () => {
    expect(decideHostRunnerReap(entry(), 'boot-new', { alive: true })).toEqual({
      action: 'kill',
      reason: 'stale_boot_alive',
    });
  });

  test('a live process whose create time is close to the registration is reaped', () => {
    expect(
      decideHostRunnerReap(entry(), 'boot-new', {
        alive: true,
        processCreateTimeMs: NOW + 1_000,
      }),
    ).toEqual({ action: 'kill', reason: 'stale_boot_alive' });
  });

  test('a live process whose create time diverges from the registration is pid reuse: only the entry is dropped', () => {
    expect(
      decideHostRunnerReap(entry(), 'boot-new', {
        alive: true,
        processCreateTimeMs: NOW + 10 * 60 * 1000,
      }),
    ).toEqual({ action: 'drop-entry', reason: 'pid_reuse_suspected' });
  });

  test('a dead process only drops the registry entry', () => {
    expect(decideHostRunnerReap(entry(), 'boot-new', { alive: false })).toEqual(
      { action: 'drop-entry', reason: 'process_dead' },
    );
  });

  test('the current boot owns its entries regardless of liveness', () => {
    expect(
      decideHostRunnerReap(entry({ bootId: 'boot-new' }), 'boot-new', {
        alive: true,
      }),
    ).toEqual({ action: 'keep', reason: 'current_boot' });
    expect(
      decideHostRunnerReap(entry({ bootId: 'boot-new' }), 'boot-new', {
        alive: false,
      }),
    ).toEqual({ action: 'keep', reason: 'current_boot' });
  });
});

describe('host runner registry file', () => {
  test('a missing or corrupt registry file reads as empty without throwing', () => {
    expect(readHostRunnerRegistry(makeTempFile('missing'))).toEqual([]);

    const corrupt = makeTempFile('corrupt');
    fs.writeFileSync(corrupt, '{not json at all', 'utf8');
    expect(readHostRunnerRegistry(corrupt)).toEqual([]);
  });

  test('register, dedupe by pid, and unregister round-trip', () => {
    const file = makeTempFile('roundtrip');

    registerHostRunner(entry(), file);
    registerHostRunner(entry({ pid: 4242, folder: 'flow-updated' }), file);
    registerHostRunner(entry({ pid: 5151, bootId: 'boot-old' }), file);

    const entries = readHostRunnerRegistry(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(entry({ folder: 'flow-updated' }));
    expect(entries[1]).toEqual({
      pid: 5151,
      folder: 'flow-abc',
      bootId: 'boot-old',
      spawnedAt: NOW,
    });

    unregisterHostRunner(4242, file);
    expect(readHostRunnerRegistry(file)).toEqual([
      { pid: 5151, folder: 'flow-abc', bootId: 'boot-old', spawnedAt: NOW },
    ]);

    // Unregistering an unknown pid is a no-op.
    unregisterHostRunner(999999, file);
    expect(readHostRunnerRegistry(file)).toHaveLength(1);
  });
});

describe('reapOrphanedHostRunners', () => {
  function makeRegistry(entries: HostRunnerRegistryEntry[]): string {
    const file = makeTempFile('reap');
    fs.writeFileSync(file, JSON.stringify(entries), 'utf8');
    return file;
  }

  test('a stale-boot live runner is killed and pruned from the registry', async () => {
    const file = makeRegistry([entry()]);
    const killProcess = vi.fn().mockResolvedValue(undefined);

    const result = await reapOrphanedHostRunners({
      registryPath: file,
      currentBootId: 'boot-new',
      isProcessAlive: () => true,
      getCreateTimeMs: async () => null,
      killProcess,
    });

    expect(result).toEqual({ killed: [4242], dropped: [], kept: [] });
    expect(killProcess).toHaveBeenCalledWith(4242);
    expect(readHostRunnerRegistry(file)).toEqual([]);
  });

  test('the current boot keeps its entries and never kills', async () => {
    const file = makeRegistry([entry({ bootId: 'boot-new' })]);
    const killProcess = vi.fn().mockResolvedValue(undefined);

    const result = await reapOrphanedHostRunners({
      registryPath: file,
      currentBootId: 'boot-new',
      isProcessAlive: () => true,
      getCreateTimeMs: async () => null,
      killProcess,
    });

    expect(result).toEqual({ killed: [], dropped: [], kept: [4242] });
    expect(killProcess).not.toHaveBeenCalled();
    expect(readHostRunnerRegistry(file)).toEqual([
      entry({ bootId: 'boot-new' }),
    ]);
  });

  test('a dead runner only drops the entry without killing', async () => {
    const file = makeRegistry([entry()]);
    const killProcess = vi.fn().mockResolvedValue(undefined);

    const result = await reapOrphanedHostRunners({
      registryPath: file,
      currentBootId: 'boot-new',
      isProcessAlive: () => false,
      getCreateTimeMs: async () => null,
      killProcess,
    });

    expect(result).toEqual({ killed: [], dropped: [4242], kept: [] });
    expect(killProcess).not.toHaveBeenCalled();
    expect(readHostRunnerRegistry(file)).toEqual([]);
  });

  test('a suspected pid reuse drops the entry without killing the innocent process', async () => {
    const file = makeRegistry([entry()]);
    const killProcess = vi.fn().mockResolvedValue(undefined);

    const result = await reapOrphanedHostRunners({
      registryPath: file,
      currentBootId: 'boot-new',
      isProcessAlive: () => true,
      getCreateTimeMs: async () => NOW + 30 * 60 * 1000,
      killProcess,
    });

    expect(result).toEqual({ killed: [], dropped: [4242], kept: [] });
    expect(killProcess).not.toHaveBeenCalled();
    expect(readHostRunnerRegistry(file)).toEqual([]);
  });

  test('a kill failure keeps the entry so the next boot can retry', async () => {
    const file = makeRegistry([entry()]);
    const killProcess = vi.fn().mockRejectedValue(new Error('taskkill failed'));

    const result = await reapOrphanedHostRunners({
      registryPath: file,
      currentBootId: 'boot-new',
      isProcessAlive: () => true,
      getCreateTimeMs: async () => null,
      killProcess,
    });

    expect(result).toEqual({ killed: [], dropped: [], kept: [4242] });
    expect(readHostRunnerRegistry(file)).toEqual([entry()]);
    expect(logger.error).toHaveBeenCalled();
  });

  test('a missing registry file is a no-op that does not throw', async () => {
    const result = await reapOrphanedHostRunners({
      registryPath: makeTempFile('empty'),
      currentBootId: 'boot-new',
      isProcessAlive: () => true,
      getCreateTimeMs: async () => null,
      killProcess: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({ killed: [], dropped: [], kept: [] });
  });
});
