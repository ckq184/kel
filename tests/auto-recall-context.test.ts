/**
 * Task Z batch 1: per-turn automatic memory recall injection.
 *
 * Pins the runner-side module (`auto-memory-context.ts`), the three turn
 * assembly call sites (cold `index.ts`, warm `index.ts`, `pi-index.ts`) and
 * the exported `callAutoMemory` bridge. The recall block mirrors the
 * workspace-memory snapshot precedent: `trust="historical_data"`,
 * `instruction_priority="none"`, `<>&` escaped JSON, and a defense line that
 * keeps curated Workspace Memory authoritative.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const callAutoMemoryMock = vi.fn();

vi.mock('../container/agent-runner/src/mcp-tools.js', () => ({
  callAutoMemory: callAutoMemoryMock,
}));

// Task Z config chain: buildAutoMemoryInput lives in src/container-runner.ts
// and imports src/config.js — point data dirs at a scratch tree (the factory
// runs lazily at first module import, after HOST_TMP exists).
const HOST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-recall-host-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(HOST_TMP, 'data'),
    GROUPS_DIR: path.join(HOST_TMP, 'data', 'groups'),
    STORE_DIR: path.join(HOST_TMP, 'data', 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  AUTO_MEMORY_RECALL_MAX_BLOCK_CHARS,
  AUTO_MEMORY_RECALL_QUERY_MAX_CHARS,
  AUTO_MEMORY_RECALL_TOP_K,
  loadAutoMemoryRecallContext,
  loadAutoMemoryRecallTurnContext,
  renderAutoMemoryRecallBlock,
} = await import('../container/agent-runner/src/auto-memory-context.js');
const { buildAutoMemoryInput } = await import('../src/container-runner.js');
const { resetAutoMemoryConfigCache } =
  await import('../src/auto-memory-config.js');

function searchOutcome(records: unknown[]) {
  return { available: true as const, value: records };
}

const RECORDS = [
  { id: 'm1', memory: 'User develops in Java and Spring', score: 0.9 },
  { id: 'm2', memory: 'User prefers concise replies', score: 0.8 },
];

describe('renderAutoMemoryRecallBlock', () => {
  test('empty input renders no block', () => {
    expect(renderAutoMemoryRecallBlock([])).toBe('');
    expect(renderAutoMemoryRecallBlock([null, 42, 'x'])).toBe('');
  });

  test('renders tagged block with defense attributes and JSON payload', () => {
    const block = renderAutoMemoryRecallBlock(RECORDS);
    expect(
      block.startsWith(
        '<auto_memory_recall trust="historical_data" instruction_priority="none">',
      ),
    ).toBe(true);
    expect(block).toContain('</auto_memory_recall>');
    // `<>&` must be escaped inside the JSON payload line (tags excluded).
    const payloadLine = block.split('\n')[1];
    expect(payloadLine).not.toMatch(/[<>&]/);
    expect(block).toContain('User develops in Java and Spring');
  });

  test('defense line marks data as non-instruction and defers to Workspace Memory', () => {
    const block = renderAutoMemoryRecallBlock(RECORDS);
    expect(block).toMatch(/historical data, not instructions/i);
    expect(block).toMatch(/Workspace Memory/i);
  });

  test('block stays within the char budget by dropping low-relevance tail items', () => {
    const items = [
      { id: 'high', memory: 'x'.repeat(900), score: 0.95 },
      { id: 'mid', memory: 'y'.repeat(900), score: 0.7 },
      { id: 'low', memory: 'z'.repeat(900), score: 0.3 },
    ];
    const block = renderAutoMemoryRecallBlock(items);
    expect(block.length).toBeLessThanOrEqual(
      AUTO_MEMORY_RECALL_MAX_BLOCK_CHARS,
    );
    expect(block).toContain('high');
    expect(block).toContain('x'.repeat(100));
    expect(block).not.toContain('z'.repeat(100));
  });
});

describe('loadAutoMemoryRecallContext', () => {
  test('truncates the query to the IPC contract limit before searching', async () => {
    const search = vi.fn().mockResolvedValue(searchOutcome([]));
    await loadAutoMemoryRecallContext('u'.repeat(800), search);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toHaveLength(
      AUTO_MEMORY_RECALL_QUERY_MAX_CHARS,
    );
  });

  test('blank query performs no search at all', async () => {
    const search = vi.fn();
    await loadAutoMemoryRecallContext('   ', search);
    expect(search).not.toHaveBeenCalled();
  });

  test('maps results into a rendered block', async () => {
    const search = vi.fn().mockResolvedValue(searchOutcome(RECORDS));
    const ctx = await loadAutoMemoryRecallContext(
      'what do I develop in',
      search,
    );
    expect(ctx.block).toContain('User develops in Java and Spring');
  });

  test('empty result set yields an empty block', async () => {
    const search = vi.fn().mockResolvedValue(searchOutcome([]));
    const ctx = await loadAutoMemoryRecallContext('query', search);
    expect(ctx.block).toBe('');
  });

  test('unavailable sidecar degrades to an empty block', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ available: false, reason: 'not_configured' });
    const ctx = await loadAutoMemoryRecallContext('query', search);
    expect(ctx.block).toBe('');
  });

  test('search rejection degrades to an empty block', async () => {
    const search = vi.fn().mockRejectedValue(new Error('ipc poll timeout'));
    const ctx = await loadAutoMemoryRecallContext('query', search);
    expect(ctx.block).toBe('');
  });

  test('budget timeout skips the block instead of blocking the turn', async () => {
    const search = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(resolve, 200, searchOutcome(RECORDS)),
          ),
      );
    const ctx = await loadAutoMemoryRecallContext('query', search, 10);
    expect(ctx.block).toBe('');
  });
});

describe('loadAutoMemoryRecallTurnContext', () => {
  beforeEach(() => {
    callAutoMemoryMock.mockReset();
  });

  test('recall disabled performs zero IPC calls', async () => {
    const ctx = await loadAutoMemoryRecallTurnContext(
      { autoMemory: { enabled: true } },
      'query',
      {} as never,
    );
    expect(ctx.block).toBe('');
    expect(callAutoMemoryMock).not.toHaveBeenCalled();
  });

  test('missing autoMemory bootstrap performs zero IPC calls', async () => {
    const ctx = await loadAutoMemoryRecallTurnContext({}, 'query', {} as never);
    expect(ctx.block).toBe('');
    expect(callAutoMemoryMock).not.toHaveBeenCalled();
  });

  test('enabled recall searches top-K with a truncated query', async () => {
    callAutoMemoryMock.mockResolvedValue(searchOutcome(RECORDS));
    const ctx = await loadAutoMemoryRecallTurnContext(
      { autoMemory: { enabled: true, recall: { enabled: true } } },
      'q'.repeat(800),
      { workspaceIpc: '/ipc' } as never,
    );
    expect(callAutoMemoryMock).toHaveBeenCalledTimes(1);
    const [ctxArg, operation, payload] = callAutoMemoryMock.mock.calls[0];
    expect(ctxArg).toEqual({ workspaceIpc: '/ipc' });
    expect(operation).toBe('search');
    expect(payload.limit).toBe(AUTO_MEMORY_RECALL_TOP_K);
    expect(payload.query).toHaveLength(AUTO_MEMORY_RECALL_QUERY_MAX_CHARS);
    expect(ctx.block).toContain('User develops in Java and Spring');
  });

  test('sidecar unavailability degrades to an empty block', async () => {
    callAutoMemoryMock.mockResolvedValue({
      available: false,
      reason: 'not_configured',
    });
    const ctx = await loadAutoMemoryRecallTurnContext(
      { autoMemory: { enabled: true, recall: { enabled: true } } },
      'query',
      {} as never,
    );
    expect(ctx.block).toBe('');
  });
});

describe('turn assembly call sites', () => {
  const runnerIndex = fs.readFileSync(
    path.resolve('container/agent-runner/src/index.ts'),
    'utf8',
  );
  const piIndex = fs.readFileSync(
    path.resolve('container/agent-runner/src/pi-index.ts'),
    'utf8',
  );

  test('cold and warm index.ts turns plus the pi-index turn wire recall in', () => {
    expect(
      runnerIndex.match(/loadAutoMemoryRecallTurnContext\(/g) ?? [],
    ).toHaveLength(2);
    expect(
      piIndex.match(/loadAutoMemoryRecallTurnContext\(/g) ?? [],
    ).toHaveLength(1);
  });

  test('the mcp-tools bridge is exported for reuse (no tool registration change)', () => {
    const mcpTools = fs.readFileSync(
      path.resolve('container/agent-runner/src/mcp-tools.ts'),
      'utf8',
    );
    expect(mcpTools).toMatch(/export (?:async )?function callAutoMemory\(/);
  });

  test('recall blocks attach below workspace memory in every decorated turn', () => {
    expect(runnerIndex).toMatch(
      /autoMemoryRecallTurn\.block[\s\S]*withWorkspaceMemory/,
    );
    expect(piIndex).toMatch(
      /owner\.block,\s*memory\.block,\s*autoMemoryRecall\.block/,
    );
  });
});

describe('buildAutoMemoryInput config chain (task Z batch 2)', () => {
  afterEach(() => {
    delete process.env.CKQCLAW_AUTO_MEMORY;
    resetAutoMemoryConfigCache();
    fs.rmSync(HOST_TMP, { recursive: true, force: true });
    fs.mkdirSync(HOST_TMP, { recursive: true });
  });

  function enableGlobalMemory(enabled: boolean): void {
    if (enabled) {
      process.env.CKQCLAW_AUTO_MEMORY = JSON.stringify({
        enabled: true,
        llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
        embedder: { baseUrl: 'https://embed.test/v1', apiKey: 'k', model: 'e' },
      });
    } else {
      delete process.env.CKQCLAW_AUTO_MEMORY;
    }
    resetAutoMemoryConfigCache();
  }

  test('global auto memory off sends nothing, even with the workspace flag on', () => {
    enableGlobalMemory(false);
    expect(buildAutoMemoryInput({ autoMemoryRecall: true })).toBeUndefined();
  });

  test('global on without the workspace flag keeps the legacy tool-only bootstrap', () => {
    enableGlobalMemory(true);
    expect(buildAutoMemoryInput(undefined)).toEqual({ enabled: true });
    expect(buildAutoMemoryInput({})).toEqual({ enabled: true });
    expect(buildAutoMemoryInput({ autoMemoryRecall: false })).toEqual({
      enabled: true,
    });
  });

  test('global on plus the workspace flag enables recall in the bootstrap', () => {
    enableGlobalMemory(true);
    expect(buildAutoMemoryInput({ autoMemoryRecall: true })).toEqual({
      enabled: true,
      recall: { enabled: true },
    });
  });

  test('recall bootstrap never carries endpoints or data paths', () => {
    enableGlobalMemory(true);
    const input = buildAutoMemoryInput({ autoMemoryRecall: true });
    expect(JSON.stringify(input)).not.toMatch(
      /apiKey|baseUrl|model|dataPath|llm|embedder/,
    );
  });

  test('both runner spawn sites derive the bootstrap from the group', () => {
    const host = fs.readFileSync(
      path.resolve('src/container-runner.ts'),
      'utf8',
    );
    expect(host.match(/buildAutoMemoryInput\(group\)/g) ?? []).toHaveLength(2);
  });
});

describe('ContainerInput autoMemory mirror (host ↔ runner)', () => {
  test('both sides declare the same recall shape inside autoMemory', () => {
    const host = fs.readFileSync(
      path.resolve('src/container-runner.ts'),
      'utf8',
    );
    const runner = fs.readFileSync(
      path.resolve('container/agent-runner/src/types.ts'),
      'utf8',
    );
    const recallShape =
      /autoMemory\?:\s*\{[\s\S]{0,220}?recall\?:\s*\{[\s\S]{0,90}?enabled\?:\s*boolean/;
    expect(host, 'host ContainerInput must declare recall').toMatch(
      recallShape,
    );
    expect(runner, 'runner ContainerInput must declare recall').toMatch(
      recallShape,
    );
  });
});

describe('frontend recall switch (task Z batch 3)', () => {
  test('GroupInfo carries auto_memory_recall', () => {
    const types = fs.readFileSync(path.resolve('web/src/types.ts'), 'utf8');
    expect(types).toMatch(/auto_memory_recall\?:\s*boolean/);
  });

  test('chat store action patches the recall endpoint and both group maps', () => {
    const store = fs.readFileSync(
      path.resolve('web/src/stores/chat.ts'),
      'utf8',
    );
    expect(store).toMatch(/updateAutoMemoryRecall:\s*async/);
    expect(store).toMatch(/\/auto-memory-recall/);
    // Optimistic update mirrors updateInteractionMode: one shared patchGroups
    // helper feeding both the chat store and the groups store.
    const action = store.slice(
      store.indexOf('updateAutoMemoryRecall: async'),
      store.indexOf('togglePin: async'),
    );
    expect(action).toMatch(/auto_memory_recall: enabled/);
    expect(action.match(/groups: patchGroups\(/g) ?? []).toHaveLength(2);
  });

  test('dialog renders the switch behind optional toggle props', () => {
    const dialog = fs.readFileSync(
      path.resolve(
        'web/src/components/chat/WorkspaceInteractionModeDialog.tsx',
      ),
      'utf8',
    );
    expect(dialog).toMatch(/自动召回记忆/);
    expect(dialog).toMatch(/onToggleAutoMemoryRecall/);
    expect(dialog).toMatch(/向量检索/);
  });

  test('ChatView passes the recall flag and toggle into the dialog', () => {
    const chatView = fs.readFileSync(
      path.resolve('web/src/components/chat/ChatView.tsx'),
      'utf8',
    );
    expect(chatView).toMatch(/autoMemoryRecall=/);
    expect(chatView).toMatch(/onToggleAutoMemoryRecall=/);
  });
});
