/**
 * memory_promote idempotency contract.
 *
 * The v2 store replays create requests that reuse an idempotencyKey. The
 * promote tool derives that key from the SOURCE automatic memory id alone —
 * not from the turn — so promoting the same automatic memory from a later
 * session cannot mint a duplicate curated item (verified end-to-end in task-C
 * acceptance: the turn-scoped predecessor produced cross-turn duplicates).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createMcpTools,
  promoteIdempotencyKey,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTools(overrides: Partial<McpContext> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-promote-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    isScheduledTask: false,
    currentTaskId: null,
    currentInputTurnId: 'turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
    ...overrides,
  };
  return createMcpTools(context);
}

describe('promoteIdempotencyKey', () => {
  test('is turn-independent (stable per source memory)', () => {
    expect(promoteIdempotencyKey('mem-abc')).toBe('promote:mem-abc');
    expect(promoteIdempotencyKey('mem-abc')).toBe(
      promoteIdempotencyKey('mem-abc'),
    );
    expect(promoteIdempotencyKey('mem-other')).not.toBe(
      promoteIdempotencyKey('mem-abc'),
    );
  });
});

describe('memory_promote / auto_memory_add registration', () => {
  test('registered in interactive turns', () => {
    const tools = makeTools();
    expect(tools.some((t) => t.name === 'memory_promote')).toBe(true);
    expect(tools.some((t) => t.name === 'auto_memory_add')).toBe(true);
    expect(tools.some((t) => t.name === 'auto_memory_search')).toBe(true);
  });

  test('absent from scheduled task rounds (read-only automatic layer)', () => {
    const tools = makeTools({ isScheduledTask: true, currentTaskId: 'task-1' });
    expect(tools.some((t) => t.name === 'memory_promote')).toBe(false);
    expect(tools.some((t) => t.name === 'auto_memory_add')).toBe(false);
    // Read access remains.
    expect(tools.some((t) => t.name === 'auto_memory_search')).toBe(true);
  });
});
