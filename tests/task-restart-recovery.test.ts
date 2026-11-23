import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir — same pattern as task-meta.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-restart-recovery-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  createTask,
  getTaskById,
  claimTaskForRun,
  updateTaskAfterRun,
} = await import('../src/db.js');

const { shouldSkipBackfill, validateCronMinimumInterval } =
  await import('../src/task-scheduler.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  createTask({
    id,
    group_folder: 'home-test',
    chat_jid: 'web:home-test',
    prompt: 'noop',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    script_command: null,
    execution_mode: 'container',
    next_run: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h overdue
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    workspace_jid: null,
    workspace_folder: null,
    ...overrides,
  });
  return id;
}

describe('task restart recovery — db helpers', () => {
  test('cron minimum interval is deterministic from the complete seconds field', () => {
    for (const value of ['* * * * * *', '0,30 0 * * * *', '@secondly']) {
      expect(() => validateCronMinimumInterval(value)).toThrow(
        'at least 60 seconds',
      );
    }
    for (const value of ['* * * * *', '0 * * * * *', '*/60 * * * * *']) {
      expect(() => validateCronMinimumInterval(value)).not.toThrow();
    }
  });

  test('updateTaskAfterRun sets last_run and last_result', () => {
    const id = makeTask();
    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'ran ok',
    );
    const after = getTaskById(id)!;
    expect(after.last_run).toBeTruthy();
    expect(after.last_result).toBe('ran ok');
  });

  test('claimTaskForRun gives a due task to only one scheduler runner until released', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(claimTaskForRun(id, 'runner-a', 60_000)).toBe(true);
    expect(claimTaskForRun(id, 'runner-b', 60_000)).toBe(false);
    const claimed = getTaskById(id)!;
    expect(claimed.runner_id).toBe('runner-a');
    expect(claimed.running_until).toBeTruthy();

    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'claimed run done',
    );
    const after = getTaskById(id)!;
    expect(after.running_until).toBeNull();
    expect(after.runner_id).toBeNull();
  });
});

describe('task restart recovery — decision predicate', () => {
  // Imported directly from production code so a future inline-only change
  // breaks the test rather than silently drifting from a local mirror.

  test('does not skip before the scheduler has started', () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(shouldSkipBackfill(tenDaysAgo, 0)).toBe(false);
  });

  test('work scheduled after process startup is not backfill', () => {
    const startedAt = Date.now();
    const scheduledAfterStart = new Date(startedAt + 1).toISOString();
    expect(shouldSkipBackfill(scheduledAfterStart, startedAt)).toBe(false);
  });

  test('work that became due while the process was offline is skipped', () => {
    const startedAt = Date.now();
    const scheduledBeforeStart = new Date(startedAt - 1).toISOString();
    expect(shouldSkipBackfill(scheduledBeforeStart, startedAt)).toBe(true);
  });

  test('null next_run never triggers skip', () => {
    expect(shouldSkipBackfill(null, Date.now())).toBe(false);
  });

  test('exactly at process startup is not considered downtime', () => {
    const startedAt = Date.now();
    expect(
      shouldSkipBackfill(new Date(startedAt).toISOString(), startedAt),
    ).toBe(false);
  });
});
