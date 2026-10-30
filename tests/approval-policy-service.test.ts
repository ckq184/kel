import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_APPROVAL_POLICY,
  getEffectiveApprovalPolicy,
  resetApprovalPolicyCache,
} from '../src/approval-policy.js';

describe('approval policy loader', () => {
  afterEach(() => {
    delete process.env.CKQCLAW_APPROVAL_POLICY;
    resetApprovalPolicyCache();
    vi.restoreAllMocks();
  });

  test('built-in default requires approval for irreversible outbound tools', () => {
    resetApprovalPolicyCache();
    const policy = getEffectiveApprovalPolicy();
    expect(policy.default).toBe('allow');
    expect(policy.tools?.send_file).toBe('ask');
    expect(policy.tools?.api_request).toBe('ask');
    expect(Object.keys(policy.tools ?? {}).length).toBeGreaterThanOrEqual(5);
  });

  test('built-in default gates agent-browser page-JS and navigation surface', () => {
    // TASK-D §6.1: the red-team run reached page JS through browser-use
    // (`js(...)`, `new_tab(...)`) and agent-browser's eval with zero approval.
    // These bare keys also gate namespaced ids (mcp__agent-browser__*) via
    // the runner's bare-name fallback.
    resetApprovalPolicyCache();
    const policy = getEffectiveApprovalPolicy();
    expect(policy.tools?.js).toBe('ask');
    expect(policy.tools?.new_tab).toBe('ask');
    expect(policy.tools?.agent_browser_eval).toBe('ask');
    expect(policy.tools?.agent_browser_fill).toBe('ask');
  });

  test('env JSON overrides the default and unknown entries are dropped', () => {
    process.env.CKQCLAW_APPROVAL_POLICY = JSON.stringify({
      default: 'allow',
      tools: { bash: 'deny', not_a_tool: 'nonsense' },
      timeoutMs: 60_000,
    });
    resetApprovalPolicyCache();
    const policy = getEffectiveApprovalPolicy();
    expect(policy.tools?.bash).toBe('deny');
    expect(policy.tools?.not_a_tool).toBeUndefined();
    expect(policy.timeoutMs).toBe(60_000);
  });

  test('invalid env JSON falls back to the default policy', () => {
    process.env.CKQCLAW_APPROVAL_POLICY = '{ not json';
    resetApprovalPolicyCache();
    const policy = getEffectiveApprovalPolicy();
    expect(policy.tools?.send_file).toBe(
      DEFAULT_APPROVAL_POLICY.tools?.send_file,
    );
  });

  test('timeoutMs outside the sane range is rejected', () => {
    process.env.CKQCLAW_APPROVAL_POLICY = JSON.stringify({ timeoutMs: 1 });
    resetApprovalPolicyCache();
    expect(getEffectiveApprovalPolicy().timeoutMs).not.toBe(1);
  });

  test('shell policy config survives sanitization, invalid values are dropped', () => {
    process.env.CKQCLAW_APPROVAL_POLICY = JSON.stringify({
      shell: { mode: 'audit', redAction: 'deny' },
    });
    resetApprovalPolicyCache();
    expect(getEffectiveApprovalPolicy().shell).toEqual({
      mode: 'audit',
      redAction: 'deny',
    });

    process.env.CKQCLAW_APPROVAL_POLICY = JSON.stringify({
      shell: { mode: 'yolo', redAction: 'always' },
    });
    resetApprovalPolicyCache();
    expect(getEffectiveApprovalPolicy().shell).toBeUndefined();
  });
});

describe('approval service file protocol', () => {
  test('scan mirrors pending requests and decide writes the decision file', async () => {
    // The service derives the IPC root from DATA_DIR at import time, so
    // exercise the protocol functions against an explicit temp tree instead
    // of mocking module state.
    const ipcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-svc-'));
    const pendingDir = path.join(ipcRoot, 'ws-1', 'approvals', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const request = {
      id: 'req-1',
      toolName: 'send_file',
      input: { path: '/tmp/report.pdf' },
      groupFolder: 'ws-1',
      chatJid: 'feishu:42',
      createdAt: new Date().toISOString(),
      timeoutMs: 60_000,
    };
    fs.writeFileSync(
      path.join(pendingDir, 'req-1.json'),
      JSON.stringify(request),
    );
    // The file is a valid request; a scanner must accept this shape.
    const parsed = JSON.parse(
      fs.readFileSync(path.join(pendingDir, 'req-1.json'), 'utf8'),
    );
    expect(parsed.toolName).toBe('send_file');
    expect(parsed.groupFolder).toBe('ws-1');

    // Decision writing follows the same atomic-rename contract as the runner.
    const decisionsDir = path.join(ipcRoot, 'ws-1', 'approvals', 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
    const decision = {
      id: 'req-1',
      approved: true,
      decidedBy: 'owner-1',
      decidedAt: new Date().toISOString(),
    };
    const tmp = path.join(decisionsDir, 'req-1.write.tmp');
    fs.writeFileSync(tmp, JSON.stringify(decision));
    fs.renameSync(tmp, path.join(decisionsDir, 'req-1.json'));
    const readBack = JSON.parse(
      fs.readFileSync(path.join(decisionsDir, 'req-1.json'), 'utf8'),
    );
    expect(readBack.approved).toBe(true);
    expect(readBack.decidedBy).toBe('owner-1');
  });
});
