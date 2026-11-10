import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AutoMemorySidecarManager,
  findHostSidecarScript,
  pythonInterpreterCandidates,
  resolvePythonInterpreter,
  type AutoMemorySidecarConfig,
  type AutoMemorySidecarOp,
  type PythonInterpreter,
} from '../src/auto-memory-sidecar-manager.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SIDECAR = path.join(
  TEST_DIR,
  'fixtures',
  'fake-auto-memory-sidecar.mjs',
);
const REAL_SIDECAR = path.resolve(
  TEST_DIR,
  '..',
  'container',
  'agent-runner',
  'python',
  'auto_memory_sidecar.py',
);

const NODE: PythonInterpreter = { command: process.execPath, args: [] };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeConfig(
  overrides: Partial<AutoMemorySidecarConfig> = {},
): AutoMemorySidecarConfig {
  return {
    dataPath: '/tmp/auto-memory-manager-test',
    collection: 'ws-test',
    userId: 'workspace:test',
    llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
    embedder: { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'e' },
    ...overrides,
  };
}

function makeManager(
  overrides: Record<string, unknown> = {},
): AutoMemorySidecarManager {
  return new AutoMemorySidecarManager({
    scriptPath: FAKE_SIDECAR,
    interpreterCandidates: [NODE],
    requestTimeoutMs: 5_000,
    ...overrides,
  });
}

/**
 * Concurrency-capable fake sidecar: request handlers are NOT awaited, so
 * overlapping requests interleave inside the fake. Only a serializing
 * manager queue can produce strict start/end alternation in the marker log
 * (SLOW_FAKE_LOG) — which is exactly what the serialization test asserts.
 */
const SLOW_FAKE_SOURCE = `
import { createInterface } from 'node:readline';
import fs from 'node:fs';

const logFile = process.env.SLOW_FAKE_LOG;
const delayMs = Number(process.env.SLOW_FAKE_DELAY ?? '150');
let ready = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const respond = (msg) => process.stdout.write(\`\${JSON.stringify(msg)}\\n\`);

const handle = async (request) => {
  const { op, id } = request;
  if (op === 'init') {
    const endpointOk = (e) =>
      e && typeof e.base_url === 'string' && typeof e.api_key === 'string' && typeof e.model === 'string';
    if (!endpointOk(request.config?.llm) || !endpointOk(request.config?.embedder)) {
      respond({ id, ok: false, error: 'init endpoints must use snake_case keys (base_url/api_key/model)' });
      process.exit(1);
    }
    ready = true;
    respond({ id, ok: true, result: 'ready' });
    return;
  }
  if (op === 'ping') {
    respond({ id, ok: true, result: { ready } });
    return;
  }
  if (!ready) {
    respond({ id, ok: false, error: 'sidecar not initialized' });
    return;
  }
  if (op === 'search') {
    if (logFile) fs.appendFileSync(logFile, \`s\${id}:\`);
    await sleep(delayMs);
    if (logFile) fs.appendFileSync(logFile, \`e\${id}:\`);
    respond({ id, ok: true, result: [{ id: 'mem-1', memory: 'slow fake memory', score: 0.9 }] });
    return;
  }
  respond({ id, ok: false, error: \`unknown op: \${op}\` });
};

for await (const line of createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    continue;
  }
  void handle(request);
}
`;

function writeSlowFake(): { dir: string; script: string } {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'am-slowfake-'),
  );
  const script = path.join(dir, 'slow-fake.mjs');
  fs.writeFileSync(script, SLOW_FAKE_SOURCE);
  return { dir, script };
}

describe('AutoMemorySidecarManager against the fake sidecar', () => {
  test('lazy spawn, init handshake, and process reuse across calls', async () => {
    const manager = makeManager();
    try {
      expect(manager.spawnCountForTest('ws1')).toBe(0);
      const first = await manager.call('ws1', makeConfig(), 'search', {
        query: 'language preference',
        limit: 5,
      });
      expect(first.available).toBe(true);
      if (first.available) {
        const records = first.value as Array<{ memory: string }>;
        expect(records[0]?.memory).toContain('TypeScript');
      }
      expect(manager.spawnCountForTest('ws1')).toBe(1);
      expect(manager.isRunning('ws1')).toBe(true);

      const second = await manager.call('ws1', makeConfig(), 'search', {
        query: 'again',
      });
      expect(second.available).toBe(true);
      // Same process serves both calls — the sidecar is a per-folder singleton.
      expect(manager.spawnCountForTest('ws1')).toBe(1);
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  test('add and get round-trip through the same handshake', async () => {
    const manager = makeManager();
    try {
      const add = await manager.call('ws2', makeConfig(), 'add', {
        messages: [{ role: 'user', content: 'I prefer TypeScript' }],
        metadata: { turnId: 't1' },
      });
      expect(add).toEqual({ available: true, value: expect.anything() });

      const get = await manager.call('ws2', makeConfig(), 'get', {
        memory_id: 'mem-9',
      });
      expect(get.available).toBe(true);
      if (get.available) {
        expect(get.value).toMatchObject({ id: 'mem-9', memory: 'fake memory' });
      }
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  test('list op paginates through the same handshake (task W)', async () => {
    const manager = makeManager();
    try {
      const firstPage = await manager.call('wsL', makeConfig(), 'list', {
        limit: 2,
      });
      expect(firstPage.available).toBe(true);
      if (firstPage.available) {
        const items = firstPage.value as Array<{ id: string }>;
        expect(items.map((item) => item.id)).toEqual([
          'fake-mem-1',
          'fake-mem-2',
        ]);
      }

      // Args ride the same serial queue verbatim: offset skips the first
      // item, mirroring the python sidecar's fetch-limit+offset-then-slice
      // pagination emulation.
      const secondPage = await manager.call('wsL', makeConfig(), 'list', {
        limit: 2,
        offset: 1,
      });
      expect(secondPage.available).toBe(true);
      if (secondPage.available) {
        const items = secondPage.value as Array<{ id: string }>;
        expect(items.map((item) => item.id)).toEqual([
          'fake-mem-2',
          'fake-mem-3',
        ]);
      }
      expect(manager.spawnCountForTest('wsL')).toBe(1);
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  test('folders hold independent sidecar processes', async () => {
    const manager = makeManager();
    try {
      const a = await manager.call('wsA', makeConfig(), 'search', {
        query: 'q',
      });
      const b = await manager.call('wsB', makeConfig(), 'search', {
        query: 'q',
      });
      expect(a.available).toBe(true);
      expect(b.available).toBe(true);
      expect(manager.spawnCountForTest('wsA')).toBe(1);
      expect(manager.spawnCountForTest('wsB')).toBe(1);

      manager.killChildForTest('wsA');
      const a2 = await manager.call('wsA', makeConfig(), 'search', {
        query: 'q',
      });
      const b2 = await manager.call('wsB', makeConfig(), 'search', {
        query: 'q',
      });
      expect(a2.available).toBe(true);
      expect(b2.available).toBe(true);
      expect(manager.spawnCountForTest('wsA')).toBe(2);
      expect(manager.spawnCountForTest('wsB')).toBe(1);
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  test('unknown op is rejected without spawning', async () => {
    const manager = makeManager();
    try {
      const result = await manager.call(
        'wsU',
        makeConfig(),
        'drop' as AutoMemorySidecarOp,
        {},
      );
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toContain('drop');
      expect(manager.spawnCountForTest('wsU')).toBe(0);
    } finally {
      await manager.stopAll();
    }
  });

  test('missing llm/embedder endpoints degrade without spawning', async () => {
    const manager = makeManager();
    try {
      const result = await manager.call(
        'wsN',
        makeConfig({ llm: undefined, embedder: undefined }),
        'search',
        { query: 'q' },
      );
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toContain('not configured');
      expect(manager.spawnCountForTest('wsN')).toBe(0);
    } finally {
      await manager.stopAll();
    }
  });
});

describe('serial op queue', () => {
  test('ops on one folder never interleave inside the sidecar', async () => {
    const { dir, script } = writeSlowFake();
    const logFile = path.join(dir, 'markers.log');
    process.env.SLOW_FAKE_LOG = logFile;
    process.env.SLOW_FAKE_DELAY = '120';
    const manager = makeManager({ scriptPath: script });
    try {
      const [a, b] = await Promise.all([
        manager.call('wsS', makeConfig(), 'search', { query: 'q1' }),
        manager.call('wsS', makeConfig(), 'search', { query: 'q2' }),
      ]);
      expect(a.available).toBe(true);
      expect(b.available).toBe(true);
      const markers = fs.readFileSync(logFile, 'utf8');
      // The fake handles requests concurrently, so strict start/end
      // alternation can only come from the manager's serial queue.
      expect(markers).toMatch(/^(s\d+:e\d+:){2}$/);
    } finally {
      delete process.env.SLOW_FAKE_LOG;
      delete process.env.SLOW_FAKE_DELAY;
      await manager.stopAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('idle TTL', () => {
  test('idle sidecar is stopped after the TTL and lazily respawned', async () => {
    const manager = makeManager({ idleTtlMs: 120 });
    try {
      const first = await manager.call('wsT', makeConfig(), 'search', {
        query: 'q',
      });
      expect(first.available).toBe(true);
      expect(manager.isRunning('wsT')).toBe(true);

      await sleep(500);
      expect(manager.isRunning('wsT')).toBe(false);
      expect(manager.spawnCountForTest('wsT')).toBe(1);

      const second = await manager.call('wsT', makeConfig(), 'search', {
        query: 'q',
      });
      expect(second.available).toBe(true);
      expect(manager.spawnCountForTest('wsT')).toBe(2);
    } finally {
      await manager.stopAll();
    }
  }, 15_000);

  test('idleTtlMs=0 disables idle shutdown', async () => {
    const manager = makeManager({ idleTtlMs: 0 });
    try {
      const first = await manager.call('wsZ', makeConfig(), 'search', {
        query: 'q',
      });
      expect(first.available).toBe(true);
      await sleep(400);
      expect(manager.isRunning('wsZ')).toBe(true);
    } finally {
      await manager.stopAll();
      expect(manager.isRunning('wsZ')).toBe(false);
    }
  }, 15_000);
});

describe('crash recovery and restart budget', () => {
  test('successful handshakes reset the budget — 4 crash/recover rounds', async () => {
    const manager = makeManager();
    try {
      for (let round = 0; round < 4; round += 1) {
        const before = await manager.call('wsC', makeConfig(), 'search', {
          query: 'ping',
        });
        expect(before.available).toBe(true);
        manager.killChildForTest('wsC');
        const after = await manager.call('wsC', makeConfig(), 'search', {
          query: 'ping',
        });
        expect(after.available).toBe(true);
      }
      expect(manager.spawnCountForTest('wsC')).toBe(5);
    } finally {
      await manager.stopAll();
    }
  }, 30_000);

  test('budget exhausts after 3 consecutive failed spawns and stops retrying', async () => {
    const manager = makeManager({
      interpreterCandidates: [
        { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      ],
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await manager.call('wsB', makeConfig(), 'search', {
          query: 'q',
        });
        expect(result.available).toBe(false);
      }
      expect(manager.spawnCountForTest('wsB')).toBe(3);

      const fourth = await manager.call('wsB', makeConfig(), 'search', {
        query: 'q',
      });
      expect(fourth.available).toBe(false);
      if (!fourth.available) expect(fourth.reason).toMatch(/3 times/);
      expect(manager.spawnCountForTest('wsB')).toBe(3);

      // stop() is the explicit recovery hatch: it resets the entry so the
      // next call may try again (e.g. after the operator fixed the env).
      await manager.stop('wsB');
      const fifth = await manager.call('wsB', makeConfig(), 'search', {
        query: 'q',
      });
      expect(fifth.available).toBe(false);
      expect(manager.spawnCountForTest('wsB')).toBe(1);
    } finally {
      await manager.stopAll();
    }
  }, 30_000);

  test('budget exhaustion self-heals after the cooldown window (review M1)', async () => {
    // Without a cooldown, three init failures inside one embedder-outage
    // window would disable the workspace's auto memory until a server
    // restart — the exact stickiness the quality review flagged. The
    // cooldown clears every sticky unavailable state (budget exhaustion,
    // interpreter-null) and re-probes the environment.
    const manager = makeManager({
      interpreterCandidates: [
        { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      ],
      budgetCooldownMs: 150,
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await manager.call('wsBC', makeConfig(), 'search', {
          query: 'q',
        });
        expect(result.available).toBe(false);
      }
      expect(manager.spawnCountForTest('wsBC')).toBe(3);
      const stuck = await manager.call('wsBC', makeConfig(), 'search', {
        query: 'q',
      });
      expect(stuck.available).toBe(false);
      expect(manager.spawnCountForTest('wsBC')).toBe(3);

      await sleep(250);
      // Past the cooldown the budget resets and the manager retries.
      const retried = await manager.call('wsBC', makeConfig(), 'search', {
        query: 'q',
      });
      expect(retried.available).toBe(false);
      expect(manager.spawnCountForTest('wsBC')).toBe(4);
    } finally {
      await manager.stopAll();
    }
  }, 30_000);
});

describe('interpreter resolution inside the manager', () => {
  test('resolution failure degrades explicitly without spawning', async () => {
    const manager = makeManager({
      interpreterCandidates: [
        { command: 'definitely-missing-python-xyz', args: [] },
      ],
    });
    try {
      const result = await manager.call('wsP', makeConfig(), 'search', {
        query: 'q',
      });
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toMatch(/[Pp]ython/);
      expect(manager.spawnCountForTest('wsP')).toBe(0);

      const again = await manager.call('wsP', makeConfig(), 'search', {
        query: 'q',
      });
      expect(again.available).toBe(false);
      expect(manager.spawnCountForTest('wsP')).toBe(0);
    } finally {
      await manager.stopAll();
    }
  }, 15_000);
});

describe('request timeout', () => {
  test('a hung sidecar degrades with a timeout reason instead of blocking', async () => {
    const { dir, script } = writeSlowFake();
    process.env.SLOW_FAKE_DELAY = '5000';
    const manager = makeManager({ scriptPath: script, requestTimeoutMs: 250 });
    try {
      const result = await manager.call('wsX', makeConfig(), 'search', {
        query: 'q',
      });
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toContain('timed out');
    } finally {
      delete process.env.SLOW_FAKE_DELAY;
      await manager.stopAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a timed-out op kills the child so the queue cannot wedge (review M2)', async () => {
    // A single hung mem0 call (client-side 600s embedder timeouts) used to
    // hold the serial queue hostage: every later op burned the full request
    // timeout until the hung call returned on its own. Timeout must kill the
    // sidecar; the next call respawns it fresh. Margins: init round-trip on
    // a cold Windows spawn needs well under 2s; the hang must exceed it.
    const { dir, script } = writeSlowFake();
    process.env.SLOW_FAKE_DELAY = '8000';
    const manager = makeManager({
      scriptPath: script,
      requestTimeoutMs: 2_000,
    });
    try {
      const hung = await manager.call('wsK', makeConfig(), 'search', {
        query: 'q',
      });
      expect(hung.available).toBe(false);
      if (!hung.available) expect(hung.reason).toContain('timed out');
      // The hung child was killed, not left wedged on the queue.
      expect(manager.isRunning('wsK')).toBe(false);
      expect(manager.spawnCountForTest('wsK')).toBe(1);

      process.env.SLOW_FAKE_DELAY = '10';
      const recovered = await manager.call('wsK', makeConfig(), 'search', {
        query: 'q',
      });
      expect(recovered.available).toBe(true);
      expect(manager.spawnCountForTest('wsK')).toBe(2);
    } finally {
      delete process.env.SLOW_FAKE_DELAY;
      await manager.stopAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 25_000);
});

describe('pythonInterpreterCandidates', () => {
  function withEnv(
    name: string,
    value: string | undefined,
    run: () => void,
  ): void {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  test('win32 order: env override, then py -3, then python3', () => {
    withEnv('CKQCLAW_AUTO_MEMORY_PYTHON', undefined, () => {
      expect(pythonInterpreterCandidates('win32')).toEqual([
        { command: 'py', args: ['-3'] },
        { command: 'python3', args: [] },
      ]);
    });
    withEnv('CKQCLAW_AUTO_MEMORY_PYTHON', 'C:\\Python312\\python.exe', () => {
      expect(pythonInterpreterCandidates('win32')).toEqual([
        { command: 'C:\\Python312\\python.exe', args: [] },
        { command: 'py', args: ['-3'] },
        { command: 'python3', args: [] },
      ]);
    });
  });

  test('non-win32 order: env override, then python3', () => {
    withEnv('CKQCLAW_AUTO_MEMORY_PYTHON', '/usr/local/bin/python3.12', () => {
      expect(pythonInterpreterCandidates('linux')).toEqual([
        { command: '/usr/local/bin/python3.12', args: [] },
        { command: 'python3', args: [] },
      ]);
    });
  });
});

describe('resolvePythonInterpreter', () => {
  test('picks the first candidate that passes the probe and short-circuits', () => {
    const probed: string[] = [];
    const picked = resolvePythonInterpreter({
      candidates: [
        { command: 'stub-python3', args: [] },
        { command: 'py', args: ['-3'] },
      ],
      probe: (candidate) => {
        probed.push(candidate.command);
        return candidate.command === 'py';
      },
    });
    expect(picked).toEqual({ command: 'py', args: ['-3'] });
    expect(probed).toEqual(['stub-python3', 'py']);
  });

  test('returns null when every candidate fails the probe', () => {
    const picked = resolvePythonInterpreter({
      candidates: [
        { command: 'nope-1', args: [] },
        { command: 'nope-2', args: [] },
      ],
      probe: () => false,
    });
    expect(picked).toBeNull();
  });
});

describe('findHostSidecarScript', () => {
  function makeRepoLayout(): { root: string; script: string } {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'am-repo-'),
    );
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "layout" }\n');
    const pythonDir = path.join(root, 'container', 'agent-runner', 'python');
    fs.mkdirSync(pythonDir, { recursive: true });
    const script = path.join(pythonDir, 'auto_memory_sidecar.py');
    fs.writeFileSync(script, '# test fixture\n');
    return { root, script };
  }

  function withSidecarEnv(value: string | undefined, run: () => void): void {
    const previous = process.env.CKQCLAW_AUTO_MEMORY_SIDECAR;
    if (value === undefined) delete process.env.CKQCLAW_AUTO_MEMORY_SIDECAR;
    else process.env.CKQCLAW_AUTO_MEMORY_SIDECAR = value;
    try {
      run();
    } finally {
      if (previous === undefined)
        delete process.env.CKQCLAW_AUTO_MEMORY_SIDECAR;
      else process.env.CKQCLAW_AUTO_MEMORY_SIDECAR = previous;
    }
  }

  test('walks up from a nested build dir to the repo agent-runner layout', () => {
    withSidecarEnv(undefined, () => {
      const { root, script } = makeRepoLayout();
      const startDir = path.join(root, 'dist', 'deep');
      fs.mkdirSync(startDir, { recursive: true });
      expect(findHostSidecarScript(startDir)).toBe(script);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  test('CKQCLAW_AUTO_MEMORY_SIDECAR override wins when it exists', () => {
    const { root, script } = makeRepoLayout();
    withSidecarEnv(script, () => {
      expect(findHostSidecarScript(path.join(root, 'dist'))).toBe(script);
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('set-but-missing override fails loud (null), never a silent fallback', () => {
    withSidecarEnv(
      path.join(fs.realpathSync(os.tmpdir()), 'am-nope', 'missing.py'),
      () => {
        const scratch = fs.mkdtempSync(
          path.join(fs.realpathSync(os.tmpdir()), 'am-scratch-'),
        );
        expect(findHostSidecarScript(scratch)).toBeNull();
        fs.rmSync(scratch, { recursive: true, force: true });
      },
    );
  });

  test('package root without the sidecar script resolves to null', () => {
    withSidecarEnv(undefined, () => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'am-bare-'),
      );
      fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "bare" }\n');
      expect(findHostSidecarScript(root)).toBeNull();
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  test('no package root and no override resolves to null', () => {
    withSidecarEnv(undefined, () => {
      const scratch = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'am-orphan-'),
      );
      expect(findHostSidecarScript(scratch)).toBeNull();
      fs.rmSync(scratch, { recursive: true, force: true });
    });
  });
});

describe('spawn environment (multi-sidecar collision, task X live finding)', () => {
  test('children spawn with MEM0_TELEMETRY=false — mem0 must never open its fixed-path qdrant store', async () => {
    // mem0ai 2.2.1's telemetry branch (MEM0_TELEMETRY, default on) opens a
    // second qdrant-local store at a FIXED shared path (~/.mem0/
    // migrations_qdrant) for every Memory instance — created but never
    // consumed. With one sidecar per workspace, the second concurrent
    // sidecar init dies on "already accessed by another instance". The
    // manager must force the env off at spawn; ping echoes it back.
    const manager = makeManager();
    try {
      const result = await manager.call('ws-env', makeConfig(), 'ping', {});
      expect(result.available).toBe(true);
      if (result.available) {
        const value = result.value as {
          ready: boolean;
          mem0Telemetry?: string;
        };
        expect(value.ready).toBe(true);
        expect(value.mem0Telemetry).toBe('false');
      }
    } finally {
      await manager.stopAll();
    }
  }, 15_000);
});

describe('spawn smoke (real python sidecar, protocol only)', () => {
  test('manager either serves or degrades explicitly against the shipped script', async () => {
    // The real sidecar needs python + mem0ai; without them init fails and
    // the manager must degrade explicitly — both outcomes prove the
    // Node↔Python protocol wiring against the script that ships.
    expect(fs.existsSync(REAL_SIDECAR)).toBe(true);
    const manager = new AutoMemorySidecarManager({
      scriptPath: REAL_SIDECAR,
      requestTimeoutMs: 20_000,
    });
    try {
      const result = await manager.call('ws-smoke', makeConfig(), 'search', {
        query: 'ping',
        limit: 1,
      });
      expect(['boolean']).toContain(typeof result.available);
    } finally {
      await manager.stopAll();
    }
  }, 40_000);
});
