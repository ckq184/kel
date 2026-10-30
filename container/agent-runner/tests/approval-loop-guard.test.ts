import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import loopGuardExtension from '../src/approval/loop-guard.js';
import { setApprovalIpcRoot } from '../src/approval/policy.js';
import {
  LoopGuardState,
  fingerprintToolCall,
  resolveLoopGuard,
} from '../src/approval/loop-guard.js';

const ARGS = { path: '/tmp/report.pdf' };
const OTHER_ARGS = { path: '/tmp/other.pdf' };

function drive(
  state: LoopGuardState,
  calls: Array<[string, unknown]>,
): Array<'allow' | 'reflect' | 'stop'> {
  return calls.map(([tool, input]) => state.record(tool, input));
}

describe('LoopGuardState', () => {
  test('distinct arguments never collide — batch loops are safe', () => {
    const state = new LoopGuardState(undefined);
    const verdicts = drive(
      state,
      Array.from({ length: 10 }, (_, i) => [
        'send_file',
        { path: `/tmp/file-${i}.pdf` },
      ]) as Array<[string, unknown]>,
    );
    expect(verdicts.every((v) => v === 'allow')).toBe(true);
  });

  test('two identical calls pass, the third demands reflection, the fourth stops', () => {
    const state = new LoopGuardState(undefined);
    const verdicts = drive(state, [
      ['send_file', ARGS],
      ['send_file', ARGS],
      ['send_file', ARGS],
      ['send_file', ARGS],
    ]);
    expect(verdicts).toEqual(['allow', 'allow', 'reflect', 'stop']);
  });

  test('verdicts escalate per fingerprint, not globally', () => {
    const state = new LoopGuardState(undefined);
    expect(state.record('send_file', ARGS)).toBe('allow');
    expect(state.record('send_file', ARGS)).toBe('allow');
    expect(state.record('api_request', ARGS)).toBe('allow');
    expect(state.record('send_file', ARGS)).toBe('reflect');
    expect(state.record('send_file', ARGS)).toBe('stop');
    // A different tool is judged independently.
    expect(state.record('api_request', OTHER_ARGS)).toBe('allow');
  });

  test('sliding window lets old fingerprints expire', () => {
    const state = new LoopGuardState({ windowSize: 4 });
    // Fill the window; each identical pair ages out before reaching 3.
    for (let round = 0; round < 4; round += 1) {
      expect(state.record('read', { file: 'a' })).toBe('allow');
      expect(state.record('read', { file: 'b' })).toBe('allow');
      expect(state.record('read', { file: 'c' })).toBe('allow');
    }
  });

  test('allowed tools bypass the guard (explicit polling loops)', () => {
    const state = new LoopGuardState({ allowedTools: ['get_status'] });
    const verdicts = drive(
      state,
      Array.from({ length: 6 }, () => ['get_status', {}]) as Array<
        [string, unknown]
      >,
    );
    expect(verdicts.every((v) => v === 'allow')).toBe(true);
  });
});

describe('fingerprint and config resolution', () => {
  test('fingerprint is stable across key order and ignores undefined', () => {
    expect(fingerprintToolCall('t', { a: 1, b: 2 })).toBe(
      fingerprintToolCall('t', { b: 2, a: 1 }),
    );
    expect(fingerprintToolCall('t', { a: 1 })).toBe(
      fingerprintToolCall('t', { a: 1, b: undefined }),
    );
    expect(fingerprintToolCall('t', { a: 1 })).not.toBe(
      fingerprintToolCall('t2', { a: 1 }),
    );
    expect(fingerprintToolCall('t', { a: 1 })).not.toBe(
      fingerprintToolCall('t', { a: 2 }),
    );
  });

  test('defaults are enforce-on; bounds are clamped', () => {
    expect(resolveLoopGuard(undefined)).toMatchObject({
      disabled: false,
      maxIdenticalCalls: 3,
      windowSize: 12,
    });
    // windowSize below the threshold is clamped up to the threshold.
    expect(
      resolveLoopGuard({ maxIdenticalCalls: 5, windowSize: 2 }),
    ).toMatchObject({
      windowSize: 5,
    });
    expect(resolveLoopGuard({ disabled: true }).disabled).toBe(true);
  });
});

describe('loop guard extension hook', () => {
  /** Minimal ExtensionAPI stand-in that captures the tool_call handler. */
  function captureHook(): {
    handler: (event: { toolName: string; input: unknown }) => Promise<unknown>;
  } {
    let handler:
      | ((event: { toolName: string; input: unknown }) => Promise<unknown>)
      | undefined;
    loopGuardExtension({
      on(event, fn) {
        if (event === 'tool_call') handler = fn as typeof handler;
      },
    } as never);
    if (!handler) throw new Error('tool_call handler was not registered');
    return { handler };
  }

  test('third identical call blocks with reflect, fourth terminates', async () => {
    const { handler } = captureHook();
    const event = { toolName: 'read', input: { path: '/tmp/x' } };
    expect(await handler(event)).toBeUndefined();
    expect(await handler(event)).toBeUndefined();
    const reflect = (await handler(event)) as {
      block: boolean;
      terminate: boolean;
    };
    expect(reflect).toMatchObject({ block: true, terminate: false });
    const stop = (await handler(event)) as {
      block: boolean;
      terminate: boolean;
    };
    expect(stop).toMatchObject({ block: true, terminate: true });
  });

  test('blocked calls are audit-logged as loop_guard events', async () => {
    const ipcRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ckqclaw-loopguard-'),
    );
    setApprovalIpcRoot(ipcRoot);
    try {
      const { handler } = captureHook();
      const event = {
        toolName: 'mcp__ckqclaw__get_channel_context',
        input: {},
      };
      await handler(event);
      await handler(event);
      await handler(event);
      await handler(event);
      const auditFile = path.join(ipcRoot, 'approvals', 'audit.jsonl');
      const entries = fs
        .readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(entries.map((e) => e.verdict)).toEqual(['reflect', 'stop']);
      expect(entries.every((e) => e.kind === 'loop_guard')).toBe(true);
      expect(entries[0].tool).toBe('mcp__ckqclaw__get_channel_context');
    } finally {
      fs.rmSync(ipcRoot, { recursive: true, force: true });
    }
  });
});
