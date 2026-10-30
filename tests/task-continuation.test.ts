import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-continuation-'));

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  TASK_CONTINUATION_FILE,
  readContinuationRequest,
  decideContinuationOutcome,
  sanitizeTaskContinuationConfig,
  getTaskContinuationConfig,
  resetTaskContinuationConfigCache,
  buildContinuationPrompt,
  formatNeedsHumanNotice,
} = await import('../src/task-continuation.js');

const CONFIG_PATH = path.join(tmpDir, 'config', 'task-continuation.json');

beforeEach(() => {
  resetTaskContinuationConfigCache();
  fs.rmSync(path.dirname(CONFIG_PATH), { recursive: true, force: true });
  delete process.env.CKQCLAW_TASK_CONTINUATION;
});

afterEach(() => {
  resetTaskContinuationConfigCache();
  delete process.env.CKQCLAW_TASK_CONTINUATION;
});

describe('decideContinuationOutcome — table driven', () => {
  const base = {
    runStatus: 'success',
    continuationState: 'requested',
    continuationCount: 0,
    maxContinuations: 3,
    taskActive: true,
  };

  test('successful run with pending request and budget continues', () => {
    expect(decideContinuationOutcome(base)).toBe('continue');
  });

  test('non-requested runs are never touched', () => {
    for (const continuationState of [
      null,
      'continued',
      'needs_human',
      'abandoned',
    ]) {
      expect(decideContinuationOutcome({ ...base, continuationState })).toBe(
        'none',
      );
    }
  });

  test('terminal non-success runs abandon the request instead of looping', () => {
    for (const runStatus of [
      'failed',
      'cancelled',
      'missed',
      'delivered',
      'queued',
      'running',
      'retry_wait',
    ]) {
      expect(decideContinuationOutcome({ ...base, runStatus })).toBe('abandon');
    }
  });

  test('deleted or paused tasks never spawn continuation work', () => {
    expect(decideContinuationOutcome({ ...base, taskActive: false })).toBe(
      'abandon',
    );
  });

  test('budget exhausted escalates to needs_human', () => {
    expect(decideContinuationOutcome({ ...base, continuationCount: 3 })).toBe(
      'needs_human',
    );
    expect(decideContinuationOutcome({ ...base, continuationCount: 9 })).toBe(
      'needs_human',
    );
  });

  test('zero budget means every declared-unfinished run escalates', () => {
    expect(decideContinuationOutcome({ ...base, maxContinuations: 0 })).toBe(
      'needs_human',
    );
  });

  test('abandon wins over needs_human (dead task cannot escalate)', () => {
    expect(
      decideContinuationOutcome({
        ...base,
        taskActive: false,
        continuationCount: 5,
      }),
    ).toBe('abandon');
    expect(
      decideContinuationOutcome({
        ...base,
        runStatus: 'failed',
        continuationCount: 5,
      }),
    ).toBe('abandon');
  });
});

describe('readContinuationRequest', () => {
  const runDir = path.join(tmpDir, 'ipc', 'tasks-run', 'run-a');

  beforeEach(() => {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
  });

  function writeRequest(payload: unknown, name = TASK_CONTINUATION_FILE) {
    fs.writeFileSync(path.join(runDir, name), JSON.stringify(payload));
  }

  test('parses a well-formed request', () => {
    writeRequest({
      reason: '订单只核对了一半',
      nextStep: '从订单 51 继续核对',
      turnId: 'turn-1',
      at: '2026-10-17T00:00:00.000Z',
    });
    expect(readContinuationRequest(runDir)).toEqual({
      reason: '订单只核对了一半',
      nextStep: '从订单 51 继续核对',
      turnId: 'turn-1',
      at: '2026-10-17T00:00:00.000Z',
    });
  });

  test('missing file or missing dir returns null', () => {
    expect(readContinuationRequest(runDir)).toBeNull();
    expect(readContinuationRequest(path.join(runDir, 'missing'))).toBeNull();
  });

  test('corrupt JSON returns null', () => {
    fs.writeFileSync(path.join(runDir, TASK_CONTINUATION_FILE), '{not json');
    expect(readContinuationRequest(runDir)).toBeNull();
  });

  test('empty or missing reason returns null', () => {
    writeRequest({ reason: '   ', nextStep: null, at: 'x' });
    expect(readContinuationRequest(runDir)).toBeNull();
    writeRequest({ nextStep: 'x', at: 'x' });
    expect(readContinuationRequest(runDir)).toBeNull();
  });

  test('non-string fields return null', () => {
    writeRequest({ reason: 42, nextStep: null, at: 'x' });
    expect(readContinuationRequest(runDir)).toBeNull();
  });

  test('oversized fields are truncated, not rejected', () => {
    writeRequest({
      reason: 'x'.repeat(9000),
      nextStep: 'y'.repeat(9000),
      turnId: 't',
      at: '2026-10-17T00:00:00.000Z',
    });
    const parsed = readContinuationRequest(runDir)!;
    expect(parsed.reason.length).toBe(4000);
    expect(parsed.nextStep?.length).toBe(4000);
  });

  test('optional fields default to null', () => {
    writeRequest({ reason: 'r', at: '2026-10-17T00:00:00.000Z' });
    expect(readContinuationRequest(runDir)).toEqual({
      reason: 'r',
      nextStep: null,
      turnId: null,
      at: '2026-10-17T00:00:00.000Z',
    });
  });
});

describe('sanitizeTaskContinuationConfig', () => {
  test('accepts a full valid object', () => {
    expect(
      sanitizeTaskContinuationConfig({ maxContinuations: 2, backoffMs: 5000 }),
    ).toEqual({ maxContinuations: 2, backoffMs: 5000 });
  });

  test('rejects non-object input', () => {
    for (const bad of [null, 'x', 3, [], true]) {
      expect(sanitizeTaskContinuationConfig(bad)).toBeNull();
    }
  });

  test('rejects out-of-range or non-integer values', () => {
    expect(sanitizeTaskContinuationConfig({ maxContinuations: -1 })).toBeNull();
    expect(
      sanitizeTaskContinuationConfig({ maxContinuations: 2.5 }),
    ).toBeNull();
    expect(sanitizeTaskContinuationConfig({ maxContinuations: 11 })).toBeNull();
    expect(
      sanitizeTaskContinuationConfig({ maxContinuations: 3, backoffMs: -1 }),
    ).toBeNull();
    expect(sanitizeTaskContinuationConfig({ backoffMs: 3_600_001 })).toBeNull();
  });

  test('partial objects fall back to defaults per field', () => {
    expect(sanitizeTaskContinuationConfig({})).toEqual({
      maxContinuations: 3,
      backoffMs: 60_000,
    });
    expect(sanitizeTaskContinuationConfig({ maxContinuations: 0 })).toEqual({
      maxContinuations: 0,
      backoffMs: 60_000,
    });
    expect(sanitizeTaskContinuationConfig({ backoffMs: 0 })).toEqual({
      maxContinuations: 3,
      backoffMs: 0,
    });
  });
});

describe('getTaskContinuationConfig precedence', () => {
  test('defaults when neither env nor file exist', () => {
    expect(getTaskContinuationConfig()).toEqual({
      maxContinuations: 3,
      backoffMs: 60_000,
    });
  });

  test('file overrides defaults', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{"maxContinuations": 5, "backoffMs": 1000}');
    resetTaskContinuationConfigCache();
    expect(getTaskContinuationConfig()).toEqual({
      maxContinuations: 5,
      backoffMs: 1000,
    });
  });

  test('env beats file', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{"maxContinuations": 5}');
    process.env.CKQCLAW_TASK_CONTINUATION = '{"maxContinuations": 1}';
    resetTaskContinuationConfigCache();
    expect(getTaskContinuationConfig().maxContinuations).toBe(1);
  });

  test('invalid env JSON falls back to built-in defaults without throwing', () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{"maxContinuations": 4}');
    process.env.CKQCLAW_TASK_CONTINUATION = 'not-json';
    resetTaskContinuationConfigCache();
    // Parity with approval-policy: a set-but-broken env never silently falls
    // through to the file — the built-in default applies.
    expect(getTaskContinuationConfig().maxContinuations).toBe(3);
  });
});

describe('buildContinuationPrompt', () => {
  test('injects reason, next step, budget and the original prompt', () => {
    const prompt = buildContinuationPrompt({
      basePrompt: '核对全部订单',
      reason: '只核对到一半',
      nextStep: '从 51 号继续',
      count: 2,
      maxContinuations: 3,
    });
    expect(prompt).toContain('[定时任务自动续跑]');
    expect(prompt).toContain('第 2/3 次续跑');
    expect(prompt).toContain('未完成原因：只核对到一半');
    expect(prompt).toContain('建议下一步：从 51 号继续');
    expect(prompt).toContain('task_request_continuation');
    expect(prompt.endsWith('核对全部订单')).toBe(true);
  });

  test('omits the next-step line when absent', () => {
    const prompt = buildContinuationPrompt({
      basePrompt: 'p',
      reason: 'r',
      nextStep: null,
      count: 1,
      maxContinuations: 3,
    });
    expect(prompt).not.toContain('建议下一步：');
  });
});

describe('formatNeedsHumanNotice', () => {
  test('mentions the escalation and the declared reason', () => {
    const text = formatNeedsHumanNotice({
      taskPrompt: '整理周报\n更多细节',
      runId: 'run-1',
      reason: '数据源还没同步',
      nextStep: '等数据源恢复后重算',
      count: 3,
      maxContinuations: 3,
    });
    expect(text).toContain('需要人工处理');
    expect(text).toContain('整理周报');
    expect(text).toContain('run-1');
    expect(text).toContain('连续 3 次自动续跑');
    expect(text).toContain('数据源还没同步');
    expect(text).toContain('等数据源恢复后重算');
  });
});
