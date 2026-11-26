import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * THESIS-27 R2：宿主侧 pause/resume/cancel/update/restore 五个 case 的
 * "expected_revision 缺失、修订冲突、任务不存在"三段回执在去重前后必须
 * 逐字不变（restore 的冲突文案历史上少一句 "Call list_tasks and retry."）。
 */
const mocks = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  updateTaskWithRevision: vi.fn(),
  softDeleteTaskWithRevision: vi.fn(),
  restoreTaskWithRevision: vi.fn(),
  getRegisteredGroup: vi.fn(),
  getRegisteredGroups: vi.fn(() => ({})),
  getActiveTaskRunForTask: vi.fn(),
  getSessionChannelOwner: vi.fn(),
  createTask: vi.fn(),
  getAllTasks: vi.fn(() => []),
  getDeletedTasks: vi.fn(() => []),
  getTaskRunById: vi.fn(),
  computeNextRunForSchedule: vi.fn(),
  computeNextRunForTaskResume: vi.fn(),
  getRunningTaskIds: vi.fn(() => []),
  notifyTaskSchedulerChanged: vi.fn(),
  resolveTaskOwner: vi.fn(() => 'owner-1'),
  findDuplicateActiveAgentTask: vi.fn(() => undefined),
  getScriptTaskHostExecutionError: vi.fn(() => null),
  resolveTaskExecutionModeForTarget: vi.fn(() => 'host'),
  getMergedTaskRunHistory: vi.fn(() => []),
  getWebDeps: vi.fn(() => undefined),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock('../src/db.js', () => ({
  getTaskById: mocks.getTaskById,
  updateTaskWithRevision: mocks.updateTaskWithRevision,
  softDeleteTaskWithRevision: mocks.softDeleteTaskWithRevision,
  restoreTaskWithRevision: mocks.restoreTaskWithRevision,
  getRegisteredGroup: mocks.getRegisteredGroup,
  getRegisteredGroups: mocks.getRegisteredGroups,
  getActiveTaskRunForTask: mocks.getActiveTaskRunForTask,
  getSessionChannelOwner: mocks.getSessionChannelOwner,
  createTask: mocks.createTask,
  getAllTasks: mocks.getAllTasks,
  getDeletedTasks: mocks.getDeletedTasks,
  getTaskRunById: mocks.getTaskRunById,
}));

vi.mock('../src/task-scheduler.js', () => ({
  computeNextRunForSchedule: mocks.computeNextRunForSchedule,
  computeNextRunForTaskResume: mocks.computeNextRunForTaskResume,
  getRunningTaskIds: mocks.getRunningTaskIds,
  notifyTaskSchedulerChanged: mocks.notifyTaskSchedulerChanged,
}));

vi.mock('../src/task-utils.js', () => ({
  resolveTaskOwner: mocks.resolveTaskOwner,
}));

vi.mock('../src/task-definition-fingerprint.js', () => ({
  findDuplicateActiveAgentTask: mocks.findDuplicateActiveAgentTask,
}));

vi.mock('../src/script-task-policy.js', () => ({
  getScriptTaskHostExecutionError: mocks.getScriptTaskHostExecutionError,
  resolveTaskExecutionModeForTarget: mocks.resolveTaskExecutionModeForTarget,
  SCRIPT_TASK_HOST_REQUIRED_ERROR: 'Script tasks must run on the host.',
}));

vi.mock('../src/task-run-history.js', () => ({
  getMergedTaskRunHistory: mocks.getMergedTaskRunHistory,
}));

vi.mock('../src/web-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/web-context.js')>()),
  getWebDeps: mocks.getWebDeps,
}));

const { processIpcTaskOps } = await import('../src/ipc/task-ops.js');

type Payload = Record<string, unknown>;

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    group_folder: 'workspace',
    chat_jid: 'web:workspace',
    prompt: 'do work',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    status: 'active',
    execution_type: 'agent',
    execution_mode: 'host',
    script_command: null,
    next_run: '2026-11-27T01:00:00.000Z',
    revision: 3,
    deleted_at: null,
    created_by: 'owner-1',
    ...overrides,
  };
}

async function runTaskOp(
  data: Payload,
  manage = true,
): Promise<{ type: string; requestId?: string; payload: Payload }[]> {
  const results: { type: string; requestId?: string; payload: Payload }[] = [];
  await processIpcTaskOps({
    data: { requestId: 'request-1', ...data },
    sourceGroup: 'workspace',
    isHome: true,
    sourceGroupEntry: undefined,
    tasksDir: '/tmp/thesis-27-task-ops',
    ipcAgentId: null,
    writeTaskResult: (_tasksDir, type, requestId, payload) => {
      results.push({ type, requestId, payload });
    },
    getRegisteredGroups: () => ({}),
    ipcActorCanAccessGroupJid: () => true,
    ipcActorCanManageTask: () => manage,
    isAdminHostOnlyOwner: () => false,
    SAFE_REQUEST_ID_RE: /^[A-Za-z0-9_-]{1,128}$/,
  } as never);
  return results;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTaskById.mockReturnValue(baseTask());
  mocks.getRegisteredGroups.mockReturnValue({});
  mocks.getRunningTaskIds.mockReturnValue([]);
  mocks.getScriptTaskHostExecutionError.mockReturnValue(null);
});

describe('IPC task revision failure contract (THESIS-27 R2)', () => {
  for (const type of ['pause_task', 'resume_task'] as const) {
    test(`${type} rejects a missing expected_revision`, async () => {
      const results = await runTaskOp({ type, taskId: 'task-1' });
      expect(results).toEqual([
        {
          type,
          requestId: 'request-1',
          payload: {
            success: false,
            error: 'expected_revision is required. Call list_tasks first.',
          },
        },
      ]);
    });

    test(`${type} reports a revision conflict with the current revision`, async () => {
      mocks.updateTaskWithRevision.mockReturnValue({
        status: 'conflict',
        task: { revision: 5 },
      });
      const results = await runTaskOp({
        type,
        taskId: 'task-1',
        expectedRevision: 3,
      });
      expect(results).toEqual([
        {
          type,
          requestId: 'request-1',
          payload: {
            success: false,
            code: 'TASK_REVISION_CONFLICT',
            error:
              'Task changed; current revision is 5. Call list_tasks and retry.',
            task: { revision: 5 },
          },
        },
      ]);
    });

    test(`${type} reports a concurrently deleted task`, async () => {
      mocks.updateTaskWithRevision.mockReturnValue({ status: 'not_found' });
      const results = await runTaskOp({
        type,
        taskId: 'task-1',
        expectedRevision: 3,
      });
      expect(results).toEqual([
        {
          type,
          requestId: 'request-1',
          payload: { success: false, error: 'Task not found.' },
        },
      ]);
    });
  }

  test('cancel_task keeps the active-run conflict payload', async () => {
    mocks.softDeleteTaskWithRevision.mockReturnValue({
      status: 'active_run',
      run: { id: 'run-9' },
    });
    const results = await runTaskOp({
      type: 'cancel_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(results).toEqual([
      {
        type: 'cancel_task',
        requestId: 'request-1',
        payload: {
          success: false,
          code: 'TASK_HAS_ACTIVE_RUN',
          error: 'Task is running. Stop the current run before deleting.',
          runId: 'run-9',
        },
      },
    ]);
  });

  test('update_task rejects a missing expected_revision', async () => {
    const results = await runTaskOp({ type: 'update_task', taskId: 'task-1' });
    expect(results).toEqual([
      {
        type: 'update_task',
        requestId: 'request-1',
        payload: {
          success: false,
          error: 'expected_revision is required. Call list_tasks first.',
        },
      },
    ]);
  });

  test('update_task reports a revision conflict and a missing task', async () => {
    mocks.getTaskById.mockReturnValue(
      baseTask({ execution_mode: 'container' }),
    );
    mocks.updateTaskWithRevision.mockReturnValue({
      status: 'conflict',
      task: { revision: 5 },
    });
    const conflict = await runTaskOp({
      type: 'update_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(conflict[0].payload).toEqual({
      success: false,
      code: 'TASK_REVISION_CONFLICT',
      error: 'Task changed; current revision is 5. Call list_tasks and retry.',
      task: { revision: 5 },
    });

    mocks.updateTaskWithRevision.mockReturnValue({ status: 'not_found' });
    const missing = await runTaskOp({
      type: 'update_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(missing[0].payload).toEqual({
      success: false,
      error: 'Task not found.',
    });
  });

  test('restore_task keeps its shorter conflict message and deleted-task error', async () => {
    mocks.getTaskById.mockReturnValue(
      baseTask({ status: 'paused', deleted_at: '2026-11-26T00:00:00.000Z' }),
    );
    mocks.restoreTaskWithRevision.mockReturnValue({
      status: 'conflict',
      task: { revision: 5 },
    });
    const conflict = await runTaskOp({
      type: 'restore_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(conflict[0].payload).toEqual({
      success: false,
      code: 'TASK_REVISION_CONFLICT',
      error: 'Task changed; current revision is 5.',
      task: { revision: 5 },
    });

    mocks.restoreTaskWithRevision.mockReturnValue({ status: 'not_found' });
    const missing = await runTaskOp({
      type: 'restore_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(missing[0].payload).toEqual({
      success: false,
      error: 'Deleted task not found.',
    });
  });

  test('restore_task still requires both task_id and expected_revision', async () => {
    const results = await runTaskOp({ type: 'restore_task' });
    expect(results).toEqual([
      {
        type: 'restore_task',
        requestId: 'request-1',
        payload: {
          success: false,
          error: 'task_id and expected_revision are required.',
        },
      },
    ]);
  });

  test('cancel_task keeps missing-revision, conflict and not-found failures', async () => {
    const missing = await runTaskOp({ type: 'cancel_task', taskId: 'task-1' });
    expect(missing[0].payload).toEqual({
      success: false,
      error: 'expected_revision is required. Call list_tasks first.',
    });

    mocks.softDeleteTaskWithRevision.mockReturnValue({
      status: 'conflict',
      task: { revision: 5 },
    });
    const conflict = await runTaskOp({
      type: 'cancel_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(conflict[0].payload).toEqual({
      success: false,
      code: 'TASK_REVISION_CONFLICT',
      error: 'Task changed; current revision is 5. Call list_tasks and retry.',
      task: { revision: 5 },
    });

    mocks.softDeleteTaskWithRevision.mockReturnValue({ status: 'not_found' });
    const notFound = await runTaskOp({
      type: 'cancel_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(notFound[0].payload).toEqual({
      success: false,
      error: 'Task not found.',
    });
  });

  test('successful pause/resume/cancel write revision, log and notify', async () => {
    const updated = { status: 'updated', task: { revision: 4 } };
    for (const [type, logMessage] of [
      ['pause_task', 'Task paused via IPC'],
      ['resume_task', 'Task resumed via IPC'],
    ] as const) {
      vi.clearAllMocks();
      mocks.getTaskById.mockReturnValue(baseTask());
      mocks.updateTaskWithRevision.mockReturnValue(updated);
      const results = await runTaskOp({
        type,
        taskId: 'task-1',
        expectedRevision: 3,
      });
      expect(results).toEqual([
        {
          type,
          requestId: 'request-1',
          payload: { success: true, taskId: 'task-1', revision: 4 },
        },
      ]);
      expect(mocks.notifyTaskSchedulerChanged).toHaveBeenCalledTimes(1);
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        { taskId: 'task-1', sourceGroup: 'workspace' },
        logMessage,
      );
    }

    vi.clearAllMocks();
    mocks.getTaskById.mockReturnValue(baseTask());
    mocks.softDeleteTaskWithRevision.mockReturnValue(updated);
    const cancelled = await runTaskOp({
      type: 'cancel_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(cancelled[0].payload).toEqual({
      success: true,
      taskId: 'task-1',
      revision: 4,
    });
    expect(mocks.notifyTaskSchedulerChanged).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { taskId: 'task-1', sourceGroup: 'workspace' },
      'Task cancelled via IPC',
    );
  });

  test('successful update writes nextRun, logs and notifies', async () => {
    mocks.getTaskById.mockReturnValue(
      baseTask({ execution_mode: 'container' }),
    );
    mocks.updateTaskWithRevision.mockReturnValue({
      status: 'updated',
      task: { revision: 4 },
    });
    const results = await runTaskOp({
      type: 'update_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(results[0].payload).toEqual({
      success: true,
      taskId: 'task-1',
      nextRun: baseTask().next_run,
      revision: 4,
    });
    expect(mocks.notifyTaskSchedulerChanged).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { taskId: 'task-1', sourceGroup: 'workspace' },
      'Task updated via IPC',
    );
  });

  test('successful restore writes revision and notifies without an info log', async () => {
    mocks.getTaskById.mockReturnValue(
      baseTask({ status: 'paused', deleted_at: '2026-11-26T00:00:00.000Z' }),
    );
    mocks.restoreTaskWithRevision.mockReturnValue({
      status: 'updated',
      task: { revision: 4 },
    });
    const results = await runTaskOp({
      type: 'restore_task',
      taskId: 'task-1',
      expectedRevision: 3,
    });
    expect(results[0].payload).toEqual({
      success: true,
      taskId: 'task-1',
      revision: 4,
    });
    expect(mocks.notifyTaskSchedulerChanged).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });
});
