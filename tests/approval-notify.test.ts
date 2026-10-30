import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// approval-service derives its IPC root from DATA_DIR at import time, so the
// whole harness (DB + file protocol) must point at a temp tree before any
// dynamic import of the modules under test.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-notify-'));
fs.mkdirSync(path.join(root, 'db'), { recursive: true });
fs.mkdirSync(path.join(root, 'groups'), { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const approvalService = await import('../src/approval-service.js');
const approvalNotify = await import('../src/approval-notify.js');
const logger = (await import('../src/logger.js')).logger as {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

import type { ApprovalEvent } from '../src/approval-notify.js';

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function writePendingRequest(folder: string, request: object): void {
  const dir = path.join(root, 'ipc', folder, 'approvals', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${(request as { id: string }).id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(request));
  fs.renameSync(tmp, file);
}

function readDecisionFile(folder: string, id: string): object | null {
  const file = path.join(
    root,
    'ipc',
    folder,
    'approvals',
    'decisions',
    `${id}.json`,
  );
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as object;
}

const baseRequest = {
  toolName: 'send_file',
  input: { path: '/tmp/report.txt', caption: '月报' },
  groupFolder: 'ws-1',
  chatJid: 'web:ws-1-home',
  sessionId: 'sess-1',
  turnId: 'turn-1',
  createdAt: '2026-10-17T10:00:00.000Z',
  timeoutMs: 300_000,
};

describe('approval notify pipeline (file protocol → DB → events)', () => {
  test('scan mirrors a new pending request and emits approval_requested', () => {
    const events: ApprovalEvent[] = [];
    const unsubscribe = approvalNotify.onApprovalEvent((event) =>
      events.push(event),
    );

    writePendingRequest('ws-1', { ...baseRequest, id: 'req-0001' });
    approvalService.scanApprovalRequests();

    const row = db.getPendingApproval('req-0001');
    expect(row).toMatchObject({
      id: 'req-0001',
      group_folder: 'ws-1',
      tool_name: 'send_file',
      status: 'pending',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'approval_requested',
      approval: {
        id: 'req-0001',
        groupFolder: 'ws-1',
        chatJid: 'web:ws-1-home',
        toolName: 'send_file',
        inputSummary: expect.stringContaining('report.txt'),
        sessionId: 'sess-1',
        turnId: 'turn-1',
        createdAt: '2026-10-17T10:00:00.000Z',
        timeoutMs: 300_000,
      },
    });
    unsubscribe();
  });

  test('decide writes the decision file, flips the DB row, and emits approval_decided once', () => {
    const events: ApprovalEvent[] = [];
    const unsubscribe = approvalNotify.onApprovalEvent((event) =>
      events.push(event),
    );

    expect(approvalService.decideApproval('req-0001', true, 'user-1')).toBe(
      true,
    );

    expect(readDecisionFile('ws-1', 'req-0001')).toMatchObject({
      id: 'req-0001',
      approved: true,
      decidedBy: 'user-1',
    });
    expect(db.getPendingApproval('req-0001')).toMatchObject({
      status: 'approved',
      decided_by: 'user-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'approval_decided',
      approval: {
        id: 'req-0001',
        groupFolder: 'ws-1',
        toolName: 'send_file',
        approved: true,
        decidedBy: 'user-1',
        decidedAt: expect.any(String),
        status: 'approved',
      },
    });

    // Second decision loses the race: no file rewrite, no DB change, no event.
    expect(approvalService.decideApproval('req-0001', false, 'user-2')).toBe(
      false,
    );
    expect(readDecisionFile('ws-1', 'req-0001')).toMatchObject({
      approved: true,
    });
    expect(events).toHaveLength(1);
    unsubscribe();
  });

  test('restart replay does not re-notify (insert detection beats the seen-set reset)', () => {
    const events: ApprovalEvent[] = [];
    const unsubscribe = approvalNotify.onApprovalEvent((event) =>
      events.push(event),
    );

    writePendingRequest('ws-1', { ...baseRequest, id: 'req-0002' });
    approvalService.scanApprovalRequests();
    expect(events).toHaveLength(1);

    // Simulate a host restart: the in-memory seen set is gone, the pending
    // files are rescanned, but the DB rows already exist.
    approvalService.resetApprovalServiceForTests();
    approvalService.scanApprovalRequests();
    expect(events).toHaveLength(1);
    expect(db.getPendingApproval('req-0002')).toMatchObject({
      status: 'pending',
    });
    unsubscribe();
  });
});

describe('decided approvals leave no pending residue (task I1)', () => {
  function pendingFileExists(folder: string, id: string): boolean {
    return fs.existsSync(
      path.join(root, 'ipc', folder, 'approvals', 'pending', `${id}.json`),
    );
  }

  test('decideApproval deletes the pending request file after deciding', () => {
    writePendingRequest('ws-1', { ...baseRequest, id: 'req-1001' });
    approvalService.scanApprovalRequests();
    expect(pendingFileExists('ws-1', 'req-1001')).toBe(true);

    expect(approvalService.decideApproval('req-1001', true, 'user-1')).toBe(
      true,
    );

    expect(readDecisionFile('ws-1', 'req-1001')).toMatchObject({
      approved: true,
    });
    expect(db.getPendingApproval('req-1001')).toMatchObject({
      status: 'approved',
    });
    expect(pendingFileExists('ws-1', 'req-1001')).toBe(false);
  });

  test('concurrent second decision does not fail on the missing pending file', () => {
    writePendingRequest('ws-1', { ...baseRequest, id: 'req-1002' });
    approvalService.scanApprovalRequests();
    expect(approvalService.decideApproval('req-1002', false, 'user-1')).toBe(
      true,
    );
    expect(pendingFileExists('ws-1', 'req-1002')).toBe(false);
    // Loses the race after the file is gone: still a clean false.
    expect(approvalService.decideApproval('req-1002', true, 'user-2')).toBe(
      false,
    );
  });

  test('scan self-heals decided leftovers: deletes the file and skips the replay log', () => {
    writePendingRequest('ws-1', { ...baseRequest, id: 'req-1003' });
    approvalService.scanApprovalRequests();
    // Decide below the service layer so the pending file lingers on disk —
    // the pre-fix shape created by any host crash between decide and cleanup.
    db.decidePendingApproval('req-1003', 'approved', 'user-1');
    expect(pendingFileExists('ws-1', 'req-1003')).toBe(true);

    approvalService.resetApprovalServiceForTests();
    const infoCallsBefore = logger.info.mock.calls.length;
    approvalService.scanApprovalRequests();

    expect(pendingFileExists('ws-1', 'req-1003')).toBe(false);
    const replayLogs = logger.info.mock.calls
      .slice(infoCallsBefore)
      .filter((call) => call[0]?.approvalId === 'req-1003');
    expect(replayLogs).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'req-1003' }),
      expect.stringContaining('stale decided'),
    );
  });

  test('scan still logs genuinely pending files on replay', () => {
    writePendingRequest('ws-1', { ...baseRequest, id: 'req-1004' });
    approvalService.scanApprovalRequests();
    expect(db.getPendingApproval('req-1004')).toMatchObject({
      status: 'pending',
    });

    approvalService.resetApprovalServiceForTests();
    const infoCallsBefore = logger.info.mock.calls.length;
    approvalService.scanApprovalRequests();

    expect(pendingFileExists('ws-1', 'req-1004')).toBe(true);
    const replayLogs = logger.info.mock.calls
      .slice(infoCallsBefore)
      .filter((call) => call[0]?.approvalId === 'req-1004');
    expect(replayLogs).toHaveLength(1);
  });
});

describe('approval id prefix matching for IM commands', () => {
  const rows = [
    { id: 'aaaaaaaa-1111', status: 'pending' },
    { id: 'aaaaaaaa-2222', status: 'pending' },
    { id: 'bbbbbbbb-9999', status: 'pending' },
    { id: 'cccccccc-0000', status: 'approved' },
  ];

  test('unique prefix resolves', () => {
    expect(approvalNotify.matchApprovalByIdPrefix('bbbbbbbb', rows)).toEqual({
      ok: true,
      id: 'bbbbbbbb-9999',
    });
  });

  test('full id resolves', () => {
    expect(
      approvalNotify.matchApprovalByIdPrefix('aaaaaaaa-1111', rows),
    ).toEqual({
      ok: true,
      id: 'aaaaaaaa-1111',
    });
  });

  test('ambiguous prefix is rejected with a helpful reason', () => {
    const result = approvalNotify.matchApprovalByIdPrefix('aaaaaaaa', rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('2');
  });

  test('short prefix is rejected', () => {
    const result = approvalNotify.matchApprovalByIdPrefix('bb', rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('4');
  });

  test('unknown prefix is rejected', () => {
    const result = approvalNotify.matchApprovalByIdPrefix('zzzzzzzz', rows);
    expect(result.ok).toBe(false);
  });

  test('already-decided approvals never match', () => {
    const result = approvalNotify.matchApprovalByIdPrefix('cccccccc', rows);
    expect(result.ok).toBe(false);
  });
});

describe('resolveApprovalInputSummary', () => {
  test('stringifies plain objects', () => {
    expect(
      approvalNotify.resolveApprovalInputSummary({ path: '/tmp/a.txt' }),
    ).toContain('/tmp/a.txt');
  });

  test('null input stays explicit', () => {
    expect(approvalNotify.resolveApprovalInputSummary(null)).toBe('null');
  });

  test('long input is truncated', () => {
    const summary = approvalNotify.resolveApprovalInputSummary({
      blob: 'x'.repeat(5_000),
    });
    expect(summary.length).toBeLessThanOrEqual(320);
    expect(summary.endsWith('…')).toBe(true);
  });
});
