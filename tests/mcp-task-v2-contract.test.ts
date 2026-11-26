import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import {
  createMcpTools,
  type McpContext,
} from '../container/agent-runner/src/mcp-tools.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-task-v2-'));
  roots.push(root);
  const context: McpContext = {
    chatJid: 'web:workspace',
    groupFolder: 'workspace',
    isHome: true,
    agentBuilderEnabled: true,
    workspaceIpc: root,
    workspaceGroup: root,
  };
  return { root, tools: createMcpTools(context) };
}

async function readRequest(root: string): Promise<Record<string, unknown>> {
  const tasksDir = path.join(root, 'tasks');
  let requestFile = '';
  await vi.waitFor(() => {
    requestFile = fs
      .readdirSync(tasksDir)
      .find((name) => !name.includes('_result_') && name.endsWith('.json'))!;
    expect(requestFile).toBeTruthy();
  });
  return JSON.parse(
    fs.readFileSync(path.join(tasksDir, requestFile), 'utf8'),
  ) as Record<string, unknown>;
}

function writeResult(
  root: string,
  type: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  fs.writeFileSync(
    path.join(root, 'tasks', `${type}_result_${requestId}.json`),
    JSON.stringify(payload),
  );
}

describe('scheduled-task MCP V2 contract', () => {
  test('revision-protected mutations send expectedRevision to the host', async () => {
    const { root, tools } = setup();
    const pause = tools.find((tool) => tool.name === 'pause_task')!;
    const pending = pause.handler(
      { task_id: 'task-1', expected_revision: 7 },
      {} as never,
    );
    const request = await readRequest(root);

    expect(request).toMatchObject({
      type: 'pause_task',
      taskId: 'task-1',
      expectedRevision: 7,
    });
    writeResult(root, 'pause_task', request.requestId as string, {
      success: true,
      taskId: 'task-1',
      revision: 8,
    });
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining('paused') }),
      ],
    });
  });

  test('run-now forwards a stable idempotency key and returns the durable run id', async () => {
    const { root, tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'run_task_now',
        'stop_task_run',
        'restore_task',
        'list_task_runs',
      ]),
    );
    const runNow = tools.find((tool) => tool.name === 'run_task_now')!;
    const pending = runNow.handler(
      { task_id: 'task-2', idempotency_key: 'retry-key-1' },
      {} as never,
    );
    const request = await readRequest(root);

    expect(request).toMatchObject({
      type: 'run_task_now',
      taskId: 'task-2',
      idempotencyKey: 'retry-key-1',
    });
    writeResult(root, 'run_task_now', request.requestId as string, {
      success: true,
      runId: 'run-123',
    });
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({ text: expect.stringContaining('run-123') }),
      ],
      structuredContent: {
        success: true,
        task_id: 'task-2',
        run_id: 'run-123',
        status: 'queued',
        idempotency_key: 'retry-key-1',
      },
    });
  });

  test('run-now active conflict exposes the existing run id structurally', async () => {
    const { root, tools } = setup();
    const runNow = tools.find((tool) => tool.name === 'run_task_now')!;
    const pending = runNow.handler(
      { task_id: 'task-active', idempotency_key: 'active-key' },
      {} as never,
    );
    const request = await readRequest(root);
    writeResult(root, 'run_task_now', request.requestId as string, {
      success: false,
      error: 'Task is already running',
      runId: 'existing-run-1',
    });
    await expect(pending).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        success: false,
        task_id: 'task-active',
        existing_run_id: 'existing-run-1',
        idempotency_key: 'active-key',
      },
    });
  });

  test('schedule defaults to isolated and rejects sub-minute frequency locally', async () => {
    const { root, tools } = setup();
    const schedule = tools.find((tool) => tool.name === 'schedule_task')!;
    const rejected = await schedule.handler(
      {
        prompt: 'too frequent',
        schedule_type: 'cron',
        schedule_value: '0,30 0 * * * *',
        execution_type: 'agent',
      },
      {} as never,
    );
    expect(rejected).toMatchObject({ isError: true });
    const rejectedInterval = await schedule.handler(
      {
        prompt: 'too frequent interval',
        schedule_type: 'interval',
        schedule_value: '1000',
        execution_type: 'agent',
      },
      {} as never,
    );
    expect(rejectedInterval).toMatchObject({ isError: true });
    expect(fs.existsSync(path.join(root, 'tasks'))).toBe(false);

    const pending = schedule.handler(
      {
        prompt: 'daily task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'agent',
      },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request).toMatchObject({ context_mode: 'isolated' });
    writeResult(root, 'schedule_task', request.requestId as string, {
      success: true,
      taskId: 'scheduled-1',
      nextRun: '2026-08-01T01:00:00.000Z',
    });
    await expect(pending).resolves.toMatchObject({
      content: [
        expect.objectContaining({
          text: expect.stringContaining('scheduled-1'),
        }),
      ],
    });
  });

  test('run-now timeout exposes the generated idempotency key for safe retry', async () => {
    vi.useFakeTimers();
    const { root, tools } = setup();
    const runNow = tools.find((tool) => tool.name === 'run_task_now')!;
    const pending = runNow.handler({ task_id: 'task-timeout' }, {} as never);
    const request = await readRequest(root);
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await pending;
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain(
      `idempotency_key=${String(request.idempotencyKey)}`,
    );
  });

  test('resume surfaces an expired one-shot rejection from the host', async () => {
    const { root, tools } = setup();
    const resume = tools.find((tool) => tool.name === 'resume_task')!;
    const pending = resume.handler(
      { task_id: 'expired-once', expected_revision: 4 },
      {} as never,
    );
    const request = await readRequest(root);
    expect(request).toMatchObject({
      type: 'resume_task',
      taskId: 'expired-once',
      expectedRevision: 4,
    });
    writeResult(root, 'resume_task', request.requestId as string, {
      success: false,
      error: '一次性任务的执行时间已过，请先修改为未来时间后再启用。',
    });

    const result = await pending;
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('执行时间已过');
  });

  test('host IPC enforces script-operation and execution-mode boundaries', () => {
    // ISSUE-12 波 4 单元 4.6：任务生命周期十 case（含本测试全部锚文本）已
    // 迁 src/ipc/task-ops.ts（原文搬运），锚随体迁、断言文本逐字不变。
    const hostSource = fs.readFileSync(
      path.join(process.cwd(), 'src/ipc/task-ops.ts'),
      'utf8',
    );
    expect(hostSource).toContain('targetGroupEntry.executionMode');
    expect(hostSource).toContain('resolveTaskExecutionModeForTarget(');
    expect(hostSource).toContain(
      'Only the Home workspace can run script tasks.',
    );
    expect(hostSource).toContain(
      'Only the Home workspace can stop script task runs.',
    );
    expect(hostSource).toContain(
      'Only the Home workspace can delete script tasks.',
    );
    expect(hostSource).toContain(
      'Target workspace runs in container mode; host execution is not allowed.',
    );
    expect(hostSource).toContain('computeNextRunForTaskResume(');
    expect(hostSource).toContain(
      'Agent execution requires a non-empty prompt.',
    );
    expect(hostSource).toContain('SCRIPT_TASK_HOST_REQUIRED_ERROR');
    expect(hostSource).toContain('createTask({');
    expect(hostSource).not.toContain('createTaskWithinOwnerLimit(');
    expect(hostSource).not.toContain('TASK_LIMIT_REACHED');
  });
});

interface TaskToolCase {
  toolName: string;
  requestType: string;
  hasWorkspaceContext: boolean;
  args: Record<string, unknown>;
  requestTarget: Record<string, unknown>;
  successResult: Record<string, unknown>;
  successText: string;
  failurePrefix: string;
  timeoutText: string;
}

/**
 * THESIS-27 R1：五个任务工具改为工厂前后，名称、schema、IPC 请求体与
 * 成功/失败/超时文案必须逐字不变。参数化锁住契约，防止工厂合并时漂移。
 */
const TASK_TOOL_CASES: TaskToolCase[] = [
  {
    toolName: 'pause_task',
    requestType: 'pause_task',
    hasWorkspaceContext: true,
    args: { task_id: 'task-1', expected_revision: 3 },
    requestTarget: { taskId: 'task-1', expectedRevision: 3 },
    successResult: { success: true, revision: 4 },
    successText: 'Task task-1 paused.',
    failurePrefix: 'Failed to pause task task-1: ',
    timeoutText: 'Timeout waiting for pause confirmation for task task-1.',
  },
  {
    toolName: 'resume_task',
    requestType: 'resume_task',
    hasWorkspaceContext: true,
    args: { task_id: 'task-1', expected_revision: 3 },
    requestTarget: { taskId: 'task-1', expectedRevision: 3 },
    successResult: { success: true, revision: 4 },
    successText: 'Task task-1 resumed.',
    failurePrefix: 'Failed to resume task task-1: ',
    timeoutText: 'Timeout waiting for resume confirmation for task task-1.',
  },
  {
    toolName: 'cancel_task',
    requestType: 'cancel_task',
    hasWorkspaceContext: true,
    args: { task_id: 'task-1', expected_revision: 3 },
    requestTarget: { taskId: 'task-1', expectedRevision: 3 },
    successResult: { success: true, revision: 4 },
    successText: 'Task task-1 deleted. Its run history is retained.',
    failurePrefix: 'Failed to cancel task task-1: ',
    timeoutText: 'Timeout waiting for cancel confirmation for task task-1.',
  },
  {
    toolName: 'stop_task_run',
    requestType: 'stop_task_run',
    hasWorkspaceContext: false,
    args: { run_id: 'run-1' },
    requestTarget: { runId: 'run-1' },
    successResult: { success: true },
    successText: 'Run run-1 stopped. Future task schedules are unchanged.',
    failurePrefix: 'Failed to stop run run-1: ',
    timeoutText: 'Timeout waiting for stop confirmation for run run-1.',
  },
  {
    toolName: 'restore_task',
    requestType: 'restore_task',
    hasWorkspaceContext: false,
    args: { task_id: 'task-1', expected_revision: 3 },
    requestTarget: { taskId: 'task-1', expectedRevision: 3 },
    successResult: { success: true, revision: 4 },
    successText: 'Task task-1 restored as paused (revision 4).',
    failurePrefix: 'Failed to restore task task-1: ',
    timeoutText: 'Timeout waiting for restore confirmation for task task-1.',
  },
];

describe.each(TASK_TOOL_CASES)(
  'task tool contract: $toolName (THESIS-27 R1)',
  (contract) => {
    test('declares the same name, arguments and IPC request body', async () => {
      const { root, tools } = setup();
      const taskTool = tools.find((tool) => tool.name === contract.toolName);
      expect(taskTool).toBeDefined();

      const schema = z.object(taskTool!.inputSchema);
      expect(schema.safeParse(contract.args).success).toBe(true);
      if (contract.hasWorkspaceContext) {
        expect(
          schema.safeParse({ task_id: 'task-1', expected_revision: 0 }).success,
        ).toBe(false);
        expect(
          schema.safeParse({ task_id: 'task-1', expected_revision: 1.5 })
            .success,
        ).toBe(false);
        expect(schema.safeParse({ task_id: 'task-1' }).success).toBe(false);
        expect(schema.safeParse({ expected_revision: 3 }).success).toBe(false);
      } else {
        expect(schema.safeParse({}).success).toBe(false);
        expect(schema.safeParse({ run_id: 1 }).success).toBe(false);
      }

      const pending = taskTool!.handler(contract.args as never, {} as never);
      const request = await readRequest(root);
      expect(request).toMatchObject({
        type: contract.requestType,
        requestId: expect.any(String),
        timestamp: expect.any(String),
        ...contract.requestTarget,
      });
      if (contract.hasWorkspaceContext) {
        expect(request).toMatchObject({
          groupFolder: 'workspace',
          isMain: true,
        });
      } else {
        expect(request).not.toHaveProperty('groupFolder');
        expect(request).not.toHaveProperty('isMain');
      }

      writeResult(root, contract.requestType, request.requestId as string, {
        ...contract.successResult,
      });
      await expect(pending).resolves.toMatchObject({
        content: [{ type: 'text', text: contract.successText }],
      });
    });

    test('passes a revision conflict through as an error result', async () => {
      const { root, tools } = setup();
      const taskTool = tools.find((tool) => tool.name === contract.toolName)!;
      const pending = taskTool.handler(contract.args as never, {} as never);
      const request = await readRequest(root);
      const error =
        'Task changed; current revision is 4. Call list_tasks and retry.';
      writeResult(root, contract.requestType, request.requestId as string, {
        success: false,
        code: 'TASK_REVISION_CONFLICT',
        error,
      });

      await expect(pending).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: `${contract.failurePrefix}${error}` }],
      });
    });

    test('passes a missing task through as an error result', async () => {
      const { root, tools } = setup();
      const taskTool = tools.find((tool) => tool.name === contract.toolName)!;
      const pending = taskTool.handler(contract.args as never, {} as never);
      const request = await readRequest(root);
      writeResult(root, contract.requestType, request.requestId as string, {
        success: false,
        error: 'Task not found.',
      });

      await expect(pending).resolves.toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: `${contract.failurePrefix}Task not found.`,
          },
        ],
      });
    });

    test('keeps the timeout message unchanged', async () => {
      vi.useFakeTimers();
      const { root, tools } = setup();
      const taskTool = tools.find((tool) => tool.name === contract.toolName)!;
      const pending = taskTool.handler(contract.args as never, {} as never);
      await readRequest(root);
      await vi.advanceTimersByTimeAsync(31_000);

      await expect(pending).resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: contract.timeoutText }],
      });
    });
  },
);
