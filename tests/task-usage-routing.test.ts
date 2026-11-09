import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ckqclaw-task-usage-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  // 路由测试只关心落库与幂等；钱包扣费路径由 usage-accounting 覆盖。
  getSystemSettings: () => ({ billingEnabled: false }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { recordIsolatedTaskUsage } = await import('../src/task-usage.js');

const dbPath = path.join(store, 'messages.db');
let probe: InstanceType<typeof Database>;

/** Pi runner 现在发出的 usage 流事件形态（对齐 shared/stream-event.ts）。 */
function taskUsageOutput(overrides?: { eventId?: string }) {
  return {
    status: 'stream' as const,
    result: null,
    streamEvent: {
      eventType: 'usage' as const,
      agentScope: 'main' as const,
      displayLevel: 'detail' as const,
      usage: {
        eventId: overrides?.eventId ?? 'pi:01a1bf1b-test:1794207602196',
        inputTokens: 55_679,
        outputTokens: 3_230,
        cacheReadInputTokens: 50_112,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        costUSD: 0,
        durationMs: 94_419,
        numTurns: 4,
        modelUsage: {
          'glm-5.3-flash': {
            inputTokens: 55_679,
            outputTokens: 3_230,
            cacheReadInputTokens: 50_112,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            costUSD: 0,
          },
        },
      },
      sessionId: '01a1bf1b-test',
    },
  };
}

beforeAll(() => {
  db.initDatabase();
  probe = new Database(dbPath, { readonly: true });
  const now = new Date().toISOString();
  db.createUser({
    id: 'workspace-owner',
    username: 'workspace-owner',
    password_hash: 'x',
    display_name: 'Workspace owner',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

describe('isolated task usage routing (recordIsolatedTaskUsage)', () => {
  test('routes a task-turn usage stream event into the ledger with source="task"', () => {
    const result = recordIsolatedTaskUsage(taskUsageOutput(), {
      taskId: '6a3bf2',
      workspaceFolder: 'main',
      userId: 'workspace-owner',
    });

    expect(result).toMatchObject({ inserted: true });

    const events = probe
      .prepare(
        'SELECT event_id, user_id, group_folder, source, num_turns FROM usage_events WHERE event_id = ?',
      )
      .all('pi:01a1bf1b-test:1794207602196');
    expect(events).toEqual([
      {
        event_id: 'pi:01a1bf1b-test:1794207602196',
        user_id: 'workspace-owner',
        group_folder: 'main',
        source: 'task',
        num_turns: 4,
      },
    ]);

    const records = probe
      .prepare(
        'SELECT model, input_tokens, output_tokens, cache_read_input_tokens, source FROM usage_records WHERE event_id = ?',
      )
      .all('pi:01a1bf1b-test:1794207602196');
    expect(records).toEqual([
      {
        model: 'glm-5.3-flash',
        input_tokens: 55_679,
        output_tokens: 3_230,
        cache_read_input_tokens: 50_112,
        source: 'task',
      },
    ]);
  });

  test('replays of the same eventId are deduplicated, never double charged', () => {
    const replay = recordIsolatedTaskUsage(taskUsageOutput(), {
      taskId: '6a3bf2',
      workspaceFolder: 'main',
      userId: 'workspace-owner',
    });

    expect(replay).toMatchObject({ inserted: false });
    const count = probe
      .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE source = ?')
      .get('task') as { n: number };
    const recordCount = probe
      .prepare('SELECT COUNT(*) AS n FROM usage_records WHERE source = ?')
      .get('task') as { n: number };
    expect(count.n).toBe(1);
    expect(recordCount.n).toBe(1);
  });

  test('non-usage outputs and terminal results do not touch the ledger', () => {
    const before = probe
      .prepare('SELECT COUNT(*) AS n FROM usage_events')
      .get() as { n: number };

    expect(
      recordIsolatedTaskUsage(
        {
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'text_delta',
            agentScope: 'main',
            displayLevel: 'primary',
            text: 'partial',
          },
        },
        {
          taskId: '6a3bf2',
          workspaceFolder: 'main',
          userId: 'workspace-owner',
        },
      ),
    ).toBeNull();
    expect(
      recordIsolatedTaskUsage(
        { status: 'success', result: 'done' },
        {
          taskId: '6a3bf2',
          workspaceFolder: 'main',
          userId: 'workspace-owner',
        },
      ),
    ).toBeNull();

    const after = probe
      .prepare('SELECT COUNT(*) AS n FROM usage_events')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  test('falls back to the system account when no owner can be resolved', () => {
    const result = recordIsolatedTaskUsage(
      taskUsageOutput({ eventId: 'pi:no-owner:1' }),
      { taskId: '6a3bf2', workspaceFolder: 'main', userId: null },
    );
    expect(result).toMatchObject({ inserted: true });
    const row = probe
      .prepare('SELECT user_id FROM usage_events WHERE event_id = ?')
      .get('pi:no-owner:1');
    expect(row).toEqual({ user_id: 'system' });
  });
});
