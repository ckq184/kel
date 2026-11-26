import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeContext(overrides: Partial<McpContext> = {}): {
  root: string;
  tools: ReturnType<typeof createMcpTools>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-continuation-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    isScheduledTask: true,
    currentTaskId: 'task-1',
    currentInputTurnId: 'turn-1',
    workspaceIpc: root,
    workspaceGroup: root,
    ...overrides,
  };
  return { root, tools: createMcpTools(context) };
}

function findTool(tools: ReturnType<typeof createMcpTools>) {
  return tools.find((tool) => tool.name === 'task_request_continuation');
}

describe('task_request_continuation registration', () => {
  test('is absent from ordinary interactive turns', () => {
    const { tools } = makeContext({
      isScheduledTask: false,
      currentTaskId: null,
    });
    expect(findTool(tools)).toBeUndefined();
  });

  test('is absent when only a task id is known but the round is not scheduled', () => {
    // Group-mode prompts carry a task id through the ordinary message
    // pipeline; continuation is an isolated-run-only contract.
    const { tools } = makeContext({
      isScheduledTask: false,
      currentTaskId: 'task-1',
    });
    expect(findTool(tools)).toBeUndefined();
  });

  test('is absent when the round is scheduled but not task-scoped', () => {
    const { tools } = makeContext({
      isScheduledTask: true,
      currentTaskId: null,
    });
    expect(findTool(tools)).toBeUndefined();
  });

  test('is registered in scheduled task rounds only', () => {
    const { tools } = makeContext();
    const tool = findTool(tools);
    expect(tool).toBeTruthy();
    expect(tool!.description).toContain('continuation');
    expect(tool!.description).toContain('escalates to a human');
    expect(tool!.inputSchema).toHaveProperty('reason');
    expect(tool!.inputSchema).toHaveProperty('next_step');
  });
});

describe('task_request_continuation handler', () => {
  test('writes continuation.json into the run IPC namespace', async () => {
    const { root, tools } = makeContext();
    const tool = findTool(tools)!;
    const result = await tool.handler(
      { reason: '订单核对到一半', next_step: '从 51 号继续' },
      undefined as never,
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(
      fs.readFileSync(path.join(root, 'continuation.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(payload.reason).toBe('订单核对到一半');
    expect(payload.nextStep).toBe('从 51 号继续');
    expect(payload.taskId).toBe('task-1');
    expect(payload.turnId).toBe('turn-1');
    expect(typeof payload.at).toBe('string');
  });

  test('accepts a missing next step and stores null', async () => {
    const { root, tools } = makeContext();
    const tool = findTool(tools)!;
    await tool.handler({ reason: 'r' }, undefined as never);
    const payload = JSON.parse(
      fs.readFileSync(path.join(root, 'continuation.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(payload.nextStep).toBeNull();
  });

  test('a later declaration overwrites the earlier one (latest wins)', async () => {
    const { root, tools } = makeContext();
    const tool = findTool(tools)!;
    await tool.handler({ reason: 'first', next_step: 'a' }, undefined as never);
    await tool.handler(
      { reason: 'second', next_step: 'b' },
      undefined as never,
    );
    const payload = JSON.parse(
      fs.readFileSync(path.join(root, 'continuation.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(payload.reason).toBe('second');
    expect(payload.nextStep).toBe('b');
    expect(
      fs.readdirSync(root).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
  });

  test('rejects an empty reason', async () => {
    const { root, tools } = makeContext();
    const tool = findTool(tools)!;
    const result = await tool.handler({ reason: '' }, undefined as never);
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(root, 'continuation.json'))).toBe(false);
  });
});
