/**
 * ISSUE-25 regression anchor: retiring the legacy definition-level lease must
 * not change the V2 restart policy (CLAUDE.md §4) — recurring work that became
 * due while the process was offline is recorded as `missed` and its schedule
 * advances; one-time work is still replayed after a restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue25-scheduler-'));
const store = path.join(root, 'db');
const groups = path.join(root, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { startSchedulerLoop, stopSchedulerLoop } =
  await import('../src/task-scheduler.js');

beforeAll(() => db.initDatabase());
afterAll(async () => {
  await stopSchedulerLoop();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function createTask(
  id: string,
  scheduleType: 'cron' | 'once',
  scheduleValue: string,
  nextRun: string,
): void {
  db.createTask({
    id,
    group_folder: 'workspace',
    chat_jid: 'web:workspace',
    prompt: 'status',
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
  });
}

describe('ISSUE-25 retained restart policy', () => {
  test('offline recurring work is missed and advanced; offline one-time work is replayed', () => {
    const overdue = new Date(Date.now() - 3_600_000).toISOString();
    createTask('offline-cron', 'cron', '0 * * * *', overdue);
    createTask('offline-once', 'once', overdue, overdue);

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { isShuttingDown: () => false },
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      assistantName: 'CKQClaw',
    } as never);

    const cronRuns = db.getTaskRunsForTask('offline-cron', 10);
    expect(cronRuns).toHaveLength(1);
    expect(cronRuns[0]).toMatchObject({
      status: 'missed',
      trigger_type: 'backfill',
      scheduled_for: overdue,
    });
    const cron = db.getTaskById('offline-cron')!;
    expect(cron.status).toBe('active');
    expect(new Date(cron.next_run!).getTime()).toBeGreaterThan(Date.now());

    const onceRuns = db.getTaskRunsForTask('offline-once', 10);
    expect(onceRuns).toHaveLength(1);
    expect(onceRuns[0].trigger_type).toBe('backfill');
    expect(onceRuns[0].status).not.toBe('missed');
    expect(db.getTaskById('offline-once')!.next_run).toBeNull();
  });
});
