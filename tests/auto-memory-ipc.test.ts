import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import {
  autoMemoryDataPath,
  handleAutoMemoryIpc,
  type AutoMemoryIpcContext,
  type AutoMemoryIpcData,
  type AutoMemoryIpcManager,
} from '../src/auto-memory-ipc.js';
import { AutoMemorySidecarManager } from '../src/auto-memory-sidecar-manager.js';
import type { AutoMemoryHostConfig } from '../src/auto-memory-config.js';

const FAKE_SIDECAR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-auto-memory-sidecar.mjs',
);

const ENABLED_CONFIG: AutoMemoryHostConfig = {
  enabled: true,
  llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
  embedder: { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'e' },
};

interface ManagerCall {
  folder: string;
  op: string;
  sidecarConfig: Record<string, unknown>;
  args: Record<string, unknown>;
}

interface TestHarness {
  ctx: AutoMemoryIpcContext;
  calls: ManagerCall[];
  writes: Array<Record<string, unknown>>;
  lastWrite(): Record<string, unknown> | null;
}

function makeHarness(overrides: Partial<AutoMemoryIpcContext> = {}): TestHarness {
  const calls: ManagerCall[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const manager: AutoMemoryIpcManager = {
    call: async (folder, sidecarConfig, op, args) => {
      calls.push({ folder, op, sidecarConfig, args });
      return { available: true, value: { echoed: op } };
    },
  };
  const ctx: AutoMemoryIpcContext = {
    folder: 'ws-folder',
    executionMode: 'container',
    config: ENABLED_CONFIG,
    manager,
    writeResult: (payload) => writes.push(payload),
    ...overrides,
  };
  return {
    ctx,
    calls,
    writes,
    lastWrite: () => writes[writes.length - 1] ?? null,
  };
}

/** Mirrors writeTaskResult's file contract for auto_memory results. */
function makeTasksDir(): {
  dir: string;
  writeResult: (requestId: string, payload: Record<string, unknown>) => void;
  readResult: (requestId: string) => Record<string, unknown> | null;
} {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'am-ipc-'));
  return {
    dir,
    writeResult: (requestId, payload) => {
      fs.writeFileSync(
        path.join(dir, `auto_memory_result_${requestId}.json`),
        JSON.stringify(payload),
      );
    },
    readResult: (requestId) => {
      try {
        return JSON.parse(
          fs.readFileSync(
            path.join(dir, `auto_memory_result_${requestId}.json`),
            'utf8',
          ),
        ) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}

describe('autoMemoryDataPath', () => {
  test('container mode reads the docker-mounted extra dir', () => {
    expect(autoMemoryDataPath('myshop', 'container')).toBe(
      path.join(DATA_DIR, 'extra', 'myshop', 'auto-memory'),
    );
  });

  test('undefined mode defaults to the container layout', () => {
    expect(autoMemoryDataPath('myshop', undefined)).toBe(
      path.join(DATA_DIR, 'extra', 'myshop', 'auto-memory'),
    );
  });

  test('host mode reads the groups workspace dir', () => {
    expect(autoMemoryDataPath('myshop', 'host')).toBe(
      path.join(GROUPS_DIR, 'myshop', 'extra', 'auto-memory'),
    );
  });

  test('container and host layouts never collide for one folder', () => {
    expect(autoMemoryDataPath('f', 'container')).not.toBe(
      autoMemoryDataPath('f', 'host'),
    );
  });
});

describe('handleAutoMemoryIpc validation', () => {
  test('invalid requestId is rejected without a result write', async () => {
    const harness = makeHarness();
    for (const requestId of ['../evil', 'has space', '', undefined]) {
      await handleAutoMemoryIpc(
        { type: 'auto_memory', operation: 'search', query: 'q', requestId },
        harness.ctx,
      );
    }
    expect(harness.writes.length).toBe(0);
    expect(harness.calls.length).toBe(0);
  });

  test('unknown operation writes a rejection result', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'delete_all', requestId: 'req-1' },
      harness.ctx,
    );
    expect(harness.calls.length).toBe(0);
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'invalid_operation',
    });
  });

  test('disabled config writes not_configured and never touches the sidecar', async () => {
    const harness = makeHarness({ config: { enabled: false } });
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'search', query: 'q', requestId: 'r1' },
      harness.ctx,
    );
    expect(harness.calls.length).toBe(0);
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'not_configured',
    });
  });

  test('config missing endpoints is treated as not configured', async () => {
    const harness = makeHarness({
      config: { enabled: true, llm: ENABLED_CONFIG.llm },
    });
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'search', query: 'q', requestId: 'r1b' },
      harness.ctx,
    );
    expect(harness.calls.length).toBe(0);
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'not_configured',
    });
  });

  test('search without a query writes invalid_args', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'search', requestId: 'r2' },
      harness.ctx,
    );
    expect(harness.calls.length).toBe(0);
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'invalid_args',
    });
  });

  test('get without memoryId writes invalid_args', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'get', requestId: 'r3' },
      harness.ctx,
    );
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'invalid_args',
    });
  });

  test('add with malformed messages writes invalid_args', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      {
        type: 'auto_memory',
        operation: 'add',
        requestId: 'r4',
        messages: [{ role: 'user' }],
      },
      harness.ctx,
    );
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'invalid_args',
    });
  });
});

describe('handleAutoMemoryIpc request routing', () => {
  test('search routes to the sidecar with trimmed query and workspace config', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      {
        type: 'auto_memory',
        operation: 'search',
        query: '  language preference  ',
        limit: 5,
        requestId: 'r5',
      },
      harness.ctx,
    );
    expect(harness.calls.length).toBe(1);
    const call = harness.calls[0];
    expect(call.folder).toBe('ws-folder');
    expect(call.op).toBe('search');
    expect(call.args).toEqual({ query: 'language preference', limit: 5 });
    expect(call.sidecarConfig).toMatchObject({
      dataPath: path.join(DATA_DIR, 'extra', 'ws-folder', 'auto-memory'),
      collection: 'ws-ws-folder',
      userId: 'workspace:ws-folder',
    });
    expect(harness.lastWrite()).toMatchObject({
      success: true,
      result: { echoed: 'search' },
    });
  });

  test('host mode routes with the groups data path', async () => {
    const harness = makeHarness({ executionMode: 'host' });
    await handleAutoMemoryIpc(
      {
        type: 'auto_memory',
        operation: 'get',
        memoryId: 'mem-1',
        requestId: 'r6',
      },
      harness.ctx,
    );
    expect(harness.calls[0]?.sidecarConfig).toMatchObject({
      dataPath: path.join(GROUPS_DIR, 'ws-folder', 'extra', 'auto-memory'),
    });
  });

  test('add routes messages + metadata; get translates memory_id', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      {
        type: 'auto_memory',
        operation: 'add',
        requestId: 'r7',
        messages: [{ role: 'user', content: 'I prefer TypeScript' }],
        metadata: { turnId: 't1' },
      },
      harness.ctx,
    );
    expect(harness.calls[0]?.args).toEqual({
      messages: [{ role: 'user', content: 'I prefer TypeScript' }],
      metadata: { turnId: 't1' },
    });
    await handleAutoMemoryIpc(
      {
        type: 'auto_memory',
        operation: 'get',
        memoryId: 'mem-9',
        requestId: 'r7b',
      },
      harness.ctx,
    );
    expect(harness.calls[1]?.args).toEqual({ memory_id: 'mem-9' });
  });

  test('search limit defaults to 10', async () => {
    const harness = makeHarness();
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'search', query: 'q', requestId: 'r9' },
      harness.ctx,
    );
    expect(harness.calls[0]?.args).toEqual({ query: 'q', limit: 10 });
  });

  test('sidecar unavailability degrades to a coded failure result', async () => {
    const harness = makeHarness({
      manager: {
        call: async () => ({
          available: false as const,
          reason: 'no usable Python interpreter',
        }),
      },
    });
    await handleAutoMemoryIpc(
      { type: 'auto_memory', operation: 'search', query: 'q', requestId: 'r8' },
      harness.ctx,
    );
    expect(harness.lastWrite()).toMatchObject({
      success: false,
      code: 'unavailable',
      error: expect.stringContaining('Python'),
    });
  });
});

describe('server shutdown wiring (fail-closed)', () => {
  const indexSource = fs.readFileSync(
    path.resolve('src/index.ts'),
    'utf8',
  );

  test('graceful shutdown stops the sidecar manager (no orphan stdio pipes)', () => {
    // Review M3: closeAutoMemorySidecarManager() was exported but never
    // called — graceful shutdown tore down the sidecars' stdio pipes while
    // qdrant writes were in flight. The shutdown sequence must call it.
    expect(indexSource).toContain('closeAutoMemorySidecarManager()');
  });
});

describe('handleAutoMemoryIpc end-to-end (request file → sidecar → result file)', () => {
  test('a fake request file is served by the real manager + fake sidecar', async () => {
    const tasks = makeTasksDir();
    const manager = new AutoMemorySidecarManager({
      scriptPath: FAKE_SIDECAR,
      interpreterCandidates: [{ command: process.execPath, args: [] }],
      requestTimeoutMs: 5_000,
    });
    const baseCtx = {
      folder: 'ws-e2e',
      executionMode: 'container' as const,
      config: ENABLED_CONFIG,
      manager,
    };
    try {
      // The IPC scanner's job: write a request file, read it back, dispatch.
      const requestFile = path.join(tasks.dir, 'req-abc123.json');
      const request: AutoMemoryIpcData = {
        type: 'auto_memory',
        operation: 'search',
        query: 'language preference',
        limit: 5,
        requestId: '1690000000-abc123',
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(requestFile, JSON.stringify(request));
      const parsed = JSON.parse(
        fs.readFileSync(requestFile, 'utf8'),
      ) as AutoMemoryIpcData;

      await handleAutoMemoryIpc(parsed, {
        ...baseCtx,
        writeResult: (payload) =>
          tasks.writeResult(parsed.requestId as string, payload),
      });
      fs.unlinkSync(requestFile);

      const result = tasks.readResult('1690000000-abc123');
      expect(result).toMatchObject({ success: true });
      const records = (result as { result: Array<{ memory: string }> }).result;
      expect(records[0]?.memory).toContain('TypeScript (from fake sidecar)');

      // add + get round-trip through the same real sidecar process.
      await handleAutoMemoryIpc(
        {
          type: 'auto_memory',
          operation: 'add',
          requestId: '1690000001-add1',
          messages: [{ role: 'user', content: 'I prefer TypeScript' }],
          metadata: { turnId: 't1' },
        },
        {
          ...baseCtx,
          writeResult: (payload) => tasks.writeResult('1690000001-add1', payload),
        },
      );
      expect(tasks.readResult('1690000001-add1')).toMatchObject({
        success: true,
      });

      await handleAutoMemoryIpc(
        {
          type: 'auto_memory',
          operation: 'get',
          memoryId: 'mem-42',
          requestId: '1690000002-get1',
        },
        {
          ...baseCtx,
          writeResult: (payload) => tasks.writeResult('1690000002-get1', payload),
        },
      );
      expect(tasks.readResult('1690000002-get1')).toMatchObject({
        success: true,
        result: { id: 'mem-42', memory: 'fake memory' },
      });
    } finally {
      await manager.stopAll();
      fs.rmSync(tasks.dir, { recursive: true, force: true });
    }
  }, 20_000);
});
