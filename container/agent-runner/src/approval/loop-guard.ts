import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { getApprovalIpcRoot, getApprovalPolicy } from './policy.js';

/**
 * Loop guard — deterministic brake for stuck agent turns.
 *
 * Fingerprints every tool call (tool name + stable hash of arguments) and
 * watches a rolling window. Identical tool+args repeats almost always mean a
 * stuck loop: genuine batch work differs in arguments, and polling loops are
 * whitelisted explicitly. Escalation is two-stage, mirroring the survey's
 * "reflection first, then stop":
 *
 *   - the call that reaches `maxIdenticalCalls` is blocked with a reflection
 *     demand (terminate: false — the model must change approach or stop);
 *   - any further identical call is blocked with terminate: true, ending the
 *     turn so the host can report honestly instead of burning budget.
 *
 * Runs as its own Pi extension on the same `tool_call` hook as the approval
 * gate, so native tools and external MCP tools are covered alike.
 */

export interface LoopGuardConfig {
  disabled?: boolean;
  /** Identical (tool+args) calls allowed per window before intervention. */
  maxIdenticalCalls?: number;
  /** Rolling window size for fingerprint history. */
  windowSize?: number;
  /** Exact tool names exempt from the guard (explicit polling loops). */
  allowedTools?: string[];
}

export const DEFAULT_LOOP_GUARD: Required<
  Pick<LoopGuardConfig, 'maxIdenticalCalls' | 'windowSize'>
> & Pick<LoopGuardConfig, 'allowedTools'> = {
  maxIdenticalCalls: 3,
  windowSize: 12,
  allowedTools: [],
};

export function resolveLoopGuard(config: LoopGuardConfig | undefined): {
  disabled: boolean;
  maxIdenticalCalls: number;
  windowSize: number;
  allowedTools: Set<string>;
} {
  const merged = { ...DEFAULT_LOOP_GUARD, ...config };
  return {
    disabled: config?.disabled === true,
    maxIdenticalCalls: Math.max(2, Math.floor(merged.maxIdenticalCalls)),
    windowSize: Math.max(
      merged.maxIdenticalCalls,
      Math.floor(merged.windowSize),
    ),
    allowedTools: new Set(merged.allowedTools ?? []),
  };
}

export function fingerprintToolCall(
  toolName: string,
  input: unknown,
): string {
  const stable = stableStringify(input);
  return createHash('sha256')
    .update(`${toolName}\u0000${stable}`)
    .digest('hex')
    .slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

export class LoopGuardState {
  private readonly window: string[] = [];
  private readonly maxIdenticalCalls: number;
  private readonly windowSize: number;
  private readonly allowedTools: Set<string>;

  constructor(config: LoopGuardConfig | undefined) {
    const resolved = resolveLoopGuard(config);
    this.maxIdenticalCalls = resolved.maxIdenticalCalls;
    this.windowSize = resolved.windowSize;
    this.allowedTools = resolved.allowedTools;
  }

  /**
   * Record a call and return the verdict for it.
   * `reflect` = block once and demand a different approach;
   * `stop` = block and end the turn; `allow` = no opinion.
   */
  record(toolName: string, input: unknown): 'allow' | 'reflect' | 'stop' {
    if (this.allowedTools.has(toolName)) return 'allow';
    const fp = fingerprintToolCall(toolName, input);
    this.window.push(fp);
    if (this.window.length > this.windowSize) this.window.shift();
    const count = this.window.filter((entry) => entry === fp).length;
    if (count > this.maxIdenticalCalls) return 'stop';
    if (count === this.maxIdenticalCalls) return 'reflect';
    return 'allow';
  }
}

function audit(entry: Record<string, unknown>): void {
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
    // best-effort, never breaks execution
  }
}

export default function loopGuardExtension(pi: ExtensionAPI): void {
  const config = getApprovalPolicy().loopGuard;
  const resolved = resolveLoopGuard(config);
  if (resolved.disabled) return;
  const state = new LoopGuardState(config);

  pi.on('tool_call', async (event: ToolCallEvent) => {
    const verdict = state.record(event.toolName, event.input);
    if (verdict === 'allow') return undefined;

    audit({
      kind: 'loop_guard',
      verdict,
      tool: event.toolName,
      fingerprint: fingerprintToolCall(event.toolName, event.input),
    });

    if (verdict === 'reflect') {
      return {
        block: true,
        terminate: false,
        reason:
          `Loop guard: "${event.toolName}" has already been called ` +
          `${resolved.maxIdenticalCalls - 1} times with identical arguments. ` +
          'The same call will keep producing the same result. Either change ' +
          'the approach (different arguments, a different tool, or a ' +
          'different sub-goal) or stop and report honestly. This exact call ' +
          'is now blocked for the rest of the turn.',
      } satisfies ToolCallEventResult;
    }
    return {
      block: true,
      terminate: true,
      reason:
        `Loop guard: "${event.toolName}" was called repeatedly with ` +
        'identical arguments despite a warning. The turn ends here. Report ' +
        'to the user what you were trying to do, what blocked it, and what ' +
        'you suggest trying next.',
    } satisfies ToolCallEventResult;
  });
}
