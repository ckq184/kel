import fs from 'node:fs';
import path from 'node:path';

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  awaitApprovalDecision,
  getApprovalIpcRoot,
  getApprovalPolicy,
  getApprovalRequestContext,
  resolveApprovalAction,
  writeApprovalRequest,
  type ApprovalRequest,
} from './policy.js';
import {
  classifyShellCommand,
  readBashCommand,
  resolveShellPolicy,
} from './shell-policy.js';

/**
 * Pi extension: host-enforced tool approval gate.
 *
 * Loaded via extensionPaths like @tintinweb/pi-subagents. The SDK routes
 * EVERY tool call (native read/bash/edit/write, Miniclaw MCP tools, and MCP
 * tools from user-configured external servers) through the `tool_call`
 * extension event before execution, so this is the single choke point where
 * policy is enforced. The model cannot bypass it: the gate runs in the
 * runner process, and resolution happens before any tool executes.
 *
 * Two layers, most specific first:
 *   1. Shell command classification (native `bash` only): red-line commands
 *      ask or deny per the shell policy in enforce mode; yellow-line
 *      commands run and are audit-logged; `pass` falls through.
 *   2. Tool-name policy (allow/ask/deny, exact or prefix entries).
 *
 * `ask` suspends the call until the host writes a decision file (user
 * approval via Web or IM), the timeout elapses, or the turn aborts — all
 * three non-approve outcomes deny.
 */
export default function approvalGateExtension(pi: ExtensionAPI): void {
  let pendingSignal: AbortController | undefined;

  const cancelPending = (reason: string): void => {
    if (pendingSignal && !pendingSignal.signal.aborted) {
      pendingSignal.abort(reason);
    }
  };

  const audit = (entry: Record<string, unknown>): void => {
    const ipcRoot = getApprovalIpcRoot();
    if (!ipcRoot) return;
    try {
      const auditFile = path.join(ipcRoot, 'approvals', 'audit.jsonl');
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.appendFileSync(
        auditFile,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
    } catch {
      // Audit is best-effort; it must never break tool execution.
    }
  };

  const suspendForApproval = async (
    event: ToolCallEvent,
    detail: string,
  ): Promise<ToolCallEventResult | undefined> => {
    const ipcRoot = getApprovalIpcRoot();
    if (!ipcRoot) {
      return {
        block: true,
        terminate: true,
        reason: `Approval is required for "${event.toolName}" but the IPC directory is unavailable — denying (fail-closed).`,
      } satisfies ToolCallEventResult;
    }
    const policy = getApprovalPolicy();
    const timeoutMs = policy.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const context = getApprovalRequestContext();
    const request: ApprovalRequest = writeApprovalRequest(ipcRoot, {
      toolName: event.toolName,
      input: event.input,
      groupFolder: context.groupFolder,
      chatJid: context.chatJid,
      sessionId: context.sessionId,
      turnId: context.turnId,
      timeoutMs,
    });
    audit({
      kind: 'approval_requested',
      id: request.id,
      tool: event.toolName,
      detail,
    });

    pendingSignal = new AbortController();
    try {
      const outcome = await awaitApprovalDecision(
        ipcRoot,
        request,
        pendingSignal.signal,
      );
      switch (outcome.kind) {
        case 'approved':
          audit({ kind: 'approval_granted', id: request.id, tool: event.toolName });
          return undefined;
        case 'denied':
          audit({ kind: 'approval_denied', id: request.id, tool: event.toolName });
          return {
            block: true,
            terminate: false,
            reason: `The user did not approve "${event.toolName}"${
              outcome.decision?.decidedBy ? ` (decided by ${outcome.decision.decidedBy})` : ''
            }. Do not retry the same call; continue without it or ask the user.`,
          } satisfies ToolCallEventResult;
        case 'timeout':
          audit({ kind: 'approval_timeout', id: request.id, tool: event.toolName });
          return {
            block: true,
            terminate: true,
            reason: `Approval for "${event.toolName}" timed out after ${Math.round(timeoutMs / 1000)}s and was denied (fail-closed). Report this to the user and stop.`,
          } satisfies ToolCallEventResult;
        case 'aborted':
          audit({ kind: 'approval_cancelled', id: request.id, tool: event.toolName });
          return {
            block: true,
            terminate: true,
            reason: `Tool call cancelled while awaiting approval: ${outcome.reason}`,
          } satisfies ToolCallEventResult;
      }
    } finally {
      pendingSignal = undefined;
    }
  };

  pi.on('tool_call', async (event: ToolCallEvent) => {
    const policy = getApprovalPolicy();
    const ipcRoot = getApprovalIpcRoot();
    if (!ipcRoot) return undefined;

    // Layer 1: shell command classification (native bash only).
    const command = readBashCommand(event.toolName, event.input);
    if (command) {
      const shell = resolveShellPolicy(policy);
      if (shell.mode !== 'off') {
        const verdict = classifyShellCommand(command);
        if (verdict.level === 'red') {
          audit({
            kind: 'shell_red_line',
            mode: shell.mode,
            reasons: verdict.reasons,
            command,
          });
          if (shell.mode === 'enforce') {
            if (shell.redAction === 'deny') {
              return {
                block: true,
                terminate: false,
                reason: `Blocked by shell policy (red line): ${verdict.reasons.join('; ')}. Do not attempt to reword or obfuscate this command; ask the user instead.`,
              } satisfies ToolCallEventResult;
            }
            return suspendForApproval(
              event,
              `shell red line: ${verdict.reasons.join('; ')}`,
            );
          }
        } else if (verdict.level === 'yellow') {
          audit({
            kind: 'shell_yellow_line',
            reasons: verdict.reasons,
            command,
          });
          // Allowed here; the tool-name policy below still applies.
        }
      }
    }

    // Layer 2: tool-name policy.
    const action = resolveApprovalAction(policy, event.toolName);
    if (action === 'allow') return undefined;
    if (action === 'deny') {
      return {
        block: true,
        reason: `Blocked by approval policy: tool "${event.toolName}" is not allowed. Ask the user to adjust the tool approval policy if this is needed.`,
      } satisfies ToolCallEventResult;
    }
    return suspendForApproval(event, 'tool policy: ask');
  });

  // Unblock a suspended `ask` wait when the turn is ending anyway, so the
  // runner loop can finish cleanly instead of polling until the timeout.
  pi.on('agent_end', () => cancelPending('agent turn ended'));
  pi.on('session_shutdown', () => cancelPending('session shutdown'));
}
