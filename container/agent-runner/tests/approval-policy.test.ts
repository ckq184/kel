import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  approvalDirs,
  awaitApprovalDecision,
  isPolicyEnforced,
  readApprovalDecision,
  resolveApprovalAction,
  setApprovalIpcRoot,
  setApprovalPolicy,
  setApprovalRequestContext,
  writeApprovalRequest,
  type ApprovalPolicy,
} from '../src/approval/policy.js';

function makeTempIpcRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-approvals-'));
}

describe('resolveApprovalAction', () => {
  test('empty policy allows everything', () => {
    const policy: ApprovalPolicy = {};
    expect(resolveApprovalAction(policy, 'send_file')).toBe('allow');
    expect(resolveApprovalAction(policy, 'bash')).toBe('allow');
  });

  test('exact tool entries win over the default', () => {
    const policy: ApprovalPolicy = {
      default: 'allow',
      tools: { send_file: 'ask' },
    };
    expect(resolveApprovalAction(policy, 'send_file')).toBe('ask');
    expect(resolveApprovalAction(policy, 'read')).toBe('allow');
  });

  test('longest prefix wildcard wins', () => {
    const policy: ApprovalPolicy = {
      tools: {
        'mcp__*': 'ask',
        mcp__miniclaw__read: 'allow',
      },
    };
    expect(resolveApprovalAction(policy, 'mcp__miniclaw__read')).toBe('allow');
    expect(
      resolveApprovalAction(policy, 'mcp__playwright__browser_click'),
    ).toBe('ask');
    expect(resolveApprovalAction(policy, 'bash')).toBe('allow');
  });

  test('deny propagates from default and tools', () => {
    const policy: ApprovalPolicy = {
      default: 'deny',
      tools: { read: 'allow' },
    };
    expect(resolveApprovalAction(policy, 'write')).toBe('deny');
    expect(resolveApprovalAction(policy, 'read')).toBe('allow');
  });

  test('bare policy keys gate namespaced tool ids', () => {
    const policy: ApprovalPolicy = {
      default: 'allow',
      tools: { send_file: 'ask', browser_evaluate: 'ask' },
    };
    expect(resolveApprovalAction(policy, 'mcp__miniclaw__send_file')).toBe(
      'ask',
    );
    expect(
      resolveApprovalAction(policy, 'mcp__playwright__browser_evaluate'),
    ).toBe('ask');
    expect(resolveApprovalAction(policy, 'mcp__miniclaw__read')).toBe('allow');
  });

  test('agent-browser tool names are gated by bare keys', () => {
    // Server ids may contain hyphens (`mcp__agent-browser__*`); the bare-name
    // fallback must still strip the namespace and hit the policy entry.
    const policy: ApprovalPolicy = {
      default: 'allow',
      tools: {
        js: 'ask',
        new_tab: 'ask',
        agent_browser_eval: 'ask',
        agent_browser_fill: 'ask',
      },
    };
    expect(
      resolveApprovalAction(policy, 'mcp__agent-browser__agent_browser_eval'),
    ).toBe('ask');
    expect(
      resolveApprovalAction(policy, 'mcp__agent-browser__agent_browser_fill'),
    ).toBe('ask');
    expect(resolveApprovalAction(policy, 'js')).toBe('ask');
    expect(resolveApprovalAction(policy, 'new_tab')).toBe('ask');
    expect(
      resolveApprovalAction(policy, 'mcp__agent-browser__agent_browser_snapshot'),
    ).toBe('allow');
  });
});

describe('isPolicyEnforced', () => {
  test('allow-everything is not enforced', () => {
    expect(isPolicyEnforced({})).toBe(false);
    expect(isPolicyEnforced({ default: 'allow' })).toBe(false);
    expect(isPolicyEnforced({ tools: { a: 'allow' } })).toBe(false);
  });

  test('any ask or deny is enforced', () => {
    expect(isPolicyEnforced({ default: 'ask' })).toBe(true);
    expect(isPolicyEnforced({ tools: { bash: 'deny' } })).toBe(true);
  });
});

describe('approval file protocol', () => {
  test('request round-trip: write, decision, read', async () => {
    const ipcRoot = makeTempIpcRoot();
    setApprovalIpcRoot(ipcRoot);
    const request = writeApprovalRequest(ipcRoot, {
      toolName: 'send_file',
      input: { path: '/tmp/x' },
      groupFolder: 'ws-1',
      chatJid: 'feishu:123',
      timeoutMs: 1_000,
    });
    const { pending } = approvalDirs(ipcRoot);
    expect(fs.existsSync(path.join(pending, `${request.id}.json`))).toBe(true);

    // No decision yet: readApprovalDecision returns undefined.
    expect(readApprovalDecision(ipcRoot, request.id)).toBeUndefined();

    // Write an approval decision, then the wait resolves approved. The host
    // owns the decisions directory, so create it before writing.
    const wait = awaitApprovalDecision(ipcRoot, request);
    fs.mkdirSync(approvalDirs(ipcRoot).decisions, { recursive: true });
    fs.writeFileSync(
      path.join(approvalDirs(ipcRoot).decisions, `${request.id}.json`),
      JSON.stringify({
        id: request.id,
        approved: true,
        decidedBy: 'owner',
        decidedAt: new Date().toISOString(),
      }),
    );
    const outcome = await wait;
    expect(outcome.kind).toBe('approved');
  });

  test('timeout denies (fail-closed)', async () => {
    const ipcRoot = makeTempIpcRoot();
    const request = writeApprovalRequest(ipcRoot, {
      toolName: 'api_request',
      input: {},
      groupFolder: 'ws-1',
      chatJid: 'feishu:123',
      timeoutMs: 60,
    });
    const outcome = await awaitApprovalDecision(ipcRoot, request);
    expect(outcome.kind).toBe('timeout');
  }, 5_000);

  test('abort unblocks the wait with denied', async () => {
    const ipcRoot = makeTempIpcRoot();
    const request = writeApprovalRequest(ipcRoot, {
      toolName: 'send_image',
      input: {},
      groupFolder: 'ws-1',
      chatJid: 'feishu:123',
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
    const controller = new AbortController();
    const wait = awaitApprovalDecision(ipcRoot, request, controller.signal);
    controller.abort('turn ended');
    const outcome = await wait;
    expect(outcome).toEqual({ kind: 'aborted', reason: 'turn ended' });
  });

  test('malformed decision files are ignored until a valid one appears', async () => {
    const ipcRoot = makeTempIpcRoot();
    const request = writeApprovalRequest(ipcRoot, {
      toolName: 'edit_message',
      input: {},
      groupFolder: 'ws-1',
      chatJid: 'feishu:123',
      timeoutMs: 2_000,
    });
    fs.mkdirSync(approvalDirs(ipcRoot).decisions, { recursive: true });
    fs.writeFileSync(
      path.join(approvalDirs(ipcRoot).decisions, `${request.id}.json`),
      '{ not json',
    );
    const wait = awaitApprovalDecision(ipcRoot, request);
    setTimeout(() => {
      fs.writeFileSync(
        path.join(approvalDirs(ipcRoot).decisions, `${request.id}.json`),
        JSON.stringify({
          id: request.id,
          approved: false,
          decidedAt: new Date().toISOString(),
        }),
      );
    }, 30);
    const outcome = await wait;
    expect(outcome.kind).toBe('denied');
  }, 5_000);
});

describe('request context holder', () => {
  test('setApprovalRequestContext strips empty identity fields', () => {
    setApprovalRequestContext({ groupFolder: 'ws', chatJid: 'qq:1' });
    setApprovalPolicy({ default: 'deny' });
    expect(isPolicyEnforced()).toBe(true);
    setApprovalPolicy(undefined);
    expect(isPolicyEnforced()).toBe(false);
  });
});
