/**
 * Auto-memory wiring over host IPC (T3, sidecar-ownership plan).
 *
 * Part 1 (behavioral): the tool layer no longer owns a sidecar client —
 * ctx.autoMemory carries only the enable flag (never endpoints), tools are
 * registered per the unchanged gate, and every op travels over the
 * workspace file-IPC channel (`{workspaceIpc}/tasks/`) to the host-owned
 * sidecar, whose receipts drive availability.
 *
 * Part 2 (forwarding proof): the Pi entry (pi-index.ts, the production
 * container entrypoint) must forward ContainerInput.autoMemory into its
 * McpContext. It once shipped without the field, which made auto memory
 * silently report "not configured for this workspace" on every Pi runner.
 * A static source assertion is the cheapest fail-closed gate for this
 * forwarding bug.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createMcpTools,
  summarizeAutoMemoryAddResult,
  type McpContext,
} from '../src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Minimal fake host: polls the tasks dir for request files, records them,
 * answers with `{type}_result_{requestId}.json` (the host's naming
 * convention), removes the request. Non-auto-memory requests (e.g. the v2
 * create leg of memory_promote) get a generic success receipt.
 */
function startFakeHost(
  tasksDir: string,
  respond: (data: Record<string, unknown>) => Record<string, unknown>,
): { requests: Array<Record<string, unknown>>; stop: () => void } {
  const requests: Array<Record<string, unknown>> = [];
  const timer = setInterval(() => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tasksDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name.includes('_result_')) continue;
      const filePath = path.join(tasksDir, entry.name);
      try {
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as Record<string, unknown>;
        requests.push(data);
        const payload =
          data.type === 'auto_memory'
            ? respond(data)
            : {
                success: true,
                item: { id: 'wm-1', revision: 1 },
                snapshot: { storeRevision: 1 },
              };
        fs.writeFileSync(
          path.join(
            tasksDir,
            `${String(data.type)}_result_${String(data.requestId)}.json`,
          ),
          JSON.stringify(payload),
        );
        fs.unlinkSync(filePath);
      } catch {
        /* half-written or raced — next tick retries */
      }
    }
  }, 40);
  return {
    requests,
    stop: () => clearInterval(timer),
  };
}

function makeCtx(overrides: Partial<McpContext> = {}): {
  ctx: McpContext;
  ipcRoot: string;
} {
  const ipcRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'am-wire-'));
  roots.push(ipcRoot);
  const ctx: McpContext = {
    chatJid: 'web:test',
    groupFolder: 'flow-test',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    interactionMode: 'assistant',
    isScheduledTask: false,
    currentTaskId: null,
    currentInputTurnId: 'turn-test',
    currentSessionId: null,
    workspaceIpc: ipcRoot,
    workspaceGroup: ipcRoot,
    ...overrides,
  };
  return { ctx, ipcRoot };
}

describe('auto memory IPC wiring (new contract: no endpoints in ctx)', () => {
  test('ctx.autoMemory carries only the enable flag and registers the tools', () => {
    const { ctx } = makeCtx({ autoMemory: { enabled: true } });
    const tools = createMcpTools(ctx);
    expect(tools.some((t) => t.name === 'auto_memory_search')).toBe(true);
    expect(tools.some((t) => t.name === 'auto_memory_add')).toBe(true);
    expect(tools.some((t) => t.name === 'memory_promote')).toBe(true);
  });

  test('search is registered even without ctx.autoMemory; ops degrade via host receipts', async () => {
    const { ctx, ipcRoot } = makeCtx();
    const host = startFakeHost(path.join(ipcRoot, 'tasks'), () => ({
      success: false,
      code: 'not_configured',
      error: 'auto memory is not configured (missing llm/embedder endpoints)',
    }));
    try {
      const tools = createMcpTools(ctx);
      const search = tools.find((t) => t.name === 'auto_memory_search')!;
      const outcome = (await search.handler(
        { query: 'language preference', limit: 5 },
        {} as never,
      )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0].text).toContain('Auto memory is unavailable');
      expect(outcome.content[0].text).toContain('not_configured');
      expect(host.requests.length).toBe(1);
      expect(host.requests[0]).toMatchObject({
        type: 'auto_memory',
        operation: 'search',
      });
    } finally {
      host.stop();
    }
  }, 15_000);

  test('search success round-trips through the file-IPC channel', async () => {
    const { ctx, ipcRoot } = makeCtx({ autoMemory: { enabled: true } });
    const host = startFakeHost(path.join(ipcRoot, 'tasks'), () => ({
      success: true,
      result: [
        { id: 'mem-1', memory: 'User prefers TypeScript', score: 0.9 },
      ],
    }));
    try {
      const tools = createMcpTools(ctx);
      const search = tools.find((t) => t.name === 'auto_memory_search')!;
      const outcome = (await search.handler(
        { query: '  language preference  ', limit: 5 },
        {} as never,
      )) as { content: Array<{ type: string; text: string }> };
      expect(outcome.content[0].text).toContain('User prefers TypeScript');
      // The request carries the trimmed query; the host derives everything
      // workspace-related itself.
      expect(host.requests[0]).toMatchObject({
        type: 'auto_memory',
        operation: 'search',
        query: 'language preference',
        limit: 5,
      });
      expect(String(host.requests[0].requestId)).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      host.stop();
    }
  }, 15_000);

  test('add routes messages + turn metadata through IPC', async () => {
    const { ctx, ipcRoot } = makeCtx({ autoMemory: { enabled: true } });
    const host = startFakeHost(path.join(ipcRoot, 'tasks'), () => ({
      success: true,
      result: [{ id: 'm1', memory: 'User prefers TypeScript', event: 'ADD' }],
    }));
    try {
      const tools = createMcpTools(ctx);
      const add = tools.find((t) => t.name === 'auto_memory_add')!;
      const outcome = (await add.handler(
        { content: 'I prefer TypeScript' },
        {} as never,
      )) as { content: Array<{ type: string; text: string }> };
      expect(outcome.content[0].text).toContain('[ADD] User prefers TypeScript');
      expect(host.requests[0]).toMatchObject({
        type: 'auto_memory',
        operation: 'add',
        messages: [{ role: 'user', content: 'I prefer TypeScript' }],
      });
      expect(host.requests[0].metadata).toMatchObject({
        turnId: 'turn-test',
      });
    } finally {
      host.stop();
    }
  }, 15_000);

  test('memory_promote verifies the source memory via IPC get', async () => {
    const { ctx, ipcRoot } = makeCtx({ autoMemory: { enabled: true } });
    const host = startFakeHost(path.join(ipcRoot, 'tasks'), (data) => {
      if (data.operation === 'get') {
        return {
          success: true,
          result: { id: 'mem-9', memory: 'source fact' },
        };
      }
      // The v2 create leg (callMemoryTool) is not under test here; answer
      // generically so the promote flow completes.
      return { success: true, snapshot: {} };
    });
    try {
      const tools = createMcpTools(ctx);
      const promote = tools.find((t) => t.name === 'memory_promote')!;
      await promote.handler(
        {
          memory_id: 'mem-9',
          kind: 'fact',
          title: 'Prefers TypeScript',
          content: 'User prefers TypeScript',
        },
        {} as never,
      );
      const get = host.requests.find((r) => r.operation === 'get');
      expect(get).toMatchObject({ type: 'auto_memory', memoryId: 'mem-9' });
    } finally {
      host.stop();
    }
  }, 15_000);
});

describe('summarizeAutoMemoryAddResult (honest add reporting)', () => {
  test('v2 additive list reports each extracted fact with its event', () => {
    const text = summarizeAutoMemoryAddResult([
      { id: 'm1', memory: 'User prefers pnpm', event: 'ADD' },
      { id: 'm2', memory: 'User works on weekends', event: 'ADD' },
    ]);
    expect(text).toContain('2 fact(s)');
    expect(text).toContain('[ADD] User prefers pnpm');
    expect(text).toContain('[ADD] User works on weekends');
  });

  test('empty extraction says so instead of claiming success', () => {
    expect(summarizeAutoMemoryAddResult([])).toContain(
      'No new facts were extracted',
    );
  });

  test('legacy {results: [...]} shape is handled', () => {
    const text = summarizeAutoMemoryAddResult({
      results: [{ id: 'm1', memory: 'X', event: 'ADD' }],
    });
    expect(text).toContain('[ADD] X');
  });

  test('opaque payloads degrade to the generic captured line', () => {
    expect(summarizeAutoMemoryAddResult({ captured: true })).toBe(
      'Captured into automatic memory.',
    );
  });
});

describe('pi-index forwards the auto-memory bootstrap (fail-closed)', () => {
  const piIndexSource = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/pi-index.ts',
    ),
    'utf8',
  );

  test('Pi entry ctx includes ContainerInput.autoMemory', () => {
    expect(piIndexSource).toContain('autoMemory: input.autoMemory');
  });
});
