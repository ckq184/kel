import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'task-continuation-sched-'),
);
const tmpStoreDir = path.join(tmpDir, 'db');

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const runContainerAgentMock = vi.hoisted(() =>
  vi.fn(
    async (
      _group: unknown,
      input: { taskRunId?: string; prompt: string },
      onOutput?: (output: unknown) => Promise<void>,
    ) => {
      const taskRunId = input.taskRunId ?? '';
      const sessionDir = path.join(
        tmpDir,
        'sessions',
        'workspace',
        'agents',
        `task-${taskRunId}`,
      );
      const ipcDir = path.join(
        tmpDir,
        'ipc',
        'workspace',
        'tasks-run',
        taskRunId,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.mkdirSync(ipcDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'transcript.jsonl'), '{}');
      await onOutput?.({
        status: 'success',
        result: 'task result',
        newSessionId: `task-session:${taskRunId}`,
        inputTurnCompleted: true,
      });
      return {
        status: 'success',
        result: 'task result',
        newSessionId: `task-session:${taskRunId}`,
        inputTurnCompleted: true,
      };
    },
  ),
);

vi.mock(import('../src/container-runner.js'), async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: runContainerAgentMock,
  };
});

vi.mock(import('../src/script-runner.js'), () => ({
  runScript: vi.fn(async () => ({
    stdout: 'script result',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 10,
  })),
}));

const db = await import('../src/db.js');
const { resetTaskContinuationConfigCache } =
  await import('../src/task-continuation.js');
const {
  sweepTaskRunContinuations,
  resolveScheduledTaskPrompt,
  triggerTaskNow,
  TASK_CONTINUATION_FILE,
} = await import('../src/task-scheduler.js');

const GROUPS = {
  'web:workspace': {
    jid: 'web:workspace',
    name: 'workspace',
    folder: 'workspace',
    added_at: new Date().toISOString(),
    is_home: false,
    executionMode: 'container',
    created_by: null,
  },
};

function makeDeps() {
  return {
    registeredGroups: () => GROUPS,
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(
        (_jid: string, _taskId: string, fn: () => Promise<void>) => {
          void fn();
          return true;
        },
      ),
      closeStdin: vi.fn(),
      enqueueMessageCheck: vi.fn(),
      isShuttingDown: () => false,
      isGroupMutationPaused: vi.fn(() => false),
    },
    onProcess: vi.fn(),
    sendMessage: vi.fn(),
    broadcastStreamEvent: vi.fn(),
    storePromptMessage: vi.fn(),
    storeResultAndNotify: vi.fn(),
    assistantName: 'CKQClaw',
  } as any;
}

function createDefinition(id: string, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date().toISOString();
  db.createTask({
    id,
    group_folder: 'workspace',
    chat_jid: 'web:workspace',
    prompt: `${id} prompt`,
    schedule_type: 'cron',
    schedule_value: '0 * * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'active',
    created_at: createdAt,
    notify_channels: null,
    ...overrides,
  } as Parameters<typeof db.createTask>[0]);
  return db.getTaskById(id)!;
}

/** Drive one run through claim → started → terminal(+ optional continuation). */
function runToTerminal(
  task: ReturnType<typeof db.getTaskById>,
  status: 'success' | 'failed',
  options: { continuation?: { reason: string; nextStep?: string } } = {},
) {
  const created = db.createTaskRun({ task, triggerType: 'manual' });
  expect(created.created).toBe(true);
  const claim = db.claimNextTaskRun('continuation-test-worker', 60_000);
  expect(claim?.id).toBe(created.run.id);
  expect(
    db.markTaskRunExecutionStarted(
      claim!.id,
      claim!.lease_owner,
      claim!.lease_token,
    ),
  ).toBe(true);
  if (options.continuation) {
    expect(
      db.recordTaskRunContinuationRequest(
        claim!.id,
        options.continuation.reason,
        options.continuation.nextStep ?? null,
      ),
    ).toBe(true);
  }
  expect(
    db.completeTaskRun(claim!.id, claim!.lease_owner, claim!.lease_token, {
      status,
      result: status === 'success' ? 'done' : null,
      error: status === 'failed' ? 'boom' : null,
    }),
  ).toBe(true);
  return db.getTaskRunById(claim!.id)!;
}

function runToSuccess(
  task: ReturnType<typeof db.getTaskById>,
  options: { continuation?: { reason: string; nextStep?: string } } = {},
) {
  return runToTerminal(task, 'success', options);
}

beforeAll(() => {
  db.initDatabase();
  process.env.CKQCLAW_TASK_CONTINUATION =
    '{"maxContinuations": 3, "backoffMs": 0}';
  resetTaskContinuationConfigCache();
});

beforeEach(() => {
  runContainerAgentMock.mockClear();
});

afterAll(() => {
  delete process.env.CKQCLAW_TASK_CONTINUATION;
  resetTaskContinuationConfigCache();
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema v71 continuation columns', () => {
  test('task_runs carries the continuation columns with safe defaults', () => {
    // v71 columns survive at head (72 = approval-gate rollback, 73 = custom
    // model pricing table, 74 = auto_memory_recall column; all unrelated to
    // task_runs).
    expect(db.CURRENT_SCHEMA_VERSION).toBe(74);
    const task = createDefinition('schema-defaults-task');
    const run = runToSuccess(task);
    // New columns exist on every row (legacy rows migrate to these defaults).
    expect(run.continuation_count).toBe(0);
    expect(run.continuation_reason).toBeNull();
    expect(run.continuation_next_step).toBeNull();
    expect(run.continuation_state).toBeNull();
    expect(run.continuation_child_run_id).toBeNull();
  });
});

describe('continuation request recording', () => {
  test('records once; a second stamp never overwrites the first request', () => {
    const task = createDefinition('record-request-task');
    const run = runToSuccess(task);
    expect(run.continuation_state).toBeNull();
    expect(
      db.recordTaskRunContinuationRequest(run.id, 'first reason', 'step one'),
    ).toBe(true);
    expect(
      db.recordTaskRunContinuationRequest(run.id, 'second reason', null),
    ).toBe(false);
    const after = db.getTaskRunById(run.id)!;
    expect(after.continuation_state).toBe('requested');
    expect(after.continuation_reason).toBe('first reason');
    expect(after.continuation_next_step).toBe('step one');
    expect(after.continuation_count).toBe(0);
    expect(db.getTaskRunsPendingContinuation().map((r) => r.id)).toContain(
      run.id,
    );
    // Keep the shared DB clean for later sweeps.
    db.settleTaskRunContinuationAbandoned(run.id);
  });
});

describe('sweepTaskRunContinuations state machine', () => {
  test('chains continuation runs up to the budget, then escalates to needs_human', async () => {
    const deps = makeDeps();
    const task = createDefinition('chain-task');
    let parent = runToSuccess(task, {
      continuation: { reason: 'not done 0', nextStep: 'go 1' },
    });

    const seenCounts: number[] = [];
    for (let index = 1; index <= 3; index++) {
      sweepTaskRunContinuations(deps);
      const parentRow = db.getTaskRunById(parent.id)!;
      expect(parentRow.continuation_state).toBe('continued');
      const child = db.getTaskRunById(parentRow.continuation_child_run_id!)!;
      expect(child.trigger_type).toBe('continuation');
      expect(child.continuation_count).toBe(index);
      expect(child.continuation_reason).toBe(`not done ${index - 1}`);
      expect(child.continuation_next_step).toBe(`go ${index}`);
      expect(child.status).toBe('queued');
      seenCounts.push(child.continuation_count);

      // Complete the child and let it request one more continuation.
      const claim = db.claimNextTaskRun('chain-worker', 60_000);
      expect(claim?.id).toBe(child.id);
      expect(
        db.markTaskRunExecutionStarted(
          child.id,
          claim!.lease_owner,
          claim!.lease_token,
        ),
      ).toBe(true);
      db.recordTaskRunContinuationRequest(
        child.id,
        `not done ${index}`,
        `go ${index + 1}`,
      );
      db.completeTaskRun(child.id, claim!.lease_owner, claim!.lease_token, {
        status: 'success',
        result: `round ${index}`,
      });
      parent = db.getTaskRunById(child.id)!;
    }
    expect(seenCounts).toEqual([1, 2, 3]);

    // Budget exhausted: the fourth request escalates instead of spawning work.
    sweepTaskRunContinuations(deps);
    const escalated = db.getTaskRunById(parent.id)!;
    expect(escalated.status).toBe('needs_human');
    expect(escalated.continuation_state).toBe('needs_human');
    expect(deps.storeResultAndNotify).toHaveBeenCalledTimes(1);
    const [chatJid, text, options] = deps.storeResultAndNotify.mock.calls[0];
    expect(chatJid).toBe('web:workspace');
    expect(text).toContain('需要人工处理');
    expect(text).toContain('not done 3');
    expect(options.messageId).toBe(`scheduled-task-needs-human:${parent.id}`);
    expect(options.sourceKind).toBe('scheduled_task_result');

    // Terminal: further sweeps are inert.
    sweepTaskRunContinuations(deps);
    expect(deps.storeResultAndNotify).toHaveBeenCalledTimes(1);
  });

  test('successful run without a request never continues', () => {
    const deps = makeDeps();
    const task = createDefinition('plain-success-task');
    runToSuccess(task);
    sweepTaskRunContinuations(deps);
    expect(db.getTaskRunsForTask(task.id)).toHaveLength(1);
    expect(deps.storeResultAndNotify).not.toHaveBeenCalled();
  });

  test('failed run with a request abandons it (no loop, no escalation)', () => {
    const deps = makeDeps();
    const task = createDefinition('failed-request-task');
    // The runner declared itself unfinished mid-turn, then the turn failed.
    const run = runToTerminal(task, 'failed', {
      continuation: { reason: 'declared unfinished' },
    });
    sweepTaskRunContinuations(deps);
    const settled = db.getTaskRunById(run.id)!;
    expect(settled.continuation_state).toBe('abandoned');
    expect(settled.status).toBe('failed');
    expect(db.getTaskRunsForTask(task.id)).toHaveLength(1);
    expect(deps.storeResultAndNotify).not.toHaveBeenCalled();
  });

  test('paused or deleted tasks never spawn continuation work', () => {
    const deps = makeDeps();
    const pausedTask = createDefinition('paused-request-task');
    const pausedRun = runToSuccess(pausedTask, {
      continuation: { reason: 'r' },
    });
    db.updateTask(pausedTask.id, { status: 'paused' });
    sweepTaskRunContinuations(deps);
    expect(db.getTaskRunById(pausedRun.id)!.continuation_state).toBe(
      'abandoned',
    );
    expect(db.getTaskRunsForTask(pausedTask.id)).toHaveLength(1);

    const deletedTask = createDefinition('deleted-request-task');
    const deletedRun = runToSuccess(deletedTask, {
      continuation: { reason: 'r' },
    });
    expect(
      db.softDeleteTaskWithRevision(deletedTask.id, deletedTask.revision)
        .status,
    ).toBe('updated');
    sweepTaskRunContinuations(deps);
    expect(db.getTaskRunById(deletedRun.id)!.continuation_state).toBe(
      'abandoned',
    );
    expect(db.getTaskRunsForTask(deletedTask.id)).toHaveLength(1);
  });

  test('a fresh active run supersedes the pending continuation', () => {
    const deps = makeDeps();
    const task = createDefinition('superseded-request-task');
    const parent = runToSuccess(task, {
      continuation: { reason: 'slow work' },
    });
    // The owner pressed "Run Now" before the sweep acted.
    const manual = db.createTaskRun({ task, triggerType: 'manual' });
    expect(manual.created).toBe(true);
    sweepTaskRunContinuations(deps);
    const parentRow = db.getTaskRunById(parent.id)!;
    expect(parentRow.continuation_state).toBe('abandoned');
    expect(parentRow.continuation_child_run_id).toBeNull();
    expect(db.getTaskRunsForTask(task.id)).toHaveLength(2);
    // Drain the manual run so later claims stay deterministic.
    const drain = db.claimNextTaskRun('superseded-drain', 60_000);
    if (drain && drain.id === manual.run.id) {
      db.cancelTaskRun(manual.run.id, 'drained by test');
    }
  });

  test('zero budget escalates on the first request', () => {
    process.env.CKQCLAW_TASK_CONTINUATION =
      '{"maxContinuations": 0, "backoffMs": 0}';
    resetTaskContinuationConfigCache();
    try {
      const deps = makeDeps();
      const task = createDefinition('zero-budget-task');
      const run = runToSuccess(task, { continuation: { reason: 'r' } });
      sweepTaskRunContinuations(deps);
      const escalated = db.getTaskRunById(run.id)!;
      expect(escalated.status).toBe('needs_human');
      expect(db.getTaskRunsForTask(task.id)).toHaveLength(1);
    } finally {
      process.env.CKQCLAW_TASK_CONTINUATION =
        '{"maxContinuations": 3, "backoffMs": 0}';
      resetTaskContinuationConfigCache();
    }
  });

  test('continuation run respects the configured backoff before becoming due', () => {
    process.env.CKQCLAW_TASK_CONTINUATION =
      '{"maxContinuations": 1, "backoffMs": 300000}';
    resetTaskContinuationConfigCache();
    try {
      const deps = makeDeps();
      const task = createDefinition('backoff-task');
      const parent = runToSuccess(task, { continuation: { reason: 'r' } });
      sweepTaskRunContinuations(deps);
      const child = db.getTaskRunById(
        db.getTaskRunById(parent.id)!.continuation_child_run_id!,
      )!;
      expect(child.status).toBe('queued');
      expect(new Date(child.available_at).getTime()).toBeGreaterThan(
        Date.now() - 1000,
      );
      // Not claimable before the backoff elapses.
      const premature = db.claimNextTaskRun('backoff-worker', 60_000);
      if (premature) db.cancelTaskRun(premature.id, 'drained by test');
      expect(premature?.id ?? 'none').not.toBe(child.id);
    } finally {
      process.env.CKQCLAW_TASK_CONTINUATION =
        '{"maxContinuations": 3, "backoffMs": 0}';
      resetTaskContinuationConfigCache();
    }
  });

  test('sweep is idempotent when run twice without new state', () => {
    const deps = makeDeps();
    const task = createDefinition('idempotent-task');
    const parent = runToSuccess(task, { continuation: { reason: 'r' } });
    const runsBefore = db.getTaskRunsForTask(task.id).length;
    sweepTaskRunContinuations(deps);
    sweepTaskRunContinuations(deps);
    sweepTaskRunContinuations(deps);
    expect(db.getTaskRunsForTask(task.id)).toHaveLength(runsBefore + 1);
    expect(db.getTaskRunById(parent.id)!.continuation_state).toBe('continued');
    // Drain the spawned child so later claim assertions stay deterministic.
    const child = db
      .getTaskRunsForTask(task.id)
      .find((r) => r.id !== parent.id)!;
    db.cancelTaskRun(child.id, 'drained by test');
  });

  test('a completed once-task still continues: the mechanical flip must not veto a pending request', () => {
    const deps = makeDeps();
    const task = createDefinition('once-continue-task', {
      schedule_type: 'once',
      schedule_value: '2020-01-01T00:00:00',
      next_run: null,
    });
    expect(task.schedule_type).toBe('once');
    const parent = runToSuccess(task, {
      continuation: { reason: 'once chain', nextStep: 'wait' },
    });
    // The scheduler's post-run bookkeeping (updateTaskAfterRun with a null
    // next_run) flips a once task to 'completed' the moment its run ends —
    // strictly before the sweep settles the continuation request.
    db.updateTaskAfterRun(task.id, null, 'done');
    expect(db.getTaskById(task.id)!.status).toBe('completed');

    sweepTaskRunContinuations(deps);

    const parentRow = db.getTaskRunById(parent.id)!;
    expect(parentRow.continuation_state).toBe('continued');
    const child = db.getTaskRunById(parentRow.continuation_child_run_id!)!;
    expect(child.trigger_type).toBe('continuation');
    expect(child.status).toBe('queued');
    // The task was revived to active inside the sweep's creation transaction
    // so markTaskRunExecutionStarted's active/paused fence admits the child.
    expect(db.getTaskById(task.id)!.status).toBe('active');
    // The child is claimable through the real execution boundary.
    const claim = db.claimNextTaskRun('once-chain-worker', 60_000);
    expect(claim?.id).toBe(child.id);
    expect(
      db.markTaskRunExecutionStarted(
        child.id,
        claim!.lease_owner,
        claim!.lease_token,
      ),
    ).toBe(true);
    // Chain end without a new request: the once-flip re-completes the task.
    db.completeTaskRun(child.id, claim!.lease_owner, claim!.lease_token, {
      status: 'success',
      result: 'round 1',
    });
    db.updateTaskAfterRun(task.id, null, 'done');
    sweepTaskRunContinuations(deps);
    expect(db.getTaskById(task.id)!.status).toBe('completed');
    expect(db.getTaskRunsForTask(task.id)).toHaveLength(2);
    expect(deps.storeResultAndNotify).not.toHaveBeenCalled();
  });

  test('a completed once-task chain escalates to needs_human and stays completed', () => {
    const deps = makeDeps();
    const task = createDefinition('once-needs-human-task', {
      schedule_type: 'once',
      schedule_value: '2020-01-01T00:00:00',
      next_run: null,
    });
    let parent = runToSuccess(task, {
      continuation: { reason: 'once not done 0', nextStep: 'go 1' },
    });
    for (let index = 1; index <= 3; index++) {
      db.updateTaskAfterRun(task.id, null, 'done');
      expect(db.getTaskById(task.id)!.status).toBe('completed');
      sweepTaskRunContinuations(deps);
      const parentRow = db.getTaskRunById(parent.id)!;
      expect(parentRow.continuation_state).toBe('continued');
      expect(db.getTaskById(task.id)!.status).toBe('active');
      const child = db.getTaskRunById(parentRow.continuation_child_run_id!)!;
      const claim = db.claimNextTaskRun('once-chain-worker', 60_000);
      expect(claim?.id).toBe(child.id);
      expect(
        db.markTaskRunExecutionStarted(
          child.id,
          claim!.lease_owner,
          claim!.lease_token,
        ),
      ).toBe(true);
      db.recordTaskRunContinuationRequest(
        child.id,
        `once not done ${index}`,
        `go ${index + 1}`,
      );
      db.completeTaskRun(child.id, claim!.lease_owner, claim!.lease_token, {
        status: 'success',
        result: `round ${index}`,
      });
      parent = db.getTaskRunById(child.id)!;
    }
    db.updateTaskAfterRun(task.id, null, 'done');
    sweepTaskRunContinuations(deps);
    const escalated = db.getTaskRunById(parent.id)!;
    expect(escalated.status).toBe('needs_human');
    expect(escalated.continuation_state).toBe('needs_human');
    // No child was spawned for the escalated request, so the once task stays
    // in its post-run 'completed' state instead of being revived.
    expect(db.getTaskById(task.id)!.status).toBe('completed');
  });
});

describe('resolveScheduledTaskPrompt', () => {
  test('plain runs keep their prompt untouched', () => {
    const task = createDefinition('prompt-plain-task');
    expect(resolveScheduledTaskPrompt(task, undefined)).toBe(task.prompt);
    const plainRun = runToSuccess(task);
    expect(resolveScheduledTaskPrompt(task, plainRun)).toBe(task.prompt);
  });

  test('continuation runs get framing with reason, next step and budget', () => {
    const task = createDefinition('prompt-continuation-task');
    const parent = runToSuccess(task, {
      continuation: { reason: 'half done', nextStep: 'resume at 51' },
    });
    sweepTaskRunContinuations(makeDeps());
    const child = db.getTaskRunById(
      db.getTaskRunById(parent.id)!.continuation_child_run_id!,
    )!;
    const prompt = resolveScheduledTaskPrompt(task, child);
    expect(prompt).toContain('[定时任务自动续跑]');
    expect(prompt).toContain('未完成原因：half done');
    expect(prompt).toContain('建议下一步：resume at 51');
    expect(prompt.endsWith(task.prompt)).toBe(true);
    // Drain the spawned child so later claim assertions stay deterministic.
    db.cancelTaskRun(child.id, 'drained by test');
  });
});

describe('host IPC wiring: continuation.json lands on the durable run', () => {
  test('runTaskInner reads the IPC file and stamps the request', async () => {
    const deps = makeDeps();
    const task = createDefinition('ipc-wiring-task');
    const parent = runToSuccess(task, {
      continuation: { reason: 'seed reason' },
    });
    sweepTaskRunContinuations(deps);
    const childId = db.getTaskRunById(parent.id)!.continuation_child_run_id!;

    // The mocked container runner writes a continuation request for the child.
    runContainerAgentMock.mockImplementationOnce(
      async (
        _group: unknown,
        input: { taskRunId?: string },
        onOutput?: (output: unknown) => Promise<void>,
      ) => {
        const taskRunId = input.taskRunId ?? '';
        const ipcDir = path.join(
          tmpDir,
          'ipc',
          'workspace',
          'tasks-run',
          taskRunId,
        );
        fs.mkdirSync(ipcDir, { recursive: true });
        fs.writeFileSync(
          path.join(ipcDir, TASK_CONTINUATION_FILE),
          JSON.stringify({
            reason: 'child unfinished',
            nextStep: 'try harder',
            turnId: 'turn-x',
            at: new Date().toISOString(),
          }),
        );
        await onOutput?.({
          status: 'success',
          result: 'child result',
          newSessionId: `task-session:${taskRunId}`,
          inputTurnCompleted: true,
        });
        return {
          status: 'success',
          result: 'child result',
          newSessionId: `task-session:${taskRunId}`,
          inputTurnCompleted: true,
        };
      },
    );

    // Pump the scheduler through an unrelated manual trigger; the pump claims
    // every due run, including the queued continuation child.
    const pumpTask = createDefinition('pump-helper-task');
    triggerTaskNow(pumpTask.id, deps);
    await vi.waitFor(() => {
      const child = db.getTaskRunById(childId);
      expect(child?.status).toBe('success');
      expect(child?.continuation_state).toBe('requested');
      expect(child?.continuation_reason).toBe('child unfinished');
      expect(child?.continuation_next_step).toBe('try harder');
    });
    // The continuation prompt reached the runner.
    const childCall = runContainerAgentMock.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'object' &&
        (call[1] as { prompt?: string }).prompt?.includes('seed reason'),
    );
    expect(childCall).toBeTruthy();
    expect((childCall![1] as { prompt: string }).prompt).toContain(
      '[定时任务自动续跑]',
    );
  });
});
